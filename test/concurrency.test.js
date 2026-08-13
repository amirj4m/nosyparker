/**
 * Several agents writing at once is the ordinary case for this tool, so the
 * rules have to hold when they do.
 *
 * These tests start real separate processes against one store file. Doing it
 * in one process would prove nothing: the database calls are synchronous, so a
 * single process cannot interleave them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { listDecisions, listMemories, openStore } from '../src/store.js';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');
const CLI_OWNER = 'local';

test('twenty five agents offering the same sentence at once store it once', async (t) => {
  const file = freshStoreFile(t);

  const results = await runAtOnce(
    file,
    Array.from({ length: 25 }, () => ['add', 'I prefer to be written to in short sentences']),
  );

  for (const result of results) {
    assert.equal(result.code, 0, result.output);
  }

  const store = openStore({ file, now: () => new Date().toISOString() });
  t.after(() => store.close());

  const memories = listMemories(store, CLI_OWNER, { includeArchived: true });
  const decisions = listDecisions(store, CLI_OWNER);

  assert.equal(memories.length, 1, `stored ${memories.length} copies of one sentence`);
  assert.equal(decisions.length, 25, 'every attempt should be in the log');
  assert.equal(decisions.filter((decision) => decision.rule === 'keep').length, 1);
  assert.equal(decisions.filter((decision) => decision.rule === 'already-stored').length, 24);
});

test('agents offering different sentences at once all get stored', async (t) => {
  const file = freshStoreFile(t);

  const results = await runAtOnce(
    file,
    Array.from({ length: 12 }, (_, index) => ['add', `sentence number ${index}`]),
  );

  for (const result of results) {
    assert.equal(result.code, 0, result.output);
  }

  const store = openStore({ file, now: () => new Date().toISOString() });
  t.after(() => store.close());

  assert.equal(listMemories(store, CLI_OWNER).length, 12);
  assert.equal(listDecisions(store, CLI_OWNER).length, 12);
});

/**
 * A store file of its own, in a folder that is cleaned up afterwards. The file
 * is created before the children start so that they are racing to write, not
 * racing to build the schema.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function freshStoreFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-race-'));
  const file = path.join(dir, 'memory.sqlite');
  openStore({ file, now: () => new Date().toISOString() }).close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

/**
 * Start every command at the same moment and wait for all of them.
 *
 * @param {string} file
 * @param {string[][]} commands
 * @returns {Promise<{code: number|null, output: string}[]>}
 */
function runAtOnce(file, commands) {
  return Promise.all(
    commands.map(
      (args) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [CLI, ...args], {
            env: { ...process.env, NOSYPARKER_STORE: file },
          });

          let output = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk) => {
            output += chunk;
          });
          child.on('close', (code) => resolve({ code, output }));
        }),
    ),
  );
}
