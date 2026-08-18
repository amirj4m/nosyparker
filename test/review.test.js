/**
 * The storage a review needs: a fourth resting state, a link between two
 * memories that already exist, and a pass to hang both off.
 *
 * Nothing here goes through the gate. That is the next file up; this one is
 * about what the store will and will not let a decision do, because every rule
 * the gate applies is only worth what the layer underneath it enforces.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  beginReview,
  closeReview,
  forget,
  restore,
  review,
  undoReview,
} from '../src/gate.js';
import {
  decisionsInPass,
  getMemory,
  getPass,
  listDecisions,
  listMemories,
  openPasses,
  OVERTAKEN,
  recordDecision,
  searchMemories,
  unknownMemories,
} from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';
import { onTheMemoryPath, ROOT } from './import-graph.js';

/**
 * Store one memory, the short way, so a test about states is not three quarters
 * setup.
 *
 * @param {import('../src/store.js').Store} store
 * @param {string} text
 * @returns {number}
 */
function store1(store, text) {
  const written = recordDecision(store, (actions, at) => ({
    owner: OWNER,
    verdict: 'stored',
    rule: 'keep',
    explanation: 'Stored.',
    input_excerpt: text,
    memory_id: actions.insertMemory({ owner: OWNER, text, at, supersedes: null }),
  }));
  return /** @type {number} */ (written.memory_id);
}

test('a memory can be left behind, and it is not forgotten and not superseded', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');

  recordDecision(store, (actions, at) => {
    actions.leaveBehind({ owner: OWNER, id, at, reason: 'The month it named has been and gone.' });
    return {
      owner: OWNER,
      verdict: OVERTAKEN,
      rule: 'overtaken',
      explanation: 'Left behind.',
      input_excerpt: '',
      memory_id: id,
    };
  });

  const memory = /** @type {import('../src/store.js').Memory} */ (
    getMemory(store, OWNER, id, { includeArchived: true })
  );

  assert.equal(memory.state, 'overtaken');
  assert.equal(memory.state_reason, 'The month it named has been and gone.');

  // The distinction the state exists for: nothing replaced it.
  assert.equal(memory.superseded_by, null);
});

test('an overtaken memory leaves every reader that shows active memories', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  recordDecision(store, (actions, at) => {
    actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
    return { owner: OWNER, verdict: OVERTAKEN, rule: 'overtaken', explanation: '.', input_excerpt: '' };
  });

  // The four filters, all of which say `state = 'active'` and none of which
  // name the states that are not. This is the assertion behind the claim that a
  // fourth state cost the readers nothing.
  assert.deepEqual(listMemories(store, OWNER), []);
  assert.deepEqual(searchMemories(store, OWNER, 'Berlin'), []);
  assert.equal(getMemory(store, OWNER, id), null);
  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.id, id);

  // And the substring path, which is a different query from the trigram one.
  assert.deepEqual(searchMemories(store, OWNER, 'am'), []);
});

test('restore brings an overtaken memory back with no code of its own', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  recordDecision(store, (actions, at) => {
    actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
    return { owner: OWNER, verdict: OVERTAKEN, rule: 'overtaken', explanation: '.', input_excerpt: '' };
  });

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.bringBack({ owner: OWNER, id, at, wasInState: 'overtaken', wasSupersededBy: null });
    return { owner: OWNER, verdict: 'restored', rule: 'restored', explanation: '.', input_excerpt: '' };
  });

  const memory = /** @type {import('../src/store.js').Memory} */ (getMemory(store, OWNER, id));
  assert.equal(memory.state, 'active');
  assert.equal(memory.state_reason, null);
});

test('only an active memory can be left behind', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  recordDecision(store, (actions, at) => {
    actions.putAway({ owner: OWNER, id, at, reason: 'no', wasInState: 'active' });
    return { owner: OWNER, verdict: 'forgotten', rule: 'forget', explanation: '.', input_excerpt: '' };
  });

  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
        return { owner: OWNER, verdict: OVERTAKEN, rule: 'overtaken', explanation: '.', input_excerpt: '' };
      }),
    /changed underneath this decision/u,
  );

  // The refusal rolled the whole thing back, so the memory is as it was and
  // there is no half-written row saying otherwise.
  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.state, 'forgotten');
});

