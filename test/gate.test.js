/**
 * Every rule the gate has, one test each, in the order they are tried.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { forget, restore, submit } from '../src/gate.js';
import {
  getMemory,
  listDecisions,
  listMemories,
  REPETITION_LIMIT,
  repetitionOf,
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

test('a card is a card in every script it can be written in', (t) => {
  // The worst finding of this project, and it was found by somebody storing his
  // own card by accident. `remember` was called with the number in
  // Persian-Indic digits and answered "Stored." — no refusal and no record of
  // one. The number sat in the plaintext store, and in the decision log's
  // excerpt, until it was taken out by hand.
  //
  // One character class caused it. `containsPaymentCard` matched `\d`, which in
  // JavaScript means ASCII `[0-9]` even under the `u` flag, so ۵۱۶۷ was not a
  // digit as far as the screen was concerned and there was nothing to checksum.
  //
  // This sits in a project that chose a trigram tokenizer because `unicode61`
  // returned nothing for Chinese and Japanese. We knew at the schema level that
  // this is not an English-only tool, and then wrote a guard that was.
  //
  // Each form is generated from the standard test card rather than typed out,
  // so it is a real string in that script and not a transliteration.
  const store = temporaryStore();
  t.after(() => store.close());

  const inScript = (/** @type {string} */ text, /** @type {number} */ zero) =>
    text.replace(/[0-9]/gu, (d) => String.fromCodePoint(zero + Number(d)));

  const card = '4111 1111 1111 1111';

  for (const [script, zero] of /** @type {[string, number][]} */ ([
    ['Persian', 0x06F0],
    ['Arabic-Indic', 0x0660],
    ['Devanagari', 0x0966],
    ['Bengali', 0x09E6],
    ['full-width', 0xFF10],
  ])) {
    const text = inScript(card, zero);
    assert.equal(submit(store, { owner: OWNER, text }).rule, 'credential',
      `a card in ${script} digits was stored`);
  }

  // Half in one script and half in another, which is what somebody actually
  // types when a keyboard layout changes partway through a number.
  assert.equal(
    submit(store, { owner: OWNER, text: `4111 1111 ${inScript('1111 1111', 0x06F0)}` }).rule,
    'credential', 'a card written half in ASCII and half in Persian was stored');

  // NFKC was the proposed one-line fix and this is the line that says it is
  // not one: it folds full-width digits to ASCII and leaves Persian,
  // Arabic-Indic, Devanagari and Bengali untouched, so it would have closed one
  // hole out of five.
  assert.equal(inScript(card, 0x06F0).normalize('NFKC'), inScript(card, 0x06F0),
    'NFKC now changes Persian digits, so this fix can be reconsidered');

  assert.equal(listMemories(store, OWNER).length, 0);
});

test('a space that is not a space does not hide a card', (t) => {
  // Found in the same survey and nothing to do with scripts: the digits are
  // ordinary ASCII and only the separator is unusual. A non-breaking space is
  // what a paste out of a PDF, a bank statement or a web page carries, so this
  // is the ordinary case for anybody who copies rather than types.
  const store = temporaryStore();
  t.after(() => store.close());

  for (const [name, gap] of /** @type {[string, string][]} */ ([
    ['non-breaking space', '\u00A0'],
    ['narrow non-breaking space', '\u202F'],
    ['figure space', '\u2007'],
  ])) {
    const text = '4111 1111 1111 1111'.replaceAll(' ', gap);
    assert.equal(submit(store, { owner: OWNER, text }).rule, 'credential',
      `a card separated by a ${name} was stored`);
  }

  assert.equal(listMemories(store, OWNER).length, 0);
});

