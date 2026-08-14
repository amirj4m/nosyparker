/**
 * The gate.
 *
 * Text goes in, one decision comes out, and the decision is written to the log
 * whether or not anything was stored. Every path through this file ends in a
 * single call to `recordDecision`, which is the only way to change a memory.
 *
 * Everything each rule looks at is read inside the transaction that writes the
 * result. Several agents writing at the same time is the ordinary case for
 * this tool, not an edge case, so a rule that decided on a read taken before
 * the write lock would be a rule that two agents can both pass at once.
 *
 * The rules are tried top to bottom and the first one that applies wins. The
 * order is part of the design, not an implementation detail:
 *
 *   1. credential        refused, and the text is not written down anywhere
 *   2. empty             refused
 *   3. already-stored    refused
 *   4. replaces-unknown  refused, so a wrong id cannot retire the wrong memory
 *   5. replaces          stored, and the named memory is superseded
 *   6. keep              stored
 *
 * `forget` and `restore` are separate entry points and are not part of the
 * submit path. Both are content to repeat themselves: forgetting something
 * already put away puts it away again under the new reason, and restoring
 * something already on show restores it again. Each writes its ordinary row.
 * A memory's row therefore carries only its latest reason, and the full run of
 * them is in the decision log, which holds every call ever made and is never
 * shortened.
 *
 * The gate does not compare meanings. It has no notion of two memories being
 * about the same topic, it never decides on its own that one memory updates
 * another, and it does not infer anything from the text beyond the shapes
 * listed above. It accepts a claim; it does not form one.
 */

import { detectCredential, credentialExplanation, credentialPlaceholder } from './credentials.js';
import { excerpt, findDuplicate, getMemory, recordDecision } from './store.js';
import { isBlank } from './text.js';

/**
 * @typedef {import('./store.js').Store} Store
 * @typedef {import('./store.js').Memory} Memory
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 */

/**
 * @typedef {object} GateResult
 * @property {'stored'|'superseded'|'forgotten'|'restored'|'refused'} verdict
 * @property {string} rule
 * @property {string} explanation
 * @property {number|null} memory_id the memory this decision produced or acted on
 * @property {number|null} related_memory_id the other memory involved, if any
 * @property {number} decision_id
 */

/**
 * What goes in the owner column when the owner is the thing that looked like a
 * secret. The decision still has to be written down, and writing it under the
 * name it was given would put the secret in the log.
 */
const OWNER_NOT_RECORDED = '[owner not recorded]';

/**
 * Rule 1, applied to the owner.
 *
 * The owner is free text from a caller like the memory and the reason are, and
 * it is stored on both tables, so it is checked on every entry point before
 * anything else happens.
 *
 * @param {string} owner
 * @returns {import('./store.js').DecisionPlan|null}
 */
function refuseCredentialOwner(owner) {
  const credential = detectCredential(owner);
  if (credential === null) return null;

  return {
    owner: OWNER_NOT_RECORDED,
    verdict: 'refused',
    rule: 'credential',
    explanation:
      'The owner name itself looked like a secret, so nothing was stored and the name ' +
      `was not written down either. ${credentialExplanation(credential)}`,
    input_excerpt: credentialPlaceholder(credential, owner),
  };
}

/**
 * Offer a memory to the store.
 *
 * @param {Store} store
 * @param {object} submission
 * @param {string} submission.owner
 * @param {string} submission.text
 * @param {number|null} [submission.replaces] id of a memory this one replaces
 * @returns {GateResult}
 */
export function submit(store, { owner, text, replaces = null }) {
  return asResult(
    recordDecision(store, (actions, at) => {
      // 1. credential, on the owner first, since the owner is written to both
      // tables and would otherwise end up in the very row that records the
      // refusal.
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      // 1. credential, on the text. This runs before anything else touches it,
      // and it is the only branch that replaces the excerpt with a placeholder.
      const credential = detectCredential(text);
      if (credential) {
        return {
          owner,
          verdict: 'refused',
          rule: 'credential',
          explanation: credentialExplanation(credential),
          input_excerpt: credentialPlaceholder(credential, text),
        };
      }

      // 2. empty.
      if (isBlank(text)) {
        return {
          owner,
          verdict: 'refused',
          rule: 'empty',
          explanation: 'There was nothing to store. The text was empty or only spaces.',
          input_excerpt: '',
        };
      }

      // 3. already-stored. Read here, inside the lock, so that two identical
      // submissions arriving together cannot both find nothing.
      const duplicate = findDuplicate(store, owner, text);
      if (duplicate) {
        return {
          owner,
          verdict: 'refused',
          rule: 'already-stored',
          explanation:
            `This is already stored as memory ${duplicate.id}, word for word. ` +
            'Nothing was added, and the memory you already have is unchanged.',
          input_excerpt: excerpt(text),
          related_memory_id: duplicate.id,
        };
      }

      // 4. replaces-unknown. The default read is active only, which is exactly
      // what this rule needs: a replaced or forgotten id is not a valid target.
      const target = replaces === null ? null : getMemory(store, owner, replaces);
      if (replaces !== null && target === null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'replaces-unknown',
          explanation:
            `Nothing was stored, because memory ${replaces} is not one of your active memories. ` +
            'Check the id and try again. Refusing here means a mistyped id cannot quietly ' +
            'retire a memory you meant to keep.',
          input_excerpt: excerpt(text),
        };
      }

      // 5. replaces.
      if (target !== null) {
        const newId = actions.insertMemory({ owner, text, at, supersedes: target.id });
        actions.retire({ owner, id: target.id, at, supersededBy: newId });

        return {
          owner,
          verdict: 'superseded',
          rule: 'replaces',
          explanation:
            `Stored, and memory ${target.id} was retired in its favour. ` +
            'The old one is still in the file and can be brought back.',
          input_excerpt: excerpt(text),
          memory_id: newId,
          related_memory_id: target.id,
        };
      }

      // 6. keep.
      return {
        owner,
        verdict: 'stored',
        rule: 'keep',
        explanation: 'Stored.',
        input_excerpt: excerpt(text),
        memory_id: actions.insertMemory({ owner, text, at, supersedes: null }),
      };
    }),
  );
}

