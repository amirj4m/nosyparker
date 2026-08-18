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
 *   1. file-not-fact     too long, refused before anything else reads it
 *   2. credential        refused, and the text is not written down anywhere
 *   3. control-character refused, and the text is not written down either
 *   4. empty             refused
 *   5. file-not-fact     too repetitive, refused as a document rather than a fact
 *   6. already-stored    refused
 *   7. replaces-unknown  refused, so a wrong id cannot retire the wrong memory
 *   8. replaces          stored, and the named memory is superseded
 *   9. keep              stored
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
 * `file-not-fact` appears twice on purpose. It is one judgement — this is a
 * document, not a fact — reached two ways, by length and by repetition, so it
 * is one name rather than two. The same reuse the blank-reason check made of
 * `empty`, and the vocabulary stays at twelve.
 *
 * Length is first because it is the only check that costs nothing, and because
 * it bounds what every check after it reads. Before this it was enforced at
 * the two entry points instead, which meant `submit` called as a library
 * function was bounded by neither, and it meant the credential patterns ran
 * over inputs of any size. Both are closed by moving it here. This is the
 * third time a bound has been put at the entrances and a new entrance has
 * appeared behind it; the gate is the one place everything passes through.
 *
 * It does not quote the text it refuses. The first hundred and sixty
 * characters of a very long paste can be a secret as easily as anything else,
 * and there is no reading of a document that is safe to put in the log.
 *
 * Rule 5 is the twelfth name, and it is the one rule here that is about what
 * this product is rather than about what is safe to store. Somebody pastes a
 * server log and says "watch out, this happens sometimes". The thing worth
 * keeping is the sentence about the pattern, not the file — and the agent that
 * read the log is the party able to work out which sentence that is. So the
 * gate stays dumb, refuses the file, and says what to send instead. It is
 * measured by how much the text repeats itself, which is how a file pretending
 * to be a fact gives itself away, but the judgement is the product's and not a
 * safety limit.
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
 *
 * ## The review
 *
 * `beginReview`, `review`, `closeReview` and `undoReview` are the four doors an
 * agent walking the store uses. They are doors, not a process: nothing here
 * starts a review, schedules one, or decides that one is due. An agent decides
 * that, an agent reads the memories, and an agent reaches every conclusion. The
 * structure and the rules are ours and the judgement is entirely its.
 *
 * **What a review is forbidden to conclude**, said as a list rather than left
 * to be inferred from what happens not to be implemented:
 *
 *   - It may not forget anything. `forget` is the person saying they do not
 *     want something shown, and an agent reaching that verdict on their behalf
 *     is the thing this project exists not to do. There is no path from here to
 *     `putAway`.
 *   - It may not delete anything, which is true of every door in this file.
 *   - It may mark a memory superseded by another memory that is already stored,
 *     and it may mark one overtaken. Those are the only two changes it can make.
 *   - It may not act on ambiguity. `could-not-tell` is a first-class outcome
 *     that changes nothing and is written down with its reasoning, and it is
 *     the right answer whenever the agent is unsure. Forced to choose between
 *     two readings, an unresolvable contradiction falls whichever way the code
 *     happens to fall, and the code has no business deciding that.
 *
 * **No rule here reads a clock.** Nothing in this file, or anywhere under
 * `src/`, compares a timestamp against the current time and concludes
 * something. A memory carries `created_at` and a review is shown it; whether a
 * statement that named a moment has had that moment go by is a reading of the
 * statement, which is why the agent does it and this does not. A memory with no
 * moment in it is never stale, however old the row. The whole of the reasoning,
 * and the project this rule exists because of: DECISIONS.md, "Time as evidence,
 * never as a rule".
 *
 * **Every finding says what it was derived from**, and that is a field, checked
 * against the store inside the transaction that writes it. Not a convention: a
 * sentence claiming "based on memory 12" is a sentence, and nothing can check
 * a sentence. Without the field this door is a way to launder a refusal —
 * anything the other doors turn away could come back through here as a review's
 * own conclusion, with no record of where it came from. The reasoning goes
 * through rules 1 to 4 exactly as an offered memory does, for the same reason.
 *
 * The vocabulary opens by eight, all of them here:
 *
 *   review-began     a review was started
 *   review-closed    it was closed and will take no more findings
 *   review-undone    everything it changed was put back
 *   review-not-open  refused, because that review is closed, undone or not there
 *   review-unknown   refused, because the memory being judged is not there
 *   derived-from     refused, because the derivation record is not usable
 *   overtaken        the memory was found no longer current, nothing replaces it
 *   undecided        the reviewer could not tell, and nothing was changed
 *
 * `replaces` and `replaces-unknown` are reused rather than doubled. Marking one
 * stored memory as replaced by another is the same judgement `submit` makes
 * with `replaces`, reached at a different door, and `replaces-unknown` covers
 * every way the replacement id is unusable — not there, not active, or the
 * memory itself.
 */

