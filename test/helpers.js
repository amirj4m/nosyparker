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
 * The environment a child process gets when it must not touch this machine.
 *
 * `HOME` alone is a sandbox on Linux and macOS and nothing at all on Windows,
 * where `os.homedir()` reads `USERPROFILE` and ignores `HOME` outright. Every
 * path this program derives from home goes with it: the store, the backup
 * directory, `actions.log` — and `%APPDATA%`, which four client rows expand
 * into and which `setup` writes to.
 *
 * So a test that spawned the CLI with `{ HOME: temp }` and let it find its own
 * store would, on Windows, write a memory into the real profile and then fail
 * looking for it in the temp directory. That is not hypothetical: the fifth
 * reviewer tripped this exact defect against its own home while hunting for it,
 * through a quoting slip that left a child with no fake home at all.
 *
 * Which is the argument for a helper rather than a rule people remember. There
 * is one way to build a child's environment here, it sets all four together,
 * and a test in `cli.test.js` fails if any test file hand-rolls one instead.
 *
 * @param {string} home a directory this test owns and will delete
 * @param {Record<string, string>} [extra] overrides — pass
 *   `{ NOSYPARKER_STORE: '' }` to exercise the default store path *inside* the
 *   sandbox, which is the only reason to unset it
 * @returns {Record<string, string|undefined>}
 */
export function sandboxEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    NOSYPARKER_STORE: path.join(home, 'memory.sqlite'),
    ...extra,
  };
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
 * Every temporary folder this file has handed out, so they can be taken away
 * again at the end.
 *
 * They were not, for five phases. Each call left a directory in `/tmp` holding
 * a SQLite file and nothing removed them. By the time anybody looked there were
 * 31,420 of them holding 5.0 GB, which was the whole of the free space on that
 * filesystem and stopped an unrelated system upgrade.
 *
 * The reason first written here was that `/tmp` is on the root filesystem
 * rather than a tmpfs, so they survived reboots. That was a guess and it was
 * wrong: `tmpfiles.d` on that machine has `D /tmp`, and the capital D empties
 * the directory at every boot whatever filesystem it sits on. They had all
 * accumulated inside a single boot session — five days, about a gigabyte a
 * day — which makes the leak faster than the guess made it sound, not slower.
 *
 * Cleaned at process exit rather than by each test, because the alternative is
 * a cleanup inside `close()` — and two tests deliberately reopen a store's file
 * after closing it, so that would break them for the sake of tidiness. The
 * exit handler needs nothing from any caller and cannot be forgotten by a new
 * test.
 *
 * @type {string[]}
 */
const temporaryFolders = [];

process.on('exit', () => {
  for (const dir of temporaryFolders) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A folder a test moved or removed itself. Nothing to do and nothing
      // worth failing a finished run over.
    }
  }
});

/**
 * A store in a fresh temporary folder, with a clock the test controls.
 *
 * @param {object} [options]
 * @param {string} [options.start] first timestamp the clock hands out
 * @returns {import('../src/store.js').Store & {tick: () => void, dir: string}}
 */
export function temporaryStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-test-'));
  temporaryFolders.push(dir);
  const file = path.join(dir, 'memory.sqlite');

  let clock = Date.parse(options.start ?? '2026-01-01T00:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const tick = () => {
    clock += 1000;
  };

  const store = openStore({ file, now });
  return Object.assign(store, { tick, dir });
}
