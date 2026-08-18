/**
 * The review, pointed at a store shaped like a real one, and then damaged.
 *
 * Phase 3's lesson, written down in DECISIONS.md and worth repeating here: of
 * the twenty-four defects that phase found, none came from the suite. They came
 * from running the thing, damaging it, and measuring it. So these tests are not
 * more coverage of the rules — `review.test.js` has that — they are the review
 * put in the way of things going wrong.
 *
 * The fixture is in `messy-store.js` and the reasoning for each row is there.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import {
  beginReview,
  closeReview,
  forget,
  restore,
  review,
  submit,
  undoReview,
} from '../src/gate.js';
import { getMemory, getPass, listDecisions, listMemories, openStore, searchMemories } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';
import { messyStore, NOW, WRITTEN } from './messy-store.js';

/**
 * Every memory and the state it is in, as something two moments can be
 * compared with.
 *
 * @param {import('../src/store.js').Store} store
 * @returns {string}
 */
function snapshot(store) {
  return listMemories(store, OWNER, { includeArchived: true })
    .map((memory) => `${memory.id} ${memory.state} ${memory.superseded_by ?? '-'} ${memory.state_reason ?? '-'}`)
    .join('\n');
}

test('the fixture is the shape the tests below assume', (t) => {
  const messy = messyStore(t);

  assert.equal(WRITTEN.length, 23);
  assert.equal(messy.timed.length, 8);
  assert.equal(messy.timeless.length, 15);

  // The one that matters. The oldest thing in the store names no moment, so any
  // review that works from age alone reaches it first.
  assert.equal(messy.oldest, messy.timeless[0]);
  assert.equal(getMemory(messy.store, OWNER, messy.oldest)?.text, 'I live in Tehran');
  assert.equal(getMemory(messy.store, OWNER, messy.oldest)?.created_at, '2024-03-11T09:12:00.000Z');

  // Two rows are already archived, which is what a review has to walk past.
  assert.equal(getMemory(messy.store, OWNER, messy.forgotten, { includeArchived: true })?.state, 'forgotten');
  assert.equal(getMemory(messy.store, OWNER, messy.superseded, { includeArchived: true })?.state, 'superseded');
});

test('reading the store, by every path there is, changes nothing in it', (t) => {
  const messy = messyStore(t);
  const before = snapshot(messy.store);

  listMemories(messy.store, OWNER);
  listMemories(messy.store, OWNER, { includeArchived: true });
  searchMemories(messy.store, OWNER, 'Berlin');
  searchMemories(messy.store, OWNER, '柏林');
  searchMemories(messy.store, OWNER, 'deadline Tuesday');
  listDecisions(messy.store, OWNER);
  for (const memory of listMemories(messy.store, OWNER)) {
    getMemory(messy.store, OWNER, memory.id, { includeArchived: true });
  }

  // Opening a review is not reading, but it is the closest thing to a bulk
  // operation this project has, and the thing it must not be is one.
  beginReview(messy.store, { owner: OWNER, reviewer: 'a reader' });

  assert.equal(snapshot(messy.store), before);
});

test('a review that judges only the dated statements leaves every other one exactly as it was', (t) => {
  const messy = messyStore(t);

  /** @type {Map<number, string>} */
  const wasTimeless = new Map(
    messy.timeless.map((id) => [
      id,
      /** @type {string} */ (getMemory(messy.store, OWNER, id, { includeArchived: true })?.state),
    ]),
  );

  const pass = /** @type {number} */ (
    beginReview(messy.store, { owner: OWNER, reviewer: 'a reviewer that reads the sentences' }).pass_id
  );

  // Standing at NOW and reading each sentence: five of the eight name a moment
  // that has gone by. One names a window that has not closed, one names a month
  // that has not arrived, and one names an afternoon that is happening at this
  // exact moment — which is the case a reviewer working from the date alone
  // gets wrong, and the reason the fixture has it. This is the agent's
  // judgement, written out by hand so the test is deterministic. No part of it
  // is nosyparker's.
  const notYet = ['For the next six weeks', 'Next month', 'This afternoon'];
  const gone = messy.timed.filter((id) => {
    const text = /** @type {string} */ (getMemory(messy.store, OWNER, id)?.text);
    return !notYet.some((start) => text.startsWith(start));
  });
  assert.equal(gone.length, 5);

  for (const id of gone) {
    const result = review(messy.store, {
      owner: OWNER,
      pass,
      id,
      outcome: 'overtaken',
      reasoning:
        `The sentence names a moment and that moment is before ${NOW}. Nothing stored since `
        + 'says what happened, so there is nothing to put in its place.',
      derivedFrom: [id],
    });
    assert.equal(result.verdict, 'overtaken', result.explanation);
  }

  closeReview(messy.store, { owner: OWNER, pass });

  // The assertion the whole phase exists for. Fifteen statements that name no
  // moment, the oldest of them two and a half years old, and not one of them
  // moved — because nothing asked about them.
  for (const [id, state] of wasTimeless) {
    assert.equal(
      getMemory(messy.store, OWNER, id, { includeArchived: true })?.state,
      state,
      `memory ${id} names no moment and should not have been touched`,
    );
  }

  assert.equal(getMemory(messy.store, OWNER, messy.oldest)?.state, 'active');

  // And the three dated ones nobody concluded anything about are untouched too.
  assert.equal(messy.timed.filter((id) => !gone.includes(id)).length, 3);
  for (const id of messy.timed.filter((row) => !gone.includes(row))) {
    assert.equal(getMemory(messy.store, OWNER, id)?.state, 'active');
  }
});

