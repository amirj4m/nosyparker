/**
 * Shared setup for the tests.
 *
 * Every test gets its own store file in a temporary folder and a clock that
 * only moves when a test moves it. Neither the real store nor the real clock
 * is ever touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/store.js';

export const OWNER = 'tester';

/**
 * A store in a fresh temporary folder, with a clock the test controls.
 *
 * @param {object} [options]
 * @param {string} [options.start] first timestamp the clock hands out
 * @returns {import('../src/store.js').Store & {tick: () => void, dir: string}}
 */
export function temporaryStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-test-'));
  const file = path.join(dir, 'memory.sqlite');

  let clock = Date.parse(options.start ?? '2026-01-01T00:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const tick = () => {
    clock += 1000;
  };

  const store = openStore({ file, now });
  return Object.assign(store, { tick, dir });
}