test('the file itself refuses a state this code does not know, and accepts the four it does', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');

  // Asked of the file rather than through an action, because no action can
  // write a fifth state and that is exactly why this has to be asked another
  // way. The CHECK is the backstop underneath the four, and a backstop nothing
  // exercises is a backstop nobody knows the shape of.
  const direct = new DatabaseSync(store.file);
  t.after(() => direct.close());

  for (const state of ['active', 'superseded', 'forgotten', 'overtaken']) {
    direct.prepare('UPDATE memories SET state = ? WHERE id = ?').run(state, id);
    assert.equal(
      /** @type {{state: string}} */ (
        /** @type {unknown} */ (direct.prepare('SELECT state FROM memories WHERE id = ?').get(id))
      ).state,
      state,
    );
  }

  assert.throws(
    () => direct.prepare('UPDATE memories SET state = ? WHERE id = ?').run('archived', id),
    /CHECK constraint failed/u,
  );
});

test('two memories that already exist can be linked, and the link is refused if it would overwrite one', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const older = store1(store, 'I live in Tehran');
  const newer = store1(store, 'I live in Berlin');
  const third = store1(store, 'I live in Vienna');

  recordDecision(store, (actions, at) => {
    actions.retire({ owner: OWNER, id: older, at, supersededBy: newer });
    actions.claimSupersedes({ owner: OWNER, id: newer, nowSupersedes: older });
    return { owner: OWNER, verdict: 'superseded', rule: 'replaces', explanation: '.', input_excerpt: '' };
  });

  assert.equal(getMemory(store, OWNER, older, { includeArchived: true })?.state, 'superseded');
  assert.equal(getMemory(store, OWNER, older, { includeArchived: true })?.superseded_by, newer);
  assert.equal(getMemory(store, OWNER, newer)?.supersedes, older);

  // The half that matters. Memory `newer` already says what it replaced, and a
  // second claim would silently rewrite it — leaving `older` retired, pointing
  // at a memory that points somewhere else, with nothing recording the change.
  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.retire({ owner: OWNER, id: third, at, supersededBy: newer });
        actions.claimSupersedes({ owner: OWNER, id: newer, nowSupersedes: third });
        return { owner: OWNER, verdict: 'superseded', rule: 'replaces', explanation: '.', input_excerpt: '' };
      }),
    /supersedes memory/u,
  );

  assert.equal(getMemory(store, OWNER, newer)?.supersedes, older);
  assert.equal(getMemory(store, OWNER, third)?.state, 'active');
});

test('a pass is opened, closed once, and undone once', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  /** @type {number} */
  let pass = 0;
  recordDecision(store, (actions, at) => {
    pass = actions.openPass({ owner: OWNER, reviewer: 'an agent', at });
    return { owner: OWNER, verdict: 'began', rule: 'review-began', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.equal(getPass(store, OWNER, pass)?.reviewer, 'an agent');
  assert.deepEqual(openPasses(store, OWNER).map((row) => row.id), [pass]);

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.shutPass({ owner: OWNER, pass, at });
    return { owner: OWNER, verdict: 'closed', rule: 'review-closed', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.notEqual(getPass(store, OWNER, pass)?.closed_at, null);
  assert.deepEqual(openPasses(store, OWNER), []);

  // Closing again would move the timestamp off the moment the review actually
  // stopped, so it is refused rather than made idempotent.
  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.shutPass({ owner: OWNER, pass, at });
        return { owner: OWNER, verdict: 'closed', rule: 'review-closed', explanation: '.', input_excerpt: '' };
      }),
    /close review/u,
  );

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.abandonPass({ owner: OWNER, pass, at });
    return { owner: OWNER, verdict: 'undone', rule: 'review-undone', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.notEqual(getPass(store, OWNER, pass)?.undone_at, null);

  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.abandonPass({ owner: OWNER, pass, at });
        return { owner: OWNER, verdict: 'undone', rule: 'review-undone', explanation: '.', input_excerpt: '' };
      }),
    /undo review/u,
  );
});

