/**
 * Verification.
 *
 * The tests that matter most here are the ones where the client says something
 * encouraging and the answer is still not `connected`. Three vendor tools were
 * caught by a control test during the research — one reports success and writes
 * nothing, one validates a file it never opens, one calls a nonexistent binary
 * enabled — and each of those is a test below, with the tool's real output
 * standing in for the tool.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clientById, loadClients } from '../src/clients.js';
import { editRequest } from '../src/write.js';
import {
  CONFIG_CONFIRMED,
  CONNECTED,
  IN_FILE,
  UNVERIFIABLE,
  VERIFY_FAILED,
  findBlockers,
  verifyClient,
  withoutColour,
} from '../src/verify.js';

/**
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {any} client
 * @param {object} [extra]
 * @returns {any}
 */
function options(client, extra = {}) {
  const base = {
    name: 'nosyparker',
    command: '/usr/bin/node',
    serverPath: '/srv/mcp-server.js',
    configPath: '/nowhere/config.json',
    clientCommand: '/usr/bin/thing',
    machine: { home: '/home/p', platform: 'linux', cwd: '/home/p/work', pathDirs: [], exists: () => false, readdir: () => [], processes: () => [] },
    ...extra,
  };
  return { ...base, editRequest: editRequest(client, base) };
}

/**
 * @param {string} stdout
 * @returns {(argv: string[]) => {status: number, stdout: string, stderr: string}}
 */
function saying(stdout) {
  return () => ({ status: 0, stdout, stderr: '' });
}

test('Claude Code reporting a connection is the one answer that is about the server', () => {
  const client = clientById('claude-code');

  const checked = verifyClient(client, options(client, {
    run: saying('nosyparker: node /srv/mcp-server.js - ✔ Connected\n'),
  }));

  assert.equal(checked.status, CONNECTED);
  assert.equal(checked.tier, 'A');
  assert.match(checked.says, /started the server/u);
  assert.equal(checked.cannotProve, null, 'tier A has nothing to hedge');
});

test('Claude Code reporting a failure to connect is a failure, not a written file', () => {
  const client = clientById('claude-code');

  const checked = verifyClient(client, options(client, {
    run: saying('nosyparker: node /srv/mcp-server.js - ✘ Failed to connect\n  Issue: spawn ENOENT\n'),
  }));

  assert.equal(checked.status, VERIFY_FAILED);
  assert.match(checked.says, /could not use the server/u);
});

test('an empty list is a failure although the command exited zero', () => {
  // `claude mcp list` exits 0 with nothing configured. The exit code is not a
  // signal here and is never consulted; the output is.
  const client = clientById('claude-code');

  const checked = verifyClient(client, options(client, {
    run: saying('No MCP servers configured.\n'),
  }));

  assert.equal(checked.status, VERIFY_FAILED);
  assert.match(checked.says, /did not mention the server at all/u);
});

test('Gemini reporting Connected is the second and last tier A answer', () => {
  const client = clientById('gemini-cli');

  const checked = verifyClient(client, options(client, {
    run: saying('Configured MCP servers:\n\n✓ nosyparker: node /srv/mcp-server.js (stdio) - Connected\n'),
  }));

  assert.equal(checked.status, CONNECTED);
  assert.equal(checked.tier, 'A');
});

test('Gemini reporting Disabled in an untrusted folder is a failure with a reason', () => {
  const client = clientById('gemini-cli');

  const checked = verifyClient(client, options(client, {
    run: saying('○ nosyparker: node /srv/mcp-server.js (stdio) - Disabled\n'),
  }));

  assert.equal(checked.status, VERIFY_FAILED);
});

test('Codex calling a nonexistent binary enabled buys config-confirmed and no more', () => {
  // The control test that settled Codex's tier: a server pointing at
  // /nonexistent/definitely-not-a-binary was reported as enabled. The read-back
  // is authoritative about the config and says nothing at all about liveness,
  // and this is the word for that.
  const client = clientById('codex-cli');

  const checked = verifyClient(client, options(client, {
    run: saying(JSON.stringify([{
      name: 'nosyparker',
      enabled: true,
      transport: { type: 'stdio', command: '/nonexistent/definitely-not-a-binary', args: [] },
    }])),
  }));

  assert.equal(checked.status, CONFIG_CONFIRMED);
  assert.notEqual(checked.status, CONNECTED);
  assert.match(/** @type {string} */ (checked.cannotProve), /never tries to start the command/u);
});

