/**
 * Restoring has to leave the two memories agreeing with each other. A memory
 * that is active again cannot still be listed as having been replaced, and the
 * memory that replaced it cannot still claim to have done so.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forget, restore, submit } from '../src/gate.js';
import { getMemory, listDecisions, listMemories } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

test('restoring a forgotten memory brings it back to the active list', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I am allergic to walnuts' });
  const id = /** @type {number} */ (stored.memory_id);
  forget(store, { owner: OWNER, id, reason: 'thought I had grown out of it' });

  const result = restore(store, { owner: OWNER, id });

  assert.equal(result.verdict, 'restored');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
  // The reason it was put away is kept. It was true, and it is the only
  // account of it that anyone reads off the row.
  assert.equal(getMemory(store, OWNER, id)?.state_reason, 'thought I had grown out of it');
  assert.deepEqual(
    listMemories(store, OWNER).map((memory) => memory.id),
    [id],
  );
});

test('restoring a superseded memory leaves no pointer dangling on either side', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const old = submit(store, { owner: OWNER, text: 'I live in Tehran' });
  const oldId = /** @type {number} */ (old.memory_id);
  const fresh = submit(store, { owner: OWNER, text: 'I live in Berlin', replaces: oldId });
  const freshId = /** @type {number} */ (fresh.memory_id);

  restore(store, { owner: OWNER, id: oldId });

  const oldRow = getMemory(store, OWNER, oldId);
  const freshRow = getMemory(store, OWNER, freshId);

  // The restored memory is active and nothing claims to have replaced it.
  assert.equal(oldRow?.state, 'active');
  assert.equal(oldRow?.superseded_by, null);

  // And the newer memory no longer claims to have replaced it either.
  assert.equal(freshRow?.supersedes, null);
  assert.equal(freshRow?.state, 'active');

  // Both are shown, because the user asked for both to be true.
  assert.deepEqual(
    listMemories(store, OWNER).map((memory) => memory.id),
    [oldId, freshId],
  );
});

test('no memory anywhere points at a memory in a state that contradicts it', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'one' });
  const second = submit(store, {
    owner: OWNER,
    text: 'two',
    replaces: /** @type {number} */ (first.memory_id),
  });
  const third = submit(store, {
    owner: OWNER,
    text: 'three',
    replaces: /** @type {number} */ (second.memory_id),
  });

  restore(store, { owner: OWNER, id: /** @type {number} */ (second.memory_id) });

  for (const memory of listMemories(store, OWNER, { includeArchived: true })) {
    if (memory.superseded_by !== null) {
      const replacement = getMemory(store, OWNER, memory.superseded_by, { includeArchived: true });
      assert.equal(
        replacement?.supersedes,
        memory.id,
        `memory ${memory.id} says ${memory.superseded_by} replaced it, but that memory disagrees`,
      );
      assert.notEqual(memory.state, 'active', `memory ${memory.id} is active and replaced at once`);
    }
    if (memory.supersedes !== null) {
      const replaced = getMemory(store, OWNER, memory.supersedes, { includeArchived: true });
      assert.equal(
        replaced?.superseded_by,
        memory.id,
        `memory ${memory.id} claims to have replaced ${memory.supersedes}, which disagrees`,
      );
    }
  }

  // The chain that was left alone is still intact.
  assert.equal(
    getMemory(store, OWNER, /** @type {number} */ (first.memory_id), { includeArchived: true })
      ?.superseded_by,
    second.memory_id,
  );
  assert.equal(getMemory(store, OWNER, /** @type {number} */ (third.memory_id))?.supersedes, null);
});

test('forgetting something already put away simply does it again', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I am allergic to walnuts' });
  const id = /** @type {number} */ (stored.memory_id);
  forget(store, { owner: OWNER, id, reason: 'one' });

  const again = forget(store, { owner: OWNER, id, reason: 'two' });

  assert.equal(again.verdict, 'forgotten');
  assert.equal(again.rule, 'forget');
  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.state_reason, 'two');

  // The row carries the latest reason, and the log carries all of them. That
  // is where an earlier reason is read back from.
  assert.deepEqual(
    listDecisions(store, OWNER).map((decision) => decision.input_excerpt),
    ['I am allergic to walnuts', 'one', 'two'],
  );
});

test('a reason survives forget, restore and forget again, in the log', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I cycle to work' });
  const id = /** @type {number} */ (stored.memory_id);

  forget(store, { owner: OWNER, id, reason: 'the first reason' });
  restore(store, { owner: OWNER, id });
  forget(store, { owner: OWNER, id, reason: 'the second reason' });

  assert.equal(
    getMemory(store, OWNER, id, { includeArchived: true })?.state_reason,
    'the second reason',
  );

  const log = listDecisions(store, OWNER);
  assert.deepEqual(
    log.map((decision) => decision.rule),
    ['keep', 'forget', 'restored', 'forget'],
  );
  assert.equal(
    log.some((decision) => decision.input_excerpt === 'the first reason'),
    true,
    'the earlier reason has to stay readable somewhere',
  );
});

test('forgetting something that was replaced puts it away', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const old = submit(store, { owner: OWNER, text: 'I live in Tehran' });
  const oldId = /** @type {number} */ (old.memory_id);
  submit(store, { owner: OWNER, text: 'I live in Berlin', replaces: oldId });

  const result = forget(store, { owner: OWNER, id: oldId, reason: 'moved' });
  const row = getMemory(store, OWNER, oldId, { includeArchived: true });

  assert.equal(result.verdict, 'forgotten');
  assert.equal(row?.state, 'forgotten');
  assert.equal(row?.state_reason, 'moved');
});

test('restoring something already being shown simply does it again', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I keep Sundays free' });
  const id = /** @type {number} */ (stored.memory_id);

  const result = restore(store, { owner: OWNER, id });

  assert.equal(result.verdict, 'restored');
  assert.equal(result.rule, 'restored');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
  assert.equal(listDecisions(store, OWNER).length, 2, 'and it is written down');
});

test('restoring is written to the log like everything else', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I keep Sundays free' });
  const id = /** @type {number} */ (stored.memory_id);
  forget(store, { owner: OWNER, id, reason: 'not any more' });
  restore(store, { owner: OWNER, id });

  const log = listDecisions(store, OWNER);
  assert.deepEqual(
    log.map((decision) => decision.rule),
    ['keep', 'forget', 'restored'],
  );
  assert.equal(log[2].memory_id, id);
});