/**
 * Ask for a memory to stop being shown.
 *
 * The row stays. It leaves the search results and the active list, keeps its
 * reason, and can be restored.
 *
 * @param {Store} store
 * @param {object} request
 * @param {string} request.owner
 * @param {number} request.id
 * @param {string} request.reason
 * @returns {GateResult}
 */
export function forget(store, { owner, id, reason }) {
  return asResult(
    recordDecision(store, (actions, at) => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      // 1. credential. A reason is free text from a caller like any other, and
      // it is written to the row as well as to the log, so it is guarded the
      // same way. This comes first here for the same reason it comes first in
      // submit: nothing else may touch the text before it has been checked.
      const credential = detectCredential(reason);
      if (credential) {
        return {
          owner,
          verdict: 'refused',
          rule: 'credential',
          explanation: credentialExplanation(credential),
          input_excerpt: credentialPlaceholder(credential, reason),
        };
      }

      // Archived rows included, because forgetting is about the row rather
      // than about what is on show.
      const memory = getMemory(store, owner, id, { includeArchived: true });

      // 8. forget-unknown.
      if (memory === null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'forget-unknown',
          explanation: `There is no memory ${id} belonging to you, so nothing was changed.`,
          input_excerpt: excerpt(reason),
        };
      }

      // 7. forget. Asking again for something already put away simply puts it
      // away again under the new reason. The reason on the row is replaced,
      // and every reason ever given is still in the decision log, which is
      // complete and never shortened.
      actions.putAway({ owner, id, at, reason, wasInState: memory.state });

      return {
        owner,
        verdict: 'forgotten',
        rule: 'forget',
        explanation:
          `Memory ${id} will not be shown any more. It is still in the file and ` +
          'can be brought back with restore.',
        input_excerpt: excerpt(reason),
        memory_id: id,
      };
    }),
  );
}

/**
 * Put a memory back into the active set.
 *
 * If the memory had been replaced by a newer one, that forward pointer is
 * cleared on both sides. Leaving it would let a newer memory go on claiming to
 * have replaced something that is active again.
 *
 * @param {Store} store
 * @param {object} request
 * @param {string} request.owner
 * @param {number} request.id
 * @returns {GateResult}
 */
export function restore(store, { owner, id }) {
  return asResult(
    recordDecision(store, (actions, at) => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      // Archived rows included, since an archived row is the whole point.
      const memory = getMemory(store, owner, id, { includeArchived: true });

      if (memory === null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'restore-unknown',
          explanation: `There is no memory ${id} belonging to you, so nothing was changed.`,
          input_excerpt: '',
        };
      }

      // Read inside the transaction, and written back guarded by the same
      // value, so the pointer cannot be cleared on the strength of a reading
      // that another writer has already changed.
      const replacedBy = memory.superseded_by;

      // state_reason is left alone on purpose. It says why this memory was put
      // away, which stays true and stays worth knowing after it comes back.
      actions.bringBack({
        owner,
        id,
        at,
        wasInState: memory.state,
        wasSupersededBy: replacedBy,
      });

      if (replacedBy !== null) {
        // The other side of the pointer, so neither row is left claiming
        // something the other one contradicts.
        actions.unlinkSupersedes({ owner, id: replacedBy, noLongerSupersedes: id });
      }

      return {
        owner,
        verdict: 'restored',
        rule: 'restored',
        explanation:
          replacedBy === null
            ? `Memory ${id} is being shown again.`
            : `Memory ${id} is being shown again, and memory ${replacedBy} no longer claims to ` +
              'have replaced it.',
        input_excerpt: '',
        memory_id: id,
        related_memory_id: replacedBy,
      };
    }),
  );
}

/**
 * @param {ReturnType<typeof recordDecision>} written
 * @returns {GateResult}
 */
function asResult(written) {
  return {
    verdict: /** @type {GateResult['verdict']} */ (written.plan.verdict),
    rule: written.plan.rule,
    explanation: written.plan.explanation,
    memory_id: written.memory_id,
    related_memory_id: written.related_memory_id,
    decision_id: written.decision_id,
  };
}