test('Codex holding our entry disabled is a failure, because it will not be loaded', () => {
  const client = clientById('codex-cli');

  const checked = verifyClient(client, options(client, {
    run: saying(JSON.stringify([{ name: 'nosyparker', enabled: false }])),
  }));

  assert.equal(checked.status, VERIFY_FAILED);
  assert.match(checked.says, /has it disabled/u);
});

test('Codex not listing it at all is a failure', () => {
  const client = clientById('codex-cli');

  const checked = verifyClient(client, options(client, {
    run: saying(JSON.stringify([{ name: 'something-else', enabled: true }])),
  }));

  assert.equal(checked.status, VERIFY_FAILED);
});

test('Goose echoing its parsed config is config-confirmed, not connected', () => {
  const client = clientById('goose');

  // The real shape, taken from `goose info -v` on a real machine: the entry is
  // a block, and the fields inside it come in whatever order Goose feels like.
  const checked = verifyClient(client, options(client, {
    run: saying('  extensions:\n    nosyparker:\n      type: stdio\n      name: nosyparker\n      enabled: true\n    developer:\n      enabled: true\n      type: builtin\n'),
  }));

  assert.equal(checked.status, CONFIG_CONFIRMED);
  assert.equal(checked.tier, 'B+');
  assert.match(/** @type {string} */ (checked.cannotProve), /no liveness check/u);
});

test('Goose has to show the enable flag, not just the name', () => {
  // Two defects in one pattern, both closed here. The check matched the name
  // line alone, so a line reporting a problem with our extension confirmed our
  // extension — copilot's shape exactly, in a tier B+ row. And the sentence it
  // produced said `enabled`, which the pattern had never looked at.
  const client = clientById('goose');

  const off = verifyClient(client, options(client, {
    run: saying('  extensions:\n    nosyparker:\n      type: stdio\n      enabled: false\n'),
  }));
  assert.equal(off.status, VERIFY_FAILED);

  const bare = verifyClient(client, options(client, { run: saying('  nosyparker:\n') }));
  assert.notEqual(bare.status, CONFIG_CONFIRMED);

  const broken = verifyClient(client, options(client, {
    run: saying('  nosyparker: <error reading extension>\n'),
  }));
  assert.equal(broken.status, VERIFY_FAILED);
});

test('one extension being enabled is not another extension being enabled', () => {
  // The trap in the obvious version of this pattern: a lazy match from our name
  // skips over our own `enabled: false` and finds the next `enabled: true`,
  // which belongs to somebody else. The entry's own indentation bounds it.
  const client = clientById('goose');

  const checked = verifyClient(client, options(client, {
    run: saying('  extensions:\n    nosyparker:\n      enabled: false\n    developer:\n      enabled: true\n'),
  }));

  assert.equal(checked.status, VERIFY_FAILED);
});

test('no client claims success for a line that says it failed', () => {
  // The finding that contradicted the point of the phase, kept as a corpus so
  // it cannot come back. Copilot's row matched its own name appearing anywhere,
  // so a config file containing nothing at all and a command printing
  // `failed to start server nosyparker` both produced `confirmed` — the
  // strongest group in the report, from the row with the weakest evidence in
  // the table.
  //
  // Two more rows had the same shape and were not spotted by the review: Claude
  // Code read `Not Connected` as connected, and opencode read `disconnected` as
  // connected, because the word is inside the longer one.
  //
  // The rule these enforce is one-directional. Failing to recognise a real
  // success costs a client being reported as unconfirmed, which is a client
  // somebody checks by hand. Recognising a failure as a success costs somebody
  // their trust in every other line of the report.
  const hostile = [
    'nosyparker: not configured',
    'nosyparker  (disabled)',
    'Error: failed to start server nosyparker: ENOENT',
    'Successfully added MCP server "nosyparker".',
    '\u2717 nosyparker: node x (stdio) - Disconnected',
    'nosyparker disconnected',
    'nosyparker: Not Connected',
    '\u2718 nosyparker - Failed to connect',
    'nosyparker  status: unknown',
    'nosyparker',
  ];

  for (const client of loadClients().clients) {
    if (client.verify.method !== 'cli-lines') continue;

    for (const line of hostile) {
      const checked = verifyClient(client, options(client, {
        run: () => ({ status: 0, stdout: line, stderr: '' }),
      }));

      assert.notEqual(checked.status, CONNECTED, `${client.id} read "${line}" as connected`);
      assert.notEqual(checked.status, CONFIG_CONFIRMED, `${client.id} read "${line}" as confirmed`);
    }
  }
});

