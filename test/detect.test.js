/**
 * Detection: three states that must never collapse into two, and a fourth that
 * is a different question.
 *
 * Every machine here is described rather than inspected. Nothing in this file
 * touches the real filesystem, so a test passes or fails on the same evidence
 * on any machine, including one where every client happens to be installed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { clientById } from '../src/clients.js';
import {
  detect,
  INSTALLED_NO_CONFIG,
  INSTALLED_PATH_UNKNOWN,
  INSTALLED_WITH_CONFIG,
  NOT_INSTALLED,
  resolveCommand,
} from '../src/detect.js';

/**
 * A machine with exactly the files and directories named, and nothing else.
 *
 * @param {object} shape
 * @param {string[]} [shape.files]
 * @param {string[]} [shape.pathDirs]
 * @param {string} [shape.platform]
 * @returns {import('../src/detect.js').Machine}
 */
function machine({ files = [], pathDirs = [], platform = 'linux' }) {
  const present = new Set(files);
  return {
    home: '/home/p',
    platform,
    appData: undefined,
    cwd: '/home/p/work',
    pathDirs,
    exists: (file) => present.has(file),
    processes: () => [],
    readdir: (dir) => {
      const prefix = `${dir}/`;
      const names = new Set();
      for (const file of present) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
  };
}

test('a client that is not on the machine is not installed', () => {
  const found = detect(clientById('cursor'), machine({}));

  assert.equal(found.state, NOT_INSTALLED);
  assert.equal(found.configPath, null);
  assert.deepEqual(found.evidence, []);
});

test('a client whose config file does not exist yet is installed, not missing', () => {
  // This is the one that cost the owner's previous project its Cursor support.
  // Cursor makes ~/.cursor on install and never makes mcp.json, so every fresh
  // Cursor on earth looks like no Cursor to a detector that asks for the file.
  const found = detect(clientById('cursor'), machine({ files: ['/home/p/.cursor'] }));

  assert.equal(found.state, INSTALLED_NO_CONFIG);
  assert.equal(found.configPath, '/home/p/.cursor/mcp.json');
  assert.deepEqual(found.evidence, ['/home/p/.cursor']);
});

test('a client whose config file exists is a third state, because something is in it', () => {
  const found = detect(
    clientById('cursor'),
    machine({ files: ['/home/p/.cursor', '/home/p/.cursor/mcp.json'] }),
  );

  assert.equal(found.state, INSTALLED_WITH_CONFIG);
  assert.equal(found.configPath, '/home/p/.cursor/mcp.json');
});

test('the three states are three, on the same client, with only the file changing', () => {
  const client = clientById('zed');
  const installed = ['/home/p/.local/bin/zed'];

  assert.equal(detect(client, machine({})).state, NOT_INSTALLED);
  assert.equal(detect(client, machine({ files: installed })).state, INSTALLED_NO_CONFIG);
  assert.equal(
    detect(client, machine({ files: [...installed, '/home/p/.config/zed/settings.json'] })).state,
    INSTALLED_WITH_CONFIG,
  );
});

test('Zed installed the way upstream recommends is still found', () => {
  // The install script unpacks into ~/.local and symlinks ~/.local/bin/zed. It
  // writes nothing under /usr/share and registers nothing with dpkg, so a
  // detector modelled on the deb-packaged clients sees nothing at all.
  const upstream = machine({
    files: ['/home/p/.local/zed.app', '/home/p/.local/bin/zed', '/home/p/.config/zed'],
  });

  const found = detect(clientById('zed'), upstream);

  assert.equal(found.state, INSTALLED_NO_CONFIG);
  assert.ok(found.evidence.includes('/home/p/.local/zed.app'));

  // And the negative half: nothing in the row asks a package manager or looks
  // in a system directory, so there is nothing to go wrong on a machine that
  // installed it some other way.
  const paths = JSON.stringify(clientById('zed').detect);
  assert.doesNotMatch(paths, /usr\/share|dpkg|snap|flatpak/u);
});

test('a client on the machine with no known path for this platform says so', () => {
  // Zed on macOS. The research established no settings path on any operating
  // system but Linux, so there is nowhere to write. Calling that "not
  // installed" would be a lie about the machine, and calling it "no config
  // yet" would send the writer at a path nobody has.
  const found = detect(
    clientById('zed'),
    machine({ files: ['/home/p/.local/bin/zed'], platform: 'darwin' }),
  );

  assert.equal(found.state, INSTALLED_PATH_UNKNOWN);
  assert.equal(found.configPath, null);
});

test('a command is found on PATH, and the resolved path is what gets run', () => {
  const found = detect(
    clientById('goose'),
    machine({ files: ['/usr/local/bin/goose'], pathDirs: ['/usr/local/bin'] }),
  );

  assert.equal(found.state, INSTALLED_NO_CONFIG);
  assert.equal(found.command, '/usr/local/bin/goose');
});

test('Claude Code bundled inside Claude Desktop is found although it is not on PATH', () => {
  // This is not a hypothetical: on the machine the table was written against,
  // `claude` is not on PATH and lives at
  // ~/.config/Claude/claude-code/<version>/claude. It is also the only client
  // that can prove the server runs, so a detector that missed it would lose
  // the one honest tick available.
  const bundled = machine({
    files: [
      '/home/p/.config/Claude/claude-code',
      '/home/p/.config/Claude/claude-code/2.1.227/claude',
      '/home/p/.claude.json',
    ],
    pathDirs: ['/usr/bin'],
  });

  const found = detect(clientById('claude-code'), bundled);

  assert.equal(found.state, INSTALLED_WITH_CONFIG);
  assert.equal(found.command, '/home/p/.config/Claude/claude-code/2.1.227/claude');
});

test('the newest bundled version is the one that gets run', () => {
  const two = machine({
    files: [
      '/home/p/.config/Claude/claude-code',
      '/home/p/.config/Claude/claude-code/2.1.9/claude',
      '/home/p/.config/Claude/claude-code/2.1.227/claude',
    ],
  });

  // Sorted as text and taken from the end, which is what "newest" means to a
  // sort that knows nothing about version numbers. 2.1.9 sorting above 2.1.227
  // is the known cost of that, and it picks a real installed binary either way.
  assert.equal(resolveCommand(clientById('claude-code'), two), '/home/p/.config/Claude/claude-code/2.1.9/claude');
});

test('a client with no command at all is detected by its files', () => {
  // Claude Desktop has no CLI of any kind, so its whole detection is paths.
  const found = detect(
    clientById('claude-desktop'),
    machine({ files: ['/home/p/.config/Claude/claude_desktop_config.json'] }),
  );

  assert.equal(found.state, INSTALLED_WITH_CONFIG);
  assert.equal(found.command, null);
});
