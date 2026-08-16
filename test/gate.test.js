/**
 * Every rule the gate has, one test each, in the order they are tried.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { forget, restore, submit } from '../src/gate.js';
import {
  DENSEST_TRIGRAM_LIMIT,
  densestTrigram,
  getMemory,
  listDecisions,
  listMemories,
} from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

test('rule 1: a credential is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: ['AKIA', 'IOSFODNN7EXAMPLE'].join('') });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'credential');
  assert.equal(result.memory_id, null);
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 1 recognises every shape it claims to', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // These are invented, but they are shaped like the real thing, which is the
  // point. They are assembled from pieces at runtime so that this file does
  // not itself contain a string that a secret scanner has to think about.
  const secrets = [
    ['-----BEGIN RSA', ' PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'],
    ['AKIA', 'IOSFODNN7EXAMPLE'],
    ['ghp', '_1234567890abcdefghijklmnopqrstuvwxyzAB'],
    ['github', '_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789'],
    ['xoxb', '-123456789012-abcdefghijklmnop'],
    ['sk-ant', '-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['sk-proj', '-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['AIza', 'SyA1234567890abcdefghijklmnopqrstuvw'],
    ['glpat', '-abcdefghijklmnopqrstuvwx'],
    ['eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9Pl'],
    ['postgres://admin:', 'hunter2@db.example.com:5432/app'],
    ['password', ': correct-horse-battery'],
    ['4111 ', '1111 1111 1111'],
    ['Zm9vYmFyMTIzNDU2', 'Nzg5MFFXRVJUWVVJT1A'],
  ].map((parts) => parts.join(''));

  for (const secret of secrets) {
    const result = submit(store, { owner: OWNER, text: secret });
    assert.equal(result.rule, 'credential', `should have been refused: ${secret.slice(0, 20)}`);
  }

  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 1 catches a card number with another number beside it', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // Every one of these was stored in plain text when only whole digit runs
  // were checked, because the card and its neighbour read as one long run.
  const cards = [
    'ref4 4111 1111 1111 1111',
    '4111111111111111 7',
    'order 12 4111111111111111',
    'id 9 5500005555555559',
    'a1 378282246310005',
    '4111 1111 1111 1111',
    'x4111111111111111',
    '1 4111111111111111',
    'invoice 2024 total 4111-1111-1111-1111 paid',
  ];

  for (const text of cards) {
    const result = submit(store, { owner: OWNER, text });
    assert.equal(result.rule, 'credential', `should have been refused: ${text}`);
  }

  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 1 leaves ordinary sentences about secrets alone', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const fine = [
    'my deployment key is in 1Password',
    'the database password lives in the team vault, ask Sara',
    'I always rotate my tokens in January',
    'card ending 1111 is the one to use for travel',
  ];

  for (const text of fine) {
    const result = submit(store, { owner: OWNER, text });
    assert.equal(result.verdict, 'stored', `should have been stored: ${text}`);
  }
});

test('rule 3: whitespace only is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: '   \n\t  ' });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'empty');
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 4: the same sentence again is refused, and points at the original', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'I take my coffee black' });
  const again = submit(store, { owner: OWNER, text: '  I TAKE my   coffee black ' });

  assert.equal(again.verdict, 'refused');
  assert.equal(again.rule, 'already-stored');
  assert.equal(again.related_memory_id, first.memory_id);
  assert.equal(listMemories(store, OWNER).length, 1);
});

test('rule 4 does not treat different punctuation as the same sentence', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: "Let's eat, grandma" });
  const second = submit(store, { owner: OWNER, text: "Let's eat grandma" });

  assert.equal(second.verdict, 'stored');
  assert.equal(listMemories(store, OWNER).length, 2);
});

test('rule 4 only compares against active memories', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'I work from home on Fridays' });
  forget(store, { owner: OWNER, id: /** @type {number} */ (first.memory_id), reason: 'changed' });

  const again = submit(store, { owner: OWNER, text: 'I work from home on Fridays' });
  assert.equal(again.verdict, 'stored');
});

