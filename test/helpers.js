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
import { execFileSync, spawn } from 'node:child_process';

import { openStore } from '../src/store.js';

export const OWNER = 'tester';

/**
 * How much memory a process is holding, in megabytes.
 *
 * Asked of `ps` rather than of `/proc`, which does not exist everywhere. The
 * number is resident set size, which is what the kernel counts when it decides
 * what to kill, and it includes what SQLite allocates outside the JavaScript
 * heap — which is the point, because that is where the memory these tests
 * guard against actually goes.
 *
 * @param {number} pid
 * @returns {number}
 */
export function residentMB(pid) {
  const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  return Number(out.trim()) / 1024;
}

/**
 * Watch a process and kill it if it goes past a limit.
 *
 * The killing is the point, not a tidy-up. A test that only measured
 * afterwards would, on the day somebody removes the bound it is testing, sit
 * there while the process took ten gigabytes and the machine went down around
 * it — which is not a hypothetical, it is what happened. So the ceiling is
 * enforced while the work is in flight, and the test asserts against the peak.
 *
 * @param {number} pid
 * @param {number} limitMB
 * @returns {{peak: () => number, stop: () => void}}
 */
export function watchResident(pid, limitMB) {
  let peak = 0;

  const timer = setInterval(() => {
    let rss;
    try {
      rss = residentMB(pid);
    } catch {
      return; // gone, which is somebody else's business
    }
    if (rss > peak) peak = rss;
    if (rss > limitMB) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      clearInterval(timer);
    }
  }, 20);

  return { peak: () => peak, stop: () => clearInterval(timer) };
}

/**
 * Run node on something, and do not let it grow past a ceiling.
 *
 * Anything that feeds an over-long input to the search has to run out of
 * process and under a watch. Run in the test runner instead, it would be the
 * runner that took the machine down the day the bound came off.
 *
 * @param {string[]} argv arguments to node
 * @param {{env?: Record<string, string>, ceilingMB?: number}} [options]
 * @returns {Promise<{code: number|null, signal: string|null, out: string, err: string, peak: number}>}
 */
export function runWatched(argv, options = {}) {
  const ceilingMB = options.ceilingMB ?? 500;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });

    const watch = watchResident(/** @type {number} */ (child.pid), ceilingMB);
    child.on('close', (code, signal) => {
      watch.stop();
      resolve({ code, signal, out, err, peak: watch.peak() });
    });
  });
}

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
