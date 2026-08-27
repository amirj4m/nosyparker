/**
 * Search has to work in every language, which is the whole reason the index
 * uses a trigram tokeniser instead of the default one. These are the languages
 * the default tokeniser would have failed on, plus English as a control.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forget, submit } from '../src/gate.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, searchMemories, SEARCH_QUERY_LIMIT } from '../src/store.js';
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

      // An ordinary memory for the query to work against. Repeated characters
      // are refused as a file now, which is right and is not what this is
      // about.
      submit(store, { owner: 'o', text: 'she studied architecture in Milan and answers email before noon' });

      try {
        searchMemories(store, 'o', 'x'.repeat(1000000));
        console.log('RAN IT');
      } catch (error) {
        console.log('REFUSED: ' + error.message);
      }

      // Refused before anything was read or written, so the store still works.
      console.log('STILL WORKS: ' + searchMemories(store, 'o', 'architecture').length);
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

test('a search that cannot be passed on whole is refused in our own words', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  submit(store, { owner: OWNER, text: 'I live in Berlin' });

  // Three characters or more takes the index path, which builds the query
  // into a quoted string for MATCH. A NUL ended that string inside SQLite's
  // own parser and the bare words "unterminated string" came back out to the
  // caller — a C parser's complaint about its internals, dressed as an answer.
  const nul = String.fromCharCode(0);

  for (const query of [`Berlin${nul}x`, `ab${nul}`, `${nul}`, `one${nul}two three`]) {
    assert.throws(
      () => searchMemories(store, OWNER, query),
      /** @param {unknown} error */
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /not something text is made of/u);
        assert.match(message, /U\+0000/u);
        assert.equal(/unterminated/iu.test(message), false, 'SQLite used to speak for itself here');
        return true;
      },
    );
  }

  // Ordinary searches are untouched, on both paths.
  assert.equal(searchMemories(store, OWNER, 'Berlin').length, 1);
  assert.equal(searchMemories(store, OWNER, 'in').length, 1);
});

test('search refuses rather than returning less, however many match', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // Well past the fifty and two hundred that Phase 1 removed, so a cap
  // reintroduced anywhere would show up here as a short answer.
  for (let index = 0; index < 250; index += 1) {
    submit(store, { owner: OWNER, text: `memory ${index}: I drink coffee in the morning` });
  }

  assert.equal(searchMemories(store, OWNER, 'coffee').length, 250);
  assert.equal(searchMemories(store, OWNER, 'coffee morning').length, 250);
  assert.equal(searchMemories(store, OWNER, 'in').length, 250, 'the substring path too');
});

test('an ordinary store answers quickly however it is shaped', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  // 2.9 MB of ordinary text, the same size the review reported taking 29.5
  // seconds. It took that long because the text was one repeated character,
  // not because the store was large: growing is not what makes search slow.
  const words = ['coffee', 'morning', 'berlin', 'meeting', 'prefers', 'quiet', 'office'];
  for (let index = 0; index < 2000; index += 1) {
    const said = [`memory ${index}:`];
    for (let word = 0; said.join(' ').length < 1500; word += 1) {
      said.push(words[(index + word) % words.length]);
    }
    submit(store, { owner: OWNER, text: said.join(' ') });
  }

  const started = Date.now();
  const found = searchMemories(store, OWNER, 'coffee');
  const took = Date.now() - started;

  assert.equal(found.length, 2000, 'every match, not a page of them');
  assert.ok(took < 3000, `searching 2000 ordinary memories took ${took} ms`);
});



