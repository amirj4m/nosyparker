/**
 * The MCP server, exercised the way an agent uses it: over stdio, through a
 * real client, against a real server process.
 *
 * Nothing here calls a function in `src/tools.js` directly. A test that did
 * would pass with the server unable to start, the tools unlisted, or the
 * schemas malformed, and would say nothing about whether an agent can use any
 * of this. So every one of these speaks the protocol.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore, recordDecision } from '../src/store.js';
import { residentMB, watchResident } from './helpers.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.join(import.meta.dirname, '..', 'src', 'mcp-server.js');

/** Invented, and assembled here so this file does not itself hold a key. */
const SECRET = ['AKIA', 'QQQZZZTESTKEY999'].join('');

test('the server lists exactly the six tools, each with something to read', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  const { tools } = await agent.listTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['remember', 'recall', 'forget', 'restore', 'list', 'why'],
  );

  for (const tool of tools) {
    // A tool an agent cannot tell when to use is a tool it will not use, so
    // the description is part of the product rather than documentation.
    assert.ok(
      (tool.description ?? '').length > 200,
      `${tool.name} needs a description that says when to reach for it`,
    );
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('remember, recall, list, forget and why, one after another', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  assert.match(await say(agent, 'remember', { text: 'I prefer short sentences' }), /Stored\./u);
  assert.match(await say(agent, 'remember', { text: '我住在柏林' }), /Stored\./u);

  const listed = await say(agent, 'list', {});
  assert.match(listed, /^1\. I prefer short sentences$/mu);
  assert.match(listed, /^2\. 我住在柏林$/mu);

  assert.match(await say(agent, 'recall', { query: 'short sentences' }), /1 match/u);
  assert.match(await say(agent, 'recall', { query: '柏林' }), /我住在柏林/u);
  assert.match(await say(agent, 'recall', { query: 'pineapple' }), /Nothing matched/u);

  const forgotten = await say(agent, 'forget', { id: 1, reason: 'I like long ones now' });
  assert.match(forgotten, /will not be shown any more/u);
  assert.equal((await say(agent, 'list', {})).includes('short sentences'), false);
  assert.match(await say(agent, 'recall', { query: 'short sentences' }), /Nothing matched/u);

  // What was put away is read back from the log, which is what `why` is for.
  const log = await say(agent, 'why', {});
  assert.match(log, /forgotten \(forget\)/u);
  assert.match(log, /text: I like long ones now/u);
});

test('remember with replaces retires the old memory and keeps it in the file', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I live in Tehran' });
  const replaced = await say(agent, 'remember', { text: 'I live in Berlin', replaces: 1 });

  assert.match(replaced, /memory 1 was retired in its favour/u);
  assert.match(replaced, /still in the file/u);

  const listed = await say(agent, 'list', {});
  assert.match(listed, /^2\. I live in Berlin$/mu);
  assert.equal(listed.includes('Tehran'), false, 'the retired one is not shown');

  assert.match(await say(agent, 'why', {}), /superseded \(replaces\)/u);
});

test('the agent is told what this is when it connects', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  const instructions = agent.getInstructions() ?? '';

  assert.notEqual(instructions, '', 'the server should introduce itself');

  // Short on purpose. A model reads this on every connection, and a page of
  // instruction is skimmed as boilerplate. The cap is loose; it is here to
  // catch this growing into a policy document, not to police a sentence.
  assert.ok(
    instructions.length < 1200,
    `the introduction is ${instructions.length} characters, which is too long to be read`,
  );
});

test('what an agent puts away, an agent can bring back', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I am vegetarian' });
  await say(agent, 'forget', { id: 1, reason: 'I eat fish again' });
  assert.equal(await say(agent, 'list', {}), 'Nothing stored yet.');

  // The id has left list and recall by now, which is exactly why restore's
  // description sends the agent to `why` to find it.
  assert.match(await say(agent, 'why', {}), /^ {2}memory: 1$/mu);

  assert.match(await say(agent, 'restore', { id: 1 }), /being shown again/u);
  assert.equal(await say(agent, 'list', {}), '1. I am vegetarian');
  assert.match(await say(agent, 'recall', { query: 'vegetarian' }), /1 match/u);

  // Asking again for something already being shown says so and changes
  // nothing, which is what makes this safe for an agent to reach for.
  assert.match(await say(agent, 'restore', { id: 1 }), /being shown again/u);
  assert.equal(await say(agent, 'list', {}), '1. I am vegetarian');

  assert.match(await say(agent, 'why', {}), /restored \(restored\)/u);
});