import { detectCredential, credentialExplanation, credentialPlaceholder } from './credentials.js';
import {
  decisionsInPass,
  findDuplicate,
  getMemory,
  getPass,
  PURGED_REPLACEMENT_REASON,
  recordDecision,
  REPETITION_LIMIT,
  repetitionOf,
  TEXT_LIMIT,
  unknownMemories,
} from './store.js';
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
 * @property {'stored'|'superseded'|'forgotten'|'restored'|'refused'|'overtaken'|'undecided'|'began'|'closed'|'undone'} verdict
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

      // 1. file-not-fact, by length. First because it is free, and because
      // everything below it reads the text: the credential patterns would
      // otherwise run over an input of any size at all.
      if (text.length > TEXT_LIMIT) {
        return {
          owner,
          verdict: 'refused',
          rule: 'file-not-fact',
          explanation:
            `Nothing was stored. That is ${text.length.toLocaleString('en')} characters, and a ` +
            `memory is one thing about you, in a sentence — the limit is ` +
            `${TEXT_LIMIT.toLocaleString('en')}. nosyparker keeps facts, not documents. If you ` +
            'have a file, keep it in a file and store what matters about it instead: what it ' +
            'is, where it came from, what it means.',
          input_excerpt: '[not recorded: longer than this store takes]',
        };
      }

      // 2. credential, on the text. This runs before anything else reads it,
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

      // 3. control-character. After the credential check, so plain secrets are
      // still named as secrets, and before everything else, because nothing
      // below this can reason about text that will not read back whole.
      const unreadable = refuseControlCharacter(owner, text);
      if (unreadable) return unreadable;

      // 4. empty.
      if (isBlank(text)) {
        return {
          owner,
          verdict: 'refused',
          rule: 'empty',
          explanation: 'There was nothing to store. The text was empty or only spaces.',
          input_excerpt: '',
        };
      }

      // 5. file-not-fact, by repetition. Before the duplicate check, so somebody re-pasting
      // the same log meets the same answer each time rather than a different
      // one, and so the expensive question is asked of text still under
      // consideration.
      const repetition = repetitionOf(store, text);
      if (repetition > REPETITION_LIMIT) {
        return {
          owner,
          verdict: 'refused',
          rule: 'file-not-fact',
          explanation:
            'Nothing was stored, because that reads as a file rather than something to ' +
            'remember. There is very little variety in it: either the same few characters ' +
            'over and over, the way a log or an export or a dump looks, or a long stretch ' +
            'built from a very small set of characters, the way a sequence or an encoding ' +
            'does. nosyparker keeps facts, not documents — one thing about you or your ' +
            'work, in a sentence, so an agent can find it later. If something in that text ' +
            'is worth keeping, store that instead: what it is, where it came from, what it ' +
            'means. Read it, decide what matters, and send that one sentence. Sending the ' +
            'same text again will get the same answer.',
          input_excerpt: excerpt(text),
        };
      }

      // 6. already-stored. Read here, inside the lock, so that two identical
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

      // 7. replaces-unknown. The default read is active only, which is exactly
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

      // 8. replaces.
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

      // 9. keep.
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
 * the same kind of text, so the vocabulary is not opened for it.
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

      // Rules 1 to 4, on the reason. A reason is free text from a caller like
      // any other and is written to the row as well as to the log, so it is
      // guarded the way the memory itself is: length first because it is free
      // and bounds what the rest read, then credentials before anything else
      // touches the text, then a character that will not read back whole — a
      // reason cut in half by a NUL is a memory put away for no stated reason,
      // which is how the adapter's own blank check was walked past — then
      // empty, which is the same name as an empty memory because it is the
      // same judgement.
      //
      // They are {@link screenFreeText} rather than four blocks here. This
      // project's recurring defect is one door screening text and another not,
      // and the review added two more doors with the same three checks to make.
      const bad = screenFreeText(owner, reason, {
        what: 'reason',
        tooLong:
          'A reason is a sentence somebody reads later to understand why a memory was put ' +
          'away, not a document.',
        empty:
          'No reason was given, so nothing was changed. A memory put away without a ' +
          'reason is one nobody can judge later. Say why it should stop being shown.',
      });
      if (bad) return bad;

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
 * Rules 1 to 4, applied to a piece of free text that is not the memory itself.
 *
 * The reviewer's name and its reasoning are both free text from a caller and
 * both are written to a row, so both are screened the way a reason for
 * forgetting is. Gathered here rather than written out three more times: the
 * last time this project let a door do its own screening, a NUL walked past a
 * check that lived in an adapter.
 *
 * The repetition rule is deliberately not among them, exactly as it is not
 * applied to a reason for forgetting. That one is a judgement about whether
 * something is a fact or a file, and neither of these is offered as a fact.
 *
 * @param {string} owner
 * @param {string} text
 * @param {object} words
 * @param {string} words.what what this text is, for the sentence
 * @param {string} words.tooLong what a person should do about it being long
 * @param {string} words.empty the whole sentence for an empty one
 * @returns {import('./store.js').DecisionPlan|null}
 */
