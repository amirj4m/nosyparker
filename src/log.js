/**
 * A record of what this program did to files it does not own.
 *
 * The reason it exists is a number. Phase 3 shipped with sixteen defects found
 * after the fact — nine by running the whole thing against a real machine,
 * seven by an independent review — and the test suite was green at every one of
 * those moments. The suite stops those defects coming back. It did not find
 * one of them, because nothing in it exercises the composition against a real
 * machine, and nothing can. What the suite cannot do, a record of what actually
 * happened can: a week after something goes wrong, somebody needs to know what
 * this touched and when, and asking the code is asking the wrong witness.
 *
 * Four properties, and each one rules something out.
 *
 * **Append-only.** It is a record, not a cache. Nothing here rewrites a line,
 * truncates the file, or removes an old entry — no rotation by age, no cap on
 * size. That is the same rule the memory store lives under and it is the same
 * reasoning: a record that quietly discards its oldest part is a record you
 * cannot trust about the thing you are least likely to have noticed. If the
 * file ever becomes a real problem, that is a decision to bring to the owner
 * with a measurement, not one to take here.
 *
 * **One line per event.** Readable in a terminal with no tool, and parseable
 * with `awk` or `grep` by anybody who wants to. A timestamp, the run it belongs
 * to, the command, the event, and then named fields — which is a format that
 * stays readable when a field is added and stays parseable when one is not
 * there.
 *
 * **No secrets, ever.** Every one of these files is allowed to hold API keys in
 * an `env` block. So nothing that came out of one is ever written here: paths,
 * outcomes, counts, byte lengths, and the names of things. Never a value, never
 * a line of somebody's config, never the text of an entry. The backup manifest
 * already works this way and this matches it deliberately.
 *
 * **A failure here cannot fail the command.** Every call is wrapped and every
 * error is swallowed. A log that can break `setup` is worse than no log, and
 * the one thing a person does not need while an install is going wrong is a
 * second thing going wrong on top of it.
 *
 * It sits beside the store and has nothing to do with it. The decision log in
 * `store.js` is about memories — what was offered, what was kept, what was
 * refused and why — and it is written through the gate inside the transaction
 * that changes a memory. This is about files on disk. Different subject,
 * different file, and neither reads the other.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Where it lives, beside the store rather than inside anybody else's folder. */
export const LOG_NAME = 'actions.log';

/**
 * @param {string} [home]
 * @returns {string}
 */
export function defaultLogPath(home) {
  return path.join(home ?? os.homedir(), '.nosyparker', LOG_NAME);
}

/**
 * @typedef {object} Log
 * @property {(event: string, fields?: Record<string, unknown>) => void} record
 * @property {string} runId
 * @property {string} file
 */

/**
 * A log that writes, or one that does nothing, and the caller cannot tell.
 *
 * @param {object} options
 * @param {string} options.file
 * @param {string} options.command what the person typed
 * @param {() => string} [options.now]
 * @param {string} [options.runId]
 * @returns {Log}
 */
export function openLog({ file, command, now, runId }) {
  const clock = now ?? (() => new Date().toISOString());
  const id = runId ?? randomBytes(3).toString('hex');

  return {
    runId: id,
    file,
    record(event, fields = {}) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${line(clock(), id, command, event, fields)}\n`, { mode: 0o600 });
      } catch {
        // A log that can break the command it is logging is worse than no log.
        // There is nowhere useful to report this to: the terminal belongs to
        // the report the person is reading.
      }
    },
  };
}

/**
 * A log that goes nowhere, for callers that have not been given one.
 *
 * @returns {Log}
 */
export function noLog() {
  return { runId: '', file: '', record: () => {} };
}

/**
 * @param {string} at
 * @param {string} runId
 * @param {string} command
 * @param {string} event
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function line(at, runId, command, event, fields) {
  const named = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${render(value)}`)
    .join(' ');

  return `${at}  ${runId}  ${command.padEnd(9)}  ${event.padEnd(11)}  ${named}`.trimEnd();
}

/**
 * One field's value, on one line, and never something that was in a file.
 *
 * Quoted only when it has to be, because quoting everything makes the common
 * case — a path — harder to read for no gain. A newline never survives: one
 * event is one line, and a value that could break that would break the format
 * for every reader after it.
 *
 * @param {unknown} value
 * @returns {string}
 */
function render(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const text = String(value).replaceAll(/[\r\n]+/gu, ' ');
  return /^[^\s"=]+$/u.test(text) ? text : JSON.stringify(text);
}