test("a pass that was never closed is not left open once it has been undone", (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  /** @type {number} */
  let pass = 0;
  recordDecision(store, (actions, at) => {
    pass = actions.openPass({ owner: OWNER, reviewer: 'an agent', at });
    return { owner: OWNER, verdict: 'began', rule: 'review-began', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.abandonPass({ owner: OWNER, pass, at });
    return { owner: OWNER, verdict: 'undone', rule: 'review-undone', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.deepEqual(openPasses(store, OWNER), []);
});

test("a pass's decisions come back newest first, which is the order an undo needs", (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = store1(store, 'I live in Tehran');
  const second = store1(store, 'I live in Berlin');

  /** @type {number} */
  let pass = 0;
  recordDecision(store, (actions, at) => {
    pass = actions.openPass({ owner: OWNER, reviewer: 'an agent', at });
    return { owner: OWNER, verdict: 'began', rule: 'review-began', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  for (const id of [first, second]) {
    store.tick();
    recordDecision(store, (actions, at) => {
      actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
      return {
        owner: OWNER,
        verdict: OVERTAKEN,
        rule: 'overtaken',
        explanation: '.',
        input_excerpt: '',
        memory_id: id,
        pass_id: pass,
        reasoning: 'the moment it named has passed',
        derived_from: String(id),
      };
    });
  }

  const inPass = decisionsInPass(store, OWNER, pass);
  assert.deepEqual(inPass.map((row) => row.memory_id), [second, first, null]);

  // The three review columns are on the decision row itself, so `why` shows a
  // review's reasoning beside everything else that ever happened.
  assert.equal(inPass[0].reasoning, 'the moment it named has passed');
  assert.equal(inPass[0].derived_from, String(second));
  assert.equal(inPass[0].pass_id, pass);
});

test('a decision taken outside a review carries none of the review columns', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'I live in Tehran');
  const [written] = decisionsInPass(store, OWNER, 1);
  assert.equal(written, undefined);

  const memory = getMemory(store, OWNER, id);
  assert.notEqual(memory, null);
});

test('derived_from is checked against the store, archived rows included', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const kept = store1(store, 'I live in Tehran');
  const putAway = store1(store, 'I live in Berlin');

  recordDecision(store, (actions, at) => {
    actions.putAway({ owner: OWNER, id: putAway, at, reason: 'no', wasInState: 'active' });
    return { owner: OWNER, verdict: 'forgotten', rule: 'forget', explanation: '.', input_excerpt: '' };
  });

  // A review reads what has been put away as readily as what is on show, and
  // usually that is the point of reading it, so an archived id is a legitimate
  // thing to have reasoned from.
  assert.deepEqual(unknownMemories(store, OWNER, [kept, putAway]), []);
  assert.deepEqual(unknownMemories(store, OWNER, [kept, 9999, putAway, 4242]), [9999, 4242]);
  assert.deepEqual(unknownMemories(store, OWNER, []), []);

  // Somebody else's memory is not one this owner reasoned from.
  assert.deepEqual(unknownMemories(store, 'somebody-else', [kept]), [kept]);
});

// ---------------------------------------------------------------------------
// The four doors.
// ---------------------------------------------------------------------------

/**
 * A review of one memory, with the parts a test does not care about filled in.
 *
 * @param {import('../src/store.js').Store} store
 * @param {number} pass
 * @param {number} id
 * @param {Partial<Parameters<typeof review>[1]>} rest
 */
function judge(store, pass, id, rest) {
  return review(store, {
    owner: OWNER,
    pass,
    id,
    outcome: 'could-not-tell',
    reasoning: 'read it',
    derivedFrom: [id],
    ...rest,
  });
}

/**
 * @param {import('../src/store.js').Store} store
 * @returns {number}
 */
function begin(store) {
  const started = beginReview(store, { owner: OWNER, reviewer: 'a test' });
  return /** @type {number} */ (started.pass_id);
}

test('a review says a memory is overtaken, and says why, and the why is on the row', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const trip = store1(store, 'Next month I am going to Berlin');
  const home = store1(store, 'I live in Tehran');
  const pass = begin(store);

  store.tick();
  const result = judge(store, pass, trip, {
    outcome: 'overtaken',
    reasoning:
      'It says "next month" and it was stored on 2026-01-01, which is more than a month ' +
      'before the date on this review. Nothing newer says where they went.',
    derivedFrom: [trip],
  });

  assert.equal(result.verdict, 'overtaken');
  assert.equal(getMemory(store, OWNER, trip, { includeArchived: true })?.state, 'overtaken');

  // The statement with no moment in it is untouched, which is the assertion the
  // whole design turns on. It is exactly as old and it stays.
  assert.equal(getMemory(store, OWNER, home)?.state, 'active');

  const [finding] = decisionsInPass(store, OWNER, pass);
  assert.match(/** @type {string} */ (finding.reasoning), /more than a month/u);
  assert.equal(finding.derived_from, String(trip));
  assert.equal(finding.rule, 'overtaken');
});

test('could-not-tell is recorded and changes nothing', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const one = store1(store, 'I prefer tea');
  const two = store1(store, 'I prefer coffee');
  const pass = begin(store);

  const result = judge(store, pass, one, {
    outcome: 'could-not-tell',
    reasoning: 'Memories 1 and 2 disagree and neither says when. I cannot tell which is current.',
    derivedFrom: [one, two],
  });

  assert.equal(result.verdict, 'undecided');
  assert.equal(getMemory(store, OWNER, one)?.state, 'active');
  assert.equal(getMemory(store, OWNER, two)?.state, 'active');

  const [finding] = decisionsInPass(store, OWNER, pass);
  assert.equal(finding.rule, 'undecided');
  assert.equal(finding.derived_from, `${one} ${two}`);
  assert.match(/** @type {string} */ (finding.reasoning), /cannot tell/u);
});

test('a review with no reasoning is refused, and changes nothing', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  const pass = begin(store);

  const result = judge(store, pass, id, { outcome: 'overtaken', reasoning: '   ' });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'empty');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('the reasoning goes through the same screens a memory does', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  const pass = begin(store);

  const secret = judge(store, pass, id, {
    outcome: 'overtaken',
    reasoning: 'the key is ghp_0123456789abcdefghijklmnopqrstuvwxyzA',
  });
  assert.equal(secret.rule, 'credential');

  const nul = judge(store, pass, id, { outcome: 'overtaken', reasoning: 'a\u0000b' });
  assert.equal(nul.rule, 'control-character');

  const long = judge(store, pass, id, { outcome: 'overtaken', reasoning: 'x'.repeat(10_001) });
  assert.equal(long.rule, 'file-not-fact');

  // A review is a door, and the reason this matters is that it is a door text
  // can arrive at after being turned away at another one.
  for (const decision of listDecisions(store, OWNER)) {
    assert.equal(decision.explanation.includes('ghp_0123456789'), false);
    assert.equal((decision.reasoning ?? '').includes('ghp_0123456789'), false);
    assert.equal(decision.input_excerpt.includes('ghp_0123456789'), false);
  }

  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('a finding has to say what it was derived from, and the ids have to be real', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  const pass = begin(store);

  const nothing = judge(store, pass, id, { outcome: 'overtaken', derivedFrom: [] });
  assert.equal(nothing.rule, 'derived-from');

  const invented = judge(store, pass, id, { outcome: 'overtaken', derivedFrom: [id, 9999] });
  assert.equal(invented.rule, 'derived-from');
  assert.match(invented.explanation, /9999/u);

  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('a review links two memories that already exist, both ways', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const older = store1(store, 'I live in Tehran');
  const newer = store1(store, 'I live in Berlin');
  const pass = begin(store);

  const result = judge(store, pass, older, {
    outcome: 'superseded',
    replacedBy: newer,
    reasoning: 'Memory 2 says the same thing more recently and they cannot both be current.',
    derivedFrom: [older, newer],
  });

  assert.equal(result.verdict, 'superseded');
  assert.equal(getMemory(store, OWNER, older, { includeArchived: true })?.superseded_by, newer);
  assert.equal(getMemory(store, OWNER, newer)?.supersedes, older);

  // Same shape as a `replaces` row written by submit: the memory that stands,
  // then the one retired.
  const [finding] = decisionsInPass(store, OWNER, pass);
  assert.equal(finding.rule, 'replaces');
  assert.equal(finding.memory_id, newer);
  assert.equal(finding.related_memory_id, older);
});

test('a memory cannot replace itself, and cannot be replaced by one that is not active', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const one = store1(store, 'I live in Tehran');
  const two = store1(store, 'I live in Berlin');
  const pass = begin(store);

  const itself = judge(store, pass, one, { outcome: 'superseded', replacedBy: one, derivedFrom: [one] });
  assert.equal(itself.rule, 'replaces-unknown');
  assert.match(itself.explanation, /cannot replace itself/u);

  const nothing = judge(store, pass, one, { outcome: 'superseded', replacedBy: 9999, derivedFrom: [one] });
  assert.equal(nothing.rule, 'replaces-unknown');

  assert.equal(getMemory(store, OWNER, one)?.state, 'active');
  assert.equal(getMemory(store, OWNER, two)?.state, 'active');
});

test('a memory that is not active is not one a review has anything to say about', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  forget(store, { owner: OWNER, id, reason: 'the person asked' });

  const pass = begin(store);
  const result = judge(store, pass, id, { outcome: 'overtaken' });

  assert.equal(result.rule, 'review-unknown');
  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.state, 'forgotten');
});