function screenFreeText(owner, text, words) {
  if (text.length > TEXT_LIMIT) {
    return {
      owner,
      verdict: 'refused',
      rule: 'file-not-fact',
      explanation:
        `Nothing was changed. That ${words.what} is ${text.length.toLocaleString('en')} ` +
        `characters and the limit is ${TEXT_LIMIT.toLocaleString('en')}. ${words.tooLong}`,
      input_excerpt: '[not recorded: longer than this store takes]',
    };
  }

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

  const unreadable = refuseControlCharacter(owner, text);
  if (unreadable) return unreadable;

  if (isBlank(text)) {
    return {
      owner,
      verdict: 'refused',
      rule: 'empty',
      explanation: words.empty,
      input_excerpt: '',
    };
  }

  return null;
}

/**
 * Start a review, and say which agent is doing it.
 *
 * Nothing is reviewed here. This opens a pass and hands back its id; every
 * finding names it, and undoing the pass undoes all of them together. A review
 * that is never closed is not an error and nothing tidies it away, but `doctor`
 * will say it is there.
 *
 * @param {Store} store
 * @param {object} request
 * @param {string} request.owner
 * @param {string} request.reviewer which agent this is, in its own words
 * @returns {GateResult & {pass_id: number|null}}
 */
export function beginReview(store, { owner, reviewer }) {
  return withPass(
    recordDecision(store, (actions, at) => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      const bad = screenFreeText(owner, reviewer, {
        what: 'name',
        tooLong: 'A reviewer is a name, not a document.',
        empty:
          'No review was started, because nothing said which agent was doing it. A review ' +
          'that changes memories has to be attributable to something. Say what you are.',
      });
      if (bad) return bad;

      const pass = actions.openPass({ owner, reviewer, at });

      return {
        owner,
        verdict: 'began',
        rule: 'review-began',
        explanation:
          `Review ${pass} is open. Every finding has to name it, and undoing it puts back ` +
          'everything it changed.',
        input_excerpt: excerpt(reviewer),
        pass_id: pass,
      };
    }),
  );
}

/**
 * The pass this decision belongs to, or is about, if there is one. Named
 * rather than inferred, because the pass is what a caller needs back from
 * `beginReview` and has no other way to learn.
 *
 * @param {ReturnType<typeof recordDecision>} written
 * @returns {GateResult & {pass_id: number|null}}
 */
function withPass(written) {
  return { ...asResult(written), pass_id: written.plan.pass_id ?? null };
}