test('the short-term path is bounded too, and nothing rests on it being cheap', async () => {
  // Any query with a term under three characters skips the index entirely and
  // scans with instr(). That path never had a guard on it — the safety rested
  // on it happening to be cheap, which nothing checked. This checks it, out of
  // process and under a watch, against the text that breaks the other path.
  const script = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    (async () => {
      const { openStore, searchMemories, recordDecision } = await import(${JSON.stringify(STORE_MODULE)});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-short-'));
      const store = openStore({ file: path.join(dir, 'memory.sqlite'), now: () => new Date().toISOString() });

      // Written straight through the store's own action, past the gate, so
      // this is the worst case even a store that predates the rule could hold.
      for (let index = 0; index < 40; index += 1) {
        recordDecision(store, (actions, at) => {
          actions.insertMemory({ owner: 'o', text: 'x'.repeat(400_000), at, supersedes: null });
          return { owner: 'o', verdict: 'stored', rule: 'keep', explanation: '.', input_excerpt: '' };
        });
      }

      const started = process.hrtime.bigint();
      // A two-character term forces every term onto the substring path.
      const found = searchMemories(store, 'o', 'x'.repeat(900) + ' ab');
      console.log('SCANNED ' + found.length + ' in ' + Number((process.hrtime.bigint() - started) / 1000000n) + ' ms');
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    })();
  `;

  const result = await runWatched(['-e', script], { ceilingMB: 400 });

  assert.equal(result.signal, null, `the substring path reached ${result.peak.toFixed(0)} MB`);
  assert.match(result.out, /SCANNED/u);
  assert.ok(
    result.peak < 400,
    `16 MB of the worst text cost ${result.peak.toFixed(0)} MB on the substring path`,
  );
});

test('a number written in two scripts finds the same memories, at every length', (t) => {
  // The gap 0.0.5 closes, and the reason the 0.0.4 fold was only half a fix.
  // `text_normalised` holds folded digits, so the substring path — anything
  // under three characters — already agreed. The FTS path did not, because the
  // index is built on `text`, which the fold deliberately never touches. So
  // `search ۱۰` and `search 10` agreed while `search ۲۰۲۶` and `search 2026`
  // did not, and the longer term is the commoner one.
  //
  // Measured on the owner's store before this: 70 results against 4.
  const store = temporaryStore();
  t.after(() => store.close());

  for (const text of [
    'the lease started in ۲۰۲۶ and runs for three years',
    'the lease on the other flat started in 2026 as well',
    'my locker downstairs is number ۱۰',
    'the bus I take is the 10',
    'flat ٤٥٦ is the one with the balcony',
  ]) {
    submit(store, { owner: OWNER, text });
  }

  /** @param {string} term @returns {string[]} */
  const found = (term) => searchMemories(store, OWNER, term).map((m) => m.text).sort();

  for (const [a, b] of [['2026', '۲۰۲۶'], ['10', '۱۰'], ['456', '٤٥٦'], ['456', '۴۵۶']]) {
    assert.deepEqual(found(a), found(b), `"${a}" and "${b}" do not find the same memories`);
    assert.ok(found(a).length > 0, `neither "${a}" nor "${b}" found anything at all`);
  }

  // Both of the 2026 memories, from either script. An equality check alone
  // would pass if both sides found nothing.
  assert.equal(found('2026').length, 2);
  assert.equal(found('۲۰۲۶').length, 2);
});

test('the folded index is kept in step as memories are added, archived and restored', (t) => {
  // An index that is right when it is built and wrong afterwards is worse than
  // no index, because nothing announces it. The raw index is maintained by
  // triggers; this asserts the folded one is too, through the operations that
  // actually change a row.
  const store = temporaryStore();
  t.after(() => store.close());

  const stored = submit(store, { owner: OWNER, text: 'the meeting is on floor ۱۲۳' });
  assert.equal(searchMemories(store, OWNER, '123').length, 1, 'a new memory is not in the folded index');

  forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (stored.memory_id),
    reason: 'the meeting moved',
  });
  assert.equal(searchMemories(store, OWNER, '123').length, 0, 'an archived memory is still being returned');
  assert.equal(
    searchMemories(store, OWNER, '123', { includeArchived: true }).length, 1,
    'an archived memory has fallen out of the folded index entirely');
});

test('a store written before the folded index existed gets one, and finds things it could not', (t) => {
  // The upgrade path, and it is an open rather than a migration. A store that
  // has rows but no folded index gets the table built and filled the first time
  // this code opens it — an external-content FTS5 table created beside existing
  // rows starts empty, so creating it is not enough.
  const first = temporaryStore();
  const file = path.join(first.dir, 'memory.sqlite');

  submit(first, { owner: OWNER, text: 'the lease started in ۲۰۲۶' });
  submit(first, { owner: OWNER, text: 'the other lease started in 2026' });
  first.close();

  // Put it back to how a 0.0.4 store looks: the folded index and its triggers
  // gone, everything else untouched.
  const raw = new DatabaseSync(file);
  raw.exec('DROP TRIGGER IF EXISTS memories_fts_folded_insert');
  raw.exec('DROP TRIGGER IF EXISTS memories_fts_folded_update');
  raw.exec('DROP TRIGGER IF EXISTS memories_fts_folded_delete');
  raw.exec('DROP TABLE IF EXISTS memories_fts_folded');
  const version = /** @type {{user_version: number}} */ (
    /** @type {unknown} */ (raw.prepare('PRAGMA user_version').get())).user_version;
  raw.close();

  const store = openStore({ file, now: () => new Date().toISOString() });
  t.after(() => store.close());

  assert.equal(searchMemories(store, OWNER, '2026').length, 2, 'the index was not filled on open');
  assert.deepEqual(
    searchMemories(store, OWNER, '2026').map((m) => m.text).sort(),
    searchMemories(store, OWNER, '۲۰۲۶').map((m) => m.text).sort(),
  );

  const after = new DatabaseSync(file);
  assert.equal(
    /** @type {{user_version: number}} */ (
      /** @type {unknown} */ (after.prepare('PRAGMA user_version').get())).user_version,
    version,
    'building an index moved the schema version, which turns older code away from the file');
  after.close();
});

test('the raw index is still maintained, which is what lets older code read this store', (t) => {
  // The compatibility claim, as an invariant rather than a sentence. A version
  // of this program that predates the folded index searches `memories_fts`, and
  // it keeps working only for as long as that index is still correct. Nothing
  // here reads it any more, so nothing else would notice it rotting.
  //
  // What this holds, precisely: that every memory this build writes reaches the
  // raw index, and that both indexes pass their own integrity check. Deleting
  // the raw insert trigger fails it. It does *not* hold the raw update trigger,
  // and cannot — nothing in normal use ever changes `memories.text`, so that
  // trigger has no observable effect to assert on. Saying so here rather than
  // leaving a comment that claims more than the assertions do.
  const store = temporaryStore();
  const file = path.join(store.dir, 'memory.sqlite');

  submit(store, { owner: OWNER, text: 'the lease started in ۲۰۲۶' });
  const stored = submit(store, { owner: OWNER, text: 'I answer email at night' });
  forget(store, {
    owner: OWNER,
    id: /** @type {number} */ (stored.memory_id),
    reason: 'not true any more',
  });
  store.close();

  const raw = new DatabaseSync(file);
  t.after(() => raw.close());

  // What the older code's query is, run against a store this code wrote.
  const asOldCodeWould = (/** @type {string} */ term) => /** @type {{n: number}} */ (
    /** @type {unknown} */ (raw.prepare(`
      SELECT count(*) n FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.owner = ?`).get(`"${term}"`, OWNER))).n;

  assert.equal(asOldCodeWould('۲۰۲۶'), 1, 'the raw index no longer finds what it used to');
  assert.equal(asOldCodeWould('night'), 1, 'an archived memory fell out of the raw index');
  assert.doesNotThrow(() => raw.exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')"));
  assert.doesNotThrow(() => raw.exec("INSERT INTO memories_fts_folded(memories_fts_folded) VALUES('integrity-check')"));
});
