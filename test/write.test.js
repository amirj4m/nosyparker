/**
 * Writing to a client, and the copy taken before the first time we do.
 *
 * Every path in this file is a temporary directory made by the test. Nothing
 * here reads or writes a real client's configuration, a real home directory, or
 * the real backup folder — the writer takes the config path, the backup folder
 * and the way to run a command as arguments, and these tests are the reason
 * it does.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backupOnce, MANIFEST_NAME, readManifest } from '../src/backup.js';
import { clientById, loadClients } from '../src/clients.js';
import {
  ABSENT,
  FAILED,
  NOT_WRITTEN,
  REMOVED,
  removeFromClient,
  UNCHANGED,
  WRITTEN,
  writeToClient,
  writePreservingMode,
} from '../src/write.js';

const NOW = '2026-08-17T10:00:00.000Z';

/**
 * @param {import('node:test').TestContext} t
 * @returns {{dir: string, backupDir: string, config: (name: string) => string}}
 */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return {
    dir,
    backupDir: path.join(dir, 'backups'),
    config: (name) => path.join(dir, name),
  };
}

/**
 * @param {object} where
 * @param {string} where.configPath
 * @param {string} where.backupDir
 * @param {object} [extra]
 * @returns {any}
 */
function options({ configPath, backupDir }, extra = {}) {
  return {
    name: 'nosyparker',
    command: '/usr/bin/node',
    serverPath: '/srv/mcp-server.js',
    configPath,
    clientCommand: null,
    backupDir,
    now: NOW,
    ...extra,
  };
}

test('a client written by file gets the entry, and the entry is read back', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');

  const written = writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, WRITTEN);
  assert.equal(written.method, 'file');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    mcpServers: { nosyparker: { command: '/usr/bin/node', args: ['/srv/mcp-server.js'] } },
  });
});

test('an existing config with other servers in it survives byte-identical', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  const before = '{\n  "theme": "dark",\n  "mcpServers": {\n    "theirs": {"command": "x"}\n  }\n}\n';
  fs.writeFileSync(configPath, before);

  const written = writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));
  assert.equal(written.outcome, WRITTEN);

  const removed = removeFromClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));
  assert.equal(removed.outcome, REMOVED);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('writing the same thing twice reports that nothing changed', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  const where = { configPath, backupDir: space.backupDir };

  assert.equal(writeToClient(clientById('gemini-cli'), options(where)).outcome, WRITTEN);
  assert.equal(writeToClient(clientById('gemini-cli'), options(where)).outcome, UNCHANGED);
});

test('a backup is taken once, and never taken again', (t) => {
  const space = workspace(t);
  const configPath = space.config('mcp.json');
  fs.writeFileSync(configPath, '{"mcpServers": {"theirs": {"command": "x"}}}\n');
  const original = fs.readFileSync(configPath, 'utf8');

  const first = backupOnce({ file: configPath, clientId: 'cursor', backupDir: space.backupDir, now: NOW });
  assert.equal(first.made, true);
  assert.equal(fs.readFileSync(/** @type {string} */ (first.backupPath), 'utf8'), original);

  // Change the file the way an install would, then ask again. The copy worth
  // keeping is the one from before we existed, and a second run must not
  // replace it with a copy of our own handiwork.
  fs.writeFileSync(configPath, '{"mcpServers": {"nosyparker": {"command": "node"}}}\n');

  const second = backupOnce({
    file: configPath, clientId: 'cursor', backupDir: space.backupDir, now: '2026-09-01T00:00:00.000Z',
  });

  assert.equal(second.made, false);
  assert.equal(second.backupPath, first.backupPath);
  assert.equal(fs.readFileSync(/** @type {string} */ (first.backupPath), 'utf8'), original,
    'the first copy is still the copy from before');

  const manifest = readManifest(path.join(space.backupDir, MANIFEST_NAME));
  assert.equal(Object.keys(manifest).length, 1);
  assert.equal(manifest[Object.keys(manifest)[0]].takenAt, NOW);
});

