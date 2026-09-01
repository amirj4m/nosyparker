/**
 * The store says when its review is overdue, and stops when one is done.
 *
 * Why there is anything to say. The review mechanism worked and had run once,
 * for eight minutes on 22 August. Seventy-nine memories arrived afterwards with
 * no review over any of them, and about 19 of 161 active memories went stale or
 * into contradiction — one saying his phone line was about to be cut off for
 * non-payment, live beside another recording that he had paid it. The design
 * was that an agent would review periodically of its own accord. That part was
 * never built, so it only ever ran when a person asked.
 *
 * Every case here goes over stdio through a real client against a real server
 * process, and reads the text an agent would actually receive. Asserting on
 * `reviewStanding()` would be asserting on a description of the behaviour
 * rather than the behaviour, and would pass with the line wired to nothing —
 * which is the trap this project has fallen into seven times.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { beginReview, closeReview, review, submit } from '../src/gate.js';
import {
  AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES, REVIEW_IS_DUE_AFTER, reviewStanding,
} from '../src/review-due.js';
import { openStore, reviewBookkeeping } from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

const SERVER = path.join(import.meta.dirname, '..', 'src', 'mcp-server.js');

/** @param {import('node:test').TestContext} t @returns {string} */
function storeFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-overdue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'memory.sqlite');
}

/** @param {import('node:test').TestContext} t @param {string} file @returns {Promise<Client>} */
async function connect(t, file) {
  const client = new Client({ name: 'nosyparker-overdue-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, NOSYPARKER_STORE: file },
  }));
  t.after(() => client.close());
  return client;
}

/** @param {Client} c @param {string} name @param {Record<string, unknown>} args @returns {Promise<string>} */
async function say(c, name, args = {}) {
  const answer = /** @type {{content: {type: string, text: string}[]}} */ (
    await c.callTool({ name, arguments: args }));
  return answer.content.map((part) => part.text ?? '').join('\n');
}

/** The sentence, recognised by what it states rather than by its exact wording. */
const IN_PROGRESS = /A review is already in progress, begun at /u;

const NUDGE = /\b(?:One memory has|\d+ memories have) been stored (?:since the last review|and no review)/u;

/** @param {Client} c @param {number} n @param {string} what @returns {Promise<void>} */
async function store(c, n, what) {
  for (let i = 0; i < n; i += 1) {
    const said = await say(c, 'remember', { text: `${what} number ${i}, which will still be true next week` });
    assert.match(said, /Stored/u, `the fixture could not store a memory: ${said.slice(0, 120)}`);
  }
}

test('a fresh store with nothing in it says nothing about reviews', async (t) => {
  const agent = await connect(t, storeFile(t));

  assert.doesNotMatch(await say(agent, 'list'), NUDGE);
  assert.doesNotMatch(await say(agent, 'recall', { query: 'anything' }), NUDGE);
});

test('a store below the threshold says nothing either', async (t) => {
  const agent = await connect(t, storeFile(t));
  await store(agent, REVIEW_IS_DUE_AFTER.memories - 1, 'a thing about the person');

  assert.doesNotMatch(await say(agent, 'list'), NUDGE);
});

test('crossing the threshold puts the line in every tool response, and one review clears it', async (t) => {
  // The whole loop, in the order it happens to somebody.
  const agent = await connect(t, storeFile(t));
  await store(agent, REVIEW_IS_DUE_AFTER.memories, 'a thing about the person');

  // 1. It is there, and it says how many and that there has never been a review.
  const listed = await say(agent, 'list');
  assert.match(listed, NUDGE, 'the line did not appear after the threshold was crossed');
  assert.match(listed, new RegExp(`${REVIEW_IS_DUE_AFTER.memories} memories have been stored`, 'u'));
  assert.match(listed, /no review has ever run/u);

  // 2. On every surface, not just the one it was tried on.
  for (const [name, args] of [['recall', { query: 'person' }], ['list', {}], ['why', {}]]) {
    assert.match(
      await say(agent, /** @type {string} */ (name), /** @type {Record<string, unknown>} */ (args)),
      NUDGE, `${name} did not carry the line`);
  }

  // 3. Once, not twice, in a single response.
  const once = await say(agent, 'list');
  assert.equal((once.match(new RegExp(NUDGE, 'gu')) ?? []).length, 1, 'the line appeared more than once');

  // 4. Not in the review tools themselves — somebody already reviewing does not
  //    need telling on every finding.
  const started = await say(agent, 'review_start', { reviewer: 'the test' });
  assert.doesNotMatch(started, NUDGE, 'review_start nagged about the review being started');
  const pass = Number(/\b(\d+)\b/u.exec(started)?.[1]);
  assert.ok(Number.isInteger(pass), `no pass id in: ${started.slice(0, 160)}`);

  // 5. A review that has just begun is alive, so the other sixteen clients are
  //    told to stand down rather than told to review. First come, and no
  //    coordination anywhere.
  const during = await say(agent, 'list');
  assert.doesNotMatch(during, NUDGE, 'it asked for a review while one was running');
  assert.match(during, IN_PROGRESS, 'it said nothing about the review already running');

  // 6. Close it, and the line goes.
  await say(agent, 'review_finding', {
    review: pass,
    id: 1,
    outcome: 'kept',
    reasoning: 'still true as far as this test knows',
    derived_from: ['read the memory itself'],
  });
  const ended = await say(agent, 'review_end', { review: pass });
  assert.match(ended, /clos/iu, `the review did not close: ${ended.slice(0, 160)}`);

  assert.doesNotMatch(await say(agent, 'list'), NUDGE, 'the line survived a completed review');
  assert.doesNotMatch(await say(agent, 'recall', { query: 'person' }), NUDGE);
});

