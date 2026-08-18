/**
 * Two of us writing to the same config file at the same time.
 *
 * This is the only path anybody has demonstrated to destroying somebody's
 * configuration, and it was found by a review rather than by us. The first
 * version of the atomic write built its temporary file's name out of the
 * config file's name alone, so every process on the machine chose the same
 * path: two writers opened it, both wrote, and the rename that was supposed to
 * be the one indivisible step published a blend of the two.
 *
 * The read-back check downstream does notice — but only after the file on disk
 * is already ruined, which is the wrong end of the problem to be right at.
 *
 * The realistic case is two `setup` runs racing an `uninstall`, which is rare;
 * the tests below are deliberately harsher than that, because "rare" is not a
 * property anybody can rely on and this is somebody's editor configuration.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { clearAbandonedTemporaries, readOrEmpty, writePreservingMode } from '../src/write.js';

/**
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The worker each concurrency test forks. Kept beside the test that runs it. */
const WORKER = `
import { readOrEmpty, writePreservingMode } from ${JSON.stringify(fileURLToPath(new URL('../src/write.js', import.meta.url)))};
import { insertEntry, removeEntry } from ${JSON.stringify(fileURLToPath(new URL('../src/edit.js', import.meta.url)))};

const file = process.env.RACE_FILE;
const request = {
  format: 'json',
  rootKey: 'mcpServers',
  name: process.env.RACE_NAME,
  entry: { command: '/usr/bin/node', args: ['/srv/mcp-server.js'] },
};

for (let cycle = 0; cycle < Number(process.env.RACE_CYCLES); cycle += 1) {
  try {
    writePreservingMode(file, insertEntry(readOrEmpty(file), request));
    writePreservingMode(file, removeEntry(readOrEmpty(file), request));
  } catch {
    // A writer that loses a race is allowed to fail. It is not allowed to
    // corrupt, which is what the assertions afterwards are about.
  }
}
`;

/**
 * @param {string} dir
 * @param {number} workers
 * @param {number} cycles
 * @returns {Promise<void>}
 */
async function race(dir, workers, cycles) {
  const worker = path.join(dir, 'worker.mjs');
  fs.writeFileSync(worker, WORKER);

  await Promise.all(Array.from({ length: workers }, (_, n) => new Promise((done) => {
    const child = fork(worker, {
      env: { ...process.env, RACE_FILE: path.join(dir, 'mcp.json'), RACE_NAME: `nosyparker${n}`, RACE_CYCLES: String(cycles) },
      stdio: 'ignore',
    });
    child.on('exit', () => done(undefined));
  })));

  fs.rmSync(worker, { force: true });
}

test('four processes writing at once cannot corrupt the file or lose what was in it', async (t) => {
  // With the shared temporary name this failed on the first trial, every time,
  // at two workers — and at four it destroyed the server that was already in
  // the file. 200 cycles is well past where it used to break.
  const dir = directory(t);
  const file = path.join(dir, 'mcp.json');
  const before = `${JSON.stringify({ mcpServers: { theirs: { command: 'keep-me' } } }, null, 2)}\n`;
  fs.writeFileSync(file, before);

  await race(dir, 4, 200);

  const after = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(after);

  assert.equal(parsed.mcpServers.theirs.command, 'keep-me', 'their server is still theirs');

  // And nothing of ours is left in the directory afterwards.
  assert.deepEqual(fs.readdirSync(dir), ['mcp.json']);
});

test('every write picks a name no other process is holding', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'mcp.json');

  /** @type {Set<string>} */
  const seen = new Set();
  const realOpen = fs.openSync;

  t.mock.method(fs, 'openSync', (/** @type {any} */ target, /** @type {any} */ flags, /** @type {any} */ mode) => {
    if (typeof target === 'string' && target.endsWith('.tmp')) {
      assert.equal(seen.has(target), false, `${target} was chosen twice`);
      seen.add(target);
      assert.match(path.basename(target), /^\.nosyparker\.mcp\.json\.\d+\.[0-9a-f]{12}\.tmp$/u,
        'the name carries the process id and something random');
    }
    return realOpen(target, flags, mode);
  });

  for (let n = 0; n < 20; n += 1) writePreservingMode(file, `{"n": ${n}}\n`);

  assert.equal(seen.size, 20);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"n": 19}\n');
});

test('a name that somehow already exists is refused, not written over', (t) => {
  // The part that makes this safe rather than merely unlikely. If the unique
  // name is somehow taken, the open fails and the original file is untouched —
  // rather than truncating whatever was there.
  const dir = directory(t);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{"original": true}\n');

  const realOpen = fs.openSync;
  const collision = path.join(dir, '.nosyparker.mcp.json.1.aaaaaaaaaaaa.tmp');
  fs.writeFileSync(collision, 'somebody else was here');

  t.mock.method(fs, 'openSync', (/** @type {any} */ target, /** @type {any} */ flags, /** @type {any} */ mode) =>
    realOpen(typeof target === 'string' && target.endsWith('.tmp') ? collision : target, flags, mode));

  assert.throws(() => writePreservingMode(file, '{"new": true}\n'), /EEXIST/u);

  assert.equal(fs.readFileSync(file, 'utf8'), '{"original": true}\n', 'the real file is untouched');
  assert.equal(fs.readFileSync(collision, 'utf8'), 'somebody else was here', 'and so is theirs');
});

test('a temporary left by a killed process is swept, and nothing else is', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{}\n');

  const abandoned = path.join(dir, '.nosyparker.mcp.json.99999.abcdef123456.tmp');
  fs.writeFileSync(abandoned, 'half a config');

  // Things that are not ours, including a temporary belonging to some other
  // config file in the same directory.
  const theirs = path.join(dir, '.other-tool.mcp.json.tmp');
  const otherConfig = path.join(dir, '.nosyparker.settings.json.123.abcdef123456.tmp');
  fs.writeFileSync(theirs, 'not ours');
  fs.writeFileSync(otherConfig, 'ours, but for a different file');

  clearAbandonedTemporaries(file);

  assert.equal(fs.existsSync(abandoned), false, 'our litter is gone');
  assert.equal(fs.existsSync(theirs), true, 'somebody else\'s is not touched');
  assert.equal(fs.existsSync(otherConfig), true, 'nor is ours for another file');
  assert.equal(fs.existsSync(file), true);
});

test('sweeping a directory that is not there is not an error', () => {
  clearAbandonedTemporaries('/nowhere/at/all/mcp.json');
});

test('a failed write leaves no temporary behind', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{"original": true}\n');

  const realWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (/** @type {any} */ target, /** @type {any} */ data, /** @type {any} */ options) => {
    if (typeof target === 'number') throw new Error('disk went away mid-write');
    return realWrite(target, data, options);
  });

  assert.throws(() => writePreservingMode(file, '{"new": true}\n'), /disk went away/u);

  assert.deepEqual(fs.readdirSync(dir), ['mcp.json']);
  assert.equal(readOrEmpty(file), '{"original": true}\n');
});
