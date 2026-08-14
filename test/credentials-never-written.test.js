/**
 * The test that matters most.
 *
 * A refused credential must not exist anywhere in the store, so this reads the
 * database file and the write ahead log as raw bytes and looks for it. Asking
 * the database with a query would only prove that no row has it. Reading the
 * bytes proves it was never written at all.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { forget, restore, submit } from '../src/gate.js';
import { getMemory, listDecisions, listMemories } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

// Invented, and assembled at runtime so that this file does not itself hold a
// string shaped like a key.
const SECRET = ['AKIA', 'QQQZZZTESTKEY999'].join('');
const ANOTHER_SECRET = ['postgres://admin:', 'hunter2isthepassword@db.example.com:5432/app'].join('');

test('a refused credential appears in neither the database file nor the write ahead log', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // Ordinary memories first, so the file has real content in it and the
  // search below is not looking through an empty file.
  submit(store, { owner: OWNER, text: 'I prefer meetings before noon' });
  submit(store, { owner: OWNER, text: 'my deployment key is in 1Password' });

  const refusedKey = submit(store, { owner: OWNER, text: `my aws key is ${SECRET}` });
  const refusedUrl = submit(store, { owner: OWNER, text: ANOTHER_SECRET });

  assert.equal(refusedKey.rule, 'credential');
  assert.equal(refusedUrl.rule, 'credential');

  const database = fs.readFileSync(store.file);
  const wal = fs.readFileSync(`${store.file}-wal`);

  // The scan finds text that really is in the file, so a miss below means the
  // secret is absent rather than the method being broken.
  assert.ok(
    contains(database, 'I prefer meetings before noon') ||
      contains(wal, 'I prefer meetings before noon'),
    'a stored memory should be findable in the bytes',
  );

  for (const secret of [SECRET, ANOTHER_SECRET, 'hunter2isthepassword']) {
    assert.equal(contains(database, secret), false, `${secret} was found in the database file`);
    assert.equal(contains(wal, secret), false, `${secret} was found in the write ahead log`);
  }
});

test('a credential in a reason for forgetting is refused too', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I use the staging server on Fridays' });
  const id = /** @type {number} */ (stored.memory_id);
  const leak = ['AKIA', 'LEAKLEAKLEAKLEAK'].join('');

  const result = forget(store, { owner: OWNER, id, reason: `rotating ${leak}` });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'credential');

  // The memory was left alone, because the call was refused before it acted.
  const row = getMemory(store, OWNER, id);
  assert.equal(row?.state, 'active');
  assert.equal(row?.state_reason, null);

  const [, decision] = listDecisions(store, OWNER);
  assert.equal(decision.input_excerpt.includes(leak), false);
  assert.equal(decision.input_excerpt, '[not recorded: recognised as an AWS access key]');

  const database = fs.readFileSync(store.file);
  const wal = fs.readFileSync(`${store.file}-wal`);
  assert.equal(contains(database, leak), false, 'the reason reached the database file');
  assert.equal(contains(wal, leak), false, 'the reason reached the write ahead log');
});

test('a credential given as the owner name is refused on every entry point', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const leak = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

  const stored = submit(store, { owner: leak, text: 'hello there friend' });
  assert.equal(stored.verdict, 'refused');
  assert.equal(stored.rule, 'credential');

  assert.equal(forget(store, { owner: leak, id: 1, reason: 'a reason' }).rule, 'credential');
  assert.equal(restore(store, { owner: leak, id: 1 }).rule, 'credential');

  // Nothing was stored under that name, and the name is not in the log either.
  assert.equal(listMemories(store, leak, { includeArchived: true }).length, 0);
  assert.equal(listDecisions(store, leak).length, 0);
  assert.equal(listDecisions(store, '[owner not recorded]').length, 3, 'but the refusals are logged');

  const database = fs.readFileSync(store.file);
  const wal = fs.readFileSync(`${store.file}-wal`);
  assert.equal(contains(database, leak), false, 'the owner name reached the database file');
  assert.equal(contains(wal, leak), false, 'the owner name reached the write ahead log');
});

test('the log records that something was refused without recording what it was', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: SECRET });
  const [decision] = listDecisions(store, OWNER);

  assert.equal(decision.rule, 'credential');
  assert.equal(decision.input_excerpt, '[not recorded: recognised as an AWS access key]');

  // Not even how long it was, which is still a fact about the secret.
  assert.equal(/\d/u.test(decision.input_excerpt), false);
  assert.equal(decision.input_excerpt.includes(SECRET), false);
  assert.equal(decision.explanation.includes(SECRET), false);
});

test('not one fragment of a refused credential survives, not even a short run of it', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: `${['sk-ant', '-api03-'].join('')}${'Zq7'.repeat(12)}` });

  const database = fs.readFileSync(store.file);
  const wal = fs.readFileSync(`${store.file}-wal`);

  assert.equal(contains(database, 'sk-ant-'), false);
  assert.equal(contains(wal, 'sk-ant-'), false);
  assert.equal(contains(database, 'Zq7Zq7Zq7'), false);
  assert.equal(contains(wal, 'Zq7Zq7Zq7'), false);
});

/**
 * Is this text anywhere in these bytes, in either of the encodings SQLite
 * stores text in?
 *
 * @param {Buffer} bytes
 * @param {string} text
 * @returns {boolean}
 */
function contains(bytes, text) {
  return (
    bytes.includes(Buffer.from(text, 'utf8')) ||
    bytes.includes(Buffer.from(text, 'utf16le')) ||
    bytes.includes(Buffer.from(text, 'latin1'))
  );
}
