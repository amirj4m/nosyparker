/**
 * Every rule the gate has, one test each, in the order they are tried.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forget, restore, submit } from '../src/gate.js';
import { getMemory, listDecisions, listMemories } from '../src/store.js';
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

test('rule 2: whitespace only is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: '   \n\t  ' });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'empty');
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 3: the same sentence again is refused, and points at the original', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'I take my coffee black' });
  const again = submit(store, { owner: OWNER, text: '  I TAKE my   coffee black ' });

  assert.equal(again.verdict, 'refused');
  assert.equal(again.rule, 'already-stored');
  assert.equal(again.related_memory_id, first.memory_id);
  assert.equal(listMemories(store, OWNER).length, 1);
});

test('rule 3 does not treat different punctuation as the same sentence', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: "Let's eat, grandma" });
  const second = submit(store, { owner: OWNER, text: "Let's eat grandma" });

  assert.equal(second.verdict, 'stored');
  assert.equal(listMemories(store, OWNER).length, 2);
});

test('rule 3 only compares against active memories', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = submit(store, { owner: OWNER, text: 'I work from home on Fridays' });
  forget(store, { owner: OWNER, id: /** @type {number} */ (first.memory_id), reason: 'changed' });

  const again = submit(store, { owner: OWNER, text: 'I work from home on Fridays' });
  assert.equal(again.verdict, 'stored');
});

test('rule 4: replacing an id that is not there is refused', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: 'something new', replaces: 99 });

  assert.equal(result.verdict, 'refused');
  assert.equal(result.rule, 'replaces-unknown');
  assert.equal(listMemories(store, OWNER).length, 0);
});

test('rule 4 also covers another owner and an already archived memory', (t) => {
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

test('rule 5: replacing a real memory supersedes it and links both ways', (t) => {
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

test('rule 6: anything else is stored', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const result = submit(store, { owner: OWNER, text: 'I read faster than I listen' });

  assert.equal(result.verdict, 'stored');
  assert.equal(result.rule, 'keep');
  assert.equal(getMemory(store, OWNER, /** @type {number} */ (result.memory_id))?.state, 'active');
});

test('rule 7: forgetting archives the memory and keeps the reason', (t) => {
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

test('rule 8: forgetting an id that is not yours is refused', (t) => {
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
