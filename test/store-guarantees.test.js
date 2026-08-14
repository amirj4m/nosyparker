/**
 * The promises the storage layer makes about itself.
 *
 * These are the ones that are easy to believe and easy to lose: that there is
 * no way to reach the database handle from outside the module, and therefore
 * no way to change a memory without the change being written down.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { forget, submit } from '../src/gate.js';
import {
  getMemory,
  listDecisions,
  listMemories,
  openStore,
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

test('a decision is handed named actions, not a way to run statements', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  /** @type {Record<string, unknown>|null} */
  let handed = null;

  recordDecision(store, (actions, at) => {
    handed = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (actions));

    return {
      owner: OWNER,
      verdict: 'stored',
      rule: 'keep',
      explanation: 'written through the actions',
      input_excerpt: 'direct',
      memory_id: actions.insertMemory({ owner: OWNER, text: 'direct', at, supersedes: null }),
    };
  });

  assert.notEqual(handed, null);
  const given = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (handed));

  // Nothing that runs SQL of the caller's choosing.
  for (const forbidden of ['prepare', 'exec', 'run', 'query', 'db', 'database']) {
    assert.equal(typeof given[forbidden], 'undefined', `actions expose ${forbidden}`);
  }

  // Only the changes a memory is allowed to undergo, and nothing else.
  assert.deepEqual(Object.keys(given).sort(), [
    'bringBack',
    'insertMemory',
    'putAway',
    'retire',
    'unlinkSupersedes',
  ]);

  assert.equal(listMemories(store, OWNER).length, 1);
  assert.equal(listDecisions(store, OWNER).length, 1);
});

test('actions kept past the end of a decision no longer work', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'the original text' });
  const id = /** @type {number} */ (first.memory_id);

  // This is the escape the second reviewer used: keep whatever the callback
  // was handed, then use it after the decision has been written.
  /** @type {import('../src/store.js').StoreActions|null} */
  let stolen = null;

  recordDecision(store, (actions) => {
    stolen = actions;
    return {
      owner: OWNER,
      verdict: 'refused',
      rule: 'empty',
      explanation: 'a decision that changes nothing',
      input_excerpt: '',
    };
  });

  const kept = /** @type {import('../src/store.js').StoreActions} */ (
    /** @type {unknown} */ (stolen)
  );
  assert.notEqual(kept, null);

  const at = '2030-01-01T00:00:00.000Z';
  assert.throws(() => kept.insertMemory({ owner: OWNER, text: 'fabricated', at, supersedes: null }));
  assert.throws(() => kept.putAway({ owner: OWNER, id, at, reason: 'r', wasInState: 'active' }));
  assert.throws(() => kept.retire({ owner: OWNER, id, at, supersededBy: id }));
  assert.throws(() =>
    kept.bringBack({ owner: OWNER, id, at, wasInState: 'active', wasSupersededBy: null }),
  );
  assert.throws(() => kept.unlinkSupersedes({ owner: OWNER, id, noLongerSupersedes: id }));

  // Nothing was rewritten and nothing was fabricated.
  const memories = listMemories(store, OWNER, { includeArchived: true });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].text, 'the original text');
  assert.equal(memories[0].state, 'active');

  // And the log still accounts for every change: two calls, two rows.
  assert.equal(listDecisions(store, OWNER).length, 2);
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

test('a decision opened while one is already open is refused outright', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  assert.throws(
    () =>
      recordDecision(store, () => {
        submit(store, { owner: OWNER, text: 'written from inside another decision' });

        return {
          owner: OWNER,
          verdict: 'refused',
          rule: 'empty',
          explanation: 'the outer decision',
          input_excerpt: '',
        };
      }),
    /decision is already open/u,
  );

  // The outer decision rolled back with it, so nothing was written at all.
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 0);
  assert.equal(listDecisions(store, OWNER).length, 0);

  // And the store is left usable rather than stuck inside a transaction.
  submit(store, { owner: OWNER, text: 'still works afterwards' });
  assert.equal(listMemories(store, OWNER).length, 1);
});