test('rule 5: replacing an id that is not there is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: 'something new', replaces: 99 });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'replaces-unknown');
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 5 also covers another owner and an already archived memory', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const theirs = submit(store, { owner: 'someone-else', text: 'their memory' });
  const stealing = submit(store, {
    owner: OWNER,
    text: 'my replacement',
    replaces: /** @type {number} */ (theirs.memory_id),
  });
  assert.equal(stealing.rule, 'replaces-unknown');

  const mine = submit(store, { owner: OWNER, text: 'I cycle to work' });
  forget(store, { owner: OWNER, id: /** @type {number} */ (mine.memory_id), reason: 'no longer' });

  const late = submit(store, {
    owner: OWNER,
    text: 'I take the tram to work',
    replaces: /** @type {number} */ (mine.memory_id),
  });
  assert.equal(late.rule, 'replaces-unknown');
});

test('rule 6: replacing a real memory supersedes it and links both ways', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const old = submit(store, { owner: OWNER, text: 'I live in Tehran' });
  const fresh = submit(store, {
    owner: OWNER,
    text: 'I live in Berlin',
    replaces: /** @type {number} */ (old.memory_id),
  });

  assert.equal(fresh.verdict, 'superseded');
  assert.equal(fresh.rule, 'replaces');

  const archived = { includeArchived: true };
  const oldRow = getMemory(store, OWNER, /** @type {number} */ (old.memory_id), archived);
  const newRow = getMemory(store, OWNER, /** @type {number} */ (fresh.memory_id));

  assert.equal(oldRow?.state, 'superseded');
  assert.equal(oldRow?.superseded_by, fresh.memory_id);
  assert.equal(newRow?.state, 'active');
  assert.equal(newRow?.supersedes, old.memory_id);
  assert.deepEqual(
    listMemories(store, OWNER).map((memory) => memory.id),
    [fresh.memory_id],
  );
});

test('rule 7: anything else is stored', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: 'I read faster than I listen' });

  assert.equal(result.verdict, 'stored');
  assert.equal(result.rule, 'keep');
  assert.equal(getMemory(store, OWNER, /** @type {number} */ (result.memory_id))?.state, 'active');
});

test('rule 8: forgetting archives the memory and keeps the reason', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I am vegetarian' });
  const result = forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (stored.memory_id),
    reason: 'I eat fish again',
  });

  assert.equal(result.verdict, 'forgotten');
  assert.equal(result.rule, 'forget');

  const row = getMemory(store, OWNER, /** @type {number} */ (stored.memory_id), {
    includeArchived: true,
  });
  assert.equal(row?.state, 'forgotten');
  assert.equal(row?.state_reason, 'I eat fish again');
  assert.equal(listMemories(store, OWNER).length, 0);
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 1);
});

test('rule 9: forgetting an id that is not yours is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const theirs = submit(store, { owner: 'someone-else', text: 'their memory' });
  const result = forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (theirs.memory_id),
    reason: 'not mine to forget',
  });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'forget-unknown');
  assert.equal(getMemory(store, 'someone-else', /** @type {number} */ (theirs.memory_id))?.state, 'active');
});

test('the order of the rules is the order in the specification', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // A credential that is also a duplicate and also names a bad id: the
  // credential rule has to be the one that answers.
  submit(store, { owner: OWNER, text: 'placeholder' });
  const credentialFirst = submit(store, {
    owner: OWNER,
    text: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
    replaces: 99,
  });
  assert.equal(credentialFirst.rule, 'credential');

  // A duplicate that also names a bad id: already-stored comes before
  // replaces-unknown.
  const duplicateFirst = submit(store, { owner: OWNER, text: 'placeholder', replaces: 99 });
  assert.equal(duplicateFirst.rule, 'already-stored');
});

