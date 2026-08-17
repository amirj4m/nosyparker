/**
 * The client table.
 *
 * The entry shapes are written out here one at a time rather than looped over,
 * for the reason the gate's vocabulary test gives: a loop can only check that
 * the rows are consistent with each other, and what matters is whether each one
 * is consistent with the machine it was measured on. Goose taking `cmd` where
 * everyone else takes `command`, Zed taking no `type` where Cursor requires
 * one, Continue being a list where the other twelve are maps — every one of
 * those is a row somebody could "tidy" into agreement with its neighbours, and
 * every one of them would then be wrong.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  clientById,
  configPathFor,
  entryJsonWithName,
  fillArgv,
  fillTokens,
  loadClients,
} from '../src/clients.js';

const VALUES = { name: 'nosyparker', command: '/usr/bin/node', serverPath: '/srv/mcp-server.js' };
const LINUX = { home: '/home/p', platform: 'linux' };

/**
 * @param {string} id
 * @returns {any}
 */
function row(id) {
  const client = clientById(id);
  assert.ok(client, `the table has no row called "${id}"`);
  return client;
}

test('the table carries the fifteen clients the research drew the line around', () => {
  // E.4 puts the line at seven verified, three installed-but-unverifiable and
  // four carried from documentation. Copilot CLI is the fifteenth: the research
  // contradicts itself about it — the prose says the table carries it, the tier
  // lists omit it — and the owner settled it in. Written out rather than
  // counted, so that adding a client is a decision somebody makes here rather
  // than a row that appears.
  const { clients } = loadClients();
  assert.deepEqual(
    clients.map((client) => client.id).sort(),
    [
      'claude-code', 'claude-desktop', 'cline', 'codex-cli', 'continue', 'copilot-cli', 'cursor',
      'devin-desktop', 'gemini-cli', 'goose', 'junie', 'kimi-code', 'vscode', 'warp', 'zed',
    ],
  );

  assert.deepEqual(
    clients.filter((client) => client.tier === 1).map((client) => client.id).sort(),
    ['claude-code', 'codex-cli', 'cursor', 'devin-desktop', 'gemini-cli', 'goose', 'vscode'],
  );
  assert.deepEqual(
    clients.filter((client) => client.tier === 2).map((client) => client.id).sort(),
    ['claude-desktop', 'kimi-code', 'zed'],
  );
  assert.deepEqual(
    clients.filter((client) => client.tier === 3).map((client) => client.id).sort(),
    ['cline', 'continue', 'copilot-cli', 'junie', 'warp'],
  );
});

test('Copilot CLI is carried on documentation alone, and says so in every field', () => {
  // It has never been installed or run here, and the research records only what
  // its documentation says. Two things follow, and both are deliberate.
  const copilot = row('copilot-cli');

  assert.equal(copilot.evidence, 'DOCS');
  assert.equal(copilot.tier, 3);

  // Its own documentation puts `copilot mcp list` in the same class as
  // `claude mcp list` — a health check. We carry it one step below that,
  // because every vendor command that turned out to lie was caught by running
  // it, and nobody has run this one.
  assert.equal(copilot.verify.tier, 'B+');
  assert.match(copilot.verify.cannotProve, /nobody has run it/u);

  // Written by file, because the path and the entry shape are documented and
  // the arguments its add command takes are not. Writing the file invents
  // nothing; guessing an argument order would.
  assert.equal(copilot.write.method, 'file');
  assert.deepEqual(fillTokens(copilot.entry, VALUES), {
    type: 'local',
    command: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });

  // The community table cannot corroborate any of it: what it lists under that
  // name is the Copilot coding agent, a web connector with no local config.
  assert.equal(copilot.upstreamId, null);
  assert.match(copilot.traps.join(' '), /not in the community clients\.json at all/u);
});

