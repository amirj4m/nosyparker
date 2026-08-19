/**
 * Taking everything out.
 *
 * The claim the export makes is "everything", and the tests that matter here
 * are the ones that make that checkable rather than something somebody
 * remembered to do: every state, every table, and every column of every table.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { exportAll, writeExport } from '../src/export.js';
import {
  beginReview,
  closeReview,
  forget,
  review,
  submit,
} from '../src/gate.js';
import { listDecisions, listMemories, SCHEMA_VERSION } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

/**
 * A store with something in every state, and a review that reached every
 * outcome, so that anything the export leaves out is missing from the answer.
 *
 * @param {import('node:test').TestContext} t
 */
function fullStore(t) {
  const store = temporaryStore();
  t.after(() => store.close());

  const tehran = /** @type {number} */ (submit(store, { owner: OWNER, text: 'I live in Tehran' }).memory_id);
  const talk = /** @type {number} */ (
    submit(store, { owner: OWNER, text: 'Next week I am presenting at the all-hands' }).memory_id
  );
  const tea = /** @type {number} */ (submit(store, { owner: OWNER, text: 'I prefer tea' }).memory_id);
  const vienna = /** @type {number} */ (
    submit(store, { owner: OWNER, text: 'I have moved to Vienna', replaces: tehran }).memory_id
  );

  store.tick();
  forget(store, { owner: OWNER, id: tea, reason: 'I have gone off tea' });

  store.tick();
  const pass = /** @type {number} */ (
    beginReview(store, { owner: OWNER, reviewer: 'an agent tidying up' }).pass_id
  );
  review(store, {
    owner: OWNER,
    pass,
    id: talk,
    outcome: 'overtaken',
    reasoning: 'The week it named has gone by and nothing says how it went.',
    derivedFrom: [talk, vienna],
  });
  closeReview(store, { owner: OWNER, pass });

  // A refusal too, because the log is half of what an export is for and a
  // refusal is the half nothing else shows.
  submit(store, { owner: OWNER, text: '   ' });

  return { store, pass };
}

test('everything comes out, in every state, with the log', (t) => {
  const { store, pass } = fullStore(t);
  const dumped = JSON.parse(exportAll(store, OWNER));

  assert.deepEqual(
    dumped.memories.map((/** @type {any} */ m) => m.state).sort(),
    ['active', 'forgotten', 'overtaken', 'superseded'],
    'every state a memory can be in should be in the file',
  );

  // The store shows one of those four. An export of what `list` shows would be
  // a copy of something the person already has.
  assert.equal(listMemories(store, OWNER).length, 1);
  assert.equal(dumped.counts.shown, 1);
  assert.equal(dumped.counts.memories, 4);

  assert.equal(dumped.review_passes.length, 1);
  assert.equal(dumped.review_passes[0].id, pass);
  assert.equal(dumped.review_passes[0].reviewer, 'an agent tidying up');

  // The reasoning and the derivation, which live nowhere else at all.
  const finding = dumped.decisions.find((/** @type {any} */ d) => d.rule === 'overtaken');
  assert.match(finding.reasoning, /The week it named has gone by/u);
  assert.equal(finding.derived_from.split(' ').length, 2);

  // And the refusal.
  assert.ok(dumped.decisions.some((/** @type {any} */ d) => d.verdict === 'refused'));
  assert.equal(dumped.decisions.length, listDecisions(store, OWNER).length);
});

test('every column of every table is in the file, and nothing decides which', (t) => {
  const { store } = fullStore(t);
  const dumped = JSON.parse(exportAll(store, OWNER));

  // Asked of the file rather than written down here. Rows go out whole, so a
  // column added to the schema appears without anybody remembering to add it —
  // and this is what says so. Picking fields in `export.js` fails this.
  const columns = new DatabaseSync(store.file);
  t.after(() => columns.close());

  /** @param {string} table */
  const of = (table) => /** @type {{name: string}[]} */ (
    /** @type {unknown} */ (columns.prepare(`PRAGMA table_info(${table})`).all())
  ).map((row) => row.name).sort();

  for (const [table, key] of [['memories', 'memories'], ['review_passes', 'review_passes'],
    ['decisions', 'decisions']]) {
    assert.ok(dumped[key].length > 0, `${table} is empty, so this is checking nothing`);
    assert.deepEqual(Object.keys(dumped[key][0]).sort(), of(table),
      `the export of ${table} does not have the same columns the table does`);
  }
});

test('the file says what wrote it and what shape it is', (t) => {
  const { store } = fullStore(t);
  const dumped = JSON.parse(exportAll(store, OWNER));

  assert.equal(dumped.schema_version, SCHEMA_VERSION);
  assert.equal(dumped.owner, OWNER);
  assert.equal(dumped.store, store.file);
  assert.match(dumped.nosyparker, /^\d+\.\d+\.\d+$/u);

  // The clock is the store's, handed in at the door, which is why this test can
  // say what it will be. Two ticks, from the fixture.
  assert.equal(dumped.exported, '2026-01-01T00:00:02.000Z');
});

test('exporting changes nothing at all', (t) => {
  const { store } = fullStore(t);

  const before = fs.readFileSync(store.file);
  const decisions = listDecisions(store, OWNER).length;

  exportAll(store, OWNER);
  exportAll(store, OWNER);

  assert.equal(listDecisions(store, OWNER).length, decisions, 'an export left a row behind');
  // Through JSON on both sides: `node:sqlite` hands back objects with a null
  // prototype and a strict comparison against parsed ones fails on that alone,
  // which says nothing about the rows.
  assert.deepEqual(
    JSON.parse(JSON.stringify(listMemories(store, OWNER, { includeArchived: true }))),
    JSON.parse(exportAll(store, OWNER)).memories,
  );
  // The bytes, since a read that quietly wrote would be a read that changed the
  // one thing this command exists to protect.
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('an empty store gives a file, not an error', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const dumped = JSON.parse(exportAll(store, OWNER));

  assert.deepEqual(dumped.memories, []);
  assert.deepEqual(dumped.decisions, []);
  assert.deepEqual(dumped.review_passes, []);
  assert.equal(dumped.counts.memories, 0);
});

test('it will not write over a file that is already there', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const file = path.join(store.dir, 'dump.json');

  assert.match(writeExport(file, exportAll(store, OWNER)), /Written to/u);

  // The moment somebody reaches for an export is the moment they are already in
  // trouble, which is exactly when replacing yesterday's copy with today's
  // costs them the one they meant to keep.
  const kept = fs.readFileSync(file, 'utf8');
  assert.throws(() => writeExport(file, '{"different": true}'), /EEXIST/u);
  assert.equal(fs.readFileSync(file, 'utf8'), kept);
});

test('what comes out is JSON, indented, and ends in a newline', (t) => {
  const { store } = fullStore(t);
  const text = exportAll(store, OWNER);

  assert.doesNotThrow(() => JSON.parse(text));
  assert.ok(text.endsWith('}\n'));
  assert.match(text, /^\{\n {2}"nosyparker"/u, 'it should read down the page, not sideways');
});