test('a new store writes down the schema version it was made under', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const reader = new DatabaseSync(store.file);
  t.after(() => reader.close());

  // 1 is the current SCHEMA_VERSION in store.js, and moves with it.
  const stamped = /** @type {{user_version: number}} */ (
    /** @type {unknown} */ (reader.prepare('PRAGMA user_version').get())
  );
  assert.equal(stamped.user_version, 1, 'a new store should be stamped, not left at zero');
});

test('a store older than this code is refused at the door, not on the first write', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.sqlite');

  // A store as it was before text_normalised was added: the table is there, so
  // CREATE TABLE IF NOT EXISTS leaves it exactly as it is, and nothing ever
  // wrote a version number into the file.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE memories (
    id            INTEGER PRIMARY KEY,
    owner         TEXT    NOT NULL,
    text          TEXT    NOT NULL,
    created_at    TEXT    NOT NULL,
    state         TEXT    NOT NULL DEFAULT 'active',
    state_reason  TEXT,
    state_at      TEXT    NOT NULL,
    supersedes    INTEGER REFERENCES memories(id),
    superseded_by INTEGER REFERENCES memories(id)
  )`);
  old.exec(
    "INSERT INTO memories (owner, text, created_at, state_at) " +
      "VALUES ('tester', 'stored before the column existed', '2025-01-01', '2025-01-01')",
  );
  old.close();

  // This used to open, list and search quite happily, and then die on the
  // first write with "no such column: text_normalised".
  assert.throws(
    () => openStore({ file, now: () => '2026-01-01T00:00:00.000Z' }),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(message, /older version of nosyparker/u);
      assert.ok(message.includes(file), 'the message should name the file');
      assert.equal(/no such column/u.test(message), false, 'not a raw SQLite error');
      return true;
    },
  );

  // And it was turned away rather than half opened: the row it already had is
  // untouched, and no table of this code's making was left behind.
  const after = new DatabaseSync(file);
  t.after(() => after.close());
  assert.equal(
    after.prepare("SELECT name FROM sqlite_master WHERE name = 'decisions'").get(),
    undefined,
  );
  assert.equal(
    /** @type {{count: number}} */ (
      /** @type {unknown} */ (after.prepare('SELECT COUNT(*) AS count FROM memories').get())
    ).count,
    1,
  );
});

test('a store newer than this code is refused too, and says so differently', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.sqlite');

  // A perfectly ordinary store, stamped by a version of nosyparker that does
  // not exist yet. This is what a Phase 2 file looks like to Phase 1 code.
  const made = openStore({ file, now: () => '2026-01-01T00:00:00.000Z' });
  submit(made, { owner: OWNER, text: 'written by a later version' });
  made.close();

  const ahead = new DatabaseSync(file);
  ahead.exec('PRAGMA user_version = 99');
  ahead.close();

  assert.throws(
    () => openStore({ file, now: () => '2026-01-01T00:00:00.000Z' }),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(message, /newer version of nosyparker/u);
      assert.ok(message.includes(file), 'the message should name the file');

      // The two are different problems and the advice for one is wrong for the
      // other: telling somebody to put this file aside and start again would
      // throw away the memories the newer version wrote.
      assert.equal(/older version/u.test(message), false, 'that is the other case');
      assert.equal(/move the file aside/u.test(message), false);
      return true;
    },
  );

  // Refused, not quietly emptied: the memory it already held is still there.
  const after = new DatabaseSync(file);
  t.after(() => after.close());
  assert.equal(
    /** @type {{count: number}} */ (
      /** @type {unknown} */ (after.prepare('SELECT COUNT(*) AS count FROM memories').get())
    ).count,
    1,
  );
});

test('a closed store cannot be used again', (t) => {
  const store = temporaryStore();
  submit(store, { owner: OWNER, text: 'something to keep' });
  store.close();

  assert.throws(() => listMemories(store, OWNER), { name: 'TypeError' });
  t.diagnostic('a closed store forgets its handle rather than leaving it lying about');
});