test('and every client still recognises the output it was actually measured printing', () => {
  // The other half. A check that says no to everything is not a check either,
  // and these are the lines these clients really printed on a real machine —
  // opencode's with the terminal colour codes it really emits, which is how the
  // word-boundary fix above was caught breaking it.
  const real = {
    'claude-code': 'nosyparker: node /srv/mcp-server.js - \u2714 Connected',
    'gemini-cli': '\u2713 nosyparker: node /srv/mcp-server.js (stdio) - Connected',
    opencode: '\u25cf  \u2713 nosyparker \u001b[90mconnected',
    goose: 'extensions:\n  nosyparker:\n    enabled: true',
    hermes: "\n  Testing 'nosyparker'...\n  Transport: stdio \u2192 /srv/node\n  Auth: none"
      + '\n  \u2713 Connected (556ms)\n  \u2713 Tools discovered: 10\n',
    openclaw: 'MCP probe (/home/x/.openclaw/openclaw.json):\n- nosyparker: 10 tools\n',
  };

  for (const [id, line] of Object.entries(real)) {
    const client = clientById(id);
    const checked = verifyClient(client, options(client, {
      run: () => ({ status: 0, stdout: line, stderr: '' }),
    }));

    assert.ok(
      checked.status === CONNECTED || checked.status === CONFIG_CONFIRMED,
      `${id} no longer recognises its own output: ${checked.status}`,
    );
  }
});

test('a success reported for one server is not read as success for ours', () => {
  // The gap the hostile list above cannot see. Every line in it is about
  // nosyparker; none of them asks whether a pattern knows *which* server it is
  // looking at. Hermes' first draft here matched `\u2713 Connected` on its own,
  // because the name is on an earlier line — so any success from any server, or
  // a summary naming none, would have been reported as ours.
  //
  // The name is in the argv for that command, so nothing on this machine could
  // reach the bad case today. That is not a reason to keep a pattern that says
  // yes to the wrong thing: it is one refactor away from mattering, and this is
  // the class of mistake that has cost this table two tiers already.
  /** @type {Record<string, string>} */
  const elsewhere = {
    'claude-code': 'somethingelse: node /srv/mcp-server.js - \u2714 Connected',
    'gemini-cli': '\u2713 somethingelse: node /srv/mcp-server.js (stdio) - Connected',
    opencode: '\u25cf  \u2713 somethingelse \u001b[90mconnected',
    goose: 'extensions:\n  somethingelse:\n    enabled: true',
    hermes: "\n  Testing 'somethingelse'...\n  \u2713 Connected (5ms)\n",
    openclaw: 'MCP probe (/home/x/.openclaw/openclaw.json):\n- somethingelse: 3 tools\n',
  };

  for (const client of loadClients().clients) {
    if (client.verify.method !== 'cli-lines') continue;

    const line = elsewhere[client.id];
    assert.ok(line, `${client.id} is checked by lines and has no other-server sample here`);

    const checked = verifyClient(client, options(client, {
      run: () => ({ status: 0, stdout: line, stderr: '' }),
    }));

    assert.notEqual(checked.status, CONNECTED, `${client.id} read another server's success as ours`);
    assert.notEqual(checked.status, CONFIG_CONFIRMED, `${client.id} read another server's entry as ours`);
  }
});