test('a file that did not exist gets a manifest row and no copy', (t) => {
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const taken = backupOnce({ file: configPath, clientId: 'cursor', backupDir: space.backupDir, now: NOW });

  assert.equal(taken.made, false, 'there was nothing to copy');
  assert.equal(taken.existed, false);
  assert.equal(taken.backupPath, null);

  // The row still matters: it is how the next run knows this file has been
  // touched, and how a person can tell a file we created from one we edited.
  const manifest = readManifest(path.join(space.backupDir, MANIFEST_NAME));
  assert.equal(Object.values(manifest)[0].existed, false);
});

test('two clients whose files are both called mcp.json get two backups', (t) => {
  const space = workspace(t);
  const cursor = space.config('cursor-mcp.json');
  const kimi = space.config('kimi-mcp.json');
  fs.writeFileSync(cursor, '{"a": 1}');
  fs.writeFileSync(kimi, '{"b": 2}');

  backupOnce({ file: cursor, clientId: 'cursor', backupDir: space.backupDir, now: NOW });
  backupOnce({ file: kimi, clientId: 'kimi-code', backupDir: space.backupDir, now: NOW });

  const manifest = readManifest(path.join(space.backupDir, MANIFEST_NAME));
  assert.equal(Object.keys(manifest).length, 2);
  assert.deepEqual(
    Object.values(manifest).map((row) => row.client).sort(),
    ['cursor', 'kimi-code'],
  );
});

test('a write that lands nowhere is a failure, however cheerful the command was', (t) => {
  // This is `gemini mcp add`, which prints that it added the server and creates
  // no file on any disk. It is also `kimi doctor` reporting that everything is
  // valid without reading the file it is talking about. A tool's success
  // message is not evidence, and this is the check that says so.
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const written = writeToClient(clientById('cursor'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/cursor',
    run: () => ({ status: 0, stdout: 'Added MCP server: nosyparker\n', stderr: '' }),
  }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /reported success and the entry is not in/u);
});