/**
 * Read a pass and say whether it will take a finding.
 *
 * Read inside the transaction that writes the finding, like every other rule
 * here, so a review closed by one agent cannot take a finding from another that
 * read it a moment earlier.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {number} pass
 * @returns {string|null} what is wrong with it, or null if it is open
 */
function whyNotOpen(store, owner, pass) {
  const found = getPass(store, owner, pass);
  if (found === null) return `There is no review ${pass} belonging to you`;
  if (found.undone_at !== null) return `Review ${pass} was undone on ${found.undone_at}`;
  if (found.closed_at !== null) return `Review ${pass} was closed on ${found.closed_at}`;
  return null;
}

/**
 * What a review found about one memory.
 *
 * Three outcomes and no fourth. `overtaken` and `superseded` change a memory;
 * `could-not-tell` changes nothing and is written down anyway, which is the
 * whole of its value.
 *
 * @param {Store} store
 * @param {object} finding
 * @param {string} finding.owner
 * @param {number} finding.pass
 * @param {number} finding.id the memory being judged
 * @param {'overtaken'|'superseded'|'could-not-tell'} finding.outcome
 * @param {string} finding.reasoning why, in the reviewer's own words
 * @param {number[]} finding.derivedFrom the memories it read to get there
 * @param {number|null} [finding.replacedBy] the memory that replaces it, for `superseded`
 * @returns {GateResult}
 */
export function review(store, { owner, pass, id, outcome, reasoning, derivedFrom, replacedBy = null }) {
  if (outcome !== 'overtaken' && outcome !== 'superseded' && outcome !== 'could-not-tell') {
    // Not a judgement about a memory, so not a rule and not a row: it is a
    // caller that has not read the schema, and the shape of a call is the
    // adapter's business exactly as a non-numeric id is.
    throw new TypeError(
      `A review outcome is "overtaken", "superseded" or "could-not-tell", and this call ` +
        `gave "${outcome}". Nothing was done.`,
    );
  }

  return asResult(
    recordDecision(store, (actions, at) => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      const bad = screenFreeText(owner, reasoning, {
        what: 'reasoning',
        tooLong:
          'Reasoning is the sentence somebody reads later to judge whether you thought ' +
          'correctly, not a document.',
        empty:
          'Nothing was changed, because no reasoning was given. A review that says what it ' +
          'concluded and not why is one nobody can check afterwards, which is the only ' +
          'reason this door exists.',
      });
      if (bad) return bad;

      const shut = whyNotOpen(store, owner, pass);
      if (shut !== null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'review-not-open',
          explanation: `${shut}, so nothing was changed. Start one with beginReview.`,
          input_excerpt: excerpt(reasoning),
        };
      }

      // The derivation record, checked rather than believed. Empty and wrong
      // are one judgement here — either way there is no usable record of what
      // this conclusion was reached from — so they share a rule and differ in
      // the sentence.
      const derived = [...new Set(derivedFrom)];
      if (derived.length === 0) {
        return {
          owner,
          verdict: 'refused',
          rule: 'derived-from',
          explanation:
            'Nothing was changed, because the finding does not say which memories it was ' +
            'reached from. Name them, including the one being judged. A conclusion nothing ' +
            'was read to reach is not a review finding.',
          input_excerpt: excerpt(reasoning),
          pass_id: pass,
          reasoning,
        };
      }

      const missing = unknownMemories(store, owner, derived);
      if (missing.length > 0) {
        return {
          owner,
          verdict: 'refused',
          rule: 'derived-from',
          explanation:
            `Nothing was changed. ${missing.length === 1 ? 'Memory' : 'Memories'} ` +
            `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not ` +
            `${missing.length === 1 ? 'a memory' : 'memories'} of yours, so the finding ` +
            'names something it cannot have read. Check the ids.',
          input_excerpt: excerpt(reasoning),
          pass_id: pass,
          reasoning,
        };
      }

      // Active only. A memory already put away, already replaced or already
      // left behind is not one a review has anything to change about, and
      // judging it again would move a state somebody else set.
      const memory = getMemory(store, owner, id);
      if (memory === null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'review-unknown',
          explanation:
            `Nothing was changed, because memory ${id} is not one of your active memories. ` +
            'It may have been forgotten, replaced or already reviewed. Read the list again.',
          input_excerpt: excerpt(reasoning),
          pass_id: pass,
          reasoning,
          derived_from: derived.join(' '),
        };
      }

      /** @type {Omit<import('./store.js').DecisionPlan, 'verdict'|'rule'|'explanation'>} */
      const common = {
        owner,
        input_excerpt: excerpt(reasoning),
        pass_id: pass,
        reasoning,
        derived_from: derived.join(' '),
      };

      if (outcome === 'could-not-tell') {
        return {
          ...common,
          verdict: 'undecided',
          rule: 'undecided',
          explanation:
            `Nothing was changed. Memory ${id} was read and the reviewer could not tell, ` +
            'and that is written down here rather than resolved. It stays exactly as it was.',
          memory_id: id,
        };
      }

      if (outcome === 'overtaken') {
        actions.leaveBehind({ owner, id, at, reason: reasoning });

        return {
          ...common,
          verdict: 'overtaken',
          rule: 'overtaken',
          explanation:
            `Memory ${id} will not be shown any more, because a review found it is no longer ` +
            'current and there is nothing to put in its place. It is still in the file and ' +
            'can be brought back with restore, or by undoing this review.',
          memory_id: id,
        };
      }

      const replacement = replacedBy === null ? null : getMemory(store, owner, replacedBy);
      if (replacement === null || replacement.id === id) {
        return {
          owner,
          verdict: 'refused',
          rule: 'replaces-unknown',
          explanation:
            replacedBy === id
              ? `Nothing was changed. Memory ${id} cannot replace itself.`
              : `Nothing was changed, because memory ${replacedBy} is not one of your active ` +
                'memories, so it cannot be the thing that replaces this one. Check the id.',
          input_excerpt: excerpt(reasoning),
          pass_id: pass,
          reasoning,
          derived_from: derived.join(' '),
          memory_id: id,
        };
      }

      actions.retire({ owner, id, at, supersededBy: replacement.id });
      actions.claimSupersedes({ owner, id: replacement.id, nowSupersedes: id });

      // memory_id is the memory that stands and related_memory_id the one
      // retired, which is the way round `submit` writes a `replaces` row. One
      // rule, one shape, whichever door it came through.
      return {
        ...common,
        verdict: 'superseded',
        rule: 'replaces',
        explanation:
          `Memory ${id} was retired in favour of memory ${replacement.id}, which a review ` +
          'found says the same thing more recently. The old one is still in the file and can ' +
          'be brought back.',
        memory_id: replacement.id,
        related_memory_id: id,
      };
    }),
  );
}

