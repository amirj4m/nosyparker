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

import { removeEntry } from '../src/edit.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  clientById,
  configPathFor,
  entryJsonWithName,
  fillArgv,
  fillTokens,
  loadClients,
  serverCommand,
  invocation,
  PLATFORMS,
  provenance,
  surfacePath,
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

test('the table carries twenty-two clients, and each one is a decision somebody made', () => {
  // Written out rather than counted. Three web-only clients are deliberately
  // absent and are not a gap: Claude on the web, ChatGPT and the Copilot coding
  // agent have no local configuration file at all, so there is nothing to write
  // and no amount of effort would change that.
  const { clients } = loadClients();
  assert.deepEqual(
    clients.map((client) => client.id).sort(),
    [
      'amazon-q', 'claude-code', 'claude-desktop', 'cline', 'codex-cli', 'continue', 'copilot-cli',
      'cursor', 'devin-desktop', 'gemini-cli', 'goose', 'hermes', 'junie', 'kimi-code', 'kiro',
      'lmstudio', 'openclaw', 'opencode', 'roo-code', 'vscode', 'warp', 'zed',
    ],
  );

  assert.deepEqual(
    clients.filter((client) => client.tier === 1).map((client) => client.id).sort(),
    ['claude-code', 'codex-cli', 'cursor', 'devin-desktop', 'gemini-cli', 'goose', 'kiro',
      'opencode', 'vscode'],
  );
  assert.deepEqual(
    clients.filter((client) => client.tier === 2).map((client) => client.id).sort(),
    ['claude-desktop', 'kimi-code', 'lmstudio', 'zed'],
  );
  assert.deepEqual(
    clients.filter((client) => client.tier === 3).map((client) => client.id).sort(),
    ['amazon-q', 'cline', 'continue', 'copilot-cli', 'hermes', 'junie', 'openclaw', 'roo-code',
      'warp'],
  );
});

test('opencode is the row that resembles nothing else, and is kept that way', () => {
  // Every field here is one somebody could "correct" into agreement with its
  // neighbours, and every correction would break it — the published schema sets
  // additionalProperties: false, so a wrong or extra field is a hard failure
  // rather than something quietly ignored.
  const opencode = row('opencode');

  assert.equal(opencode.rootKey, 'mcp');
  assert.equal(opencode.format, 'jsonc');

  assert.deepEqual(fillTokens(opencode.entry, VALUES), {
    type: 'local',
    command: ['/usr/bin/node', '/srv/mcp-server.js'],
  });

  // `local`, not `stdio`. One array holding the program and its arguments
  // together, not a string plus an args array. And nothing else at all.
  assert.equal(Object.keys(opencode.entry).length, 2);
  assert.equal('args' in opencode.entry, false);
  assert.equal('env' in opencode.entry, false);
  assert.match(opencode.traps.join(' '), /additionalProperties: false/u);
  assert.match(opencode.traps.join(' '), /Environment variables go in `environment`, not `env`/u);

  // It is also the one client that can prove the server runs and was measured
  // doing it, which is why it is tier A alongside Claude Code and Gemini.
  assert.equal(opencode.verify.tier, 'A');
});

test('Amazon Q is marked as the least certain row, in every field that could mislead', () => {
  const q = row('amazon-q');

  assert.equal(q.evidence, 'DOCS');
  assert.equal(q.verify.tier, 'C');

  // The fifth vendor command found reporting success over nothing.
  assert.equal(q.write.method, 'file');
  assert.match(q.write.why, /exits 0 while refusing/u);
  assert.match(q.traps.join(' '), /exit code means nothing here/u);

  // And the part that separates it from every other measured row: the path was
  // never seen on disk, because nothing would create it.
  assert.match(q.traps.join(' '), /never been observed on disk/u);
  assert.match(q.verify.cannotProve, /least certain row in the table/u);
});