test('colour codes are taken off before anything is matched', () => {
  // A real regression, caught by running the thing rather than by the tests.
  // Tightening opencode's pattern to a whole word — so that `disconnected`
  // could not satisfy it — turned a client that genuinely starts the server
  // into one reported as never mentioning it, because opencode colours the word
  // and the escape ends in `m`, which is a word character sitting exactly where
  // the boundary needed to be.
  const client = clientById('opencode');

  const coloured = verifyClient(client, options(client, {
    run: saying('\u25cf  \u2713 nosyparker \u001b[90mconnected\n'),
  }));
  assert.equal(coloured.status, CONNECTED);

  // And the tightening it was protecting still holds, colours or not.
  const broken = verifyClient(client, options(client, {
    run: saying('\u25cf  \u2717 nosyparker \u001b[31mdisconnected\n'),
  }));
  assert.equal(broken.status, VERIFY_FAILED);

  assert.equal(withoutColour('\u001b[90mconnected\u001b[0m'), 'connected');
  assert.equal(withoutColour('nothing to strip'), 'nothing to strip');
});

test('Copilot asks nothing, because nobody has ever seen what it answers', () => {
  // It has a documented list command and deliberately does not use it. A
  // pattern written against output nobody has observed is not a check: this one
  // reported `confirmed` for a config containing `{}` and for a line saying the
  // server had failed to start.
  const copilot = clientById('copilot-cli');

  assert.equal(copilot.verify.method, 'file-reread');
  assert.equal(copilot.verify.argv, null);
  assert.equal(copilot.verify.tier, 'C');
  assert.match(copilot.traps.join(' '), /deliberately not used/u);
});

test('Copilot on an empty config reports a failure, which is what it is', (t) => {
  const configPath = path.join(directory(t), 'mcp-config.json');
  fs.writeFileSync(configPath, '{}');

  const client = clientById('copilot-cli');
  const checked = verifyClient(client, options(client, { configPath }));

  assert.equal(checked.status, VERIFY_FAILED);
  assert.match(checked.says, /The entry is not in/u);
});

test('a client written by its own command and read back from the file says written', (t) => {
  const client = clientById('vscode');
  const configPath = path.join(directory(t), 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ servers: { nosyparker: { command: 'node' } } }));

  const checked = verifyClient(client, options(client, { configPath }));

  assert.equal(checked.status, IN_FILE);
  assert.equal(checked.tier, 'B');
  assert.match(checked.says, /own command wrote the entry/u);
});

test('a client we wrote ourselves and cannot ask says so in words', (t) => {
  const client = clientById('zed');
  const configPath = path.join(directory(t), 'settings.json');
  fs.writeFileSync(configPath, '{"context_servers": {"nosyparker": {"command": "node"}}}');

  const checked = verifyClient(client, options(client, { configPath }));

  assert.equal(checked.status, UNVERIFIABLE);
  assert.match(checked.says, /nothing on this machine can confirm Zed reads it/u);
});

test('Kimi is written and unverifiable, and the reason is an account', (t) => {
  const client = clientById('kimi-code');
  const configPath = path.join(directory(t), 'mcp.json');
  fs.writeFileSync(configPath, '{"mcpServers": {"nosyparker": {"command": "node"}}}');

  const checked = verifyClient(client, options(client, { configPath }));

  assert.equal(checked.status, UNVERIFIABLE);
  assert.match(/** @type {string} */ (checked.cannotProve), /Moonshot account/u);

  // And the trap that would otherwise have supplied a green tick over nothing.
  assert.match(client.traps.join(' '), /kimi doctor/u);
});

test('an entry that is not in the file is a failure, whatever the write said', (t) => {
  const client = clientById('zed');
  const configPath = path.join(directory(t), 'settings.json');
  fs.writeFileSync(configPath, '{"context_servers": {}}');

  const checked = verifyClient(client, options(client, { configPath }));

  assert.equal(checked.status, VERIFY_FAILED);
  assert.match(checked.says, /The entry is not in/u);
});

test('a client whose command has gone missing is checked the weaker way, and says so', (t) => {
  const client = clientById('claude-code');
  const configPath = path.join(directory(t), 'claude.json');
  fs.writeFileSync(configPath, '{"mcpServers": {"nosyparker": {"command": "node"}}}');

  const checked = verifyClient(client, options(client, { configPath, clientCommand: null }));

  assert.notEqual(checked.status, CONNECTED);
  assert.equal(checked.declaredTier, 'A');
  assert.match(checked.says, /own command could not be found/u);
});