/**
 * Close a review. It takes no more findings afterwards.
 *
 * This is not bookkeeping. The previous project had a `finish()` that nothing
 * ever called, so every review it ever ran was still open, and a review that is
 * never closed is one that can be added to forever by anything holding its id.
 * Closing has teeth here — a finding offered to a closed pass is refused, and
 * there is a test that offers one — and undoing still works afterwards, because
 * deciding a review was wrong usually happens after reading what it did.
 *
 * @param {Store} store
 * @param {object} request
 * @param {string} request.owner
 * @param {number} request.pass
 * @returns {GateResult}
 */
export function closeReview(store, { owner, pass }) {
  return asResult(
    recordDecision(store, (actions, at) => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      const shut = whyNotOpen(store, owner, pass);
      if (shut !== null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'review-not-open',
          explanation: `${shut}, so there was nothing to close.`,
          input_excerpt: '',
        };
      }

      actions.shutPass({ owner, pass, at });

      const findings = decisionsInPass(store, owner, pass);
      const changed = findings.filter(
        (row) => row.rule === 'overtaken' || row.rule === 'replaces',
      ).length;
      const undecided = findings.filter((row) => row.rule === 'undecided').length;

      return {
        owner,
        verdict: 'closed',
        rule: 'review-closed',
        explanation:
          `Review ${pass} is closed and will take no more findings. It changed ${changed} ` +
          `${changed === 1 ? 'memory' : 'memories'} and left ${undecided} undecided. ` +
          'Undoing it puts back everything it changed.',
        input_excerpt: '',
        pass_id: pass,
      };
    }),
  );
}