test('LM Studio carries the path measured on Linux, not the one its docs give', () => {
  const lms = row('lmstudio');

  assert.equal(configPathFor(lms, LINUX), '/home/p/.lmstudio/mcp.json');
  assert.equal(lms.evidence, 'MACHINE');
  assert.match(lms.traps.join(' '), /macOS path its documentation gives does not apply here/u);

  // And nothing is claimed for the platforms nobody looked at.
  assert.equal(configPathFor(lms, { ...LINUX, platform: 'darwin' }), null);
});

test('Copilot CLI is carried on documentation alone, and says so in every field', () => {
  // It has never been installed or run here, and the research records only what
  // its documentation says. Two things follow, and both are deliberate.
  const copilot = row('copilot-cli');

  assert.equal(copilot.evidence, 'DOCS');
  assert.equal(copilot.tier, 3);

  // Its own documentation puts `copilot mcp list` in the same class as
  // `claude mcp list` — a health check. This row asked it until a review showed
  // what that was worth: with no observed output to write a pattern against,
  // the pattern written from guesswork reported success for a config file
  // holding nothing and for a line saying the server had failed to start. It
  // asks nothing now.
  assert.equal(copilot.verify.tier, 'C');
  assert.equal(copilot.verify.method, 'file-reread');
  assert.equal(copilot.verify.argv, null);

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

test('no row anywhere names an interpreter that a client would have to search for', () => {
  // The defect this exists to prevent, watched happening: in opencode an entry
  // of `["node", …]` fails with `Connection closed` and no other explanation,
  // and the same entry with the full path connects. opencode does not inherit
  // the shell environment, so a version-managed Node is invisible to it. Zed
  // and Gemini work with a bare `node` only because those two deliberately
  // import the shell environment, which is their choice and not a thing to
  // build on.
  //
  // So no row may carry an interpreter name of its own: every one of them takes
  // {{command}}, which is filled with the absolute path of the interpreter
  // actually running the installer.
  const table = fs.readFileSync(new URL('../src/clients.json', import.meta.url), 'utf8');
  const entries = loadClients().clients
    .filter((client) => client.entry !== null)
    .map((client) => JSON.stringify(client.entry));

  for (const entry of entries) {
    assert.doesNotMatch(entry, /"(node|python|python3|npx|bun|deno)"/u, entry);
  }

  // And the write commands, where a bare name would be just as wrong.
  for (const client of loadClients().clients) {
    for (const argument of client.write.argv ?? []) {
      assert.notEqual(argument, 'node', client.id);
    }
  }

  assert.doesNotMatch(table, /"command": "node"/u);
});

test('the interpreter written is the one running, absolute, and on this machine', () => {
  const { command, serverPath } = serverCommand();

  assert.equal(command, process.execPath);
  assert.equal(path.isAbsolute(command), true);
  assert.equal(fs.existsSync(command), true);

  // Already fully resolved, so we are not writing a symlink that a version
  // manager can repoint underneath us without us noticing.
  assert.equal(fs.realpathSync(command), command);

  assert.equal(path.isAbsolute(serverPath), true);
  assert.equal(fs.existsSync(serverPath), true);
});

test('each root key is that client\'s own, and three of them are not mcpServers', () => {
  assert.equal(row('vscode').rootKey, 'servers');
  assert.equal(row('devin-desktop').rootKey, 'servers');
  assert.equal(row('zed').rootKey, 'context_servers');
  assert.equal(row('goose').rootKey, 'extensions');
  assert.equal(row('codex-cli').rootKey, 'mcp_servers');

  assert.equal(row('kiro').rootKey, 'servers');
  assert.equal(row('opencode').rootKey, 'mcp');

  for (const id of ['claude-code', 'claude-desktop', 'cursor', 'gemini-cli', 'kimi-code',
    'cline', 'continue', 'warp', 'junie', 'lmstudio', 'roo-code', 'amazon-q']) {
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
    hermes: 'A',
    openclaw: 'A',
    'codex-cli': 'B+',
    goose: 'B+',
    'copilot-cli': 'C',
    opencode: 'A',
    kiro: 'B',
    lmstudio: 'C',
    'roo-code': 'C',
    'amazon-q': 'C',
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

test('a client whose own command writes a second file says so, and the entry can be removed from it', () => {
  // Found on a real machine, three days after the fact. `cursor --add-mcp`
  // was run once during research; the row recorded "exited 0 and created no
  // file anywhere on disk", and `~/.cursor/mcp.json` — the file the row names —
  // was indeed untouched. The command had written
  // `~/.config/Cursor/User/settings.json` instead, under `mcp` → `servers`,
  // which is the VS Code surface Cursor inherited. Nothing here knew, so
  // `uninstall` could not clean it.
  //
  // Re-measured in a clean HOME before this test was written: `cursor
  // --add-mcp` creates exactly that file, and `code --add-mcp` creates
  // `~/.config/Code/User/mcp.json`, which is what the vscode row already says.
  const cursor = clientById('cursor');
  const second = (cursor.alsoRemoveFrom ?? []).find(
    (/** @type {any} */ s) => surfacePath(s, 'linux')?.includes('Cursor/User/settings.json'));

  assert.ok(second, 'the cursor row should name the file its own --add-mcp writes');
  assert.equal(second.rootKey, 'mcp.servers');

  // And the remover has to be able to reach it, which means a dotted root key.
  const text = [
    '{',
    '\t"window.autoDetectColorScheme": true,',
    '\t"mcp": {',
    '\t\t"servers": {',
    '\t\t\t"nosyparker": {',
    '\t\t\t\t"command": "/usr/bin/node"',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
  ].join('\n');

  const after = removeEntry(text, { name: 'nosyparker', rootKey: second.rootKey, format: 'json', entry: {} });

  assert.equal(after.includes('nosyparker'), false, 'the entry should be gone');
  assert.match(after, /"window\.autoDetectColorScheme": true/u, "his own setting should survive");
  assert.ok(after.includes('\t'), 'the tabs it was written with should survive');
  assert.doesNotThrow(() => JSON.parse(after));
});

test('a trap does not state one platform\'s path as if it were every platform\'s', () => {
  // `setup --print-config` prints traps, on whatever machine it is run on. The
  // Cursor trap named `~/.config/Cursor/User/settings.json` flatly — the Linux
  // path, told to a Windows user as the file their own command writes. Every
  // other path in this table is a per-OS map for exactly this reason; a trap is
  // prose and cannot be one, so it has to name the platform instead.
  //
  // Structural rather than a reading of the prose: take the paths the row
  // itself gives per platform, and if a trap quotes one of them, the trap must
  // also name the platform it belongs to.
  /** @type {string[]} */
  const wrong = [];

  for (const client of loadClients().clients) {
    /** @type {Record<string, string>[]} */
    const maps = [client.configPaths, ...(client.alsoRemoveFrom ?? []).map(
      (/** @type {any} */ s) => Object.fromEntries(
        PLATFORMS.map((platform) => [platform, surfacePath(s, platform)])))];

    for (const trap of client.traps) {
      for (const map of maps) {
        for (const [platform, value] of Object.entries(map)) {
          if (typeof value !== 'string' || !trap.includes(value)) continue;

          // Named by every platform alike — `~/.claude.json` is the same string
          // on all three — so quoting it says nothing platform-specific.
          const shared = Object.values(map).filter((other) => other === value).length;
          if (shared > 1) continue;

          const names = { linux: /linux/iu, darwin: /macos|mac os|darwin/iu, win32: /windows|win32/iu };
          if (!names[/** @type {'linux'|'darwin'|'win32'} */ (platform)].test(trap)) {
            wrong.push(`${client.id}: a trap quotes the ${platform} path and does not say ${platform}`);
          }
        }
      }
    }
  }

  assert.deepEqual(wrong, []);
});

test('what has been watched is data, and the sentence people read is built from it', (t) => {
  // The third instrument tried on one claim, and the first that is not standing
  // at one remove from it.
  //
  // First it was a clause somebody typed into the row's `why`. Then a regex
  // asking whether that clause looked like an admission — which passed three
  // times for reasons unrelated to what it checked, twice inside a test written
  // to close it, the last time on the phrase "on a machine we have never looked
  // at", which is about the output and not about the paths. A reviewer stripped
  // every real admission from the row and 455 tests stayed green.
  //
  // A regex over prose cannot express "this sentence admits the thing it needs
  // to admit". So the admission is a boolean next to each path, and the words a
  // person reads are generated from it.
  const table = loadClients();
  const surfaces = table.clients.flatMap((/** @type {any} */ client) =>
    (client.alsoRemoveFrom ?? []).map((/** @type {any} */ surface) => [client.id, surface]));

  assert.ok(surfaces.length > 0, 'there is no second surface left to check');

  for (const [id, surface] of surfaces) {
    for (const platform of PLATFORMS) {
      const where = surface.path[platform];
      if (where === null) continue;

      assert.equal(typeof where.at, 'string', `${id}: the ${platform} path is not a string`);
      assert.equal(where.inferred, !surface.measuredOn.includes(platform),
        `${id}: the ${platform} flag and measuredOn disagree`);
    }
  }

  // Both directions refused at the door, so the disagreement cannot exist in a
  // table this program will load.
  const url = new URL(`${t.name.replaceAll(/\W/gu, '-')}.json`, import.meta.url);
  t.after(() => fs.rmSync(url, { force: true }));

  /** @param {(surface: any) => void} damage */
  const refused = (damage) => {
    const broken = structuredClone(table);
    const client = broken.clients.find((/** @type {any} */ c) => c.alsoRemoveFrom?.length);
    damage(client.alsoRemoveFrom[0]);
    fs.writeFileSync(url, JSON.stringify(broken));
    return () => loadClients(url);
  };

  // An unmeasured platform presented as fact — the exact edit the reviewer made.
  assert.throws(refused((surface) => { surface.path.darwin.inferred = false; }), /disagree/u);
  // And a measured one hidden as a guess, which is the same fault backwards.
  assert.throws(refused((surface) => { surface.path.linux.inferred = true; }), /disagree/u);
  // A path with no admission attached to it at all.
  assert.throws(refused((surface) => { surface.path.win32 = '~/somewhere'; }), /at, inferred/u);

  // The sentence is generated, and it says what the flags say.
  const [, cursor] = surfaces.find(([id]) => id === 'cursor') ?? [];
  assert.equal(provenance(cursor), 'measured on Linux, and inferred on macOS and Windows');

  // And the row does not write that claim down a second time in prose beside
  // it. Two copies of one fact is how the last one drifted: the clause was
  // taken out of the table and left standing in CLIENTS.md, which ships.
  for (const [id, surface] of surfaces) {
    assert.doesNotMatch(surface.why, /measured on|inferred on|nobody has watched|never looked/iu,
      `${id}: the row says in prose what its flags already say`);
  }
});

test('a table with an incomplete second surface is refused on load', (t) => {
  // `validateTable` grew a block for these rows and nothing made it fire: the
  // shipped table is complete, so a test that reads the shipped table passes
  // whether the check runs or not. This one hands it a broken row.
  const url = new URL(`${t.name.replaceAll(/\W/gu, '-')}.json`, import.meta.url);
  t.after(() => fs.rmSync(url, { force: true }));

  /** @param {(surface: any) => void} damage */
  const refused = (damage) => {
    const broken = structuredClone(loadClients());
    const client = broken.clients.find((/** @type {any} */ c) => c.alsoRemoveFrom?.length);
    assert.ok(client, 'no client in the table has a second surface to damage');
    damage(client.alsoRemoveFrom[0]);
    fs.writeFileSync(url, JSON.stringify(broken));
    return () => loadClients(url);
  };

  assert.throws(refused((s) => delete s.why), /second surface with no "why"/u);
  assert.throws(refused((s) => delete s.measuredOn), /second surface with no "measuredOn"/u);

  // A platform we know nothing about has to say so out loud. A missing key and
  // an explicit null read identically to the code that cleans — both mean "not
  // here" — and only one of them is a decision somebody made.
  assert.throws(refused((s) => delete s.path.win32), /says nothing about win32/u);

  // Measured somewhere, by somebody. A row nobody has ever run is a row that
  // edits a stranger's editor settings on a guess.
  assert.throws(refused((s) => { s.measuredOn = []; }), /which platform its second surface was measured on/u);
});

test('a second surface is a per-OS path like every other path in the table', () => {
  // `alsoRemoveFrom.path` was one hardcoded Linux string while `configPaths`
  // beside it is a map. On macOS the file is not found, the loop continues, and
  // the command prints the exact false "Nothing to remove" the first review
  // flagged — while CLIENTS.md promises the cleanup with no platform named.
  const cursor = clientById('cursor');
  const second = cursor.alsoRemoveFrom[0];

  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.ok(platform in second.path,
      `${platform} is not in alsoRemoveFrom.path — a path we do not know must be null, not absent`);
  }

  assert.equal(surfacePath(second, 'linux'), '~/.config/Cursor/User/settings.json');

  // And it has to say which of those was measured rather than inferred. That
  // now lives on each path as a boolean rather than in the prose beside it —
  // see the test that replaced the regex which kept passing for the wrong
  // reason.
  assert.deepEqual(second.measuredOn, ['linux']);
});

test('every alsoRemoveFrom row is complete, like every other row in the table', () => {
  // Nothing validated these. A row missing a rootKey would remove nothing and
  // say nothing, which is the shape of every finding in both reviews.
  for (const client of loadClients().clients) {
    for (const surface of client.alsoRemoveFrom ?? []) {
      for (const key of ['path', 'rootKey', 'format', 'why', 'measuredOn']) {
        assert.ok(key in surface, `${client.id}'s second surface has no "${key}"`);
      }
      assert.ok(['json', 'jsonc'].includes(surface.format), `${client.id}: ${surface.format}`);
      assert.ok(Array.isArray(surface.measuredOn) && surface.measuredOn.length > 0,
        `${client.id}: measuredOn must name at least one platform we actually ran it on`);
    }
  }
});

test('no row claims a command writes nothing when the row itself says it writes', () => {
  // CLIENTS.md was rewritten and `src/clients.json` was not. `traps[0]` still
  // said `cursor --add-mcp` "exits 0 and writes no file", contradicted by
  // `write.why` five lines up in the same object — and `setup --print-config`
  // prints traps, so the falsehood reached the terminal after the prose that
  // retracted it had shipped.
  for (const client of loadClients().clients) {
    const claimsNothing = (client.traps ?? []).some((/** @type {any} */ trap) => /writes no file|creates no file/iu.test(trap));
    if (!claimsNothing) continue;

    assert.equal(/does write|writes ~|writes `/iu.test(client.write.why ?? ''), false,
      `${client.id}: traps say the command writes nothing and write.why says it writes`);
  }
});

test('invocation names the command only when it was started as one', () => {
  // Two mutations were green: dropping the `nosyparker.cmd` case, and widening
  // the branch to return 'nosyparker' unconditionally. The second is the worse
  // one — every sentence this program prints would name a command that does not
  // exist for somebody running from a clone, which is the exact defect the
  // check in documentation.js was written for.
  const argv = process.argv[1];

  try {
    for (const started of ['/usr/local/bin/nosyparker', 'C:\\npm\\nosyparker.cmd']) {
      process.argv[1] = started;
      assert.equal(invocation(), 'nosyparker', `${started} should name the command`);
    }

    // From a clone, or anything else, it has to name the path — the shim is the
    // only thing that makes the bare word true.
    for (const started of ['/home/somebody/nosyparker/src/cli.js', '/usr/bin/node', '']) {
      process.argv[1] = started;
      assert.match(invocation(), /^node \/.*\/src\/cli\.js$/u, `${started} should name the path`);
    }
  } finally {
    process.argv[1] = argv;
  }
});
