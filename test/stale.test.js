/**
 * The line the terminal says when the wiring has stopped pointing at anything.
 *
 * Every entry names the interpreter by its full path, and a version manager
 * moves that path. `doctor` has found that since Phase 4; nothing prompted
 * anybody to run `doctor`. This is the prompt, and these are the cases it has
 * to get right in both directions — it must fire when the recorded path is
 * gone, and it must stay silent whenever it is not sure, because a sentence
 * about somebody's machine that nothing stands behind is worse than none.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MANIFEST_NAME } from '../src/backup.js';
import { staleWiring } from '../src/stale.js';

/**
 * A backup folder holding the given manifest rows, under a directory the test
 * owns. The interpreter that "exists" is a real file in it.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} rows
 * @returns {{backupDir: string, present: string}}
 */
function folder(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, MANIFEST_NAME), JSON.stringify(rows));

  const present = path.join(dir, 'old-node');
  fs.writeFileSync(present, '');

  return { backupDir, present };
}

/**
 * @param {string} client
 * @param {string} interpreter
 * @param {string} [serverPath]
 * @returns {Record<string, unknown>}
 */
function row(client, interpreter, serverPath = '/srv/current/mcp-server.js') {
  return {
    path: `/home/p/.${client}/mcp.json`,
    backup: null,
    existed: false,
    takenAt: '2026-09-24T10:00:00.000Z',
    client,
    wroteWith: { interpreter, serverPath },
  };
}

const NOW = { interpreter: '/opt/node-24/bin/node', serverPath: '/srv/current/mcp-server.js' };

test('nothing recorded means nothing said', (t) => {
  const { backupDir } = folder(t, {});
  assert.equal(staleWiring({ backupDir, ...NOW }), null);

  // A folder that is not there at all is the same answer, not a crash: the
  // first thing a fresh install runs is a store command, before any setup.
  assert.equal(staleWiring({ backupDir: path.join(backupDir, 'missing'), ...NOW }), null);
});

test('a row written before the field existed makes no claim', (t) => {
  // Every manifest written by 0.0.6 and earlier. Comparing against a record
  // that was never taken would be a guess about somebody's machine.
  const { backupDir } = folder(t, {
    'cursor.mcp.json': { path: '/home/p/.cursor/mcp.json', backup: null, existed: false,
      takenAt: '2026-08-21T09:34:40.073Z', client: 'cursor' },
  });

  assert.equal(staleWiring({ backupDir, ...NOW }), null);
});

test('the same interpreter is not stale, however the shell reached it', (t) => {
  const { backupDir } = folder(t, { a: row('cursor', NOW.interpreter) });
  assert.equal(staleWiring({ backupDir, ...NOW }), null);
});

test('a different interpreter that still exists is not stale either', (t) => {
  // nvm use 24 with 22 still installed. The entries name 22 and 22 starts, so
  // the clients work, and a line here would teach the person to ignore it.
  const { backupDir, present } = folder(t, { a: row('cursor', '') });
  fs.writeFileSync(path.join(backupDir, MANIFEST_NAME), JSON.stringify({ a: row('cursor', present) }));

  assert.equal(staleWiring({ backupDir, ...NOW }), null);
});

test('an interpreter that has gone is named, counted, and followed by what to run', (t) => {
  const gone = '/home/p/.nvm/versions/node/v22.19.0/bin/node';
  const { backupDir } = folder(t, {
    a: row('cursor', gone),
    b: row('gemini-cli', gone),
    c: row('zed', NOW.interpreter),
  });

  const said = staleWiring({ backupDir, ...NOW });

  assert.ok(said !== null);
  assert.match(said, /entries setup wrote for 2 clients/u);
  assert.match(said, new RegExp(`start the server with ${gone.replaceAll('.', '\\.')}, which is not there any more`, 'u'));
  assert.match(said, /Node version that was switched or removed/u);
  assert.match(said, /setup` to rewrite them/u);
  assert.match(said, /doctor` says which clients/u);
  assert.equal(said.includes('\n'), false, 'it is one line');
});

test('a copy of the server that has gone is named too, and the current one beside it', (t) => {
  // npm install -g under a new prefix: the interpreter may be the same and the
  // path to mcp-server.js is not.
  const { backupDir } = folder(t, {
    a: row('cursor', NOW.interpreter, '/old/prefix/lib/node_modules/nosyparker/src/mcp-server.js'),
  });

  const said = staleWiring({ backupDir, ...NOW });

  assert.ok(said !== null);
  assert.match(said, /entries setup wrote for one client point at \/old\/prefix.*which is not there any more/u);
  assert.match(said, /this copy is at \/srv\/current\/mcp-server\.js/u);
  assert.doesNotMatch(said, /Node version/u, 'the interpreter is fine and must not be blamed');
});

test('both gone at once is one sentence about each, and one instruction', (t) => {
  const { backupDir } = folder(t, {
    a: row('cursor', '/gone/node', '/gone/mcp-server.js'),
  });

  const said = staleWiring({ backupDir, ...NOW });

  assert.ok(said !== null);
  assert.match(said, /start the server with \/gone\/node/u);
  assert.match(said, /They point at \/gone\/mcp-server\.js/u);
  assert.equal((said.match(/setup` to rewrite them/gu) ?? []).length, 1);
});

test('a row whose entry was taken out again has nothing to go stale', (t) => {
  // `forgetWrittenWith` drops the field on removal; a row without it is the
  // case two tests up. Held here as well from the other side: a row that still
  // carries the field after an uninstall would keep warning about entries that
  // are not in any file.
  const { backupDir } = folder(t, {
    a: { ...row('cursor', '/gone/node'), wroteWith: undefined, removedFrom: true },
  });

  assert.equal(staleWiring({ backupDir, ...NOW }), null);
});
