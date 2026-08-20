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
import { fileURLToPath } from 'node:url';

import { runWatched } from './helpers.js';
import { beginReview, closeReview, review } from '../src/gate.js';
import { LOCAL_OWNER, systemClock } from '../src/config.js';
import { openStore } from '../src/store.js';

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
 * It carries that file on it, for the one test that has to set something up the
 * terminal has no command for. Said in the type as well as in a comment: the
 * property was there and the return type did not mention it, so every use of it
 * was a type error nobody could act on.
 *
 * @param {import('node:test').TestContext} t
 * @returns {((args: string[]) => {code: number|null, out: string, err: string}) & {file: string}}
 */
function commandRunner(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'memory.sqlite');

  /** @param {string[]} args */
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOSYPARKER_STORE: file },
    });

    return { code: result.status, out: result.stdout, err: result.stderr };
  };

  // The store this runner talks to, for the one test that has to set something
  // up the terminal has no command for.
  return Object.assign(run, { file });
}

test('a search too long to run is refused at the terminal, in a sentence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { NOSYPARKER_STORE: path.join(dir, 'memory.sqlite') };

  // A hundred and twenty kilobytes is about as much as a shell will pass in a
  // single argument, and a query that long used to take a terminal past 1.2 GB
  // and climbing. What is under test is the query bound, so the memory it
  // searches is an ordinary one.
  const sentence = 'I answer email in the morning and prefer meetings before noon. ';
  const long = sentence.repeat(Math.ceil(120_000 / sentence.length)).slice(0, 120_000);

  const stored = await runWatched([CLI, 'add', 'I prefer meetings before noon'], { env, ceilingMB: 500 });
  assert.equal(stored.code, 0);
  assert.match(stored.out, /Stored\./u);

  // And the same paste as a memory is refused. At the terminal it is the
  // length that catches it first — that bound was missing here for the whole
  // of Phase 2, and it was the only way to store something a later search
  // could not afford.
  // A gate refusal, so it is an answer on stdout and not an error: the same
  // shape as being told a memory is already stored.
  const pasted = await runWatched([CLI, 'add', long], { env, ceilingMB: 500 });
  assert.equal(pasted.code, 0);
  assert.match(pasted.out, /the limit is 10,000/u);
  assert.match(pasted.out, /keep it in a file and store what matters about it/u);

  // Under that length, a log is still refused for what it is.
  const log = '2026-08-16T09:14:22.031Z INFO  request handled status=200\n'.repeat(150);
  const shortLog = await runWatched([CLI, 'add', log.slice(0, 9_000)], { env, ceilingMB: 500 });
  assert.match(shortLog.out, /reads as a file rather than something to remember/u);

  // And a reason is bounded the same way.
  const reason = await runWatched([CLI, 'forget', '1', long], { env, ceilingMB: 500 });
  assert.equal(reason.code, 0);
  assert.match(reason.out, /the limit is 10,000/u);

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

test('a person can undo a whole review from the terminal, and the log tells them which one', (t) => {
  const run = commandRunner(t);

  run(['add', 'Next month I am going to Berlin']);
  run(['add', 'I live in Tehran']);

  // The review itself is an agent's work, so it is done through the gate the
  // way an agent would; what is being tested here is the one part of it a
  // person reaches from a terminal.
  const store = openStore({ file: run.file, now: systemClock });
  const started = beginReview(store, { owner: LOCAL_OWNER, reviewer: 'an agent' });
  const pass = /** @type {number} */ (started.pass_id);
  review(store, {
    owner: LOCAL_OWNER,
    pass,
    id: 1,
    outcome: 'overtaken',
    reasoning: 'The month it named has gone by and nothing replaced it.',
    derivedFrom: [1],
  });
  closeReview(store, { owner: LOCAL_OWNER, pass });
  store.close();

  assert.doesNotMatch(run(['list']).out, /going to Berlin/u);

  // Everything a person needs to judge it and to reverse it, in the one place
  // they already go to ask why something happened.
  const log = run(['log']);
  assert.match(log.out, /review: 1/u);
  assert.match(log.out, /read: 1/u);
  assert.match(log.out, /reviewer said: The month it named has gone by/u);

  assert.match(run(['undo-review']).err, /Which review\?/u);
  assert.equal(run(['undo-review']).code, 1);

  const undone = run(['undo-review', '1']);
  assert.equal(undone.code, 0);
  assert.match(undone.out, /Review 1 is undone/u);
  assert.match(run(['list']).out, /going to Berlin/u);

  assert.match(run(['undo-review', '1']).out, /already undone/u);
  assert.match(run(['undo-review', '1', 'extra']).err, /does not take extra/u);
});

test('export writes a file, refuses to write over one, and pipes when unnamed', (t) => {
  const run = commandRunner(t);
  const dump = path.join(path.dirname(run.file), 'dump.json');

  run(['add', 'I live in Tehran']);
  run(['add', 'I have moved to Vienna', '--replaces', '1']);
  run(['forget', '2', 'no, I am still in Tehran']);

  const written = run(['export', dump]);
  assert.equal(written.code, 0);
  assert.match(written.out, /Written to/u);

  const dumped = JSON.parse(fs.readFileSync(dump, 'utf8'));
  assert.deepEqual(dumped.memories.map((/** @type {any} */ m) => m.state).sort(),
    ['forgotten', 'superseded']);
  assert.ok(dumped.decisions.length >= 3);

  // Insurance is not something to overwrite by accident.
  const again = run(['export', dump]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already there, and this will not write over it/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(dump, 'utf8')), dumped);

  // Unnamed goes to standard output, so it pipes.
  const piped = run(['export']);
  assert.equal(piped.code, 0);
  assert.deepEqual(JSON.parse(piped.out).memories, dumped.memories);

  assert.match(run(['export', dump, 'extra']).err, /does not take extra/u);
});

