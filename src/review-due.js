/**
 * When the store's review is overdue, and the one line that says so.
 *
 * **Why this exists.** The review mechanism works and had run exactly once, on
 * 22 August, for eight minutes. Seventy-nine memories were written afterwards
 * with no review over any of them, and by the time anybody looked, roughly 19 of
 * 161 active memories were stale or in direct contradiction — one saying his
 * phone line was about to be cut off for non-payment, live beside another
 * recording that he had paid it. Nothing was broken. The review had no trigger:
 * the design was that an agent would go and review periodically of its own
 * accord, and that part was never built, so it only ever ran because a person
 * asked for it.
 *
 * So the store says the fact out loud, in every tool response, until a review is
 * done.
 *
 * **The line this must not cross, and it is the project's oldest rule.** No code
 * here concludes anything from a *memory's* date. Counting our own process —
 * how long since we last reviewed, how many memories have arrived since — is
 * bookkeeping and is fine. Deciding that a particular memory is old, stale,
 * expired or due for removal is not, and never will be: that is the judgement
 * `valid_until` was rejected for, and the reason is that only somebody reading
 * the sentence can tell a fact that has gone out of date from one that has
 * simply been true for a long time.
 *
 * This is built so that the separation is structural rather than a promise in a
 * comment: **it reads the decision log and never touches a memory row.** The
 * decision log records what this program did and when, which is our process. It
 * cannot rank memories, select them, or mark them, because it never sees one.
 * The line says there is unreviewed material and how much. Which memories are
 * wrong is for the agent that reads them.
 */

import { reviewBookkeeping } from './store.js';

/**
 * When a review becomes overdue.
 *
 * Both numbers come from the owner's measured rate — about 2.3 memories a day
 * after his import — so they land at roughly weekly for him and move with him if
 * that rate changes. They are here, together, and nowhere else, so that somebody
 * who wants a different cadence has one place to change.
 */
export const REVIEW_IS_DUE_AFTER = {
  /** Memories stored since the last review. */
  memories: 20,
  /** Days since the last review closed. */
  days: 7,
};

/**
 * How long an open review is taken to still be alive, with nothing happening in
 * it.
 *
 * Thirty minutes, and it is idle time rather than total time — measured from the
 * last thing that happened in the pass, not from when it began — so a review
 * that is working never goes stale however long it takes.
 *
 * **Why this number.** The only review anybody has run took eight minutes. An
 * idle gap of thirty is nearly four times that with nothing recorded at all,
 * which is far more likely to be an agent that closed its terminal than one
 * that is thinking.
 *
 * **Why it errs short.** The two ways of being wrong do not cost the same. Too
 * long, and an agent dies and the store says nothing to anybody until the window
 * passes — silence that looks exactly like health, which is worse than never
 * having had a reminder. Too short, and a second agent may start a review while
 * one is genuinely running, which is wasteful and safe: two open passes cannot
 * both retire the same memory, and there is a test that says so.
 */
export const AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES = 30;

/** The verdicts that mean a new memory arrived. `superseded` records the new one. */
const AROSE = ['stored', 'superseded'];

/**
 * @typedef {object} Standing
 * @property {'quiet'|'in-progress'|'overdue'} state
 * @property {boolean} overdue whether a review is wanted, whether or not one is running
 * @property {number} since memories stored since the reference point
 * @property {string|null} lastClosedAt when the last completed review closed
 * @property {string|null} line the sentence to append, or null when nothing is due
 */

/**
 * How the store stands with respect to its own review.
 *
 * @param {import('./store.js').Store} store
 * @param {string} owner
 * @param {string} now ISO timestamp
 * @returns {Standing}
 */
export function reviewStanding(store, owner, now) {
  const books = reviewBookkeeping(store, owner);
  const since = books.storedSince(books.lastClosedAt);
  const from = books.lastClosedAt ?? books.firstDecisionAt;

  if (!isOverdue(since, from, now)) {
    return { state: 'quiet', overdue: false, since, lastClosedAt: books.lastClosedAt, line: null };
  }

  // Seventeen clients are wired to this store, and the answer to "which one
  // reviews" is whichever gets there first. An agent that finds a review
  // already running stands down on its own, with nothing configured and nothing
  // knowing about anything else.
  //
  // Only while that review is plausibly alive. An agent that begins one and
  // then dies — terminal closed, client quit — leaves a pass open for good, and
  // treating that as "in progress" would silence this permanently and look
  // completely healthy while nothing was ever reviewed again.
  //
  // Nothing is decided about the pass itself. It is not closed, marked or
  // tidied away; `doctor` still reports it, and still declines to say whether
  // anybody will finish it, because that is a judgement about somebody else's
  // intent. All that is decided here is how long to stay quiet.
  const open = books.openPass;
  if (open !== null && minutesBetween(open.beatingAt, now) < AN_OPEN_REVIEW_IS_ALIVE_FOR_MINUTES) {
    return {
      state: 'in-progress',
      overdue: true,
      since,
      lastClosedAt: books.lastClosedAt,
      line: `A review is already in progress, begun at ${open.begunAt.slice(0, 16).replace('T', ' ')}.`,
    };
  }

  return {
    state: 'overdue',
    overdue: true,
    since,
    lastClosedAt: books.lastClosedAt,
    line: books.lastClosedAt === null
      ? `${count(since)} been stored and no review has ever run.`
      : `${count(since)} been stored since the last review, which closed on `
        + `${books.lastClosedAt.slice(0, 10)}.`,
  };
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function minutesBetween(from, to) {
  const gap = (Date.parse(to) - Date.parse(from)) / 60_000;
  // An unreadable moment is not evidence that a review is alive. Saying it has
  // been idle forever is the answer that keeps the reminder rather than the one
  // that loses it.
  return Number.isFinite(gap) ? gap : Number.POSITIVE_INFINITY;
}

/**
 * @param {number} since
 * @param {string|null} from
 * @param {string} now
 * @returns {boolean}
 */
function isOverdue(since, from, now) {
  // Nothing has arrived, so there is nothing to read. The seven-day rule does
  // not fire on an empty interval: a review with nothing new in front of it
  // finds nothing, and a line that appears when there is nothing to do is a
  // line an agent learns to skip past — which would cost us the one that
  // matters.
  if (since === 0) return false;
  if (since >= REVIEW_IS_DUE_AFTER.memories) return true;
  if (from === null) return false;

  const days = (Date.parse(now) - Date.parse(from)) / 86_400_000;
  return Number.isFinite(days) && days >= REVIEW_IS_DUE_AFTER.days;
}

/** @param {number} n @returns {string} */
function count(n) {
  return n === 1 ? 'One memory has' : `${n} memories have`;
}
