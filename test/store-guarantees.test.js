/**
 * The promises the storage layer makes about itself.
 *
 * These are the ones that are easy to believe and easy to lose: that there is
 * no way to reach the database handle from outside the module, and therefore
 * no way to change a memory without the change being written down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forget, submit } from '../src/gate.js';
import {
  getMemory,
  listDecisions,
  listMemories,
  recordDecision,
  searchMemories,
} from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

test('a store hands out no database handle', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  assert.equal('db' in store, false);
  assert.deepEqual(Object.keys(store).filter((key) => key === 'db'), []);

  // Nothing hanging off the store is something you could prepare a statement
  // on, which is the only shape that would let a caller write without logging.
  for (const value of Object.values(/** @type {Record<string, unknown>} */ (store))) {
    const candidate = /** @type {Record<string, unknown>} */ (Object(value));
    assert.equal(
      typeof candidate.prepare,
      'undefined',
      'a store property exposes something statement shaped',
    );
  }
});

test('the only way in writes its own log row', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // recordDecision is the exported door, and it takes the handle in rather
  // than giving it out. Using it at all produces a decision row.
  recordDecision(store, (db, at) => {
    const written = db
      .prepare(
        `INSERT INTO memories (owner, text, created_at, state, state_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .run(OWNER, 'direct', at, at);

    return {
      owner: OWNER,
      verdict: 'stored',
      rule: 'keep',
      explanation: 'written directly through the exported door',
      input_excerpt: 'direct',
      memory_id: Number(written.lastInsertRowid),
    };
  });

  assert.equal(listMemories(store, OWNER).length, 1);
  assert.equal(listDecisions(store, OWNER).length, 1);
});

test('every read shows only active memories until asked otherwise', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I keep Wednesdays clear' });
  const id = /** @type {number} */ (stored.memory_id);
  forget(store, { owner: OWNER, id, reason: 'not any more' });

  assert.equal(getMemory(store, OWNER, id), null, 'getMemory should default to active only');
  assert.equal(listMemories(store, OWNER).length, 0);
  assert.equal(searchMemories(store, OWNER, 'Wednesdays').length, 0);

  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.state, 'forgotten');
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 1);
  assert.equal(searchMemories(store, OWNER, 'Wednesdays', { includeArchived: true }).length, 1);
});

test('nothing is quietly held back from a search or from the log', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  for (let index = 0; index < 210; index += 1) {
    submit(store, { owner: OWNER, text: `memory number ${index} mentions rhubarb` });
  }

  assert.equal(searchMemories(store, OWNER, 'rhubarb').length, 210, 'search held some back');
  assert.equal(listDecisions(store, OWNER).length, 210, 'the log held some back');

  // The oldest entry, the one a truncating log would lose first, is there.
  assert.equal(listDecisions(store, OWNER)[0].input_excerpt, 'memory number 0 mentions rhubarb');
});

test('a failure inside a decision is the error that comes back', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  assert.throws(
    () =>
      recordDecision(store, () => {
        throw new Error('the real problem');
      }),
    /the real problem/u,
    'the original failure should not be replaced by a rollback failure',
  );

  // And the store is still usable afterwards, with nothing half written.
  assert.equal(listDecisions(store, OWNER).length, 0);
  assert.equal(listMemories(store, OWNER).length, 0);
  submit(store, { owner: OWNER, text: 'still works' });
  assert.equal(listMemories(store, OWNER).length, 1);
});

test('a decision taken inside another decision joins it instead of failing', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  recordDecision(store, () => {
    // The gate, called from inside an open decision, used to fail here with
    // "cannot start a transaction within a transaction".
    submit(store, { owner: OWNER, text: 'written from inside another decision' });

    return {
      owner: OWNER,
      verdict: 'refused',
      rule: 'empty',
      explanation: 'the outer decision',
      input_excerpt: '',
    };
  });

  assert.equal(listMemories(store, OWNER).length, 1);
  assert.deepEqual(
    listDecisions(store, OWNER).map((decision) => decision.explanation),
    ['Stored.', 'the outer decision'],
  );
});

test('an inner decision that fails does not take the outer one with it', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  recordDecision(store, () => {
    assert.throws(() =>
      recordDecision(store, () => {
        submit(store, { owner: OWNER, text: 'this should be undone' });
        throw new Error('the inner decision failed');
      }),
    );

    return {
      owner: OWNER,
      verdict: 'stored',
      rule: 'keep',
      explanation: 'the outer decision survived',
      input_excerpt: '',
    };
  });

  assert.equal(listMemories(store, OWNER).length, 0, 'the inner write should have been undone');
  assert.deepEqual(
    listDecisions(store, OWNER).map((decision) => decision.explanation),
    ['the outer decision survived'],
  );
});

test('a closed store cannot be used again', (t) => {
  const store = temporaryStore();
  submit(store, { owner: OWNER, text: 'something to keep' });
  store.close();

  assert.throws(() => listMemories(store, OWNER), { name: 'TypeError' });
  t.diagnostic('a closed store forgets its handle rather than leaving it lying about');
});