test('VS Code settings that would block a good entry are found and reported apart', (t) => {
  const dir = directory(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'Code', 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'Code', 'User', 'settings.json'),
    '{\n  // switched off by our IT\n  "chat.mcp.enabled": false,\n  "chat.mcp.deniedServers": ["nosyparker"]\n}\n',
  );

  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, '{"servers": {"nosyparker": {"command": "node"}}}');

  const client = clientById('vscode');
  const checked = verifyClient(client, options(client, {
    configPath,
    machine: { home, platform: 'linux', cwd: dir, pathDirs: [], exists: () => false, readdir: () => [], processes: () => [] },
  }));

  // The write succeeded and the entry is there. Both of those are true and
  // neither of them is the whole story, so the status stays what it was and
  // the blockers arrive beside it rather than inside it.
  assert.equal(checked.status, IN_FILE);
  assert.equal(checked.blockers.length, 2);
  assert.match(checked.blockers.join(' '), /chat\.mcp\.enabled is false/u);
  assert.match(checked.blockers.join(' '), /deniedServers/u);
});

test('a settings file with comments in it is still read for blockers', (t) => {
  // VS Code's settings.json is JSON with comments and people write them. A
  // blocker check that fell over on a comment would report a clean machine.
  const dir = directory(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'Code', 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'Code', 'User', 'settings.json'),
    '{\n  /* company policy */\n  "chat.mcp.access": "registry" // registry only\n}\n',
  );

  const client = clientById('vscode');
  const checked = verifyClient(client, options(client, {
    configPath: path.join(dir, 'absent.json'),
    machine: { home, platform: 'linux', cwd: dir, pathDirs: [], exists: () => false, readdir: () => [], processes: () => [] },
  }));

  assert.match(checked.blockers.join(' '), /chat\.mcp\.access is not `any`/u);
});

test('Gemini folder trust is a blocker when this folder is not in the trust file', (t) => {
  const dir = directory(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), '{"/somewhere/else": "TRUST_FOLDER"}');

  const client = clientById('gemini-cli');
  const machine = { home, platform: 'linux', cwd: '/home/p/work', pathDirs: [], exists: () => false, readdir: () => [], processes: () => [] };

  const untrusted = verifyClient(client, options(client, {
    machine,
    run: saying('✓ nosyparker: node /srv/mcp-server.js (stdio) - Connected\n'),
  }));
  assert.match(untrusted.blockers.join(' '), /in a folder it does not trust/u);

  fs.writeFileSync(
    path.join(home, '.gemini', 'trustedFolders.json'),
    '{"/home/p/work": "TRUST_FOLDER"}',
  );
  const trusted = verifyClient(client, options(client, {
    machine,
    run: saying('✓ nosyparker: node /srv/mcp-server.js (stdio) - Connected\n'),
  }));
  assert.deepEqual(trusted.blockers, []);
});

test('no client can reach connected except the two the research proved can', () => {
  // The statuses are a closed vocabulary and this is the half of it that is
  // easy to lose: a row promoted to tier A by a tidy-up would start printing a
  // word that means the server runs, over a check that never started it.
  const reachable = ['claude-code', 'gemini-cli'];

  for (const client of [clientById('codex-cli'), clientById('goose'), clientById('vscode'),
    clientById('cursor'), clientById('devin-desktop'), clientById('claude-desktop'),
    clientById('zed'), clientById('kimi-code')]) {
    assert.equal(reachable.includes(client.id), false, client.id);
    assert.notEqual(client.verify.tier, 'A', `${client.id} claims tier A`);
  }
});

test('a blocker says what to do about it, not only that something is wrong', () => {
  // The owner asked how to unlock Gemini's folder trust and the message could
  // not tell him, because it named the file and stopped there. Every blocker in
  // the table now ends in an action, in the same shape as the sentence for an
  // application that is running: what is wrong, then what to do.
  for (const client of loadClients().clients) {
    for (const blocker of client.blockers) {
      assert.ok(
        /\b(Set|Remove|Start|add|ask|Make)\b/u.test(blocker.says),
        `${client.id}: "${blocker.says}" says what is wrong and not what to do`,
      );
    }
  }
});

