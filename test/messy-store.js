/**
 * A store shaped like one somebody has actually been using.
 *
 * Every other test in this project builds the two or three memories it needs
 * and asserts about those. That is right for testing a rule and useless for
 * testing a review, because a review is a thing that walks a whole store and
 * the interesting failures are the ones that only appear when there is enough
 * in it to be wrong about. So this is one store, built once, messy on purpose,
 * and the review tests are pointed at it.
 *
 * What "messy" means here, item by item, because a fixture that is only long is
 * not messy — it is just long:
 *
 *   - **Statements that name a moment**, written at intervals across two years.
 *     "Next week", "on Tuesday", "before the 14th", "until the end of the year",
 *     "this afternoon". Some of those moments are long gone by the last date in
 *     the fixture and one of them has not arrived.
 *   - **Statements that name no moment at all**, and the oldest thing in the
 *     store is one of them. These are the ones the whole design turns on: they
 *     are exactly as true after two years as the day they were written, and
 *     anything that touches one because it is old has failed.
 *   - **A contradiction with no time signal in it.** Tea and coffee, a year
 *     apart, and nothing in either sentence saying which is current. There is a
 *     right answer here and it is "I could not tell".
 *   - **A contradiction that resolves**, where the newer one says so itself.
 *   - **Rows that are already archived** — one forgotten by the person, one
 *     superseded by a newer memory — because a review walks past those and must
 *     not treat them as things to judge.
 *   - **Text that is not English and not left to right**, because a review that
 *     only works on English is a review that quietly does nothing for most of
 *     the people who might use this.
 *   - **A memory with a URL, one with markdown, one with an emoji**, which are
 *     the shapes that broke other things in this project before.
 *
 * The clock is the fixture's own and every date below is deliberate. Nothing in
 * `src/` reads a clock, so these dates are evidence handed to whatever is
 * reading the store and nothing else.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { forget, submit } from '../src/gate.js';
import { openStore } from '../src/store.js';
import { OWNER } from './helpers.js';

/**
 * The last moment in the fixture's world. A reviewer reading this store is
 * standing here, and every "has that moment gone by" question is asked against
 * it — by the reviewer, never by the code.
 */
export const NOW = '2026-08-18T14:00:00.000Z';

/**
 * What is in the store, in the order it was written.
 *
 * `at` is when it was stored. `moment` says whether the sentence itself names a
 * time, which is a fact about the English and is written down here so the tests
 * can assert about the two groups separately. Nothing in `src/` has any notion
 * of this field; it exists so that a test can say "none of the timeless ones
 * moved" without listing ids.
 *
 * @type {{at: string, text: string, moment: boolean, note?: string}[]}
 */
