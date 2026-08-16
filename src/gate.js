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
 *   2. control-character refused, and the text is not written down either
 *   3. empty             refused
 *   4. already-stored    refused
 *   5. replaces-unknown  refused, so a wrong id cannot retire the wrong memory
 *   6. replaces          stored, and the named memory is superseded
 *   7. keep              stored
 *
 * Rule 2 is the eleventh name in a vocabulary that was closed at ten, and it
 * was opened on purpose. It is here rather than in the adapter because the
 * guarantee it carries is the store's: what was stored is what reads back. A
 * NUL was written whole to the file and read back cut in half, and everything
 * downstream then disagreed with the file — two identical-looking memories
 * from one duplicate rule, a secret sitting in the bytes with only its
 * harmless first half on show, and a search matching text the list could not
 * display. Stripping the character instead would have been the other way to
 * close it, and this project does not edit what somebody typed. Refusing is
 * the only answer left that keeps both promises.
 *
 * It writes its row like every other rule, which is the point of it being a
 * rule at all: an agent that walks into this leaves a mark. The blank-reason
 * check in the adapter is not a rule and left nothing, which is exactly how a
 * NUL walked past it.
 *
 * `forget` and `restore` are separate entry points and are not part of the
 * submit path. Both are content to repeat themselves: forgetting something
 * already put away puts it away again under the new reason, and restoring
 * something already on show restores it again. Each writes its ordinary row.
 *
 * A memory's row says what is true of it now: `state_reason` holds the reason
 * it is put away while it is put away, and is cleared when it comes back,
 * because an active memory has no reason for being archived. Every reason ever
 * given is in the decision log, which holds every call ever made and is never
 * shortened. The row is the current state; the log is the history.
 *
 * The gate does not compare meanings. It has no notion of two memories being
 * about the same topic, it never decides on its own that one memory updates
 * another, and it does not infer anything from the text beyond the shapes
 * listed above. It accepts a claim; it does not form one.
 */

import { detectCredential, credentialExplanation, credentialPlaceholder } from './credentials.js';
import { findDuplicate, getMemory, PURGED_REPLACEMENT_REASON, recordDecision } from './store.js';
import { controlCharacterIn, isBlank, namedCodePoint } from './text.js';

/**
 * Rule 2, which both entry points that take free text apply.
 *
 * The excerpt is a placeholder rather than the text, for two reasons that
 * point the same way. The text cannot be quoted: written to the log it would
 * be cut off at the character exactly as it was cut off in the memory, so the
 * row would not say what was offered either. And it may be a secret with an
 * invisible character dropped into the middle of it to break its shape, which
 * is the other half of why this rule exists — quoting it would put in the log
 * precisely what rule 1 exists to keep out.
 *
 * @param {string} owner
 * @param {string} text
 * @returns {import('./store.js').DecisionPlan|null}
 */
function refuseControlCharacter(owner, text) {
  const found = controlCharacterIn(text);
  if (found === null) return null;

  return {
    owner,
    verdict: 'refused',
    rule: 'control-character',
    explanation:
      `That text contains ${namedCodePoint(found)}, which is not something text is made of, ` +
      'so nothing was stored and the text was not written down either. A character like that ' +
      'does not read back the way it was written, and it can hide a secret from the check that ' +
      'looks for one. Send it again without it.',
    input_excerpt: '[not recorded: contains a character that is not text]',
  };
}

/** Longest excerpt of the offered text kept on a decision row. */
const EXCERPT_LIMIT = 160;

/**
 * Cut the offered text down to what a decision row is allowed to keep.
 *
 * Counted in characters, not in the sixteen bit pieces JavaScript stores them
 * in. `"…".length` lies about anything outside the first sixty five thousand
 * code points, which is most of the world's writing and every emoji, and
 * cutting by that count can slice a single character in half and leave an
 * unpaired surrogate in the log. This counts the same way
 * `credentialPlaceholder` does.
 *
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  const flattened = text.replace(/\s+/gu, ' ').trim();
  const characters = [...flattened];
  if (characters.length <= EXCERPT_LIMIT) return flattened;
  return characters.slice(0, EXCERPT_LIMIT - 1).join('') + '…';
}

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
    input_excerpt: credentialPlaceholder(credential),
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
          input_excerpt: credentialPlaceholder(credential),
        };
      }

      // 2. control-character. After the credential check, so plain secrets are
      // still named as secrets, and before everything else, because nothing
      // below this can reason about text that will not read back whole.
      const unreadable = refuseControlCharacter(owner, text);
      if (unreadable) return unreadable;

      // 3. empty.
      if (isBlank(text)) {
        return {
          owner,
          verdict: 'refused',
          rule: 'empty',
          explanation: 'There was nothing to store. The text was empty or only spaces.',
          input_excerpt: '',
        };
      }

      // 4. already-stored. Read here, inside the lock, so that two identical
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

      // 5. replaces-unknown. The default read is active only, which is exactly
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

      // 6. replaces.
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

      // 7. keep.
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
 * Screen a search before it runs, and write down anything refused.
 *
 * A search is not a decision about a memory and this does not pretend it is:
 * it changes nothing, and on a clean query it writes nothing at all. What it
 * does is close an asymmetry that was hard to defend. The same key offered to
 * `remember` left a row and offered to `recall` left none, so `why` — the one
 * place a person can look to see what their agents have been doing — showed
 * one and not the other, and which door was used is the least interesting
 * thing about an agent offering a secret.
 *
 * It reuses rule 1 rather than adding a name. It is the same judgement about
 * the same kind of text, and the vocabulary stays at twelve.
 *
 * The query itself is never written down, exactly as in `submit`.
 *
 * @param {Store} store
 * @param {object} request
 * @param {string} request.owner
 * @param {string} request.query
 * @returns {GateResult|null} a refusal to hand back, or null to go ahead
 */