test('restoring a replaced memory leaves the newer one no longer claiming it', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I live in Tehran' });
  await say(agent, 'remember', { text: 'I live in Berlin', replaces: 1 });

  assert.match(
    await say(agent, 'restore', { id: 1 }),
    /memory 2 no longer claims to have replaced it/u,
  );

  const listed = await say(agent, 'list', {});
  assert.match(listed, /^1\. I live in Tehran$/mu, 'the older one is shown again');
  assert.match(listed, /^2\. I live in Berlin$/mu, 'and the newer one still is');
});

test('an empty store says so rather than answering with nothing', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  assert.equal(await say(agent, 'list', {}), 'Nothing stored yet.');
  assert.equal(await say(agent, 'why', {}), 'Nothing has happened yet.');
});

test('a credential offered through remember reaches neither the store nor the log', async (t) => {
  const file = freshStoreFile(t);
  const agent = await connect(t, file);

  // Ordinary memories first, so the byte scan below is looking through a file
  // with real content in it.
  await say(agent, 'remember', { text: 'I prefer meetings before noon' });

  const refused = await say(agent, 'remember', { text: `my aws key is ${SECRET}` });
  assert.match(refused, /looks like an AWS access key/u);
  assert.match(refused, /memory, not a secret store/u);

  // A refusal is an answer, not a failure. Told otherwise, an agent tries
  // again in a different shape, which is the one thing this rule exists to
  // stop.
  const raw = await agent.callTool({
    name: 'remember',
    arguments: { text: `my aws key is ${SECRET}` },
  });
  assert.notEqual(raw.isError, true, 'a refusal must not read as a failed call');

  // The refusal is in the log, and what was refused is not.
  const log = await say(agent, 'why', {});
  assert.match(log, /refused \(credential\)/u);
  assert.match(log, /\[not recorded: recognised as an AWS access key\]/u);
  assert.equal(log.includes(SECRET), false);

  // The bytes are the proof. Asking the database would only show that no row
  // has it; this shows it was never written.
  //
  // Read with the server still up, on purpose. Closing the store checkpoints
  // the write ahead log and takes the file away, so a scan afterwards would be
  // looking at whatever survived the tidying rather than at everything that
  // was ever written.
  const database = fs.readFileSync(file);
  const wal = fs.readFileSync(`${file}-wal`);

  assert.ok(
    contains(database, 'I prefer meetings before noon') ||
      contains(wal, 'I prefer meetings before noon'),
    'a stored memory should be findable in the bytes, or this scan proves nothing',
  );
  assert.equal(contains(database, SECRET), false, 'the key reached the database file');
  assert.equal(contains(wal, SECRET), false, 'the key reached the write ahead log');
});

test('every refusal writes its row, whatever it was refused for', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I prefer short sentences' });

  await say(agent, 'remember', { text: 'I prefer short sentences' });
  await say(agent, 'remember', { text: '   ' });
  await say(agent, 'remember', { text: SECRET });
  await say(agent, 'remember', { text: 'something new', replaces: 404 });
  await say(agent, 'forget', { id: 404, reason: 'not there' });
  await say(agent, 'restore', { id: 404 });

  const log = await say(agent, 'why', {});
  for (const rule of [
    'stored (keep)',
    'refused (already-stored)',
    'refused (empty)',
    'refused (credential)',
    'refused (replaces-unknown)',
    'refused (forget-unknown)',
    'refused (restore-unknown)',
  ]) {
    assert.ok(log.includes(rule), `${rule} should be in the log`);
  }

  // Seven calls, seven entries, in the order they were made.
  assert.equal(log.split('\n\n').length, 7);
});