test('the contradiction with nothing to date it is left undecided, and both survive', (t) => {
  const messy = messyStore(t);

  const tea = /** @type {number} */ (
    listMemories(messy.store, OWNER).find((memory) => memory.text.startsWith('I prefer tea'))?.id
  );
  const coffee = /** @type {number} */ (
    listMemories(messy.store, OWNER).find((memory) => memory.text.startsWith('I prefer coffee'))?.id
  );

  const pass = /** @type {number} */ (
    beginReview(messy.store, { owner: OWNER, reviewer: 'a careful reviewer' }).pass_id
  );

  const result = review(messy.store, {
    owner: OWNER,
    pass,
    id: tea,
    outcome: 'could-not-tell',
    reasoning:
      'These two disagree and neither sentence says when it applies — one may be a change of '
      + 'mind and they may both be true at different times of day. Choosing would be a guess.',
    derivedFrom: [tea, coffee],
  });

  assert.equal(result.verdict, 'undecided');
  assert.equal(getMemory(messy.store, OWNER, tea)?.state, 'active');
  assert.equal(getMemory(messy.store, OWNER, coffee)?.state, 'active');
});

// ---------------------------------------------------------------------------
// Damage.
// ---------------------------------------------------------------------------

test('a memory the person changes mid-review is not changed again by the review', (t) => {
  const messy = messyStore(t);
  const id = messy.timed[0];

  const pass = /** @type {number} */ (
    beginReview(messy.store, { owner: OWNER, reviewer: 'a reviewer' }).pass_id
  );

  // The reviewer has read it and is about to conclude. The person gets there
  // first, through a different agent, and puts it away themselves.
  forget(messy.store, { owner: OWNER, id, reason: 'I do not want this remembered' });

  const late = review(messy.store, {
    owner: OWNER,
    pass,
    id,
    outcome: 'overtaken',
    reasoning: 'the moment it names has gone',
    derivedFrom: [id],
  });

  assert.equal(late.rule, 'review-unknown');
  assert.equal(getMemory(messy.store, OWNER, id, { includeArchived: true })?.state, 'forgotten');
  assert.equal(
    getMemory(messy.store, OWNER, id, { includeArchived: true })?.state_reason,
    'I do not want this remembered',
    "the person's reason survived",
  );
});

test('an undo that finds the store moved on puts back what it can and reports the rest', (t) => {
  const messy = messyStore(t);
  const [first, second] = messy.timed;

  const pass = /** @type {number} */ (
    beginReview(messy.store, { owner: OWNER, reviewer: 'a reviewer' }).pass_id
  );
  for (const id of [first, second]) {
    review(messy.store, { owner: OWNER, pass, id, outcome: 'overtaken',
      reasoning: 'that moment has gone', derivedFrom: [id] });
  }
  closeReview(messy.store, { owner: OWNER, pass });

  // The person restores one of them themselves and then decides they never
  // wanted it, which is two of their own decisions stacked on top of the
  // review's one.
  restore(messy.store, { owner: OWNER, id: first });
  forget(messy.store, { owner: OWNER, id: first, reason: 'no, take it away' });

  const undone = undoReview(messy.store, { owner: OWNER, pass });

  assert.equal(getMemory(messy.store, OWNER, second)?.state, 'active', 'the untouched one came back');
  assert.equal(
    getMemory(messy.store, OWNER, first, { includeArchived: true })?.state,
    'forgotten',
    'the undo did not overwrite the person',
  );
  assert.match(undone.explanation, /left alone/u);
});

test('a review that throws partway through writes nothing at all', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const one = /** @type {number} */ (submit(store, { owner: OWNER, text: 'I live in Tehran' }).memory_id);
  const before = snapshot(store);
  const decisions = listDecisions(store, OWNER).length;

  // A decision is a transaction and the actions live inside it. Something
  // throwing after a memory has been changed but before the row explaining it
  // is written is the failure this shape exists to make impossible, and the
  // way to prove it is to make it happen.
  assert.throws(() => {
    const pass = /** @type {number} */ (beginReview(store, { owner: OWNER, reviewer: 'a reviewer' }).pass_id);
    review(store, {
      owner: OWNER,
      pass,
      id: one,
      outcome: 'superseded',
      // A replacement that is really the memory itself, reached the long way
      // round: this gets past the caller and is refused inside the transaction.
      replacedBy: one,
      reasoning: 'wrong',
      derivedFrom: [one],
    });
    throw new Error('stop here');
  }, /stop here/u);

  assert.equal(snapshot(store), before);
  assert.equal(listDecisions(store, OWNER).length, decisions + 2, 'the two completed decisions stand');
  assert.equal(getMemory(store, OWNER, one)?.state, 'active');
});