test('a mistake of ours is not dressed up as a refusal', (t) => {
  // `runSetup` grew a blanket catch so that `install`'s deliberate refusal
  // would print as a sentence rather than a stack. It caught everything, so an
  // injected `ReferenceError` printed as `nope is not defined` with no stack
  // and nothing to say it was a bug — indistinguishable from a considered no.
  // That is the shape this project keeps writing rules against, one level up
  // from the one it had just fixed downstream.
  //
  // Tested by breaking the program on purpose and running it, because the
  // question is what a person sees, not what the source looks like.
  const setup = fileURLToPath(new URL('../src/setup.js', import.meta.url));
  const original = fs.readFileSync(setup, 'utf8');
  t.after(() => fs.writeFileSync(setup, original));

  fs.writeFileSync(setup, original.replace(
    'export function install(io) {',
    'export function install(io) {\n  nope.notAThing();',
  ));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-oops-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const broken = spawnSync(process.execPath, [CLI, 'setup'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NOSYPARKER_STORE: path.join(home, 'memory.sqlite') },
  });

  const said = `${broken.stdout}${broken.stderr}`;
  assert.match(said, /ReferenceError/u, 'a bug should say it is a bug');
  assert.match(said, /at .*setup\.js/u, 'a bug should come with the stack somebody would report');

});

test('started through the shim, the sentences it prints name the command', (t) => {
  // `invocation()` grew a branch for the command a global install puts on PATH,
  // and nothing held it: deleting the branch changed no test, so every usage
  // string could have gone back to naming a path without anybody noticing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // npm's shim is a symlink named after the command; node reports it as argv[1].
  const shim = path.join(dir, 'nosyparker');
  fs.symlinkSync(CLI, shim);

  const said = spawnSync(process.execPath, [shim, 'add'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, NOSYPARKER_STORE: path.join(dir, 'memory.sqlite') },
  });

  const out = `${said.stdout}${said.stderr}`;
  assert.match(out, /nosyparker add "<text>"/u, 'it should name the command it was started as');
  assert.doesNotMatch(out, /node .*src\/cli\.js add/u, 'it named a path instead');
});
