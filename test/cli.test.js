/**
 * The command line tool, exercised the way a person uses it: by running it.
 *
 * These tests care about what someone reading the terminal sees, and about the
 * exit codes, since those are the tool's whole interface.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');

test('storing, listing, searching and reading the log', (t) => {
  const run = commandRunner(t);

  assert.match(run(['add', 'I prefer short sentences']).out, /Stored\. \(memory 1\)/u);
  assert.match(run(['add', '我住在柏林']).out, /Stored\. \(memory 2\)/u);

  const listed = run(['list']);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /1\. I prefer short sentences/u);
  assert.match(listed.out, /2\. 我住在柏林/u);

  assert.match(run(['search', 'short sentences']).out, /1 match/u);
  assert.match(run(['search', '柏林']).out, /我住在柏林/u, 'a two character search should work');
  assert.match(run(['search', 'pineapple']).out, /Nothing matched/u);

  const log = run(['log']);
  assert.match(log.out, /stored \(keep\)/u);
  assert.match(log.out, /text: I prefer short sentences/u);
});

test('an empty store says so rather than printing nothing', (t) => {
  const run = commandRunner(t);

  assert.match(run(['list']).out, /Nothing stored yet/u);
  assert.match(run(['log']).out, /Nothing has happened yet/u);
});

test('a refusal is explained and is not an error', (t) => {
  const run = commandRunner(t);

  run(['add', 'I prefer short sentences']);

  const duplicate = run(['add', 'I prefer short sentences']);
  assert.equal(duplicate.code, 0, 'a refusal is an answer, not a crash');
  assert.match(duplicate.out, /already stored as memory 1/u);

  const credential = run(['add', `my key is ${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}`]);
  assert.equal(credential.code, 0);
  assert.match(credential.out, /looks like an AWS access key/u);
  assert.match(credential.out, /memory, not a secret store/u);

  // And the credential is not in the log either.
  assert.match(run(['log']).out, /\[not recorded: recognised as an AWS access key/u);
});

test('forgetting and restoring, and what the list shows in between', (t) => {
  const run = commandRunner(t);

  run(['add', 'I am vegetarian']);

  assert.match(run(['forget', '1', 'I eat fish again']).out, /will not be shown any more/u);
  assert.match(run(['list']).out, /Nothing stored yet/u);
  assert.match(run(['search', 'vegetarian']).out, /Nothing matched/u);

  // What was put away is read back from the log, not from the list.
  assert.match(run(['log']).out, /forgotten \(forget\)/u);
  assert.match(run(['log']).out, /text: I eat fish again/u);

  assert.match(run(['restore', '1']).out, /being shown again/u);
  assert.match(run(['list']).out, /1\. I am vegetarian/u);
});

test('replacing a memory from the command line', (t) => {
  const run = commandRunner(t);

  run(['add', 'I live in Tehran']);
  const replaced = run(['add', 'I live in Berlin', '--replaces', '1']);

  assert.match(replaced.out, /memory 1 was retired in its favour/u);
  assert.match(run(['list']).out, /^2\. I live in Berlin$/mu);
  assert.equal(run(['list']).out.includes('Tehran'), false, 'the retired one is not shown');
});

test('the tool says what it wants when it is given nonsense', (t) => {
  const run = commandRunner(t);

  const noCommand = run([]);
  assert.equal(noCommand.code, 1);
  assert.match(noCommand.err, /No command was given/u);
  assert.equal(noCommand.err.includes('search'), false, 'it does not list the commands');

  assert.equal(run(['add']).code, 1);
  assert.match(run(['add']).err, /Say what you want to store/u);

  assert.equal(run(['search']).code, 1);
  assert.equal(run(['forget']).code, 1);
  assert.equal(run(['forget', '1']).code, 1, 'forgetting needs a reason');
  assert.equal(run(['restore']).code, 1);

  const unknown = run(['sing']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no command called "sing"/u);
  assert.equal(unknown.err.includes('search'), false, 'it does not list the commands');

  const badId = run(['restore', 'seven']);
  assert.equal(badId.code, 1);
  assert.match(badId.err, /not a memory id/u);
});

test('--replaces is checked before anything is stored', (t) => {
  const run = commandRunner(t);

  run(['add', 'one']);

  const twice = run(['add', 'two', '--replaces', '1', '--replaces', '1']);
  assert.equal(twice.code, 1);
  assert.match(twice.err, /more than once/u);

  const missing = run(['add', 'two', '--replaces']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /needs the id/u);

  // Neither attempt stored anything, and memory 1 is untouched.
  assert.match(run(['list']).out, /^1\. one$/mu);
  assert.equal(run(['list']).out.includes('two'), false);
});

/**
 * A runner bound to a store file of its own.
 *
 * @param {import('node:test').TestContext} t
 * @returns {(args: string[]) => {code: number|null, out: string, err: string}}
 */
function commandRunner(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOSYPARKER_STORE: path.join(dir, 'memory.sqlite') },
    });

    return { code: result.status, out: result.stdout, err: result.stderr };
  };
}