export const WRITTEN = [
  // The oldest thing in the store, and it names no moment. If anything in a
  // review ever touches this one, the design has failed and this is the row
  // that says so.
  { at: '2024-03-11T09:12:00.000Z', text: 'I live in Tehran', moment: false },

  { at: '2024-05-02T18:40:00.000Z', text: 'My sister is called Roshanak', moment: false },
  { at: '2024-07-19T11:05:00.000Z', text: 'I read Persian, English and German', moment: false },

  // A moment that came and went two years ago.
  { at: '2024-11-05T16:22:00.000Z', text: 'Tomorrow I will send them the first draft', moment: true },

  { at: '2025-01-08T08:03:00.000Z', text: 'I prefer tea to coffee', moment: false,
    note: 'the first half of a contradiction with nothing to date it' },

  { at: '2025-02-01T10:00:00.000Z', text: 'Until the end of the year I am on the Helios team', moment: true },
  { at: '2025-03-02T13:31:00.000Z', text: 'Next week I am presenting at the all-hands', moment: true },

  { at: '2025-04-14T07:55:00.000Z', text: 'من فارسی می‌نویسم', moment: false,
    note: 'right to left, and short enough that the trigram index cannot help' },

  { at: '2025-05-01T09:00:00.000Z', text: 'This has to be finished before the deadline on 14 May', moment: true },
  { at: '2025-06-10T20:14:00.000Z', text: 'On Tuesday I fly to Istanbul', moment: true },

  { at: '2025-07-22T12:00:00.000Z', text: 'I use nvim, and I do not want to be talked out of it', moment: false },
  { at: '2025-08-30T17:45:00.000Z', text: '我住在柏林', moment: false,
    note: 'and it contradicts the oldest memory, in a different script' },

  { at: '2025-09-15T06:30:00.000Z', text: 'I answer email in the morning and not after six', moment: false },
  { at: '2025-10-02T14:20:00.000Z', text: 'The runbook is at https://example.invalid/ops/runbook#restart', moment: false },

  { at: '2025-11-11T11:11:00.000Z', text: 'I am learning to sail ⛵ and it is going badly', moment: false },

  { at: '2025-12-03T09:47:00.000Z',
    text: '## How I like reviews\n\n- the problem first\n- then what you tried\n- then what you want from me',
    moment: false, note: 'markdown, which the repetition rule has opinions about' },

  { at: '2026-01-20T15:00:00.000Z', text: 'I prefer coffee in the afternoon', moment: false,
    note: 'the other half of the contradiction' },

  { at: '2026-02-14T10:10:00.000Z', text: 'I have moved to Vienna', moment: false,
    note: 'resolves the Tehran/Berlin question, and says so itself' },

  { at: '2026-03-30T08:00:00.000Z', text: 'I am not interested in cryptocurrency, please stop offering', moment: false },
  { at: '2026-05-19T13:00:00.000Z', text: 'For the next six weeks I am only working Tuesdays and Thursdays', moment: true },

  { at: '2026-07-01T09:30:00.000Z', text: 'I am writing a book about the Caspian, and it is slow going', moment: false },

  // A moment that has been and gone by hours rather than months, which is the
  // case a reviewer working from a date alone gets wrong most easily.
  { at: '2026-08-18T08:00:00.000Z', text: 'This afternoon I am in interviews all day', moment: true },

  // And one that has not arrived. Nothing should conclude anything about it.
  { at: '2026-08-18T09:00:00.000Z', text: 'Next month I am going to Berlin for the conference', moment: true },
];

/**
 * @typedef {object} Messy
 * @property {import('../src/store.js').Store} store
 * @property {number[]} timeless ids of every memory whose text names no moment
 * @property {number[]} timed ids of every memory whose text names one
 * @property {number} oldest the oldest memory in the store, which is a timeless one
 * @property {number} forgotten the memory the person put away themselves
 * @property {number} superseded the memory that was replaced
 * @property {number} replacement the memory that replaced it
 */

/**
 * Build it.
 *
 * Everything goes in through the gate, which is the point: a fixture assembled
 * with SQL would be a store no caller could have produced, and the states it
 * ended up in would prove nothing about the states a real one reaches.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Messy}
 */
export function messyStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-messy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let clock = WRITTEN[0].at;
  const store = openStore({ file: path.join(dir, 'memory.sqlite'), now: () => clock });
  t.after(() => store.close());

  /** @type {number[]} */
  const ids = [];
  for (const row of WRITTEN) {
    clock = row.at;
    const written = submit(store, { owner: OWNER, text: row.text });
    if (written.memory_id === null) {
      throw new Error(`the fixture failed to store "${row.text}": ${written.explanation}`);
    }
    ids.push(written.memory_id);
  }

  // Two rows that are already archived when the review arrives, put there the
  // two ways a person's own use gets them there.
  clock = '2026-02-14T10:10:00.000Z';
  const superseded = ids[WRITTEN.findIndex((row) => row.text === '我住在柏林')];
  const replacement = submit(store, {
    owner: OWNER,
    text: 'I have moved to Vienna and Berlin is behind me',
    replaces: superseded,
  });

  clock = '2026-04-02T19:00:00.000Z';
  const forgotten = ids[WRITTEN.findIndex((row) => row.text.startsWith('I am learning to sail'))];
  forget(store, { owner: OWNER, id: forgotten, reason: 'I gave up on the sailing' });

  clock = NOW;

  return {
    store,
    timeless: ids.filter((_, index) => !WRITTEN[index].moment),
    timed: ids.filter((_, index) => WRITTEN[index].moment),
    oldest: ids[0],
    forgotten,
    superseded,
    replacement: /** @type {number} */ (replacement.memory_id),
  };
}