test('nothing is ever removed by storing, replacing or forgetting', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const one = submit(store, { owner: OWNER, text: 'first' });
  const two = submit(store, {
    owner: OWNER,
    text: 'second',
    replaces: /** @type {number} */ (one.memory_id),
  });
  forget(store, { owner: OWNER, id: /** @type {number} */ (two.memory_id), reason: 'done' });

  const everything = listMemories(store, OWNER, { includeArchived: true });
  assert.equal(everything.length, 2);
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('every call writes exactly one decision row, refusals included', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I like long walks' }); // stored
  submit(store, { owner: OWNER, text: '   ' }); // refused, empty
  submit(store, { owner: OWNER, text: 'I like long walks' }); // refused, duplicate
  submit(store, { owner: OWNER, text: ['ghp', '_1234567890abcdefghijklmnopqrstuvwxyzAB'].join('') });
  submit(store, { owner: OWNER, text: 'nope', replaces: 404 }); // refused, unknown id
  forget(store, { owner: OWNER, id: 404, reason: 'not there' }); // refused, unknown id
  restore(store, { owner: OWNER, id: 404 }); // refused, unknown id

  const log = listDecisions(store, OWNER);
  assert.equal(log.length, 7);
  assert.deepEqual(
    log.map((decision) => decision.rule),
    ['keep', 'empty', 'already-stored', 'credential', 'replaces-unknown', 'forget-unknown', 'restore-unknown'],
  );
  assert.equal(log.filter((decision) => decision.verdict === 'refused').length, 6);

  for (const decision of log) {
    assert.ok(decision.explanation.length > 0, 'every decision explains itself');
    assert.ok(decision.decided_at.length > 0);
  }
});

test('the gate has twelve rule names and no more', () => {
  // Twelve outcomes, so twelve names. Nine were written down in the
  // specification; `restored` is the tenth, because a restore that works has
  // to say which rule answered it and none of the other nine is that rule.
  // `control-character` is the eleventh and `too-repetitive` the twelfth, and
  // the vocabulary was opened for each deliberately — see the note at the top
  // of gate.js for why each is a rule rather than a check somewhere else.
  //
  // Written out in full on purpose. Loosening this to a count, or to a subset
  // that new names slip past, is how the check stops being one.
  const VOCABULARY = [
    'credential',
    'control-character',
    'too-repetitive',
    'empty',
    'already-stored',
    'replaces-unknown',
    'replaces',
    'keep',
    'forget',
    'forget-unknown',
    'restore-unknown',
    'restored',
  ];

  // Read out of the file rather than collected from a run, because a run can
  // only show that a name is reachable. The half that matters here is the
  // other half: that there is no eleventh name anywhere in the gate. Two
  // reviews read past `restored` because nothing was checking for that.
  const source = fs.readFileSync(new URL('../src/gate.js', import.meta.url), 'utf8');
  const named = [...source.matchAll(/\brule: '([^']*)'/gu)].map((match) => match[1]);

  assert.deepEqual([...new Set(named)].sort(), [...VOCABULARY].sort());
});

test('a decision row and its memory arrive together or not at all', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I answer email in the morning' });
  const log = listDecisions(store, OWNER);

  assert.equal(log.length, 1);
  assert.equal(log[0].memory_id, stored.memory_id);
  assert.equal(log[0].decided_at, getMemory(store, OWNER, /** @type {number} */ (stored.memory_id))?.created_at);
});

test('the excerpt on a decision row is capped at 160 characters', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'x'.repeat(500) });
  const [decision] = listDecisions(store, OWNER);

  assert.equal([...decision.input_excerpt].length, 160);
});

test('the excerpt counts characters, and never cuts one in half', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const scripts = [
    '🌍'.repeat(200), // outside the basic plane, two code units each
    '柏'.repeat(200),
    'ی'.repeat(200),
    'a🌍'.repeat(150), // a cut that lands mid character if you count wrong
  ];

  for (const text of scripts) {
    submit(store, { owner: OWNER, text });
  }

  for (const decision of listDecisions(store, OWNER)) {
    const characters = [...decision.input_excerpt];
    assert.equal(characters.length, 160, 'the excerpt should hold 160 characters');

    // A lone half of a surrogate pair is the damage this guards against.
    for (const character of characters) {
      const code = character.codePointAt(0) ?? 0;
      assert.equal(code >= 0xd800 && code <= 0xdfff, false, 'a character was cut in half');
    }

    // Round tripping through the database has to leave it unchanged.
    assert.equal(decision.input_excerpt.normalize('NFC'), decision.input_excerpt);
  }
});

// Rule 2. A control character is invisible, so every one of these builds it
// from its code point rather than pasting it into the source.
const NUL = String.fromCharCode(0);