test('each entry is the shape that client was measured to take', () => {
  // Claude Code and Codex have no entry shape: both are written by their own
  // CLI, which owns the file's format. A shape here would be a shape nobody
  // uses and nobody would notice going stale.
  assert.equal(row('claude-code').entry, null);
  assert.equal(row('codex-cli').entry, null);

  assert.deepEqual(fillTokens(row('gemini-cli').entry, VALUES), {
    command: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });

  assert.deepEqual(fillTokens(row('claude-desktop').entry, VALUES), {
    command: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });

  // No `source`. Zed 1.15.0's own embedded example omits it, and an entry
  // carrying an invalid one started anyway.
  assert.deepEqual(fillTokens(row('zed').entry, VALUES), {
    command: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });
  assert.equal('source' in row('zed').entry, false);

  // `type` is required by Cursor's own field table and is safe under either
  // reading of VS Code's two contradictory pages.
  for (const id of ['cursor', 'vscode', 'devin-desktop']) {
    assert.deepEqual(fillTokens(row(id).entry, VALUES), {
      type: 'stdio',
      command: '/usr/bin/node',
      args: ['/srv/mcp-server.js'],
    }, id);
  }

  // `cmd`, not `command`; `enabled: true` or it never loads; and the name is
  // repeated inside the entry as well as above it.
  assert.deepEqual(fillTokens(row('goose').entry, VALUES), {
    type: 'stdio',
    name: 'nosyparker',
    enabled: true,
    cmd: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });

  // A list of maps, so the name is a field.
  assert.deepEqual(fillTokens(row('continue').entry, VALUES), {
    name: 'nosyparker',
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['/srv/mcp-server.js'],
  });

  for (const id of ['kimi-code', 'cline', 'warp', 'junie']) {
    assert.deepEqual(fillTokens(row(id).entry, VALUES), {
      command: '/usr/bin/node',
      args: ['/srv/mcp-server.js'],
    }, id);
  }
});

test('each root key is that client\'s own, and three of them are not mcpServers', () => {
  assert.equal(row('vscode').rootKey, 'servers');
  assert.equal(row('devin-desktop').rootKey, 'servers');
  assert.equal(row('zed').rootKey, 'context_servers');
  assert.equal(row('goose').rootKey, 'extensions');
  assert.equal(row('codex-cli').rootKey, 'mcp_servers');

  for (const id of ['claude-code', 'claude-desktop', 'cursor', 'gemini-cli', 'kimi-code',
    'cline', 'continue', 'warp', 'junie']) {
    assert.equal(row(id).rootKey, 'mcpServers', id);
  }
});

test('the file formats are declared, because three of them are not JSON', () => {
  assert.equal(row('zed').format, 'jsonc');
  assert.equal(row('vscode').format, 'jsonc');
  assert.equal(row('goose').format, 'yaml-map');
  assert.equal(row('continue').format, 'yaml-list');
  assert.equal(row('codex-cli').format, 'toml');
});

test('the verification tiers are the ones the research earned, not one green tick', () => {
  const tiers = Object.fromEntries(
    loadClients().clients.map((client) => [client.id, client.verify.tier]),
  );

  assert.deepEqual(tiers, {
    'claude-code': 'A',
    'gemini-cli': 'A',
    'codex-cli': 'B+',
    goose: 'B+',
    'copilot-cli': 'B+',
    vscode: 'B',
    cursor: 'C',
    'devin-desktop': 'B',
    'claude-desktop': 'C',
    zed: 'C',
    'kimi-code': 'C',
    cline: 'C',
    continue: 'C',
    warp: 'C',
    junie: 'C',
  });
});

test('every row says what its check proves, and every row below tier A says what it cannot', () => {
  for (const client of loadClients().clients) {
    assert.ok(client.verify.proves.length > 0, `${client.id} does not say what it proves`);
    if (client.verify.tier === 'A') {
      assert.equal(client.verify.cannotProve, null, `${client.id} is tier A and hedges`);
    } else {
      assert.ok(
        typeof client.verify.cannotProve === 'string' && client.verify.cannotProve.length > 0,
        `${client.id} is tier ${client.verify.tier} and does not say what it cannot prove`,
      );
    }
  }
});

test('the four traps that decide the phase are written down in the rows they belong to', () => {
  const traps = (/** @type {string} */ id) => row(id).traps.join(' ');

  assert.match(traps('gemini-cli'), /reports success and writes nothing/u);
  assert.equal(row('gemini-cli').write.method, 'file');
  assert.equal(row('gemini-cli').verify.method, 'cli-lines');

  assert.match(traps('kimi-code'), /kimi doctor.*never reads mcp\.json/su);
  assert.equal(row('kimi-code').verify.tier, 'C');

  assert.match(traps('codex-cli'), /read-back, not a health check/u);
  assert.equal(row('codex-cli').verify.tier, 'B+');

  assert.match(traps('devin-desktop'), /Windsurf is now Devin Desktop/u);
  assert.equal(row('devin-desktop').configPaths.linux, '~/.config/Devin/User/mcp.json');
  assert.equal(row('devin-desktop').extraConfigPaths[0].path, '~/.codeium/windsurf/mcp_config.json');
  assert.equal(row('devin-desktop').extraConfigPaths[0].status, 'dormant');
});

