/**
 * The only module that knows where the file lives and what time it is.
 *
 * Everything else takes the store path and the clock as arguments. That is
 * what lets the tests point at a temporary file and hand out a fixed time
 * without touching the real store or the real system clock.
 */

import os from 'node:os';
import path from 'node:path';

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