export function screenQuery(store, { owner, query }) {
  if (detectCredential(owner) === null && detectCredential(query) === null) return null;

  return asResult(
    recordDecision(store, () => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      const credential = /** @type {import('./credentials.js').CredentialMatch} */ (
        detectCredential(query)
      );

      return {
        owner,
        verdict: 'refused',
        rule: 'credential',
        explanation: `${credentialExplanation(credential)} Nothing was searched for either.`,
        input_excerpt: credentialPlaceholder(credential),
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
          input_excerpt: credentialPlaceholder(credential),
        };
      }

      // 2. control-character. The reason is written to the row as well as to
      // the log, so it can be cut in half by a NUL exactly as a memory can —
      // and a reason that reads back as blank is a memory put away for no
      // stated reason. The adapter's own blank check was walked past this way.
      const unreadable = refuseControlCharacter(owner, reason);
      if (unreadable) return unreadable;

      // 3. empty. The same rule as an empty memory and the same name, because
      // it is the same judgement: there was nothing there.
      //
      // It was in the adapter, where it refused without writing anything down
      // — so a memory put away for no stated reason and a refusal to put one
      // away left the same trace, which is none. Here it leaves its row like
      // every other decision, and the terminal gets it too rather than having
      // its own copy of the check.
      if (isBlank(reason)) {
        return {
          owner,
          verdict: 'refused',
          rule: 'empty',
          explanation:
            'No reason was given, so nothing was changed. A memory put away without a ' +
            'reason is one nobody can judge later. Say why it should stop being shown.',
          input_excerpt: '',
        };
      }

      // Archived rows included, because forgetting is about the row rather
      // than about what is on show.
      const memory = getMemory(store, owner, id, { includeArchived: true });

      // 9. forget-unknown.
      if (memory === null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'forget-unknown',
          explanation: `There is no memory ${id} belonging to you, so nothing was changed.`,
          input_excerpt: excerpt(reason),
        };
      }

      // 8. forget. Asking again for something already put away simply puts it
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

      // A memory whose replacement was purged has no pointer left to say so:
      // the purge cleared it. What it has instead is the sentence the purge
      // wrote in its place, and that sentence is the only way left to know.
      // Without this, restoring such a memory said only that it was being
      // shown again, and left the person to work out on their own that the
      // memory which had replaced it no longer exists.
      const replacementWasPurged = memory.state_reason === PURGED_REPLACEMENT_REASON;

      // state_reason is cleared, because it says why this memory is put away
      // and it is not put away any more. Leaving it left an active memory
      // carrying "not interested any more", which is simply not true of a
      // memory being shown.
      //
      // It used to be kept, on the grounds that the row was the only place
      // anyone could read that sentence. That was wrong: `forget` writes the
      // reason to the decision log, the log holds every call ever made, and
      // nothing shortens it. So the sentence is still there to be read, under
      // the date it was given, along with every other reason this memory was
      // ever put away. The row keeps the current state of things; the log
      // keeps the history.
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
        explanation: restoreExplanation(id, replacedBy, replacementWasPurged),
        input_excerpt: '',
        memory_id: id,
        related_memory_id: replacedBy,
      };
    }),
  );
}

/**
 * What to tell somebody who has just brought a memory back.
 *
 * Three situations, and the difference between them is worth a sentence each.
 * The memory that replaced this one may still be there, in which case it has
 * just stopped claiming to have replaced it. It may have been purged, in which
 * case there is nothing to name and the person should be told that rather than
 * left to notice. Or there was never a replacement at all.
 *
 * @param {number} id
 * @param {number|null} replacedBy the memory that replaced it, if it is still there
 * @param {boolean} replacementWasPurged whether the memory that replaced it has been purged
 * @returns {string}
 */
function restoreExplanation(id, replacedBy, replacementWasPurged) {
  if (replacedBy !== null) {
    return (
      `Memory ${id} is being shown again, and memory ${replacedBy} no longer claims to ` +
      'have replaced it.'
    );
  }

  if (replacementWasPurged) {
    return (
      `Memory ${id} is being shown again. The memory that had replaced it was purged, so ` +
      'there is nothing left claiming to have replaced it.'
    );
  }

  return `Memory ${id} is being shown again.`;
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
