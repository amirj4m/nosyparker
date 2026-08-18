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

import { MANIFEST_NAME, readManifest, recordFirstTouch } from '../src/backup.js';
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

  const first = recordFirstTouch({ weEdit: true, file: configPath, clientId: 'cursor', backupDir: space.backupDir, now: NOW });
  assert.equal(first.made, true);
  assert.equal(fs.readFileSync(/** @type {string} */ (first.backupPath), 'utf8'), original);

  // Change the file the way an install would, then ask again. The copy worth
  // keeping is the one from before we existed, and a second run must not
  // replace it with a copy of our own handiwork.
  fs.writeFileSync(configPath, '{"mcpServers": {"nosyparker": {"command": "node"}}}\n');

  const second = recordFirstTouch({
    weEdit: true,
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

  const taken = recordFirstTouch({ weEdit: true, file: configPath, clientId: 'cursor', backupDir: space.backupDir, now: NOW });

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

  recordFirstTouch({ weEdit: true, file: cursor, clientId: 'cursor', backupDir: space.backupDir, now: NOW });
  recordFirstTouch({ weEdit: true, file: kimi, clientId: 'kimi-code', backupDir: space.backupDir, now: NOW });

  const manifest = readManifest(path.join(space.backupDir, MANIFEST_NAME));
  assert.equal(Object.keys(manifest).length, 2);
  assert.deepEqual(
    Object.values(manifest).map((row) => row.client).sort(),
    ['cursor', 'kimi-code'],
  );
});