test('closing a review has teeth: it takes no findings afterwards', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  const pass = begin(store);

  const closed = closeReview(store, { owner: OWNER, pass });
  assert.equal(closed.verdict, 'closed');
  assert.notEqual(getPass(store, OWNER, pass)?.closed_at, null);

  // The test the previous project's uncalled `finish()` never had. If closing
  // did nothing but write a timestamp, this would pass a finding straight
  // through and the memory below would be overtaken.
  const late = judge(store, pass, id, { outcome: 'overtaken' });
  assert.equal(late.rule, 'review-not-open');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');

  // And closing it again is refused rather than quietly moving the moment the
  // review stopped.
  assert.equal(closeReview(store, { owner: OWNER, pass }).rule, 'review-not-open');
});

test('a finding cannot name a review that was never started', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  const result = judge(store, 77, id, { outcome: 'overtaken' });

  assert.equal(result.rule, 'review-not-open');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('undoing a review puts back everything it changed, in one transaction', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const trip = store1(store, 'Next month I am going to Berlin');
  const older = store1(store, 'I live in Tehran');
  const newer = store1(store, 'I live in Berlin');
  const unsure = store1(store, 'I prefer tea');

  const pass = begin(store);
  judge(store, pass, trip, { outcome: 'overtaken', derivedFrom: [trip] });
  judge(store, pass, older, { outcome: 'superseded', replacedBy: newer, derivedFrom: [older, newer] });
  judge(store, pass, unsure, { outcome: 'could-not-tell', derivedFrom: [unsure] });
  closeReview(store, { owner: OWNER, pass });

  store.tick();
  const undone = undoReview(store, { owner: OWNER, pass });

  assert.equal(undone.verdict, 'undone');
  assert.equal(getMemory(store, OWNER, trip)?.state, 'active');
  assert.equal(getMemory(store, OWNER, older)?.state, 'active');
  assert.equal(getMemory(store, OWNER, older)?.superseded_by, null);
  assert.equal(getMemory(store, OWNER, newer)?.supersedes, null);
  assert.equal(getMemory(store, OWNER, unsure)?.state, 'active');

  assert.match(undone.explanation, new RegExp(String(trip), 'u'));
  assert.match(undone.explanation, new RegExp(String(older), 'u'));

  // Once. A second undo would put back states something else has set since.
  assert.equal(undoReview(store, { owner: OWNER, pass }).rule, 'review-not-open');
});

