/**
 * Search has to work in every language, which is the whole reason the index
 * uses a trigram tokeniser instead of the default one. These are the languages
 * the default tokeniser would have failed on, plus English as a control.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forget, submit } from '../src/gate.js';
import { searchMemories } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

test('search finds Persian, Arabic, Chinese and English', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const sentences = {
    persian: 'من قهوه را تلخ دوست دارم',
    arabic: 'أنا أفضل الاجتماعات في الصباح',
    chinese: '我住在柏林并且喜欢安静的办公室',
    english: 'I prefer quiet offices and short meetings',
  };

  for (const sentence of Object.values(sentences)) {
    submit(store, { owner: OWNER, text: sentence });
  }

  const cases = [
    ['قهوه', sentences.persian],
    ['الاجتماعات', sentences.arabic],
    ['我住在柏林', sentences.chinese],
    ['quiet offices', sentences.english],
  ];

  for (const [query, expected] of cases) {
    const found = searchMemories(store, OWNER, query);
    assert.equal(found.length, 1, `no match for ${query}`);
    assert.equal(found[0].text, expected);
  }
});

test('search matches in the middle of a word, which is what trigrams are for', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I use a standing desk in the afternoons' });
  submit(store, { owner: OWNER, text: '柏林的天气很冷' });

  assert.equal(searchMemories(store, OWNER, 'ternoon').length, 1);
  assert.equal(searchMemories(store, OWNER, '的天气').length, 1);
});

test('several words are all looked for, not required to be next to each other', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I drink coffee in the morning and never after four' });
  submit(store, { owner: OWNER, text: 'I drink tea in the evening' });

  assert.equal(searchMemories(store, OWNER, 'coffee morning').length, 1);
  assert.equal(searchMemories(store, OWNER, 'morning coffee').length, 1, 'order should not matter');
  assert.equal(searchMemories(store, OWNER, 'coffee evening').length, 0, 'both words are required');

  // Still works when the words really are next to each other.
  assert.equal(searchMemories(store, OWNER, 'drink coffee').length, 1);
});

test('an FTS5 operator in a query is looked for rather than carried out', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I prefer cats' });
  submit(store, { owner: OWNER, text: 'I tolerate dogs' });

  // If OR were carried out this would match both memories.
  assert.equal(searchMemories(store, OWNER, 'cats OR dogs').length, 0);
  assert.doesNotThrow(() => searchMemories(store, OWNER, 'NEAR(cats dogs)'));
  assert.doesNotThrow(() => searchMemories(store, OWNER, 'cats*'));
  assert.doesNotThrow(() => searchMemories(store, OWNER, '"unbalanced quote'));
});

test('search leaves archived memories out unless they are asked for', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const forgotten = submit(store, { owner: OWNER, text: 'I drink coffee after four' });
  const replaced = submit(store, { owner: OWNER, text: 'I answer email at night' });
  submit(store, {
    owner: OWNER,
    text: 'I answer email in the morning',
    replaces: /** @type {number} */ (replaced.memory_id),
  });
  forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (forgotten.memory_id),
    reason: 'not true any more',
  });

  assert.equal(searchMemories(store, OWNER, 'coffee').length, 0);
  assert.equal(searchMemories(store, OWNER, 'night').length, 0);

  assert.equal(searchMemories(store, OWNER, 'coffee', { includeArchived: true }).length, 1);
  assert.equal(searchMemories(store, OWNER, 'night', { includeArchived: true }).length, 1);
});

test('search only ever returns the owner their own memories', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: 'someone-else', text: 'a secret preference for pineapple' });
  assert.equal(searchMemories(store, OWNER, 'pineapple').length, 0);
  assert.equal(searchMemories(store, 'someone-else', 'pineapple').length, 1);
});

test('the index follows a memory that changes state', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'I bike to the office' });
  forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (stored.memory_id),
    reason: 'moved further away',
  });

  assert.equal(searchMemories(store, OWNER, 'bike').length, 0);
  assert.equal(searchMemories(store, OWNER, 'bike', { includeArchived: true }).length, 1);
});

test('two character words are findable, which is most of Chinese and Japanese', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: '我住在柏林并且喜欢安静的办公室' });
  submit(store, { owner: OWNER, text: '私は東京に住んでいます' });
  submit(store, { owner: OWNER, text: '寿司が好きです' });
  submit(store, { owner: OWNER, text: 'I live in Berlin' });

  /** @type {[string, string|null][]} */
  const cases = [
    ['柏林', '我住在柏林并且喜欢安静的办公室'], // Berlin
    ['东京', null], // simplified form, deliberately not in the store
    ['東京', '私は東京に住んでいます'], // Tokyo
    ['寿司', '寿司が好きです'], // sushi
    ['我', '我住在柏林并且喜欢安静的办公室'], // a single character
  ];

  for (const [query, expected] of cases) {
    const found = searchMemories(store, OWNER, query);
    if (expected === null) {
      assert.equal(found.length, 0, `${query} should not have matched anything`);
    } else {
      assert.equal(found.length, 1, `no match for ${query}`);
      assert.equal(found[0].text, expected);
    }
  }
});

test('short and long words can be mixed in one query', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I drink coffee in the morning' });
  submit(store, { owner: OWNER, text: 'I drink tea in the evening' });

  assert.equal(searchMemories(store, OWNER, 'in coffee').length, 1);
  assert.equal(searchMemories(store, OWNER, 'coffee in the morning').length, 1);
  assert.equal(searchMemories(store, OWNER, 'in coffee evening').length, 0);
});

test('a short query treats percent and underscore as ordinary characters', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'my battery alarm is set at 20%' });
  submit(store, { owner: OWNER, text: 'the file is called year_end and nothing else' });
  submit(store, { owner: OWNER, text: 'nothing special about this one' });

  // As a wildcard each of these would match everything.
  assert.equal(searchMemories(store, OWNER, '%').length, 1);
  assert.equal(searchMemories(store, OWNER, '_').length, 1);
  assert.equal(searchMemories(store, OWNER, '0%').length, 1);

  // Literally, "r_e" really is inside "year_end", so it matches.
  assert.equal(searchMemories(store, OWNER, 'r_e').length, 1);

  // As a wildcard "y_ar" would match "year". Taken literally, it matches
  // nothing, which is the behaviour being asked for here.
  assert.equal(searchMemories(store, OWNER, 'y_ar').length, 0);
  assert.equal(searchMemories(store, OWNER, '2%').length, 0);
});

test('the archive stays out of short queries too', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: '我住在柏林' });
  forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (stored.memory_id),
    reason: '搬走了',
  });

  assert.equal(searchMemories(store, OWNER, '柏林').length, 0);
  assert.equal(searchMemories(store, OWNER, '柏林', { includeArchived: true }).length, 1);
  assert.equal(searchMemories(store, 'someone-else', '柏林', { includeArchived: true }).length, 0);
});

test('punctuation in a query is treated as text to look for, not as syntax', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I use the "long form" version of my name' });

  assert.equal(searchMemories(store, OWNER, '"long form"').length, 1);
  assert.doesNotThrow(() => searchMemories(store, OWNER, 'NEAR(a b) OR *'));
});