test('a client driven through its own command is recorded, and not copied', (t) => {
  // The reason this rule exists: ~/.claude.json holds oauthAccount, a user id
  // and a machine id, and we never edit it — `claude mcp add` does, which is
  // what its documentation requires. There is nothing of ours to undo, so a
  // copy protects against nothing and duplicates a live credential store for
  // the privilege.
  const space = workspace(t);
  const configPath = space.config('claude.json');
  fs.writeFileSync(configPath, '{"oauthAccount":{"secret":"x"},"mcpServers":{}}');

  const written = writeToClient(clientById('claude-code'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/claude',
    run: () => {
      fs.writeFileSync(configPath, '{"oauthAccount":{"secret":"x"},"mcpServers":{"nosyparker":{"command":"node"}}}');
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(written.outcome, WRITTEN);
  assert.equal(written.backup?.made, false);
  assert.equal(written.backup?.backupPath, null);

  // Nothing in the backup folder but the record itself.
  assert.deepEqual(fs.readdirSync(space.backupDir), [MANIFEST_NAME]);

  // And the record is still complete, because uninstall needs it.
  const row = Object.values(readManifest(path.join(space.backupDir, MANIFEST_NAME)))[0];
  assert.equal(row.existed, true);
  assert.equal(row.backup, null);
  assert.match(/** @type {string} */ (row.whyNoBackup), /its own command writes this file, not us/u);
});

test('no copy of any file is taken for any client we do not edit ourselves', () => {
  // Five rows are driven by their own command, and none of them may be copied.
  // Claude Code is the one that made the rule; Codex, VS Code and Devin were
  // being copied for the same non-reason, and Kiro would have been.
  const driven = loadClients().clients
    .filter((client) => client.write.method === 'cli')
    .map((client) => client.id);

  assert.deepEqual(driven.sort(), ['claude-code', 'codex-cli', 'devin-desktop', 'kiro', 'vscode']);
});

test('a file we do edit ourselves is still copied before the first change', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  fs.writeFileSync(configPath, '{"theme":"dark"}\n');

  const written = writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.backup?.made, true);
  assert.equal(fs.readFileSync(/** @type {string} */ (written.backup?.backupPath), 'utf8'), '{"theme":"dark"}\n');
});

test('a write that lands nowhere is a failure, however cheerful the command was', (t) => {
  // This is `gemini mcp add`, which prints that it added the server and creates
  // no file on any disk. It is also `kimi doctor` reporting that everything is
  // valid without reading the file it is talking about. A tool's success
  // message is not evidence, and this is the check that says so.
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const written = writeToClient(clientById('vscode'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/code',
    run: () => ({ status: 0, stdout: 'Added MCP server: nosyparker\n', stderr: '' }),
  }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /reported success and the entry is not in/u);
});

test('a client CLI that fails is reported with what it said, on one line', (t) => {
  const space = workspace(t);

  const written = writeToClient(clientById('vscode'), options({
    configPath: space.config('mcp.json'),
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/code',
    run: () => ({ status: 3, stdout: '', stderr: 'unknown option --add-mcp\nsecond line\n' }),
  }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /exited 3: unknown option --add-mcp/u);
  assert.doesNotMatch(/** @type {string} */ (written.error), /second line/u);
});

test('a client whose own command cannot be found says that, and writes nothing', (t) => {
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const written = writeToClient(clientById('vscode'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, FAILED);
  assert.match(/** @type {string} */ (written.error), /its own command could not be found/u);
  assert.equal(fs.existsSync(configPath), false);
});

test('a CLI write is believed only after the file is read back', (t) => {
  const space = workspace(t);
  const configPath = space.config('mcp.json');

  const written = writeToClient(clientById('vscode'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/code',
    run: (/** @type {string[]} */ argv) => {
      // Stand in for the client's own writer, including the shape of the blob
      // it is handed, so a change to that blob shows up here.
      const blob = JSON.parse(argv[2]);
      const { name, ...entry } = blob;
      fs.writeFileSync(configPath, JSON.stringify({ servers: { [name]: entry } }, null, 2));
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(written.outcome, WRITTEN);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).servers.nosyparker, {
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

test('running setup twice over a client whose add refuses a duplicate is not a failure', (t) => {
  // `claude mcp add` exits 1 with `MCP server nosyparker already exists in user
  // config`. Without taking ours out first, a second run reports a failure over
  // a client that is working perfectly — and a second run is ordinary, because
  // the entry names an absolute path to a Node that upgrades.
  const space = workspace(t);
  const configPath = space.config('claude.json');
  fs.writeFileSync(configPath, '{"mcpServers":{"nosyparker":{"command":"/old/node"}}}');

  /** @type {string[][]} */
  const ran = [];

  const written = writeToClient(clientById('claude-code'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/claude',
    run: (/** @type {string[]} */ argv) => {
      ran.push(argv.slice(1));
      if (argv[2] === 'remove') {
        fs.writeFileSync(configPath, '{"mcpServers":{}}');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (fs.readFileSync(configPath, 'utf8').includes('nosyparker')) {
        return { status: 1, stdout: '', stderr: 'MCP server nosyparker already exists in user config' };
      }
      fs.writeFileSync(configPath, '{"mcpServers":{"nosyparker":{"command":"/usr/bin/node"}}}');
      return { status: 0, stdout: '', stderr: '' };
    },
  }));

  assert.equal(written.outcome, WRITTEN);
  assert.deepEqual(ran.map((argv) => argv[1]), ['remove', 'add'], 'ours came out before it went back');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.nosyparker.command, '/usr/bin/node',
    'and the arguments are the new ones, not the stale ones');
});

test('a client with its own remove command has it used, not its file edited', (t) => {
  // Claude Code's ~/.claude.json is the CLI's live state file: the OAuth
  // account, the machine id, every project's history, rewritten constantly by
  // a running application. Its own documentation says not to hand-edit it, and
  // an uninstall that did would be racing that application over a file almost
  // none of which is ours.
  const space = workspace(t);
  const configPath = space.config('claude.json');
  fs.writeFileSync(configPath, '{"oauthAccount":{"kept":true},"mcpServers":{"nosyparker":{"command":"node"}}}');

  /** @type {string[][]} */
  const ran = [];

  const removed = removeFromClient(clientById('claude-code'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/claude',
    run: (/** @type {string[]} */ argv) => {
      ran.push(argv);
      fs.writeFileSync(configPath, '{"oauthAccount":{"kept":true},"mcpServers":{}}');
      return { status: 0, stdout: 'Removed MCP server nosyparker\n', stderr: '' };
    },
  }));

  assert.equal(removed.outcome, REMOVED);
  assert.equal(removed.method, 'cli');
  assert.deepEqual(ran, [['/usr/bin/claude', 'mcp', 'remove', '--scope', 'user', 'nosyparker']]);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).oauthAccount.kept, true);
});

test('a remove command that reports success and changes nothing is a failure too', (t) => {
  const space = workspace(t);
  const configPath = space.config('claude.json');
  const before = '{"mcpServers":{"nosyparker":{"command":"node"}}}';
  fs.writeFileSync(configPath, before);

  const removed = removeFromClient(clientById('claude-code'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/claude',
    run: () => ({ status: 0, stdout: 'Removed MCP server nosyparker\n', stderr: '' }),
  }));

  assert.equal(removed.outcome, FAILED);
  assert.match(/** @type {string} */ (removed.error), /reported success and the entry is still in/u);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('a client whose remove command has gone falls back to editing the file', (t) => {
  // The reason the fallback exists: an uninstall has to work on a machine where
  // the client has been deleted, upgraded, or moved off PATH since.
  const space = workspace(t);
  const configPath = space.config('claude.json');
  fs.writeFileSync(configPath, '{\n  "mcpServers": {\n    "nosyparker": {"command": "node"},\n    "theirs": {"command": "x"}\n  }\n}\n');

  const removed = removeFromClient(clientById('claude-code'), options({
    configPath,
    backupDir: space.backupDir,
  }, { clientCommand: null }));

  assert.equal(removed.outcome, REMOVED);
  assert.equal(removed.method, 'file');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers, { theirs: { command: 'x' } });
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

test('a config somebody set read-only is not written, and is told so', (t) => {
  // An atomic write does not need permission on the file — it renames a new one
  // over the top, which POSIX allows with only directory permission. So a 0444
  // config was being rewritten happily, and because the mode is carried onto
  // the replacement, the person who set it could not tell afterwards. Read-only
  // on a config is somebody saying leave this alone, and a change its owner
  // cannot see is the one thing this phase must not make.
  const space = workspace(t);
  const configPath = space.config('settings.json');
  fs.writeFileSync(configPath, '{"theme": "dark"}\n');
  fs.chmodSync(configPath, 0o444);

  const written = writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(written.outcome, NOT_WRITTEN);
  assert.match(/** @type {string} */ (written.error), /is read-only \(0444\)/u);
  assert.match(/** @type {string} */ (written.error), /--print-config gemini-cli/u);

  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"theme": "dark"}\n');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o444);
});

test('and uninstall will not touch it either', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  fs.writeFileSync(configPath, '{"mcpServers": {"nosyparker": {"command": "node"}}}\n');
  fs.chmodSync(configPath, 0o444);

  const removed = removeFromClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir }));

  assert.equal(removed.outcome, NOT_WRITTEN);
  assert.match(fs.readFileSync(configPath, 'utf8'), /nosyparker/u);
});

test('a writable config is written exactly as before', (t) => {
  const space = workspace(t);
  const configPath = space.config('settings.json');
  fs.writeFileSync(configPath, '{"theme": "dark"}\n', { mode: 0o644 });

  assert.equal(
    writeToClient(clientById('gemini-cli'), options({ configPath, backupDir: space.backupDir })).outcome,
    WRITTEN,
  );
});

test('a client written by its own command is not second-guessed about permissions', (t) => {
  // What a vendor's own tool makes of a read-only file is between them and it.
  const space = workspace(t);
  const configPath = space.config('mcp.json');
  fs.writeFileSync(configPath, '{"servers": {}}\n');
  fs.chmodSync(configPath, 0o444);

  const written = writeToClient(clientById('vscode'), options({
    configPath,
    backupDir: space.backupDir,
  }, {
    clientCommand: '/usr/bin/code',
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  }));

  // It fails on the read-back, which is the honest outcome, rather than being
  // refused by us on a rule that is not ours to apply here.
  assert.notEqual(written.outcome, NOT_WRITTEN);
});