test('a malformed call is answered with a sentence and the server carries on', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I live in Berlin' });

  /**
   * Each of these is a way a client can get a call wrong.
   *
   * @type {[string, Record<string, unknown>, RegExp][]}
   */
  const wrong = [
    ['remember', {}, /"text" has to be text/u],
    ['remember', { text: 5 }, /this call gave 5/u],
    ['remember', { text: 'fine', replaces: 'one' }, /has to be the id of a memory/u],
    ['remember', { text: 'fine', replaces: 0 }, /whole number above zero/u],
    ['remember', { text: 'fine', replaces: 1.5 }, /whole number above zero/u],
    ['forget', { id: 1 }, /"reason" has to be text/u],
    ['forget', { id: 1, reason: '   ' }, /No reason was given/u],
    ['forget', { id: null, reason: 'why not' }, /this call gave null/u],
    ['restore', {}, /"id" has to be the id of a memory/u],
    ['restore', { id: 1, reason: 'changed my mind' }, /does not take an argument called "reason"/u],
    ['recall', {}, /"query" has to be text/u],
    ['recall', { query: ['a'] }, /this call gave a list/u],
    ['list', { limit: 3 }, /does not take an argument called "limit"/u],
    ['why', { since: 'yesterday' }, /takes no arguments at all/u],
    ['remember', { text: 'fine', colour: 'blue' }, /does not take an argument called "colour"/u],
    ['sing', {}, /no tool called "sing"/u],
  ];

  for (const [name, args, expected] of wrong) {
    const answer = await agent.callTool({ name, arguments: args });
    assert.match(text(answer), expected, `${name} ${JSON.stringify(args)}`);
  }

  // Nothing was stored by any of them, and the server is still answering.
  assert.equal(await say(agent, 'list', {}), '1. I live in Berlin');
  assert.match(await say(agent, 'remember', { text: 'still working' }), /Stored\./u);

  // A refused call is not a decision, so none of the above is in the log.
  assert.equal(await say(agent, 'why', {}).then((log) => log.split('\n\n').length), 2);
});

test('a query far too long to be a search is refused, and nothing is allocated for it', async (t) => {
  const agent = await connect(t, freshStoreFile(t));
  const pid = /** @type {number} */ (serverPids.get(agent));

  // A memory of one repeated character indexes as thousands of identical
  // trigrams. That is the other half of the bug: it is what a long query
  // matches against, and the position lists for the match are what SQLite
  // built ten gigabytes of.
  await say(agent, 'remember', { text: 'x'.repeat(9000) });

  const settled = residentMB(pid);
  const watch = watchResident(pid, settled + 400);
  t.after(() => watch.stop());

  // The exact call that killed the machine: a one megabyte query.
  const answer = await say(agent, 'recall', { query: 'x'.repeat(1_000_000) });
  watch.stop();

  assert.match(answer, /longer than this store will run/u);
  assert.match(answer, /limit is 1000 characters/u);

  assert.ok(
    watch.peak() < settled + 400,
    `the server grew from ${settled.toFixed(0)} MB to ${watch.peak().toFixed(0)} MB answering it`,
  );

  // Two hundred thousand terms is the same bound from the other direction: it
  // used to hold a core for over a minute.
  const many = await say(agent, 'recall', { query: Array(200_000).fill('abcd').join(' ') });
  assert.match(many, /longer than this store will run/u);

  // And an ordinary search of the same store still works.
  assert.match(await say(agent, 'recall', { query: 'xxx' }), /1 match/u);
});

test('text and reasons are bounded, at the character rather than near it', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  assert.match(await say(agent, 'remember', { text: 'a'.repeat(10_000) }), /Stored\./u);
  assert.match(
    await say(agent, 'remember', { text: 'b'.repeat(10_001) }),
    /limit is 10000 characters/u,
  );
  assert.match(
    await say(agent, 'forget', { id: 1, reason: 'c'.repeat(10_001) }),
    /limit is 10000 characters/u,
  );
  assert.match(await say(agent, 'recall', { query: 'd'.repeat(1000) }), /Nothing matched/u);
  assert.match(await say(agent, 'recall', { query: 'd'.repeat(1001) }), /longer than this store will run/u);

  // Refused before the gate, so none of them is a decision.
  assert.equal((await say(agent, 'why', {})).split('\n\n').length, 1);

  // Memory 1 was not put away by the refused reason.
  assert.match(await say(agent, 'list', {}), /^1\. a{10}/mu);
});