test('the Gemini instruction names the folder the person is actually in', (t) => {
  // Both routes were run against a real installation before this was written.
  // `/permissions trust` writes ~/.gemini/trustedFolders.json itself; writing
  // that file by hand has exactly the same effect, and `gemini mcp list` goes
  // from `Disabled` to `Connected` either way.
  const dir = directory(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), '{"/somewhere/else": "TRUST_FOLDER"}');

  const configPath = path.join(dir, 'settings.json');
  fs.writeFileSync(configPath, '{"mcpServers": {"nosyparker": {"command": "node"}}}');

  const client = clientById('gemini-cli');
  const checked = verifyClient(client, options(client, {
    configPath,
    machine: {
      home,
      platform: 'linux',
      cwd: '/home/p/my project',
      pathDirs: [],
      exists: () => false,
      readdir: () => [],
      processes: () => [],
    },
    run: saying('○ nosyparker: node (stdio) - Disabled\n'),
  }));

  const said = checked.blockers.join(' ');

  assert.match(said, /Start `\/usr\/bin\/thing` in \/home\/p\/my project and run `\/permissions trust`/u);
  assert.match(said, /"\/home\/p\/my project": "TRUST_FOLDER"/u);
  assert.doesNotMatch(said, /\{\{cwd\}\}/u, 'the token is filled in, not printed');
});

test('advice names a command the person can actually type', (t) => {
  // The owner read "Start gemini in ~ and run `/permissions trust`", typed
  // `gemini`, and got `command not found` — from a program that had just run
  // the thing successfully and knew the absolute path it used. `detect.js`
  // falls back to where a client is known to be installed, `verify` runs what
  // it got back, and then the sentence named the bare command anyway.
  //
  // Five of twelve detected clients on the owner's machine resolved somewhere
  // not on his interactive PATH. It is the same mistake as writing `node` into
  // a config instead of `process.execPath`, which this project refuses to make
  // in the entry it writes and made in the sentence it printed.
  const gemini = clientById('gemini-cli');

  /** @param {string} command @param {string[]} pathDirs */
  const advice = (command, pathDirs) => findBlockers(gemini, {
    name: 'nosyparker',
    configPath: '',
    clientCommand: command,
    machine: { home: '/home/x', platform: 'linux', cwd: '/home/x', pathDirs, exists: () => false, readdir: () => [], processes: () => null },
    editRequest: {},
  })[0] ?? '';

  // Off PATH: the path we used, because the name would not work.
  assert.match(
    advice('/home/x/.npm-global/bin/gemini', ['/usr/bin']),
    /Start `\/home\/x\/\.npm-global\/bin\/gemini`/u,
    'it told somebody to type a name their shell cannot find');

  // On PATH: the name, because the path would be noise.
  assert.match(
    advice('/usr/bin/gemini', ['/usr/bin']), /Start `gemini`/u,
    'it printed a full path where the bare name works');

  // Nothing resolved at all: the name is the only thing we have.
  assert.match(advice(/** @type {any} */ (null), []), /Start `gemini`/u);
});

test('no printed advice hardcodes a command name the row resolves for itself', () => {
  // The general form, so the next row added does not reintroduce it. A blocker
  // or a restart instruction is something a person types; if it names a
  // client's own command it has to use the token that gets substituted for
  // whatever we actually found, not the bare word.
  /** @type {string[]} */
  const wrong = [];

  for (const client of loadClients().clients) {
    for (const name of client.detect?.commands ?? []) {
      const bare = new RegExp(`(^|[\\s\`"])${name}([\\s\`"]|$)`, 'u');

      for (const blocker of client.blockers ?? []) {
        if (bare.test(blocker.says.replaceAll('{{clientCommand}}', ''))) {
          wrong.push(`${client.id}: a blocker names \`${name}\` instead of {{clientCommand}}`);
        }
      }
      const restart = typeof client.restart === 'string' ? client.restart : '';
      if (bare.test(restart.replaceAll('{{clientCommand}}', ''))) {
        wrong.push(`${client.id}: its restart line names \`${name}\` instead of {{clientCommand}}`);
      }
    }
  }

  assert.deepEqual(wrong, []);
});