test('memories stored after a review start it counting again', async (t) => {
  // The count is since the last *completed* review, so the loop can run twice.
  const agent = await connect(t, storeFile(t));
  await store(agent, REVIEW_IS_DUE_AFTER.memories, 'a thing about the person');

  const started = await say(agent, 'review_start', { reviewer: 'the test' });
  const pass = Number(/\b(\d+)\b/u.exec(started)?.[1]);
  await say(agent, 'review_end', { review: pass });
  assert.doesNotMatch(await say(agent, 'list'), NUDGE);

  await store(agent, REVIEW_IS_DUE_AFTER.memories - 1, 'something else');
  assert.doesNotMatch(await say(agent, 'list'), NUDGE, 'it fired one memory early');

  await store(agent, 1, 'the one that tips it');
  const tipped = await say(agent, 'list');
  assert.match(tipped, NUDGE, 'it did not fire again after the same number of new memories');
  assert.match(tipped, /since the last review, which closed on \d{4}-\d{2}-\d{2}/u,
    'the second time round it should name the review it is counting from');
});

test('a review that was undone is not the last review', async (t) => {
  // `undone_at` matters as much as `closed_at`. A pass that was closed and then
  // taken back reviewed nothing that still stands, so the count has to go on
  // from before it — and without this the line goes quiet for good after an
  // undo, which is the worst of the three ways this could fail because it looks
  // like success.
  const agent = await connect(t, storeFile(t));
  await store(agent, REVIEW_IS_DUE_AFTER.memories, 'a thing about the person');

  const started = await say(agent, 'review_start', { reviewer: 'the test' });
  const pass = Number(/\b(\d+)\b/u.exec(started)?.[1]);
  await say(agent, 'review_finding', {
    review: pass, id: 1, outcome: 'kept', reasoning: 'still true', derived_from: ['the memory'],
  });
  await say(agent, 'review_end', { review: pass });
  assert.doesNotMatch(await say(agent, 'list'), NUDGE, 'the fixture never got to a quiet state');

  const undone = await say(agent, 'review_undo', { review: pass });
  assert.match(undone, /undo|undone|taken back/iu, `the undo did not happen: ${undone.slice(0, 160)}`);

  assert.match(await say(agent, 'list'), NUDGE, 'an undone review still counted as a review');
});

test('a pass left open does not reset the count to the beginning', async (t) => {
  // The other half of "which pass counts". An abandoned pass has no `closed_at`,
  // so code that took the newest pass regardless would fall back to counting
  // every memory the store has ever held — and start nagging long before the
  // threshold, on a store that was reviewed last week. Quiet when it should
  // speak is the failure above; speaking when it should be quiet is this one,
  // and it costs the same thing in the end, because a line that is always there
  // is a line nobody reads.
  const agent = await connect(t, storeFile(t));
  await store(agent, REVIEW_IS_DUE_AFTER.memories, 'a thing about the person');

  const first = await say(agent, 'review_start', { reviewer: 'the test' });
  const pass = Number(/\b(\d+)\b/u.exec(first)?.[1]);
  await say(agent, 'review_end', { review: pass });
  assert.doesNotMatch(await say(agent, 'list'), NUDGE, 'the fixture never reached a quiet state');

  // A handful of new memories, well under the threshold, and a review begun and
  // walked away from.
  await store(agent, 5, 'a later thing');
  await say(agent, 'review_start', { reviewer: 'somebody who wandered off' });

  const said = await say(agent, 'list');
  assert.doesNotMatch(said, NUDGE, 'an abandoned pass made it count from the beginning again');
  assert.doesNotMatch(said, IN_PROGRESS,
    'it announced a review in progress when the count was not even overdue');
});