test('a message too large for the connection says so instead of dying quietly', async (t) => {
  // Past the transport's own ten megabyte limit. It closes rather than trying
  // to resynchronise a stream it has thrown part of away, which is right —
  // but it used to close without a word, and a session that simply ends is
  // the hardest kind of failure to diagnose.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, NOSYPARKER_STORE: path.join(dir, 'memory.sqlite') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'nosyparker-test', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());

  let said = '';
  transport.stderr?.on('data', (chunk) => {
    said += String(chunk);
  });

  await assert.rejects(() =>
    client.callTool({ name: 'remember', arguments: { text: 'y'.repeat(20_000_000) } }),
  );

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.match(said, /nosyparker: the connection failed/u);
  assert.match(said, /ReadBuffer exceeded maximum size/u);
});

test('a wrong id is a sentence rather than a crash, and changes nothing', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I live in Berlin' });

  assert.match(
    await say(agent, 'forget', { id: 99, reason: 'no such thing' }),
    /no memory 99 belonging to you/u,
  );
  assert.match(
    await say(agent, 'remember', { text: 'I live in Lisbon', replaces: 99 }),
    /memory 99 is not one of your active memories/u,
  );
  assert.match(
    await say(agent, 'restore', { id: 99 }),
    /no memory 99 belonging to you/u,
  );

  assert.equal(await say(agent, 'list', {}), '1. I live in Berlin');
});

test('two agents on the same store read each other, in both directions', async (t) => {
  // The whole point of the product: one memory on the machine, not one per
  // agent. Two separate server processes, two clients, one file.
  const file = freshStoreFile(t);
  const first = await connect(t, file);
  const second = await connect(t, file);

  await say(first, 'remember', { text: 'I prefer to be written to in short sentences' });

  assert.match(
    await say(second, 'list', {}),
    /^1\. I prefer to be written to in short sentences$/mu,
    'the second agent should see what the first one stored',
  );
  assert.match(await say(second, 'recall', { query: 'short sentences' }), /1 match/u);

  // And back the other way, so this is not one process happening to be ahead.
  await say(second, 'remember', { text: 'I live in Berlin' });
  assert.match(await say(first, 'list', {}), /^2\. I live in Berlin$/mu);

  // The second agent offering what the first one already stored is refused by
  // the rule that has to see across both of them.
  assert.match(
    await say(second, 'remember', { text: 'I prefer to be written to in short sentences' }),
    /already stored as memory 1/u,
  );

  // One log, holding what both of them did.
  const log = await say(first, 'why', {});
  assert.equal(log.split('\n\n').length, 3);

  // What one agent puts away is put away for the other one too, and either of
  // them can undo it.
  await say(first, 'forget', { id: 2, reason: 'I moved' });
  assert.equal((await say(second, 'list', {})).includes('Berlin'), false);

  await say(second, 'restore', { id: 2 });
  assert.match(await say(first, 'list', {}), /^2\. I live in Berlin$/mu);
});

/**
 * Which process each client started, so a test can watch how big it gets.
 *
 * @type {WeakMap<Client, number>}
 */
const serverPids = new WeakMap();

/**
 * Start a server on its own process and connect a client to it.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} file the store both ends should use
 * @returns {Promise<Client>}
 */
async function connect(t, file) {
  const client = new Client({ name: 'nosyparker-test', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, NOSYPARKER_STORE: file },
  });

  await client.connect(transport);
  if (transport.pid !== null) serverPids.set(client, transport.pid);

  // Closing the client stops the server process it started, so no test leaves
  // one behind holding the file.
  t.after(() => client.close());
  return client;
}


/**
 * Call a tool and hand back what a person would be shown.
 *
 * @param {Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
async function say(client, name, args) {
  return text(await client.callTool({ name, arguments: args }));
}

/**
 * @param {Awaited<ReturnType<Client['callTool']>>} result
 * @returns {string}
 */
function text(result) {
  const content = /** @type {{type: string, text?: string}[]} */ (result.content);
  return content.map((part) => part.text ?? '').join('\n');
}

/**
 * A store file of its own, in a folder that is cleaned up afterwards.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function freshStoreFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'memory.sqlite');
}

/**
 * Is this text anywhere in these bytes, in any of the encodings SQLite stores
 * text in?
 *
 * @param {Buffer} bytes
 * @param {string} value
 * @returns {boolean}
 */
function contains(bytes, value) {
  return (
    bytes.includes(Buffer.from(value, 'utf8')) ||
    bytes.includes(Buffer.from(value, 'utf16le')) ||
    bytes.includes(Buffer.from(value, 'latin1'))
  );
}