test('a labelled secret is labelled in more than one language', (t) => {
  // The other half of the same defect. The word list that spots "password: x"
  // was English, in a store whose owner writes Persian, so `رمز عبور: hunter2`
  // went in as plain text. Same blindness as the card, wearing different
  // clothes: guards written by English speakers, tested in English.
  //
  // The list is still a list and cannot be complete — every language not in it
  // is a hole, which is why the rules that carry the weight here are about the
  // shape of a secret rather than the word beside it. This test holds the
  // languages we claim, not a claim to have finished.
  const store = temporaryStore();
  t.after(() => store.close());

  for (const [language, text] of /** @type {[string, string][]} */ ([
    ['English', 'password: hunter2goeshere'],
    ['Persian', 'رمز عبور: hunter2goeshere'],
    ['Arabic', 'كلمة المرور: hunter2goeshere'],
    ['Hindi', 'पासवर्ड: hunter2goeshere'],
    ['Urdu', 'پاس ورڈ: hunter2goeshere'],
    ['Chinese', '密码: hunter2goeshere'],
    ['Japanese', 'パスワード: hunter2goeshere'],
    ['Korean', '비밀번호: hunter2goeshere'],
    ['Spanish', 'contraseña: hunter2goeshere'],
    ['French', 'mot de passe : hunter2goeshere'],
    ['German', 'Passwort: hunter2goeshere'],
    ['Russian', 'пароль: hunter2goeshere'],
    ['Turkish', 'şifre: hunter2goeshere'],
  ])) {
    assert.equal(submit(store, { owner: OWNER, text }).rule, 'credential',
      `a secret labelled in ${language} was stored`);
  }

  // And a sentence that talks about a password without carrying one is still a
  // fact, in every one of those scripts. A rule that refuses these is worse
  // than no rule, because people learn to route around it.
  for (const [language, text] of /** @type {[string, string][]} */ ([
    ['English', 'I keep my password in a password manager'],
    ['Persian', 'رمز عبور من در برنامه مدیریت رمز است'],
    ['Chinese', '我把密码存在密码管理器里'],
    ['English again', 'the secret to good bread is time'],
  ])) {
    assert.equal(submit(store, { owner: OWNER, text }).rule, 'keep',
      `an ordinary sentence in ${language} was refused`);
  }
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

test('rule 4: whitespace only is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: '   \n\t  ' });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'empty');
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 6: the same sentence again is refused, and points at the original', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'I take my coffee black' });
  const again = submit(store, { owner: OWNER, text: '  I TAKE my   coffee black ' });

  assert.equal(again.verdict, 'refused');
  assert.equal(again.rule, 'already-stored');
  assert.equal(again.related_memory_id, first.memory_id);
  assert.equal(listMemories(store, OWNER).length, 1);
});

test('rule 6 does not treat different punctuation as the same sentence', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: "Let's eat, grandma" });
  const second = submit(store, { owner: OWNER, text: "Let's eat grandma" });

  assert.equal(second.verdict, 'stored');
  assert.equal(listMemories(store, OWNER).length, 2);
});

test('rule 6 only compares against active memories', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'I work from home on Fridays' });
  forget(store, { owner: OWNER, id: /** @type {number} */ (first.memory_id), reason: 'changed' });

  const again = submit(store, { owner: OWNER, text: 'I work from home on Fridays' });
  assert.equal(again.verdict, 'stored');
});