/**
 * The seven-day rule, and why these two are not over the protocol.
 *
 * Everything above drives the real server because the question there is whether
 * the line reaches an agent, and only the protocol can answer that. The
 * question here is different: what the policy decides when a week has passed.
 * No protocol test can reach it without waiting a week, and the alternative —
 * an environment variable that moves the server's clock — would be a test-only
 * branch in the code that decides when to nag, which is worth less than the gap
 * it closes.
 *
 * So the wiring is proven above and the policy is proven here, with the clock
 * handed in. Both halves are needed: a mutation that stops the line being
 * appended fails the tests above, and a mutation that removes the day rule or
 * the nothing-to-review rule fails these.
 */
test('a week with new memories is overdue; a week with none is not', (t) => {
  // The store's own clock and this one share an origin, or "a week later" is
  // measured from somewhere else and the test says nothing.
  const START = '2026-03-01T00:00:00.000Z';
  const store = temporaryStore({ start: START });
  t.after(() => store.close());

  /** @param {number} n @returns {string} */
  const day = (n) => new Date(Date.parse(START) + n * 86_400_000).toISOString();

  for (let i = 0; i < 3; i += 1) {
    submit(store, { owner: OWNER, text: `something true about them, number ${i}` });
  }

  // Three memories is far below the count threshold, so anything that fires
  // here fired on the calendar.
  assert.equal(reviewStanding(store, OWNER, day(1)).overdue, false, 'it fired on the first day');
  assert.equal(reviewStanding(store, OWNER, day(6)).overdue, false, 'it fired a day early');

  const seven = reviewStanding(store, OWNER, day(7));
  assert.equal(seven.overdue, true, 'a week passed with unreviewed memories and it said nothing');
  assert.match(/** @type {string} */ (seven.line), /3 memories have been stored/u);

  // And the other half: a store that has been reviewed and has had nothing
  // since. A review with nothing in front of it finds nothing, and a line that
  // appears when there is nothing to do is one an agent learns to skip — which
  // would cost us the one time it matters.
  //
  // It has to be a reviewed store rather than an empty one. An empty store is
  // quiet for a different reason — there is no first decision to count from —
  // so testing that would leave the rule that matters unwatched, and did.
  const pass = beginReview(store, { owner: OWNER, reviewer: 'the test' });
  closeReview(store, { owner: OWNER, pass: /** @type {number} */ (pass.pass_id) });
  assert.equal(reviewStanding(store, OWNER, day(8)).overdue, false,
    'it asked for a review straight after one finished');

  assert.equal(reviewStanding(store, OWNER, day(400)).overdue, false,
    'a year passed with nothing new and it asked for a review of nothing');

  // And it starts again the moment something arrives. The clock has to move
  // first: this store's clock stands still until it is told otherwise, so
  // without a tick the new memory lands in the same instant the review closed
  // and is not "since" it.
  store.tick();
  submit(store, { owner: OWNER, text: 'one more thing that is true about them' });
  assert.equal(reviewStanding(store, OWNER, day(400)).overdue, true,
    'something arrived after a reviewed year and it stayed quiet');

  // An empty store, for completeness, is quiet too.
  const empty = temporaryStore({ start: START });
  t.after(() => empty.close());
  assert.equal(reviewStanding(empty, OWNER, day(400)).overdue, false,
    'it asked for a review of an empty store');
});

test('a review that has gone quiet stops holding the reminder down', (t) => {
  // The failure this whole idea creates, and the reason it needs a bound.
  //
  // An agent starts a review and dies — terminal closed, session ended, client
  // quit. The pass stays open, because nothing in this project tidies one away.
  // If an open pass silenced the reminder for good, the store would go on
  // looking perfectly healthy while nothing was ever reviewed again, which is
  // strictly worse than never having had a reminder at all: it fails silently.
  //
  // Handed a clock for the same reason as the seven-day rule — no protocol test
  // can wait half an hour. What the protocol proves is that a fresh open pass
  // does suppress it; this proves the suppression ends.
  const START = '2026-04-01T00:00:00.000Z';
  const store = temporaryStore({ start: START });
  t.after(() => store.close());

  /** @param {number} n @returns {string} */
  const minutes = (n) => new Date(Date.parse(START) + n * 60_000).toISOString();

  for (let i = 0; i < REVIEW_IS_DUE_AFTER.memories; i += 1) {
    submit(store, { owner: OWNER, text: `a thing worth keeping, number ${i}` });
  }
  assert.equal(reviewStanding(store, OWNER, minutes(1)).state, 'overdue');

  beginReview(store, { owner: OWNER, reviewer: 'an agent that is about to vanish' });

  // Alive, so everybody else stands down.
  assert.equal(reviewStanding(store, OWNER, minutes(1)).state, 'in-progress');
  assert.equal(
    reviewStanding(store, OWNER, minutes(AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES - 1)).state,
    'in-progress', 'it gave up on a review that was still within its window');

  // Gone quiet for long enough. The reminder comes back, and the pass itself is
  // untouched — nothing here closes or marks it, and `doctor` still has it to
  // report.
  const after = reviewStanding(store, OWNER, minutes(AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES));
  assert.equal(after.state, 'overdue', 'an abandoned review silenced the reminder for good');
  assert.match(/** @type {string} */ (after.line), NUDGE);

  assert.equal(
    reviewBookkeeping(store, OWNER).openPass?.id, 1,
    'deciding to speak again quietly closed somebody\'s review');
});

