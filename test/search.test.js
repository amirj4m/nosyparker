/**
 * Search has to work in every language, which is the whole reason the index
 * uses a trigram tokeniser instead of the default one. These are the languages
 * the default tokeniser would have failed on, plus English as a control.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forget, submit } from '../src/gate.js';
import { searchMemories, SEARCH_QUERY_LIMIT } from '../src/store.js';
import { OWNER, runWatched, temporaryStore } from './helpers.js';

const STORE_MODULE = new URL('../src/store.js', import.meta.url).href;
const GATE_MODULE = new URL('../src/gate.js', import.meta.url).href;

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

test('a short query ignores case in every alphabet that has case', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const sentences = {
    swedish: 'jag köper ölm på fredagar',
    greek: 'μου αρέσει ο καφές το πρωί',
    cyrillic: 'я живу в Москве уже три года',
    armenian: 'ես սիրում եմ գիրք կարդալ',
    accented: 'je préfère les réunions courtes',
  };

  for (const sentence of Object.values(sentences)) {
    submit(store, { owner: OWNER, text: sentence });
  }

  /** @type {[string, string][]} */
  const cases = [
    ['öl', sentences.swedish],
    ['ÖL', sentences.swedish],
    ['κα', sentences.greek],
    ['ΚΑ', sentences.greek],
    ['мо', sentences.cyrillic],
    ['МО', sentences.cyrillic],
    ['սի', sentences.armenian],
    ['ՍԻ', sentences.armenian],
    ['ré', sentences.accented],
    ['RÉ', sentences.accented],
  ];

  for (const [query, expected] of cases) {
    const found = searchMemories(store, OWNER, query);
    assert.equal(found.length, 1, `no match for ${query}`);
    assert.equal(found[0].text, expected);
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

test('a query the store will not run is refused before it costs anything', async () => {
  // Run in a child, under a watch that kills it, and never in the test runner.
  // Without the bound this exact call allocated about ten gigabytes inside
  // SQLite and the kernel killed the machine's sessions. A test that could do
  // that again on the day somebody removes the bound would be worse than no
  // test at all.
  const script = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    (async () => {
      const { openStore, searchMemories } = await import(${JSON.stringify(STORE_MODULE)});
      const { submit } = await import(${JSON.stringify(GATE_MODULE)});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-bound-'));
      const store = openStore({ file: path.join(dir, 'memory.sqlite'), now: () => new Date().toISOString() });

      // A memory of one repeated character indexes as thousands of identical
      // trigrams. It is what a long query matches against, and matching is
      // where the memory went.
      submit(store, { owner: 'o', text: 'x'.repeat(9000) });

      try {
        searchMemories(store, 'o', 'x'.repeat(1000000));
        console.log('RAN IT');
      } catch (error) {
        console.log('REFUSED: ' + error.message);
      }

      // Refused before anything was read or written, so the store still works.
      console.log('STILL WORKS: ' + searchMemories(store, 'o', 'xxx').length);
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    })();
  `;

  const settled = 200;
  const result = await runWatched(['-e', script], { ceilingMB: settled + 400 });

  assert.equal(result.signal, null, `the child was killed at ${result.peak.toFixed(0)} MB`);
  assert.match(result.out, /REFUSED: That search is longer than this store will run/u);
  assert.match(result.out, /the limit is 1000 characters and this one is 1000000/u);
  assert.match(result.out, /STILL WORKS: 1/u, 'an ordinary search of the same store still works');

  assert.ok(
    result.peak < settled + 400,
    `refusing it should cost nothing, and the child reached ${result.peak.toFixed(0)} MB`,
  );
});

test('the bound is at the character, and every caller gets the same one', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I live in Berlin' });

  // Checked first, before a single character is built from it, and that order
  // is the whole safety of this test. The lengths below are derived from the
  // constant, so if somebody raised it to something enormous this test would
  // otherwise be the thing that built an enormous query — in the test runner's
  // own process, where there is nothing to kill it. Failing here instead costs
  // nothing and says exactly what changed.
  //
  // The number is read from the store rather than written down again. Two
  // copies that have to agree is how one sentence became three in Phase 1.
  assert.equal(SEARCH_QUERY_LIMIT, 1000);

  // Now safe: a thousand characters either side of a bound that is a thousand.
  assert.equal(searchMemories(store, OWNER, 'x'.repeat(SEARCH_QUERY_LIMIT)).length, 0);
  assert.throws(
    () => searchMemories(store, OWNER, 'x'.repeat(SEARCH_QUERY_LIMIT + 1)),
    /longer than this store will run/u,
  );
});