test('rule 7: replacing an id that is not there is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: 'something new', replaces: 99 });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'replaces-unknown');
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 7 also covers another owner and an already archived memory', (t) => {
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

test('rule 8: replacing a real memory supersedes it and links both ways', (t) => {
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

test('rule 9: anything else is stored', (t) => {
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

test('the gate has twenty rule names and no more', () => {
  // Twelve outcomes, so twelve names. Nine were written down in the
  // specification; `restored` is the tenth, because a restore that works has
  // to say which rule answered it and none of the other nine is that rule.
  // `control-character` is the eleventh and `file-not-fact` the twelfth, each
  // opened deliberately — see the note at the top of gate.js for why each is a
  // rule rather than a check somewhere else.
  //
  // The twelfth slot was used once before, by `too-repetitive`, which refused
  // text that looked expensive to search. It was removed when measurement
  // showed it ranked a deeply indented source file as worse than a document of
  // one word repeated a hundred thousand times, and the vocabulary closed back
  // to eleven before opening again for this one. That history is why this list
  // is written out rather than counted.
  //
  // Loosening this to a count, or to a subset that new names slip past, is how
  // the check stops being one.
  //
  // Phase 4 opened it by eight, for the review, and the eight are the second
  // group below. Two things it did not open it for are worth saying, because
  // both were on the table and both would have been easy: marking one stored
  // memory as replaced by another is the judgement `replaces` already names,
  // reached at a different door, and every way the replacement id can be
  // unusable is the one `replaces-unknown` already names. Reusing those two is
  // the same move `file-not-fact` and `empty` made before them.
  const VOCABULARY = [
    'credential',
    'control-character',
    'file-not-fact',
    'empty',
    'already-stored',
    'replaces-unknown',
    'replaces',
    'keep',
    'forget',
    'forget-unknown',
    'restore-unknown',
    'restored',

    // The review.
    'review-began',
    'review-closed',
    'review-undone',
    'review-not-open',
    'review-unknown',
    'derived-from',
    'overtaken',
    'undecided',
  ];

  // Read out of the file rather than collected from a run, because a run can
  // only show that a name is reachable. The half that matters here is the
  // other half: that there is no twenty-first name anywhere in the gate. Two
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

test('rule 3: text that will not read back whole is refused, and leaves a row', (t) => {
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

test('rule 3 covers the other invisible characters, and leaves ordinary text alone', (t) => {
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

test('rule 3 closes the ways a NUL walked past the other rules', (t) => {
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

test('rule 4 also covers a reason that says nothing, and leaves its row', (t) => {
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



test('rule 5: a file pasted as a memory is refused, and leaves a row', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const log = '2026-08-16T09:14:22.031Z INFO  request handled  status=200 duration=14ms\n';
  const refused = submit(store, { owner: OWNER, text: log.repeat(120) });

  assert.equal(refused.verdict, 'refused');
  assert.equal(refused.rule, 'file-not-fact');
  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 0);

  // The sentence is the product speaking. It has to tell a person what to do
  // instead, and tell an agent to summarise rather than paste again.
  assert.match(refused.explanation, /reads as a file rather than something to remember/u);
  assert.match(refused.explanation, /keeps facts, not documents/u);
  assert.match(refused.explanation, /Read it, decide what matters/u);
  assert.match(refused.explanation, /same text again will get the same answer/u);
  assert.equal(/trigram|ratio|character run/iu.test(refused.explanation), false, 'no jargon');

  // It has to be true of the other thing that scores high: a sequence over a
  // very small alphabet, which is random rather than repetitive. Saying "the
  // same few characters over and over" about a DNA read would be false.
  const dna = 'ACGT'.repeat(1_000).split('').sort(() => 0.5).join('').slice(0, 4_000);
  const other = submit(store, { owner: OWNER, text: dna });
  assert.equal(other.rule, 'file-not-fact');
  assert.match(other.explanation, /built from a very small set of characters/u);

  const [decision] = listDecisions(store, OWNER);
  assert.equal(decision.rule, 'file-not-fact');
});

test('rule 5 admits the things people actually write', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const notes = fs.readFileSync(new URL('../DECISIONS.md', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  // Cut to sit under the length limit, because these are about rule 5 and not
  // about rule 1: a sample that tripped the length check would pass this test
  // for the wrong reason.
  /** @type {(n: number, make: (i: number) => string) => string} */
  const rows = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join('\n').slice(0, 9_500);

  const fine = [
    ['a fact', 'I prefer to be written to in short sentences'],
    ['a short fact with a number', 'I am 25 years old'],
    ['a page of notes', notes.slice(0, 5_000)],
    ['this project\'s own notes', notes.slice(0, 8_000)],
    ['source code', source.slice(0, 10_000)],
    ['deeply indented source', rows(140, (i) => ' '.repeat(24) + `const value${i} = compute(${i}, options);`)],
    ['a markdown table', rows(240, (i) => `| person${i} | Berlin | engineer | 2026 |`)],
    ['a CSV', rows(220, (i) => `person${i},Berlin,engineer,2026-01-01,platform`)],
    ['a bullet list of notes', rows(190, (i) => `- remember to call the ${i} supplier about the invoice`)],
    ['notes with separator lines', rows(40, (i) => `${'-'.repeat(80)}\nnote ${i} about the meeting that followed, who was there and what they agreed to do next, with the actions listed underneath and a date against each one`)],
    ['Chinese notes', '我住在柏林并且喜欢安静的办公室因为我需要思考。'.repeat(3).concat('会议最好安排在上午，他不喜欢视频通话。')],
  ];

  for (const [what, text] of fine) {
    const result = submit(store, { owner: OWNER, text });
    assert.equal(result.verdict, 'stored', `${what} should have been stored, got ${result.rule}`);

    // Room to spare, not just inside the line — except for one case, called
    // out below, which is the closest legitimate text found and is worth
    // knowing about rather than hiding behind a looser bound.
    const score = repetitionOf(store, text);
    const room = what === 'notes with separator lines' ? REPETITION_LIMIT : REPETITION_LIMIT / 2;
    assert.ok(score < room, `${what} scored ${score.toFixed(0)} against a limit of ${REPETITION_LIMIT}`);
  }

  // A page that is a third rule-off lines scores about 42 against a limit of
  // 60. It is the narrowest margin any ordinary text showed, and if the limit
  // ever moves down this is what breaks first.
  const heavy = fine.find(([what]) => what === 'notes with separator lines') ?? ['', ''];
  assert.ok(repetitionOf(store, heavy[1]) > REPETITION_LIMIT / 2, 'the known-closest case moved');
});

test('rule 5 refuses the files people paste, in any script', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const files = [
    ['an application log', '2026-08-16T09:14:22.031Z INFO  request handled  status=200\n'.repeat(400)],
    ['a systemd log', 'Aug 16 09:14:22 amirjam systemd[1]: Started Session 42 of user amirjam.\n'.repeat(120)],
    ['a repeated stack trace', 'Error: connection reset\n    at Socket.onError (/srv/app/pg.js:142:17)\n'.repeat(120)],
    ['one character', 'x'.repeat(9_000)],
    ['one Chinese character', '柏'.repeat(9_000)],
    ['one Persian letter', 'ق'.repeat(9_000)],
    ['two characters alternating', 'ab'.repeat(4_500)],
  ];

  for (const [what, text] of files) {
    assert.equal(submit(store, { owner: OWNER, text }).rule, 'file-not-fact', `${what} got through`);
  }

  // A base64 dump is refused too, but by rule 1 rather than this one: an
  // unbroken run of mixed case and digits is what a credential looks like.
  // Worth pinning, because it means the two rules cover it between them and
  // neither needs to be widened for it.
  const dump = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w'.repeat(150);
  assert.equal(submit(store, { owner: OWNER, text: dump }).rule, 'credential');

  assert.equal(listMemories(store, OWNER, { includeArchived: true }).length, 0);
});

test('rule 5 is measured on the offered text alone, and the limit has room either side', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // Checked before anything is built from it, so a limit moved far in either
  // direction fails here and says which rather than in the assertions below.
  assert.ok(REPETITION_LIMIT >= 30, 'lower and ordinary notes start being refused as files');
  assert.ok(REPETITION_LIMIT <= 120, 'higher and a pasted log stops being refused');

  for (let index = 0; index < 50; index += 1) {
    submit(store, { owner: OWNER, text: `note ${index} about the supplier and the invoice` });
  }

  // Neighbours cannot move it: this is one document weighed on its own.
  assert.equal(submit(store, { owner: OWNER, text: 'x'.repeat(9_000) }).rule, 'file-not-fact');
  assert.equal(listMemories(store, OWNER).length, 50);
});
