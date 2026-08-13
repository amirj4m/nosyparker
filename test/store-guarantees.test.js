/**
 * The promises the storage layer makes about itself.
 *
 * These are the ones that are easy to believe and easy to lose: that there is
 * no way to reach the database handle from outside the module, and therefore
 * no way to change a memory without the change being written down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { submit } from '../src/gate.js';
import { listDecisions, listMemories, recordDecision } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

test('a store hands out no database handle', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  assert.equal('db' in store, false);
  assert.deepEqual(Object.keys(store).filter((key) => key === 'db'), []);

  // Nothing reachable from the store, at any depth of its own properties, is
  // something you could prepare a statement on.
  for (const value of Object.values(store)) {
    assert.equal(
      typeof (/** @type {Record<string, unknown>} */ (value ?? {}).prepare),
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

test('a closed store cannot be used again', (t) => {
  const store = temporaryStore();
  submit(store, { owner: OWNER, text: 'something to keep' });
  store.close();

  assert.throws(() => listMemories(store, OWNER), { name: 'TypeError' });
  t.diagnostic('a closed store forgets its handle rather than leaving it lying about');
});