test('a review that keeps working is never called abandoned', (t) => {
  // Idle time, not total time. A review of a hundred and sixty memories may run
  // for hours; what says it is alive is that something is still happening in it.
  // Without this the bound would interrupt exactly the thorough review it most
  // wants to encourage.
  //
  // This one drives the store's own clock rather than using the shared fixture,
  // because the findings have to land at chosen moments — the fixture's clock
  // moves a second at a time, and asserting at minute ninety against a finding
  // written at second one is a test that proves the opposite of what it says.
  // It did, first time round.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-heartbeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const START = Date.parse('2026-05-01T00:00:00.000Z');
  let at = START;
  /** @param {number} n @returns {string} */
  const minutes = (n) => new Date(START + n * 60_000).toISOString();

  const store = openStore({ file: path.join(dir, 'memory.sqlite'), now: () => new Date(at).toISOString() });
  t.after(() => store.close());

  /** @type {number[]} */
  const ids = [];
  for (let i = 0; i < REVIEW_IS_DUE_AFTER.memories; i += 1) {
    at += 1000;
    const stored = submit(store, { owner: OWNER, text: `a thing worth keeping, number ${i}` });
    ids.push(/** @type {number} */ (stored.memory_id));
  }

  at += 60_000;
  const pass = beginReview(store, { owner: OWNER, reviewer: 'a slow and careful agent' });
  const id = /** @type {number} */ (pass.pass_id);

  // Six findings, each one most of the window after the last, running to well
  // over two hours in total — far past the bound, and never idle for it.
  const gap = AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES - 5;
  for (let n = 0; n < 6; n += 1) {
    at += gap * 60_000;
    review(store, {
      owner: OWNER,
      pass: id,
      id: ids[n],
      outcome: 'could-not-tell',
      reasoning: 'this test has no way to tell, which is itself an outcome',
      derivedFrom: [ids[n]],
    });

    const elapsed = (at - START) / 60_000;
    assert.equal(
      reviewStanding(store, OWNER, new Date(at + 60_000).toISOString()).state, 'in-progress',
      `after ${Math.round(elapsed)} minutes of a working review it was called abandoned`);
  }

  assert.ok((at - START) / 60_000 > AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES * 4,
    'the review did not actually run for long enough to prove anything');

  // And when it does stop, the bound still applies.
  assert.equal(
    reviewStanding(store, OWNER, minutes((at - START) / 60_000 + AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES)).state,
    'overdue', 'a review that stopped was still called alive');
});

test('a moment it cannot read is not taken as proof a review is alive', (t) => {
  // The fallback, and which way it has to fall. If a timestamp cannot be parsed
  // — a clock that answered oddly, a row written by something else — the
  // question "has this review gone quiet" has no answer. Answering "no, it is
  // alive" would suppress the reminder on the strength of something unreadable,
  // and this whole addition exists because silence that looks like health is
  // the expensive failure. So an unreadable gap counts as forever idle.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-unreadable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = openStore({ file: path.join(dir, 'memory.sqlite'), now: () => new Date().toISOString() });
  t.after(() => store.close());

  for (let i = 0; i < REVIEW_IS_DUE_AFTER.memories; i += 1) {
    submit(store, { owner: OWNER, text: `a thing worth keeping, number ${i}` });
  }
  beginReview(store, { owner: OWNER, reviewer: 'an agent that is genuinely here' });

  // Alive, read normally.
  assert.equal(reviewStanding(store, OWNER, new Date().toISOString()).state, 'in-progress');

  // And with a moment nothing can make sense of.
  assert.equal(
    reviewStanding(store, OWNER, 'whenever').state, 'overdue',
    'an unreadable moment was taken as proof the review was still running');
});
