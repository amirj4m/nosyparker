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
 * submit path.
 *
 * The gate does not compare meanings. It has no notion of two memories being
 * about the same topic, it never decides on its own that one memory updates
 * another, and it does not infer anything from the text beyond the shapes
 * listed above. It accepts a claim; it does not form one.
 */

import { detectCredential, credentialExplanation, credentialPlaceholder } from './credentials.js';
import { excerpt, getMemory, listMemories, recordDecision } from './store.js';
import { isBlank, normaliseForComparison } from './text.js';

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
    recordDecision(store, (db, at) => {
      // 1. credential. This runs before anything else touches the text, and it
      // is the only branch that replaces the excerpt with a placeholder.
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

      // 4. replaces-unknown.
      const target = replaces === null ? null : getMemory(store, owner, replaces);
      if (replaces !== null && (target === null || target.state !== 'active')) {
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
        const newId = insertMemory(db, { owner, text, at, supersedes: target.id });
        db.prepare(
          `UPDATE memories
              SET state = 'superseded',
                  state_reason = ?,
                  state_at = ?,
                  superseded_by = ?
            WHERE id = ? AND owner = ?`,
        ).run(`Replaced by memory ${newId}`, at, newId, target.id, owner);

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
        memory_id: insertMemory(db, { owner, text, at, supersedes: null }),
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
    recordDecision(store, (db, at) => {
      const memory = getMemory(store, owner, id);

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

      // 7. forget.
      db.prepare(
        `UPDATE memories
            SET state = 'forgotten', state_reason = ?, state_at = ?
          WHERE id = ? AND owner = ?`,
      ).run(reason, at, id, owner);

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
    recordDecision(store, (db, at) => {
      const memory = getMemory(store, owner, id);

      if (memory === null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'restore-unknown',
          explanation: `There is no memory ${id} belonging to you, so nothing was changed.`,
          input_excerpt: '',
        };
      }

      const replacedBy = memory.superseded_by;

      db.prepare(
        `UPDATE memories
            SET state = 'active', state_reason = NULL, state_at = ?, superseded_by = NULL
          WHERE id = ? AND owner = ?`,
      ).run(at, id, owner);

      if (replacedBy !== null) {
        // The other side of the pointer, so neither row is left claiming
        // something the other one contradicts.
        db.prepare(
          `UPDATE memories
              SET supersedes = NULL
            WHERE id = ? AND owner = ? AND supersedes = ?`,
        ).run(replacedBy, owner, id);
      }

      return {
        owner,
        verdict: 'restored',
        rule: 'restore',
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
 * The active memory that says exactly the same thing, if there is one.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {string} text
 * @returns {Memory|null}
 */
function findDuplicate(store, owner, text) {
  const wanted = normaliseForComparison(text);
  for (const memory of listMemories(store, owner)) {
    if (normaliseForComparison(memory.text) === wanted) return memory;
  }
  return null;
}

/**
 * @param {DatabaseSync} db
 * @param {{owner: string, text: string, at: string, supersedes: number|null}} row
 * @returns {number}
 */
function insertMemory(db, { owner, text, at, supersedes }) {
  const written = db
    .prepare(
      `INSERT INTO memories (owner, text, created_at, state, state_reason, state_at, supersedes)
       VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
    )
    .run(owner, text, at, at, supersedes);
  return Number(written.lastInsertRowid);
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