test('a path the research could not establish is null, not a guess', () => {
  // Zed's docs give no filesystem path on any operating system, and only Linux
  // was measured. Devin's User directory is the same story.
  assert.equal(configPathFor(row('zed'), LINUX), '/home/p/.config/zed/settings.json');
  assert.equal(configPathFor(row('zed'), { ...LINUX, platform: 'darwin' }), null);
  assert.equal(configPathFor(row('zed'), { ...LINUX, platform: 'win32' }), null);

  assert.equal(configPathFor(row('devin-desktop'), { ...LINUX, platform: 'darwin' }), null);
  assert.equal(configPathFor(row('cline'), { ...LINUX, platform: 'darwin' }), null);
});

test('a Windows path expands through APPDATA, and Warp deliberately does not', () => {
  const windows = { home: 'C:\\Users\\p', platform: 'win32', appData: 'C:\\Users\\p\\AppData\\Roaming' };

  assert.equal(
    configPathFor(row('goose'), windows),
    path.join('C:\\Users\\p\\AppData\\Roaming', 'Block', 'goose', 'config', 'config.yaml'),
  );

  // Warp's own file-locations page puts this at ~/.warp on every platform,
  // including Windows, while the rest of Warp's configuration follows the
  // platform. Copying the neighbours here would be wrong.
  assert.match(configPathFor(row('warp'), windows) ?? '', /\.warp/u);
  assert.doesNotMatch(configPathFor(row('warp'), windows) ?? '', /AppData/u);
});

test('a CLI row fills its arguments, including the blob a client wants its name inside', () => {
  assert.deepEqual(fillArgv(row('claude-code').write.argv, row('claude-code'), VALUES), [
    'claude', 'mcp', 'add', '--scope', 'user', 'nosyparker', '--',
    '/usr/bin/node', '/srv/mcp-server.js',
  ]);

  assert.deepEqual(fillArgv(row('vscode').write.argv, row('vscode'), VALUES), [
    'code', '--add-mcp',
    '{"name":"nosyparker","type":"stdio","command":"/usr/bin/node","args":["/srv/mcp-server.js"]}',
  ]);

  assert.equal(
    entryJsonWithName(row('cursor'), VALUES),
    '{"name":"nosyparker","type":"stdio","command":"/usr/bin/node","args":["/srv/mcp-server.js"]}',
  );
});

test('every row dates the fields the community table does not model', () => {
  const table = loadClients();

  for (const client of table.clients) {
    assert.match(client.lastVerified.configPaths, /^\d{4}-\d{2}-\d{2}$/u, client.id);
    assert.match(client.lastVerified.verify, /^\d{4}-\d{2}-\d{2}$/u, client.id);
    if (client.traps.length > 0) {
      assert.match(client.lastVerified.traps, /^\d{4}-\d{2}-\d{2}$/u, client.id);
    }
    if (client.blockers.length > 0) {
      assert.match(client.lastVerified.blockers, /^\d{4}-\d{2}-\d{2}$/u, client.id);
    }
  }

  // The list exists so the drift watcher knows which fields it may never
  // overwrite from upstream, however loudly upstream disagrees.
  for (const field of ['verify', 'blockers', 'traps', 'restart', 'entry']) {
    assert.ok(table.fieldsUpstreamDoesNotModel.includes(field), field);
  }
});

test('a table with a row missing its verification block is refused on load', (t) => {
  const file = `${t.name.replaceAll(/\W/gu, '-')}.json`;
  const url = new URL(file, import.meta.url);
  const table = loadClients();

  const broken = structuredClone(table);
  delete broken.clients[0].verify;

  fs.writeFileSync(url, JSON.stringify(broken));
  t.after(() => fs.rmSync(url, { force: true }));

  assert.throws(() => loadClients(url), /has no "verify"/u);
});