test("one owner's review cannot touch another owner's memories", (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const mine = /** @type {number} */ (submit(store, { owner: OWNER, text: 'I live in Tehran' }).memory_id);
  const theirs = /** @type {number} */ (
    submit(store, { owner: 'somebody-else', text: 'Next week I move house' }).memory_id
  );

  const pass = /** @type {number} */ (
    beginReview(store, { owner: OWNER, reviewer: 'a reviewer' }).pass_id
  );

  assert.equal(
    review(store, { owner: OWNER, pass, id: theirs, outcome: 'overtaken',
      reasoning: 'not mine to judge', derivedFrom: [mine] }).rule,
    'review-unknown',
  );

  // Their pass is not one this owner can add to either, in either direction.
  assert.equal(getPass(store, 'somebody-else', pass), null);
  assert.equal(
    review(store, { owner: 'somebody-else', pass, id: theirs, outcome: 'overtaken',
      reasoning: 'borrowing a review', derivedFrom: [theirs] }).rule,
    'review-not-open',
  );

  assert.equal(getMemory(store, 'somebody-else', theirs)?.state, 'active');
});

test('two reviews open at once cannot both retire the same memory', (t) => {
  const messy = messyStore(t);
  const id = messy.timed[0];

  const first = /** @type {number} */ (
    beginReview(messy.store, { owner: OWNER, reviewer: 'agent one' }).pass_id
  );
  const second = /** @type {number} */ (
    beginReview(messy.store, { owner: OWNER, reviewer: 'agent two' }).pass_id
  );

  assert.equal(
    review(messy.store, { owner: OWNER, pass: first, id, outcome: 'overtaken',
      reasoning: 'that moment has gone', derivedFrom: [id] }).verdict,
    'overtaken',
  );

  // The second one read the same active memory a moment ago. It is not active
  // now, and the answer is a refusal rather than a second state change.
  assert.equal(
    review(messy.store, { owner: OWNER, pass: second, id, outcome: 'overtaken',
      reasoning: 'that moment has gone', derivedFrom: [id] }).rule,
    'review-unknown',
  );

  // And undoing the review that did not change it puts nothing back.
  const undone = undoReview(messy.store, { owner: OWNER, pass: second });
  assert.match(undone.explanation, /changed nothing/u);
  assert.equal(getMemory(messy.store, OWNER, id, { includeArchived: true })?.state, 'overtaken');
});

test('a review killed partway through leaves a store that opens and is consistent', (t) => {
  const messy = messyStore(t);
  const file = messy.store.file;
  const before = snapshot(messy.store);

  // Out of process and killed with SIGKILL, because the point is a review that
  // stops without unwinding anything — no catch, no finally, no rollback of its
  // own. What has to survive that is the file.
  const script = path.join(path.dirname(file), 'kill-mid-review.mjs');
  fs.writeFileSync(script, [
    "import { beginReview, review } from '" + new URL('../src/gate.js', import.meta.url).href + "';",
    "import { openStore } from '" + new URL('../src/store.js', import.meta.url).href + "';",
    `const store = openStore({ file: ${JSON.stringify(file)}, now: () => ${JSON.stringify(NOW)} });`,
    `const pass = beginReview(store, { owner: ${JSON.stringify(OWNER)}, reviewer: 'doomed' }).pass_id;`,
    `review(store, { owner: ${JSON.stringify(OWNER)}, pass, id: ${messy.timed[0]}, outcome: 'overtaken',`,
    "  reasoning: 'that moment has gone', derivedFrom: [" + messy.timed[0] + '] });',
    'process.kill(process.pid, 9);',
  ].join('\n'));

  const killed = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);

  // A second connection rather than the fixture's, because what is being
  // checked is the file the killed process left behind, not what this one is
  // holding in memory.
  const reopened = openStore({ file, now: () => NOW });
  t.after(() => reopened.close());

  // The finding it completed stands, with its row. Nothing else moved, and
  // there is no memory in a state no decision explains.
  const after = snapshot(reopened);
  assert.notEqual(after, before, 'the completed finding should have survived');
  assert.equal(getMemory(reopened, OWNER, messy.timed[0], { includeArchived: true })?.state, 'overtaken');

  const changes = listDecisions(reopened, OWNER).filter((row) => row.rule === 'overtaken');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].memory_id, messy.timed[0]);

  // The pass it opened is still open, which is exactly the state doctor exists
  // to report and nothing here tidies away.
  assert.notEqual(getPass(reopened, OWNER, /** @type {number} */ (changes[0].pass_id)), null);
});
