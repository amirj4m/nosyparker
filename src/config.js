/**
 * The only module that knows where the file lives, what time it is, and whose
 * memories these are.
 *
 * Everything else takes the store path and the clock as arguments. That is
 * what lets the tests point at a temporary file and hand out a fixed time
 * without touching the real store or the real system clock.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * The one person on this machine.
 *
 * The store takes an owner on every call, and there are now two ways in: the
 * command line tool and the MCP server. Both are that same person sitting at
 * that same laptop, so both have to pass the same word, or the memories stored
 * through one would be invisible to the other and neither would say why. It is
 * written down once here rather than spelled out in each entry point, for the
 * same reason SCHEMA_VERSION is exported rather than copied.
 *
 * This is not identity and it is not a login. There is one person and there is
 * no second one to tell them apart from.
 */
export const LOCAL_OWNER = 'local';

/** Folder name used under the user's home directory. */
const STORE_DIR_NAME = '.nosyparker';

/** File name of the SQLite database inside that folder. */
const STORE_FILE_NAME = 'memory.sqlite';

/** Environment variable that overrides the store location. */
const STORE_ENV_VAR = 'NOSYPARKER_STORE';

/**
 * Where the store file lives.
 *
 * @returns {string} absolute path to the SQLite file
 */
export function defaultStorePath() {
  const override = process.env[STORE_ENV_VAR];
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), STORE_DIR_NAME, STORE_FILE_NAME);
}

/**
 * The system clock, as an ISO 8601 string in UTC.
 *
 * Times are stored as text because that is readable when someone opens the
 * file with any SQLite viewer, and it sorts correctly as a string.
 *
 * @returns {string}
 */
export function systemClock() {
  return new Date().toISOString();
}

/**
 * Milliseconds from a clock that only goes forward, for measuring how long
 * something has been running.
 *
 * Not a date and not comparable with one: it counts from an arbitrary point,
 * so it can say that a search has run for ten seconds and can never say that a
 * memory is old. That is the whole reason it is a separate function from
 * `systemClock`, and the reason it lives here. The store is handed it at the
 * door, the way it is handed `systemClock`, and the guard that keeps every
 * clock off the memory path stays intact: `store.js` reads a function it was
 * given and names no clock of its own.
 *
 * @returns {number}
 */
export function monotonicClock() {
  return performance.now();
}