test('an undo leaves alone anything that has changed since, and says so', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const trip = store1(store, 'Next month I am going to Berlin');
  const other = store1(store, 'I answer email in the morning');

  const pass = begin(store);
  judge(store, pass, trip, { outcome: 'overtaken', derivedFrom: [trip] });
  judge(store, pass, other, { outcome: 'overtaken', derivedFrom: [other] });

  // The person reaches in themselves between the review and the undo. Putting
  // this one back would be the undo overwriting their decision.
  store.tick();
  restore(store, { owner: OWNER, id: trip });
  forget(store, { owner: OWNER, id: trip, reason: 'actually I do not want this at all' });

  store.tick();
  const undone = undoReview(store, { owner: OWNER, pass });

  assert.equal(getMemory(store, OWNER, trip, { includeArchived: true })?.state, 'forgotten');
  assert.equal(getMemory(store, OWNER, other)?.state, 'active');
  assert.match(undone.explanation, /left alone/u);
  assert.match(undone.explanation, /forgotten now/u);
});

test('an undo of a review that changed nothing says so', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'I live in Tehran');
  const pass = begin(store);
  judge(store, pass, id, { outcome: 'could-not-tell', derivedFrom: [id] });

  const undone = undoReview(store, { owner: OWNER, pass });
  assert.match(undone.explanation, /changed nothing/u);
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('a review has to say which agent it is', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  assert.equal(beginReview(store, { owner: OWNER, reviewer: '  ' }).rule, 'empty');
  assert.equal(
    beginReview(store, { owner: OWNER, reviewer: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzA' }).rule,
    'credential',
  );
  assert.deepEqual(openPasses(store, OWNER), []);
});

test('an outcome the review does not have is a call that never reaches the store', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  const pass = begin(store);
  const before = listDecisions(store, OWNER).length;

  assert.throws(
    // @ts-expect-error the point of the test
    () => review(store, { owner: OWNER, pass, id, outcome: 'forgotten', reasoning: 'x', derivedFrom: [id] }),
    /overtaken/u,
  );

  assert.equal(listDecisions(store, OWNER).length, before);
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('nothing a review can do puts a memory in the state the person alone decides', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const one = store1(store, 'Next month I am going to Berlin');
  const two = store1(store, 'I live in Tehran');
  const three = store1(store, 'I live in Berlin');
  const pass = begin(store);

  judge(store, pass, one, { outcome: 'overtaken', derivedFrom: [one] });
  judge(store, pass, two, { outcome: 'superseded', replacedBy: three, derivedFrom: [two, three] });
  closeReview(store, { owner: OWNER, pass });

  // Every outcome the review has, driven, and `forgotten` is not among the
  // states any of them produced. Forgetting is the person saying they do not
  // want something shown, and there is no path from the review to it.
  const states = new Set(
    listMemories(store, OWNER, { includeArchived: true }).map((memory) => memory.state),
  );
  assert.deepEqual([...states].sort(), ['active', 'overtaken', 'superseded']);
});

test('the review has no way to reach putAway, and the source says so', () => {
  // The functional test above drives the outcomes that exist. This one is about
  // the outcome that does not: it reads the file and asserts that the part of
  // it the review lives in never calls the action that forgets.
  //
  // Written as a slice from `beginReview` to the end of the file, which is
  // where the four doors are. Moving them elsewhere in the file means moving
  // this with them, and that is the intended cost — a check that followed the
  // code around by pattern would stop catching the thing it exists to catch.
  const source = fs.readFileSync(new URL('../src/gate.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function beginReview');

  assert.notEqual(start, -1, 'beginReview has moved; move this check with it');

  const reviewDoors = source.slice(start);
  assert.equal(reviewDoors.includes('putAway'), false, 'a review door can forget a memory');
  assert.ok(reviewDoors.includes('export function review'));
  assert.ok(reviewDoors.includes('export function closeReview'));
  assert.ok(reviewDoors.includes('export function undoReview'));
});

/**
 * Everything that would have to be true for a piece of code to decide something
 * from a date, and the phrase that gives each of them away.
 *
 * The first version of this guard forbade naming a clock, and a reviewer walked
 * straight past it with the rule that destroyed the owner's previous project:
 *
 *     if (memory.created_at < '2024-01-01T00:00:00.000Z') { actions.leaveBehind(...) }
 *
 * Older than N, therefore archive it, inside `review()`, waved through. It
 * needs no clock at all. Timestamps in this project are ISO 8601 strings and
 * ISO 8601 sorts as text, which is a deliberate property of the format and the
 * reason it was chosen — so the comparison a clock would have been needed for
 * is available for free, in a language operator, to anything holding two rows.
 *
 * The guard was protecting the phrasing of a mistake rather than the mistake.
 * These are the mistake.
 *
 * @type {{what: string, pattern: RegExp, unless?: RegExp}[]}
 */
const FORBIDDEN = [
  {
    // Every way of asking the machine what time it is. `Date` on its own rather
    // than `Date.now` and `new Date` separately, because an alias — `const D =
    // Date` — is one line and would have satisfied a narrower pattern. Nothing
    // on this path has any business naming the constructor at all.
    what: 'names a clock',
    pattern: /\b(?:Date|performance\s*\.\s*now|process\s*\.\s*hrtime|Temporal)\b/u,
  },
  {
    // A column holding a moment, next to an operator that orders or measures.
    // `created_at`, `state_at`, `decided_at`, `began_at`, `closed_at`,
    // `undone_at` — the shape rather than the list, so a seventh is covered the
    // day it is added.
    //
    // Null is the exception and is the only one. `closed_at IS NULL` is how a
    // pass says it is open and `undone_at !== null` is how it says it was
    // undone; neither reads the moment, both ask whether there is one. Every
    // other comparison of a timestamp is this project deciding from a date.
    what: 'compares a timestamp with something other than null',
    pattern: new RegExp(
      String.raw`\b\w*_at\b\s*(?:<=|>=|<>|<|>|===|!==|==|!=|-)|`
      + String.raw`(?:<=|>=|<>|<|>|===|!==|==|!=|-)\s*\b\w*_at\b`,
      'u',
    ),
    unless: /\b\w*_at\b\s*(?:!==?|===?)\s*null|null\s*(?:!==?|===?)\s*\b\w*_at\b/u,
  },
  {
    // The literal on the other side of that comparison, caught separately so
    // that writing the threshold as a bare string rather than against a column
    // — `at < '2024-01-01'`, `since > NOW` — is caught too. This is also what
    // catches it inside a SQL string, which is where the same rule is one WHERE
    // clause away from being written.
    what: 'compares something against a moment written out',
    pattern: /(?:<=|>=|<>|<|>|===|!==|==|!=|=)\s*['"`]\d{4}-\d\d-\d\d|['"`]\d{4}-\d\d-\d\d[^'"`]*['"`]\s*(?:<=|>=|<>|<|>|===|!==|==|!=)/u,
  },
  {
    // Arithmetic on a moment, which is how a threshold gets written when
    // somebody has already decided the comparison would look too obvious.
    what: 'does arithmetic on a moment',
    pattern: /\b(?:getTime|valueOf)\s*\(\s*\)|\bMath\s*\.\s*(?:floor|round)\s*\(\s*\w*_at/u,
  },
];

test('nothing on the memory path can decide anything from a date', () => {
  // The list is derived from the import graph and not written down here. The
  // hand-written version of it missed `doctor.js` when that module joined the
  // entrances in this very phase — in the commit whose own test says a module
  // joining one list joins the other, in the same commit, for the same reason.
  // Two lists kept by hand drifted apart inside the change that promised they
  // would not, so now there is one and nobody keeps it.
  const files = onTheMemoryPath();

  // What the derivation has to have got right, asserted rather than assumed,
  // because a guard over an empty list passes.
  for (const near of ['src/store.js', 'src/gate.js', 'src/tools.js', 'src/cli-main.js',
    'src/doctor.js', 'src/text.js', 'src/credentials.js', 'scripts/purge.mjs']) {
    assert.ok(files.includes(near), `${near} is on the memory path and is not being checked`);
  }

  // And what it has to have left out. Writing a timestamp down is fine and this
  // project does it constantly: `log.js` stamps every line of the action log
  // and `setup.js` stamps a run. `config.js` holds the one real clock, which is
  // handed in at the door — and if it ever turns up in this list that is not an
  // exemption to add, it is the clock having joined the memory path.
  for (const far of ['src/log.js', 'src/setup.js', 'src/config.js', 'src/write.js']) {
    assert.equal(files.includes(far), false, `${far} is on the memory path and should not be`);
  }

  /** @type {string[]} */
  const offenders = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Comments go; string literals stay. The SQL in `store.js` lives in string
    // literals, and `WHERE created_at < ?` is the same rule written one layer
    // down where JavaScript cannot see it.
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

    for (const line of code.split('\n')) {
      for (const rule of FORBIDDEN) {
        if (!rule.pattern.test(line)) continue;
        if (rule.unless?.test(line)) continue;
        offenders.push(`${file}: ${rule.what} — ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test('a review row records its reasoning once, and not twice under two names', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  const pass = begin(store);
  const said = 'It says "next month" and that month has gone by. Nothing replaced it.';

  judge(store, pass, id, { outcome: 'overtaken', reasoning: said, derivedFrom: [id] });

  const [finding] = decisionsInPass(store, OWNER, pass);

  // Found by running it: the reasoning was written to `reasoning` in full and
  // to `input_excerpt` cut to 160 characters, so `why` printed the same
  // sentence twice — once under a label that means "the memory text" on every
  // other row in the log.
  assert.equal(finding.reasoning, said);
  assert.equal(finding.input_excerpt, '');
});

test('a refusal names the review it was about, when there is one to name', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  const pass = begin(store);
  closeReview(store, { owner: OWNER, pass });

  const late = judge(store, pass, id, { outcome: 'overtaken' });
  assert.equal(late.rule, 'review-not-open');

  const [refusal] = decisionsInPass(store, OWNER, pass);
  assert.equal(refusal.rule, 'review-not-open');

  // And a review that was never started has nothing for the column to point
  // at, which is a foreign key rather than a matter of taste.
  assert.equal(judge(store, 404, id, { outcome: 'overtaken' }).rule, 'review-not-open');
  assert.deepEqual(decisionsInPass(store, OWNER, 404), []);
});

test('a pasted log is refused as a reason and as a reasoning, and not only as a memory', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'I live in Tehran');
  const pass = begin(store);

  // Well under the length limit, and exactly the shape the repetition rule
  // exists to catch. The decision log is never shortened, so anything accepted
  // here sits in it for good — which is why the gap mattered: the rule whose
  // whole job is to say "that is a document" was applied at one door and not at
  // the two that write to the same log.
  const log = '2026-08-18T09:14:22Z INFO worker-7 ready, waiting for work\n'.repeat(100);
  assert.ok(log.length < 10_000);

  const asReason = forget(store, { owner: OWNER, id, reason: log });
  assert.equal(asReason.rule, 'file-not-fact');
  assert.match(asReason.explanation, /reads as a file/u);
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');

  const asReasoning = judge(store, pass, id, { outcome: 'overtaken', reasoning: log });
  assert.equal(asReasoning.rule, 'file-not-fact');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');

  const asName = beginReview(store, { owner: OWNER, reviewer: log });
  assert.equal(asName.rule, 'file-not-fact');

  // Ordinary writing of any reasonable length still goes through all three.
  const real = 'It says "next week" and was stored more than a month before this review; the '
    + 'all-hands it names has happened, and nothing stored since says how it went, so there is '
    + 'nothing to put in its place.';
  assert.equal(judge(store, pass, id, { outcome: 'could-not-tell', reasoning: real }).rule, 'undecided');
});

test('an outcome the review does not have is named back when it is safe to name', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');
  const pass = begin(store);

  assert.throws(
    // @ts-expect-error the point of the test
    () => review(store, { owner: OWNER, pass, id, outcome: 'forgotten', reasoning: 'x', derivedFrom: [id] }),
    /gave "forgotten"/u,
  );

  // And not named when it is not enum-shaped. `describe` refuses to quote text
  // at all, which is right for a memory and unhelpful for an enum; this is the
  // line between the two.
  assert.throws(
    // @ts-expect-error the point of the test
    () => review(store, { owner: OWNER, pass, id, outcome: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzA', reasoning: 'x', derivedFrom: [id] }),
    /gave something else/u,
  );
});