/**
 * Put back everything one review changed.
 *
 * One decision, one row, one transaction. Reversing each finding as its own
 * decision would read better in the log and would be wrong: an undo that fails
 * halfway leaves a store in a state no agent chose and no row explains. So the
 * whole review comes back or none of it does, and the explanation names every
 * memory either way.
 *
 * Findings are walked newest first, which matters when a review touched the
 * same memory twice — the later change has to come off before the earlier one
 * is looked at.
 *
 * A memory that is not in the state this review left it in is left exactly
 * alone and named as left alone. Something else has happened to it since: the
 * person may have restored it themselves, or a later review or a newer memory
 * may have moved it on. Putting it back would be this undo overwriting somebody
 * else's decision, which is the one thing an undo must never do.
 *
 * @param {Store} store
 * @param {object} request
 * @param {string} request.owner
 * @param {number} request.pass
 * @returns {GateResult}
 */
export function undoReview(store, { owner, pass }) {
  return asResult(
    recordDecision(store, (actions, at) => {
      const badOwner = refuseCredentialOwner(owner);
      if (badOwner) return badOwner;

      const found = getPass(store, owner, pass);
      if (found === null || found.undone_at !== null) {
        return {
          owner,
          verdict: 'refused',
          rule: 'review-not-open',
          explanation:
            found === null
              ? `There is no review ${pass} belonging to you, so nothing was changed.`
              : `Review ${pass} was already undone on ${found.undone_at}, so nothing was ` +
                'changed. Undoing it twice would put back states that something else has ' +
                'set since.',
          input_excerpt: '',
        };
      }

      /** @type {number[]} */
      const back = [];
      /** @type {string[]} */
      const alone = [];

      for (const row of decisionsInPass(store, owner, pass)) {
        if (row.rule === 'overtaken') {
          const id = /** @type {number} */ (row.memory_id);
          const memory = getMemory(store, owner, id, { includeArchived: true });
          if (memory?.state === 'overtaken') {
            actions.bringBack({ owner, id, at, wasInState: 'overtaken', wasSupersededBy: null });
            back.push(id);
          } else {
            alone.push(`memory ${id} is ${memory?.state ?? 'gone'} now, not overtaken`);
          }
          continue;
        }

        if (row.rule === 'replaces') {
          const retired = /** @type {number} */ (row.related_memory_id);
          const stands = /** @type {number} */ (row.memory_id);
          const memory = getMemory(store, owner, retired, { includeArchived: true });

          if (memory?.state === 'superseded' && memory.superseded_by === stands) {
            actions.bringBack({
              owner,
              id: retired,
              at,
              wasInState: 'superseded',
              wasSupersededBy: stands,
            });
            actions.unlinkSupersedes({ owner, id: stands, noLongerSupersedes: retired });
            back.push(retired);
          } else {
            alone.push(
              `memory ${retired} is no longer the one memory ${stands} replaced`,
            );
          }
        }

        // `undecided` changed nothing, so there is nothing to put back, and the
        // three lifecycle rows are not findings at all.
      }

      actions.abandonPass({ owner, pass, at });

      return {
        owner,
        verdict: 'undone',
        rule: 'review-undone',
        explanation: undoExplanation(pass, back, alone),
        input_excerpt: '',
        pass_id: pass,
      };
    }),
  );
}

/**
 * @param {number} pass
 * @param {number[]} back
 * @param {string[]} alone
 * @returns {string}
 */
function undoExplanation(pass, back, alone) {
  const parts = [
    back.length === 0
      ? `Review ${pass} is undone. It had changed nothing, so nothing was put back.`
      : `Review ${pass} is undone. ${back.length === 1 ? 'Memory' : 'Memories'} ` +
        `${back.join(', ')} ${back.length === 1 ? 'is' : 'are'} being shown again.`,
  ];

  if (alone.length > 0) {
    parts.push(
      `${alone.length} of its changes ${alone.length === 1 ? 'was' : 'were'} left alone, ` +
        `because something else has happened since: ${alone.join('; ')}.`,
    );
  }

  return parts.join(' ');
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
