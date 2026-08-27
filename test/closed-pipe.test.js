/**
 * What happens when somebody pipes a command into `head`.
 *
 * `nosyparker search 2026 | head -1` printed the first line, then a raw Node
 * stack trace with our own source paths in it, and exited 1. `head` closes the
 * pipe after the line it was asked for; the next write fails with EPIPE; Node
 * turns an unhandled `error` event on stdout into a crash.
 *
 * That is the same defect the migration was carrying — a stack trace where a
 * sentence belongs — and the guard written for it was one file away from the
 * place a person is most likely to meet it. This file exists so the guard is
 * against the thing rather than against its neighbour, which is why every case
 * below runs the real binary through a real pipe rather than simulating one.
 *
 * A tool whose reader has gone away has nothing to complain about. It stops
 * writing and goes quietly.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';

import { submit } from '../src/gate.js';
import { openStore } from '../src/store.js';
import { LOCAL_OWNER } from '../src/config.js';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');

/**
 * A store with enough in it that a command has to write more than once.
 *
 * One `write()` that fits in the pipe buffer never meets a closed reader, so a
 * store of three memories would let every command below pass without the fix.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function loudStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-pipe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'memory.sqlite');
  const store = openStore({ file, now: () => new Date().toISOString() });
  for (let n = 0; n < 300; n += 1) {
    submit(store, { owner: LOCAL_OWNER, text: `memory number ${n} about the meeting on floor ${n % 40} in ۲۰۲۶` });
  }
  store.close();
  return file;
}

/**
 * Run `nosyparker <argv> | head -1` in a real shell, and report what the
 * program did rather than what the pipeline did.
 *
 * @param {string} file
 * @param {string[]} argv
 * @returns {{status: number, stderr: string}}
 */
function throughHead(file, argv) {
  const quoted = argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');

  // The program's own status, not the pipeline's. `head` exits 0 whatever
  // happens to its left, and `PIPESTATUS` does not exist in /bin/sh here — the
  // first version of this used it, read head's 0, and asserted nothing at all.
  // Recording `$?` inside the left-hand side of the pipe works in any shell.
  const run = spawnSync('/bin/sh', [
    '-c',
    `{ "$NODE" "$CLI" ${quoted} 2>"$ERRFILE"; echo "$?" > "$RCFILE"; } | head -1 >/dev/null`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE: process.execPath,
      CLI,
      NOSYPARKER_STORE: file,
      ERRFILE: `${file}.err`,
      RCFILE: `${file}.rc`,
    },
  });
  assert.equal(run.status, 0, 'the harness itself failed');

  return {
    status: Number(fs.readFileSync(`${file}.rc`, 'utf8').trim()),
    stderr: fs.readFileSync(`${file}.err`, 'utf8'),
  };
}

const COMMANDS = [
  ['search', '2026'],
  ['list'],
  ['log'],
  ['export'],
];

test('a command piped into head says nothing and does not crash', (t) => {
  // The list is every command that writes more than a line or two. `add`,
  // `forget`, `restore` and `undo-review` write one line and never meet a
  // closed reader; they are left out rather than asserted on, because a test
  // that cannot fail is not a test.
  const file = loudStore(t);

  for (const argv of COMMANDS) {
    const { stderr } = throughHead(file, argv);

    assert.equal(stderr, '', `\`${argv.join(' ')} | head -1\` wrote to stderr:\n${stderr.slice(0, 400)}`);
    assert.doesNotMatch(stderr, /EPIPE/u);
    assert.doesNotMatch(stderr, /^\s*at .+:\d+:\d+\)?$/mu, 'it printed a stack frame');
  }
});

test('and setup printing a config is the same', (t) => {
  // Not a store command, and it goes down a different path in `cli-main.js`,
  // which is exactly how a fix applied per-command would come out half done.
  const file = loudStore(t);
  const { stderr } = throughHead(file, ['setup', '--print-config', 'gemini-cli']);

  assert.equal(stderr, '', `setup --print-config wrote to stderr:\n${stderr.slice(0, 400)}`);
});

test('the first line still arrives, so this is not silence bought by writing nothing', (t) => {
  // The failure mode of the fix: catching the error early enough that nothing
  // reaches the reader at all. `head -1` must still get its line.
  const file = loudStore(t);

  const line = execFileSync('/bin/sh', [
    '-c',
    `"$NODE" "$CLI" search 2026 2>/dev/null | head -1`,
  ], { encoding: 'utf8', env: { ...process.env, NODE: process.execPath, CLI, NOSYPARKER_STORE: file } });

  assert.match(line, /^\d+ matches:/u, `head -1 got ${JSON.stringify(line)}`);
});

test('the exit code is not a failure', (t) => {
  // It exited 1, which to a script reads as the search having gone wrong. The
  // reader going away is not our failure and must not be reported as one.
  const file = loudStore(t);

  for (const argv of COMMANDS) {
    const { status } = throughHead(file, argv);
    assert.notEqual(status, 1, `\`${argv.join(' ')}\` still exits 1 when the pipe closes`);
  }
});

test('a write that fails for any other reason is still reported', (t) => {
  // The trap in the fix. A handler that swallows every write error swallows a
  // full disk with it. Only "the reader has gone" is quiet.
  const file = loudStore(t);
  const full = path.join(path.dirname(file), 'full');
  fs.mkdirSync(full);

  // A pipe whose reader exits *without* reading is EPIPE and must be quiet; a
  // write to a full filesystem is not. The nearest thing a test can arrange
  // without filling a disk is /dev/full, which accepts the open and fails every
  // write with ENOSPC — the real error, from the real kernel.
  assert.ok(fs.existsSync('/dev/full'), 'this machine has no /dev/full to fail against');
  fs.rmSync(full, { recursive: true, force: true });

  const run = spawnSync('/bin/sh', [
    '-c',
    `"$NODE" "$CLI" list > /dev/full 2>"$ERRFILE"; echo "$?"`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE: process.execPath, CLI, NOSYPARKER_STORE: file, ERRFILE: `${file}.e2` },
  });

  const status = Number(String(run.stdout).trim());
  const stderr = fs.readFileSync(`${file}.e2`, 'utf8');

  assert.notEqual(status, 0, 'a write that could not land was reported as success');
  assert.notEqual(stderr, '', 'a write that could not land said nothing at all');
  assert.doesNotMatch(stderr, /^\s*at .+:\d+:\d+\)?$/mu, 'it reported the failure as a stack trace');
});