test('rule 2: text that will not read back whole is refused, and leaves a row', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const refused = submit(store, { owner: OWNER, text: `ZQHEAD twenty chars.${NUL}ZQTAIL the rest` });

  assert.equal(refused.verdict, 'refused');
  assert.equal(refused.rule, 'control-character');
  assert.match(refused.explanation, /U\+0000/u);
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 0);

  // A rule, so it leaves a mark — which is the whole reason it is one.
  const [decision] = listDecisions(store, OWNER);
  assert.equal(decision.rule, 'control-character');

  // And the excerpt does not quote it. It could not be quoted honestly: the
  // log would cut it off in the same place the memory did.
  assert.equal(decision.input_excerpt.includes('ZQHEAD'), false);
  assert.equal(decision.input_excerpt.includes('ZQTAIL'), false);
});

test('rule 2 covers the other invisible characters, and leaves ordinary text alone', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  for (const code of [1, 8, 11, 12, 27, 31]) {
    const result = submit(store, { owner: OWNER, text: `before${String.fromCharCode(code)}after` });
    assert.equal(result.rule, 'control-character', `U+${code.toString(16)} should be refused`);
  }

  // Tab, newline and carriage return are things people type.
  assert.equal(submit(store, { owner: OWNER, text: 'one\ntwo\tthree\rfour' }).verdict, 'stored');
  assert.equal(submit(store, { owner: OWNER, text: '我住在柏林 🎉' }).verdict, 'stored');
});

test('rule 2 closes the ways a NUL walked past the other rules', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'ZQDUP the same sentence' });
  const id = /** @type {number} */ (stored.memory_id);

  // The duplicate rule: the same sentence with a NUL and a tail used to be a
  // second memory that read back identical to the first.
  assert.equal(
    submit(store, { owner: OWNER, text: `ZQDUP the same sentence${NUL}extra` }).rule,
    'control-character',
  );
  assert.equal(listMemories(store, OWNER).length, 1);

  // The blank-reason check: a NUL reason is not blank to `trim`, and used to
  // put a memory away for no stated reason at all.
  assert.equal(forget(store, { owner: OWNER, id, reason: NUL }).rule, 'control-character');
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
});

test('a credential split by a control character reaches neither the store nor the file', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // Assembled at runtime so this file does not itself hold a key shape.
  const half = ['ZQMARKER', '9XYZABCD'].join('');
  const split = `my key AKIA${NUL}${half}`;

  assert.equal(submit(store, { owner: OWNER, text: split }).rule, 'control-character');

  // Something real first, so a miss below means absence rather than a broken
  // method.
  submit(store, { owner: OWNER, text: 'I prefer meetings before noon' });

  const database = fs.readFileSync(store.file);
  const wal = fs.readFileSync(`${store.file}-wal`);
  /**
   * @param {Buffer} bytes
   * @param {string} text
   * @returns {boolean}
   */
  const has = (bytes, text) => bytes.includes(Buffer.from(text, 'utf8'));

  assert.ok(
    has(database, 'I prefer meetings before noon') || has(wal, 'I prefer meetings before noon'),
    'a stored memory should be findable, or this scan proves nothing',
  );
  assert.equal(has(database, half), false, 'the second half reached the database file');
  assert.equal(has(wal, half), false, 'the second half reached the write ahead log');
});

test('what is stored is what reads back, for every memory in the file', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  for (const text of ['I live in Berlin', '我住在柏林', 'one\ntwo', 'ends with a space ', '🎉🎉🎉']) {
    submit(store, { owner: OWNER, text });
  }
  submit(store, { owner: OWNER, text: `refused${NUL}anyway` });

  // The bytes SQLite is holding, asked of the file directly, against the
  // bytes that come back through the ordinary read. These disagreed before
  // rule 2: forty two characters written, twenty read back, and nothing
  // anywhere said so.
  const onDisk = new DatabaseSync(store.file, { readOnly: true });
  const rows = /** @type {{id: number, text: string, bytes: number}[]} */ (
    /** @type {unknown} */ (
      onDisk.prepare('SELECT id, text, length(CAST(text AS BLOB)) AS bytes FROM memories').all()
    )
  );
  onDisk.close();

  assert.equal(rows.length, 5, 'the refused one is not in the file');

  for (const row of rows) {
    assert.equal(
      row.bytes,
      Buffer.byteLength(row.text, 'utf8'),
      `memory ${row.id} holds ${row.bytes} bytes but reads back as ${Buffer.byteLength(row.text, 'utf8')}`,
    );
  }
});