test('a client CLI that fails is reported with what it said, on one line', (t) => {
  const space = workspace(t);

  const written = writeToClient(clientById('cursor'), options({
    configPath: space.config('mcp.json'),
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/cursor',
    run: () => ({ status: 3, stdout: '', stderr: 'unknown option --add-mcp\nsecond line\n' }),
  }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /exited 3: unknown option --add-mcp/u);
  assert.doesNotMatch(/** @type {string} */ (written.error), /second line/u);
});

test('a client whose own command cannot be found says that, and writes nothing', (t) => {
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const written = writeToClient(clientById('cursor'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /its own command could not be found/u);
  assert.equal(fs.existsSync(configPath), false);
});

test('a CLI write is believed only after the file is read back', (t) => {
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const written = writeToClient(clientById('cursor'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/cursor',
    run: (/** @type {string[]} */ argv) => {
      // Stand in for the client's own writer, including the shape of the blob
      // it is handed, so a change to that blob shows up here.
      const blob = JSON.parse(argv[2]);
      const { name, ...entry } = blob;
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(written.outcome, WRITTEN);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.nosyparker, {
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });
});

test('a file mode is carried over, so a 0600 config does not become readable', (t) => {
  const space = workspace(t);
  const configPath = space.config('claude_desktop_config.json');
  fs.writeFileSync(configPath, '{"preferences": {}}\n', { mode: 0o600 });

  writeToClient(clientById('claude-desktop'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('a file we create is created private, because these files hold API keys', (t) => {
  const space = workspace(t);
  const configPath = space.config('new.json');

  writePreservingMode(configPath, '{}\n');

  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('a missing directory is made, because a client can be installed without one', (t) => {
  const space = workspace(t);
  const configPath = path.join(space.dir, 'junie', 'mcp', 'mcp.json');

  const written = writeToClient(clientById('junie'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, WRITTEN);
  assert.equal(fs.existsSync(configPath), true);
});

test('removing from a config that has since changed still works', (t) => {
  // The uninstall has to cope with a file the user has edited, a client has
  // rewritten, or another install has added to since we were last here.
  const space = workspace(t);
  const configPath = space.config('settings.json');

  writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  const meddled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  meddled.mcpServers.somethingElse = { command: 'other' };
  meddled.theme = 'light';
  fs.writeFileSync(configPath, JSON.stringify(meddled, null, 4));

  const removed = removeFromClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(removed.outcome, REMOVED);
  const left = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(left.mcpServers, { somethingElse: { command: 'other' } });
  assert.equal(left.theme, 'light');
});

test('removing when there is nothing of ours says so rather than failing', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  fs.writeFileSync(configPath, '{"mcpServers": {"theirs": {}}}');

  const removed = removeFromClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(removed.outcome, ABSENT);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"mcpServers": {"theirs": {}}}');
});

test('removing from a file that is not there at all is not an error', (t) => {
  const space = workspace(t);

  const removed = removeFromClient(clientById('gemini-cli'), options({
    configPath: space.config('nothing.json'),
    backupDir: space.backupDir,
  }));

  assert.equal(removed.outcome, ABSENT);
});

test('a config that has become unreadable is refused rather than written over', (t) => {
  const space = workspace(t);
  const configPath = space.config('claude_desktop_config.json');
  fs.writeFileSync(configPath, '{"mcpServers": { "half": }');

  const written = writeToClient(clientById('claude-desktop'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /not valid JSON/u);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"mcpServers": { "half": }',
    'and it is exactly as it was');
});

/**
 * @param {string[]} running
 * @returns {any}
 */
function machineRunning(running) {
  return {
    home: '/home/p',
    platform: 'linux',
    cwd: '/home/p',
    pathDirs: [],
    exists: () => false,
    readdir: () => [],
    processes: () => running,
  };
}

test('a client that would overwrite our write is not written to while it runs', (t) => {
  // Claude Desktop rewrites this file wholesale from whatever it holds in
  // memory. An entry written now would read back correctly, report success,
  // and be gone at its next settings write — a green tick with a shelf life.
  const space = workspace(t);
  const configPath = space.config('claude_desktop_config.json');
  fs.writeFileSync(configPath, '{"preferences": {}}\n');

  const written = writeToClient(clientById('claude-desktop'), options({
    configPath,
    backupDir: space.backupDir,
  }, { machine: machineRunning(['claude-desktop', 'firefox']) }));

  assert.equal(written.outcome, NOT_WRITTEN);
  assert.match(/** @type {string} */ (written.error), /Claude Desktop is running/u);
  assert.match(/** @type {string} */ (written.error), /Quit it and run this again/u);

  // Nothing was attempted, so nothing changed and no copy was taken.
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"preferences": {}}\n');
  assert.equal(fs.existsSync(space.backupDir), false);
});

test('the same client is written to happily when it is not running', (t) => {
  const space = workspace(t);
  const configPath = space.config('claude_desktop_config.json');
  fs.writeFileSync(configPath, '{"preferences": {}}\n');

  const written = writeToClient(clientById('claude-desktop'), options({
    configPath,
    backupDir: space.backupDir,
  }, { machine: machineRunning(['firefox']) }));

  assert.equal(written.outcome, WRITTEN);
});

test('a machine whose processes cannot be listed is written to, not blocked', (t) => {
  // An unknown is not a yes. Refusing on an answer we do not have would block
  // the install everywhere `ps` is not how the question is asked.
  const space = workspace(t);
  const configPath = space.config('claude_desktop_config.json');

  const written = writeToClient(clientById('claude-desktop'), options({
    configPath,
    backupDir: space.backupDir,
  }, { machine: { ...machineRunning([]), processes: () => null } }));

  assert.equal(written.outcome, WRITTEN);
});

test('only the two clients caught rewriting their own file wait for a quit', () => {
  const waiting = loadClients().clients
    .filter((client) => client.writeRequiresQuit !== undefined)
    .map((client) => client.id);

  // Cursor and VS Code also watch and rewrite their config files, and are not
  // here: their entries go in through their own command, which is the writer
  // the application itself supports and will not undo.
  assert.deepEqual(waiting.sort(), ['claude-desktop', 'devin-desktop']);
});

test('the backup is taken before the write, so it is a copy of what was there', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  const before = '{"mcpServers": {"theirs": {"command": "x"}}}\n';
  fs.writeFileSync(configPath, before);

  const written = writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, WRITTEN);
  assert.equal(written.backup?.made, true);
  assert.equal(fs.readFileSync(/** @type {string} */ (written.backup?.backupPath), 'utf8'), before);
});
