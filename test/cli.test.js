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
import { DatabaseSync } from 'node:sqlite';

import { runWatched } from './helpers.js';

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

test('no Node warning about SQLite reaches the terminal', (t) => {
  const run = commandRunner(t);

  // Two lines of red after a command that worked is how a person decides a
  // tool is broken.
  const stored = run(['add', 'I live in Berlin']);
  assert.equal(stored.code, 0);
  assert.equal(stored.err, '', `stderr should be empty, got: ${stored.err}`);

  // And every command, not just the first one to touch the store.
  for (const args of [['list'], ['log'], ['search', 'Berlin'], ['forget', '1', 'moved']]) {
    assert.equal(run(args).err.includes('ExperimentalWarning'), false, `warning leaked from ${args[0]}`);
  }

  // What the tool has to say for itself still arrives, which is the half a
  // blanket --no-warnings would have taken with it.
  const unknown = run(['sing']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no command called "sing"/u);
  assert.equal(unknown.err.includes('ExperimentalWarning'), false);
});

test('an argument a command does not take is refused, not ignored', (t) => {
  const run = commandRunner(t);
  run(['add', 'I live in Berlin']);

  // --all was taken out on purpose. Accepting it in silence told the reader
  // they had been shown the forgotten and replaced memories as well.
  const all = run(['list', '--all']);
  assert.equal(all.code, 1);
  assert.match(all.err, /"list" does not take --all/u);

  assert.equal(run(['log', '--since', 'yesterday']).code, 1);
  assert.equal(run(['restore', '1', 'please']).code, 1);

  // And each of them still works when given nothing it did not ask for.
  assert.equal(run(['list']).code, 0);
  assert.equal(run(['log']).code, 0);
  assert.equal(run(['restore', '1']).code, 0);
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

test('a search too long to run is refused at the terminal, in a sentence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { NOSYPARKER_STORE: path.join(dir, 'memory.sqlite') };

  // A hundred and twenty kilobytes is about as much as a shell will pass in a
  // single argument, and it used to take a terminal past 1.2 GB and climbing.
  // Ordinary prose of that length, so the write-time rule has no quarrel with
  // it and what is under test is the query bound rather than the paste.
  const sentence = 'I answer email in the morning and prefer meetings before noon. ';
  const long = sentence.repeat(Math.ceil(120_000 / sentence.length)).slice(0, 120_000);

  const stored = await runWatched([CLI, 'add', long], { env, ceilingMB: 500 });
  assert.equal(stored.code, 0);
  assert.match(stored.out, /Stored\./u, 'ordinary prose that long is fine to store');

  const searched = await runWatched([CLI, 'search', long], { env, ceilingMB: 500 });

  assert.equal(searched.signal, null, `the search was killed at ${searched.peak.toFixed(0)} MB`);
  assert.equal(searched.code, 1);
  assert.match(searched.err, /That search is longer than this store will run/u);
  assert.match(searched.err, /the limit is 1000 characters/u);
  assert.equal(searched.err.includes('at Object'), false, 'a sentence, not a stack trace');

  // And an ordinary search of that same store still works.
  const ordinary = await runWatched([CLI, 'search', 'meetings before noon'], { env, ceilingMB: 500 });
  assert.equal(ordinary.code, 0);
  assert.match(ordinary.out, /1 match/u);
});


test('a store this code cannot read is refused in a sentence, not a stack trace', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.sqlite');

  // A real store, stamped with a version this code does not know.
  /** @param {string[]} args */
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, NOSYPARKER_STORE: file },
  });
  assert.equal(run(['add', 'I live in Berlin']).status, 0);

  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 99');
  db.close();

  const opened = run(['list']);
  assert.equal(opened.status, 1);
  assert.match(opened.stderr, /written by a newer version of nosyparker/u);
  assert.match(opened.stderr, /schema version 99/u);

  // The sentence names the file, which is the whole point of it.
  assert.ok(opened.stderr.includes(file), 'the message should name the file');

  // And it is a sentence rather than a stack trace under one.
  assert.equal(/^\s*at /mu.test(opened.stderr), false, opened.stderr);
  assert.equal(opened.stderr.includes('throw'), false);
});