test('rule 3 also covers a reason that says nothing, and leaves its row', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I am vegetarian' });
  const id = /** @type {number} */ (stored.memory_id);

  for (const reason of ['', '   ', '\n\t ']) {
    const result = forget(store, { owner: OWNER, id, reason });
    assert.equal(result.verdict, 'refused');
    assert.equal(result.rule, 'empty', `should have been refused: ${JSON.stringify(reason)}`);
  }

  // The memory was left alone, and every attempt is in the log — which is the
  // reason this moved out of the adapter, where it left no trace at all.
  assert.equal(getMemory(store, OWNER, id)?.state, 'active');
  assert.equal(getMemory(store, OWNER, id)?.state_reason, null);
  assert.equal(listDecisions(store, OWNER).filter((d) => d.rule === 'empty').length, 3);

  // A reason that says something still works.
  assert.equal(forget(store, { owner: OWNER, id, reason: 'I eat fish again' }).verdict, 'forgotten');
});


test('rule 4: text too repetitive to search is refused, and leaves a row', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const refused = submit(store, { owner: OWNER, text: 'x'.repeat(100_000) });

  assert.equal(refused.verdict, 'refused');
  assert.equal(refused.rule, 'too-repetitive');
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 0);

  // The sentence has to be about repetition, not length, or a person pasting
  // a long ordinary document reads it and changes the wrong thing.
  assert.match(refused.explanation, /same three characters occur/u);
  assert.match(refused.explanation, /not how long it is/u);
  assert.match(refused.explanation, /ordinary writing of this length is fine/u);

  const [decision] = listDecisions(store, OWNER);
  assert.equal(decision.rule, 'too-repetitive');
});

test('rule 4 clears ordinary text by a wide margin, in any language', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const sentence = 'I answer email in the morning and prefer meetings before noon. ';
  const chinese = '我住在柏林并且喜欢安静的办公室因为我需要思考。';
  const fine = [
    ['one fact', 'I prefer to be written to in short sentences'],
    ['a 2 KB note', sentence.repeat(33).slice(0, 2_000)],
    ['a 10 KB paste', sentence.repeat(162).slice(0, 10_000)],
    ['a 100 KB paste', sentence.repeat(1_613).slice(0, 100_000)],
    ['10 KB of Chinese', chinese.repeat(455).slice(0, 10_000)],
    ['100 KB of log lines', '2026-08-16T09:00:00Z INFO request handled ok\n'.repeat(2_223).slice(0, 100_000)],
  ];

  for (const [what, text] of fine) {
    const result = submit(store, { owner: OWNER, text });
    assert.equal(result.verdict, 'stored', `${what} should have been stored`);
    assert.ok(
      densestTrigram(store, text) < DENSEST_TRIGRAM_LIMIT / 4,
      `${what} is closer to the limit than it should be: ${densestTrigram(store, text)}`,
    );
  }
});

test('rule 4 catches what actually poisons a search, including prose that repeats', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const bad = [
    ['400 KB of one character', 'x'.repeat(400_000)],
    ['400 KB of "the the the"', 'the '.repeat(100_000)],
    ['a 30 KB run inside ordinary text', `I pasted this in by mistake: ${'y'.repeat(30_000)} sorry`],
  ];

  for (const [what, text] of bad) {
    assert.equal(submit(store, { owner: OWNER, text }).rule, 'too-repetitive', `${what} got through`);
  }
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 0);
});

test('rule 4 is measured on the offered memory alone, not on the store around it', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // This is where the read-time estimate went wrong: ordinary memories
  // containing the same run dragged the average down and let the dense one
  // through. A per-document measurement cannot be moved by its neighbours.
  for (let index = 0; index < 100; index += 1) {
    submit(store, { owner: OWNER, text: `note ${index} mentioning xxx in passing` });
  }

  assert.equal(submit(store, { owner: OWNER, text: 'x'.repeat(100_000) }).rule, 'too-repetitive');
  assert.equal(listMemories(store, OWNER).length, 100, 'and the ordinary ones are untouched');
});