test('calls an agent has given up on do not keep the server busy', async (t) => {
  const file = freshStoreFile(t);

  // Low-diversity text, every memory inside the adapter's limit. A search of
  // it is slow for the reason Item 15 records and cannot be interrupted:
  // node:sqlite is synchronous and its binding exposes no way to stop a
  // running statement. What can be stopped is starting the next one.
  const store = openStore({ file, now: () => new Date().toISOString() });
  for (let index = 0; index < 16; index += 1) {
    recordDecision(store, (actions, at) => {
      actions.insertMemory({ owner: 'local', text: 'x'.repeat(10_000), at, supersedes: null });
      return { owner: 'local', verdict: 'stored', rule: 'keep', explanation: '.', input_excerpt: '' };
    });
  }
  store.close();

  const agent = await connect(t, file);
  const watch = watchResident(/** @type {number} */ (serverPids.get(agent)), 900);
  t.after(() => watch.stop());

  const slow = { query: 'x'.repeat(999) };

  const started = Date.now();
  await say(agent, 'recall', slow);
  const oneSearch = Date.now() - started;

  // Four of them, each abandoned almost immediately.
  const abandoned = Date.now();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      agent.callTool({ name: 'recall', arguments: slow }, undefined, { timeout: 200 }).catch(() => {}),
    ),
  );

  // The question that matters to a person: is it answering again? One search
  // is already running and has to finish. The other three were given up on
  // and must not be started.
  const askedAgain = Date.now();
  assert.equal(await say(agent, 'list', {}), await say(agent, 'list', {}));
  const waited = Date.now() - askedAgain;
  const total = Date.now() - abandoned;

  assert.ok(
    total < oneSearch * 2.5,
    `four abandoned searches held the server for ${total} ms, against ${oneSearch} ms for one`,
  );
  assert.ok(waited < oneSearch * 2.5, `an ordinary call waited ${waited} ms behind them`);
});


test('a control character offered over the protocol is refused and leaves a row', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  // JSON-RPC allows U+0000 inside a string and execve forbids it in an
  // argument, so this is the one door in the project that can carry one.
  // Phase 2 opened it, which is why this is tested here as well as against
  // the gate. Built from its code point: pasting it into the source would put
  // an invisible character in a file people read.
  const nul = String.fromCharCode(0);

  await say(agent, 'remember', { text: 'ZQDUP the same sentence' });

  const refused = await say(agent, 'remember', { text: `ZQHEAD${nul}ZQTAIL` });
  assert.match(refused, /U\+0000/u);
  assert.match(refused, /not something text is made of/u);

  assert.match(
    await say(agent, 'remember', { text: `ZQDUP the same sentence${nul}extra` }),
    /U\+0000/u,
    'the duplicate rule can no longer be walked past',
  );
  assert.match(
    await say(agent, 'forget', { id: 1, reason: nul }),
    /U\+0000/u,
    'nor the blank reason check',
  );

  // One memory, still shown, and the refusals are in the log with the text
  // withheld rather than quoted.
  assert.equal(await say(agent, 'list', {}), '1. ZQDUP the same sentence');

  const log = await say(agent, 'why', {});
  assert.equal((log.match(/refused \(control-character\)/gu) ?? []).length, 3);
  assert.match(log, /\[not recorded: contains a character that is not text\]/u);
  assert.equal(log.includes('ZQHEAD'), false);
  assert.equal(log.includes('ZQTAIL'), false);
});

test('a secret offered to recall is refused in the same words as anywhere else', async (t) => {
  const agent = await connect(t, freshStoreFile(t));

  await say(agent, 'remember', { text: 'I keep my keys in 1Password' });

  const key = ['AKIA', 'ZQRECALLKEY99XYZ'].join('');
  const refused = await say(agent, 'recall', { query: `my key is ${key}` });

  // "Nothing matched" was true and taught an agent nothing, so the next thing
  // it did was offer the same key to remember.
  assert.equal(refused.includes('Nothing matched'), false);
  assert.match(refused, /looks like an AWS access key/u);
  assert.match(refused, /memory, not a secret store/u);
  assert.match(refused, /Nothing was searched for either/u);

  // Ordinary searches are untouched.
  assert.match(await say(agent, 'recall', { query: '1Password' }), /1 match/u);
});
