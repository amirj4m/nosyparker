/**
 * `doctor`.
 *
 * The first test is the one the command exists for. Every entry names an
 * absolute path to the Node that wrote it, because a client started from a
 * desktop icon has no PATH to find `node` on; the cost is that a version
 * manager moves that path and every entry then points at nothing, silently.
 * That was a documented failure with no detection behind it for the whole of
 * Phase 3.
 *
 * Everything here runs against a described machine in a temporary directory.
 * Nothing reads or writes a real config, a real backup or the real log.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocumentation } from '../src/documentation.js';

import { BROKEN, diagnose, interpreterIn, NOT_ASKABLE, reportDiagnosis, SOUND } from '../src/doctor.js';
import { DatabaseSync } from 'node:sqlite';
import { beginReview, closeReview, review, submit, undoReview } from '../src/gate.js';
import { LOCAL_OWNER } from '../src/config.js';
import { listMemories, openStore } from '../src/store.js';
import { clientById } from '../src/clients.js';
import { defaultLogPath, openLog } from '../src/log.js';
import { defaultIo, install } from '../src/setup.js';

/**
 * A machine with a real temporary home and an interpreter we can delete.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [shape]
 * @param {string[]} [shape.files]
 * @param {string[]} [shape.pathDirs] relative to the temporary home
 * @param {(argv: string[]) => {status: number, stdout: string, stderr: string}} [shape.run]
 * @returns {{io: any, home: string, dir: string, interpreter: string, printed: () => string}}
 */
function machine(t, { files = [], pathDirs = [], run } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const file of files) {
    const full = path.join(home, file);
    if (file.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
  }

  const interpreter = path.join(dir, 'runtime', 'bin', 'node');
  fs.mkdirSync(path.dirname(interpreter), { recursive: true });
  fs.writeFileSync(interpreter, '');

  let printed = '';

  const io = defaultIo({
    out: (/** @type {string} */ text) => { printed += text; },
    machine: {
      home,
      platform: 'linux',
      appData: undefined,
      cwd: home,
      pathDirs: pathDirs.map((dir) => path.join(home, dir)),
      exists: (/** @type {string} */ file) => file.startsWith(home) && fs.existsSync(file),
      processes: () => [],
      readdir: (/** @type {string} */ target) => {
        if (!target.startsWith(home)) return [];
        try {
          return fs.readdirSync(target);
        } catch {
          return [];
        }
      },
    },
    backupDir: path.join(home, '.nosyparker', 'backups'),
    // Inside the temporary home like everything else. Without this the store
    // check would look at the real one in the real home directory, which no
    // test in this project may touch.
    storePath: path.join(home, '.nosyparker', 'memory.sqlite'),
    now: '2026-08-18T10:00:00.000Z',
    command: interpreter,
    serverPath: '/srv/mcp-server.js',
    log: openLog({ file: defaultLogPath(home), command: 'doctor' }),
    run,
  });

  return { io, home, dir, interpreter, printed: () => printed };
}

test('an interpreter that has gone away is found, which nothing could do before', (t) => {
  const { io, dir } = machine(t, { files: ['.gemini/'] });

  install({ ...io, out: () => {} });
  fs.rmSync(path.join(dir, 'runtime'), { recursive: true, force: true });

  const { findings } = diagnose(io);
  const gemini = findings.find((finding) => finding.client === 'gemini-cli');

  assert.equal(gemini?.state, BROKEN);
  assert.match(gemini?.says.join(' ') ?? '', /is not there any more/u);
  assert.match(gemini?.says.join(' ') ?? '', /Run setup again to rewrite it/u);
});

test('a client this never installed into is not reported at all', (t) => {
  // The half that was right: a client with no entry and no record of us having
  // put one there is somebody who has not run setup for it, or who took it out
  // on purpose. Neither is a fault.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{"mcpServers": {}}\n');

  const { findings } = diagnose(io);

  assert.equal(findings.find((finding) => finding.client === 'gemini-cli'), undefined);
});

test('a config this did install into, with the entry gone, is broken', (t) => {
  // The half that was wrong, and it is the most likely reason anybody runs this
  // command. Four ways of destroying a config all produced "Nothing is broken"
  // and an exit code of zero, with the client vanishing from the report. The
  // manifest is what tells this case from the one above, and it was already
  // being read in this function for something else.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install({ ...io, out: () => {} });
  fs.writeFileSync(settings, '{"mcpServers": {}}\n');

  const { findings } = diagnose(io);
  const gemini = findings.find((finding) => finding.client === 'gemini-cli');

  assert.equal(gemini?.state, BROKEN);
  assert.match(gemini?.says.join(' ') ?? '', /its entry is no longer in it/u);
  assert.match(gemini?.says.join(' ') ?? '', /setup` to put it back/u);
  assert.equal(reportDiagnosis(io, { findings, documents: [], store: { state: SOUND, says: [] } }), 1);
});

test('each way of losing a config gets the answer that fits it', (t) => {
  // Four different situations. Two of them are put right by running setup and
  // two are not, and saying so wrongly is worse than saying nothing: setup
  // refuses to touch a file it cannot parse, on purpose.
  /** @type {[string, (file: string) => void, RegExp, RegExp][]} */
  const cases = [
    ['the entry removed', (file) => fs.writeFileSync(file, '{"mcpServers": {}}\n'),
      /its entry is no longer in it/u, /setup` to put it back/u],
    ['the file deleted', (file) => fs.rmSync(file),
      /it is not there any more/u, /setup` to put it back/u],
    ['the file unreadable', (file) => fs.chmodSync(file, 0o000),
      /it cannot be read/u, /Check who is allowed to read that file/u],
    ['the file replaced with rubbish', (file) => fs.writeFileSync(file, 'not json at all'),
      /cannot be read as JSON any more/u, /Setup will not touch a file it cannot parse/u],
  ];

  for (const [label, damage, why, what] of cases) {
    const { io, home } = machine(t, { files: ['.gemini/'] });
    const settings = path.join(home, '.gemini', 'settings.json');

    install({ ...io, out: () => {} });
    damage(settings);

    const gemini = diagnose(io).findings.find((finding) => finding.client === 'gemini-cli');

    assert.equal(gemini?.state, BROKEN, label);
    assert.match(gemini?.says.join(' ') ?? '', why, label);
    assert.match(gemini?.says.join(' ') ?? '', what, label);

    try {
      fs.chmodSync(settings, 0o644);
    } catch {
      // already gone, which is one of the cases
    }
  }
});

test('an entry edited since we wrote it is reported, and setup is what fixes it', (t) => {
  const { io, home } = machine(t, { files: ['.gemini/'] });

  install({ ...io, out: () => {} });
  const settings = path.join(home, '.gemini', 'settings.json');
  const edited = JSON.parse(fs.readFileSync(settings, 'utf8'));
  edited.mcpServers.nosyparker.args = ['/somewhere/else.js'];
  fs.writeFileSync(settings, JSON.stringify(edited, null, 2));

  const { findings } = diagnose(io);
  const gemini = findings.find((finding) => finding.client === 'gemini-cli');

  assert.equal(gemini?.state, BROKEN);
  assert.match(gemini?.says.join(' ') ?? '', /not the one setup would write now/u);
});

test('a client that cannot be asked is said to be not askable, never fine', (t) => {
  const { io } = machine(t, { files: ['.local/bin/zed', '.config/zed/'] });

  install({ ...io, out: () => {} });
  const { findings } = diagnose(io);
  const zed = findings.find((finding) => finding.client === 'zed');

  assert.equal(zed?.state, NOT_ASKABLE);
  assert.match(zed?.says.join(' ') ?? '', /offers no way to ask/u);

  // The distinction that matters: it says what it cannot tell you, rather than
  // telling you the thing is fine. Both sentences contain the word "working";
  // only one of them claims it.
  assert.match(zed?.says.join(' ') ?? '', /cannot tell you/u);
  assert.notEqual(zed?.state, SOUND);
});

test('a client that answers is reported in the words setup already uses', (t) => {
  const { io } = machine(t, {
    files: ['.local/bin/goose', '.config/goose/'],
    run: () => ({ status: 0, stdout: '  extensions:\n    nosyparker:\n      enabled: true\n', stderr: '' }),
  });

  const wired = { ...io, machine: { ...io.machine, pathDirs: [path.join(io.machine.home, '.local', 'bin')] } };
  install({ ...wired, out: () => {} });

  const { findings } = diagnose(wired);
  const goose = findings.find((finding) => finding.client === 'goose');

  assert.equal(goose?.state, SOUND);
  assert.match(goose?.says.join(' ') ?? '', /read its own config back/u);
});

test('it changes nothing on disk', (t) => {
  const { io, home } = machine(t, { files: ['.gemini/', '.cursor/'] });

  install({ ...io, out: () => {} });

  /** @param {string} dir @returns {Record<string, string>} */
  const snapshot = (dir) => {
    /** @type {Record<string, string>} */
    const seen = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const full = path.join(entry.parentPath ?? dir, entry.name);
      if (entry.isFile() && !full.includes('actions.log')) seen[full] = fs.readFileSync(full, 'utf8');
    }
    return seen;
  };

  const before = snapshot(home);
  diagnose(io);
  const after = snapshot(home);

  // Everything except our own log, which is the record that it ran and is not
  // a change to anything of anybody else's.
  assert.deepEqual(after, before);
});

test('it says it ran, and what it found, in the log', (t) => {
  const { io, home } = machine(t, { files: ['.gemini/'] });

  install({ ...io, out: () => {} });
  diagnose(io);

  const lines = fs.readFileSync(defaultLogPath(home), 'utf8').trim().split('\n');
  const mine = lines.filter((line) => line.includes('  doctor '));

  assert.ok(mine.some((line) => line.includes('  run ')), 'it did not record that it ran');
  assert.ok(mine.some((line) => line.includes('  check ') && line.includes('client=gemini-cli')));
  assert.ok(mine.some((line) => line.includes('  done ')));
});

test('the exit code is nothing-is-wrong, not is-everything-installed', (t) => {
  // Somebody may put this in a shell prompt or a cron line. A client that
  // cannot be asked is the ordinary state of most of them, so exiting non-zero
  // for that would make the code mean "you have clients" instead.
  const { io } = machine(t, { files: ['.local/bin/zed', '.config/zed/'] });

  install({ ...io, out: () => {} });
  assert.equal(reportDiagnosis(io, diagnose(io)), 0, 'not askable is not a failure');

  fs.rmSync(path.join(io.machine.home, '..', 'runtime'), { recursive: true, force: true });
  assert.equal(reportDiagnosis(io, diagnose(io)), 1, 'a broken entry is');
});

test('with nothing installed it says so rather than saying all is well', (t) => {
  const { io, printed } = machine(t, {});

  const code = reportDiagnosis(io, diagnose(io));

  assert.match(printed(), /No client on this machine has an entry for nosyparker\./u);
  assert.equal(code, 0);
});

test('the interpreter is read back out of every format it can be', () => {
  const entry = { command: '/opt/node/bin/node', args: ['/srv/mcp-server.js'] };

  assert.equal(
    interpreterIn(JSON.stringify({ mcpServers: { nosyparker: entry } }), clientById('gemini-cli'), 'nosyparker'),
    '/opt/node/bin/node',
  );

  // opencode holds the program and its arguments in one array.
  assert.equal(
    interpreterIn(
      JSON.stringify({ mcp: { nosyparker: { type: 'local', command: ['/opt/node/bin/node', '/srv/mcp-server.js'] } } }),
      clientById('opencode'), 'nosyparker',
    ),
    '/opt/node/bin/node',
  );

  // Goose says cmd, in YAML, which has no parser here — so it is found by
  // search rather than by parsing.
  assert.equal(
    interpreterIn('extensions:\n  nosyparker:\n    cmd: /opt/node/bin/node\n', clientById('goose'), 'nosyparker'),
    '/opt/node/bin/node',
  );

  // Codex is TOML, written by its own command.
  assert.equal(
    interpreterIn('[mcp_servers.nosyparker]\ncommand = "/opt/node/bin/node"\n', clientById('codex-cli'), 'nosyparker'),
    '/opt/node/bin/node',
  );

  // And something it cannot read is null, which is reported as unchecked
  // rather than as sound.
  assert.equal(interpreterIn('{ not json', clientById('gemini-cli'), 'nosyparker'), null);
});

test('a client whose own command writes the file is not judged on our formatting', (t) => {
  // Both halves of this were found by running the command on a real machine
  // with 335 tests green, and the first was hiding the second.
  //
  // Codex's file is TOML, which this project has no writer for, so asking "is
  // this what setup would write" threw and took the whole command down. And
  // behind that: every client written through its own command would have been
  // called broken, because their commands write their own formatting — VS Code
  // uses tabs and adds an `inputs` key — and comparing that against our own
  // serialiser can only ever differ.
  const { io, home, interpreter } = machine(t, {
    files: ['.codex/', '.config/Code/User/', '.local/bin/code'],
    pathDirs: ['.local/bin'],
  });

  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    `[mcp_servers.nosyparker]\ncommand = "${interpreter}"\nargs = ["/srv/mcp-server.js"]\n`);

  // Exactly the shape VS Code's own --add-mcp produces, tabs and all.
  fs.writeFileSync(path.join(home, '.config', 'Code', 'User', 'mcp.json'),
    `{\n\t"servers": {\n\t\t"nosyparker": {\n\t\t\t"type": "stdio",\n\t\t\t"command": "${interpreter}",\n\t\t\t"args": [\n\t\t\t\t"/srv/mcp-server.js"\n\t\t\t]\n\t\t}\n\t},\n\t"inputs": []\n}`);

  const { findings } = diagnose(io);

  for (const id of ['codex-cli', 'vscode']) {
    const finding = findings.find((candidate) => candidate.client === id);
    assert.ok(finding, `${id} was not looked at`);
    assert.notEqual(finding.state, BROKEN, `${id} was called broken over its own formatting`);
    assert.match(finding.says.join(' '), /writes this file with its own command/u);
  }
});

test('a client written by its own command is still checked for a missing interpreter', (t) => {
  // Not judging their formatting is not the same as not checking them. The one
  // failure this command exists for applies to them too.
  const { io, home, dir, interpreter } = machine(t, { files: ['.codex/'] });

  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    `[mcp_servers.nosyparker]\ncommand = "${interpreter}"\nargs = ["/srv/mcp-server.js"]\n`);
  fs.rmSync(path.join(dir, 'runtime'), { recursive: true, force: true });

  const codex = diagnose(io).findings.find((finding) => finding.client === 'codex-cli');

  assert.equal(codex?.state, BROKEN);
  assert.match(codex?.says.join(' ') ?? '', /is not there any more/u);
});

test('a config that has stopped being a link is seen, which contents cannot show', (t) => {
  // The second half of the symlink defect, and the shape both blind spots
  // share: doctor compares contents against a record, and something that
  // changes the *path* leaves contents that look perfect. The file it reads
  // does contain the entry — it is just no longer the file the person's
  // dotfiles repository is looking at.
  const { io, home } = machine(t, { files: ['.cursor/', 'dotfiles/'] });
  const real = path.join(home, 'dotfiles', 'cursor.json');
  const link = path.join(home, '.cursor', 'mcp.json');

  fs.writeFileSync(real, '{"mcpServers": {}}\n');
  fs.symlinkSync(real, link);

  install({ ...io, out: () => {} });
  // Cursor cannot be asked anything, so the most it ever reaches is
  // not-askable. What matters is that it is not broken.
  assert.notEqual(diagnose(io).findings.find((f) => f.client === 'cursor')?.state, BROKEN);

  // Something replaces the link with a plain copy — an older version of this
  // did exactly that.
  const content = fs.readFileSync(link, 'utf8');
  fs.rmSync(link);
  fs.writeFileSync(link, content);

  const cursor = diagnose(io).findings.find((finding) => finding.client === 'cursor');

  assert.equal(cursor?.state, BROKEN);
  assert.match(cursor?.says.join(' ') ?? '', /used to point at/u);
  assert.match(cursor?.says.join(' ') ?? '', /it is a plain file now/u);
  assert.match(cursor?.says.join(' ') ?? '', new RegExp(real.replaceAll('/', '\\/'), 'u'));
});

test('a directory where the config should be is not called a permissions problem', (t) => {
  // Every read failure was mapped to "check who is allowed to read that file",
  // which sends somebody to look at permissions that are fine.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install({ ...io, out: () => {} });
  fs.rmSync(settings);
  fs.mkdirSync(settings);

  const gemini = diagnose(io).findings.find((finding) => finding.client === 'gemini-cli');

  assert.equal(gemini?.state, BROKEN);
  assert.match(gemini?.says.join(' ') ?? '', /there is a directory there now, not a file/u);
  assert.doesNotMatch(gemini?.says.join(' ') ?? '', /who is allowed to read/u);
});

test('an entry with no interpreter in it says that, rather than blaming the format', (t) => {
  // The format read perfectly well. It is the entry that has nothing this can
  // check, and that is the check that matters most here.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install({ ...io, out: () => {} });
  fs.writeFileSync(settings, JSON.stringify({ mcpServers: { nosyparker: { args: ['/srv/mcp-server.js'] } } }, null, 2));

  const gemini = diagnose(io).findings.find((finding) => finding.client === 'gemini-cli');

  assert.match(gemini?.says.join(' ') ?? '', /has no interpreter in it that this can read/u);
  assert.doesNotMatch(gemini?.says.join(' ') ?? '', /back out of json/u);
});

test('a format with no parser here says so in its own name, in capitals', (t) => {
  const { io, home } = machine(t, { files: ['.codex/'] });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    '[mcp_servers.nosyparker]\nargs = ["/srv/mcp-server.js"]\n');

  install({ ...io, out: () => {} });
  const codex = diagnose(io).findings.find((finding) => finding.client === 'codex-cli');

  assert.match(codex?.says.join(' ') ?? '', /cannot read an interpreter back out of TOML/u);
});

// ---------------------------------------------------------------------------
// The memory store, which this command reads and never writes.
// ---------------------------------------------------------------------------

test('asking after the store does not create it', (t) => {
  const { io, home } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  const { store } = diagnose(io);

  assert.equal(fs.existsSync(file), false, 'diagnose created a memory store');
  assert.equal(store.state, NOT_ASKABLE);
  assert.match(store.says.join(' '), /no memory store at/u);
  assert.equal(reportDiagnosis(io, diagnose(io)), 0, 'no store yet is not a fault');
});

test('a store this version cannot open is reported, in the sentence the store gives', (t) => {
  const { io, home, printed } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // A file from before Phase 4: it has a memories table, so it is not a new
  // store, and it says it was written at schema version 1. This is what
  // somebody who has just updated has on disk, and this command is the first
  // one they will run.
  const older = new DatabaseSync(file);
  older.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY)');
  older.exec('PRAGMA user_version = 1');
  older.close();

  const { store } = diagnose(io);

  assert.equal(store.state, BROKEN);
  assert.match(store.says.join(' '), /written by an older version/u);
  assert.match(store.says.join(' '), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.equal(reportDiagnosis(io, diagnose(io)), 1);

  // First on the page, ahead of every client. Somebody who has just updated
  // runs this to find out why nothing works, and that sentence was at the
  // bottom under twenty clients they were not asking about.
  reportDiagnosis(io, diagnose(io));
  const page = printed();
  assert.ok(
    page.indexOf('The memory store:') < page.indexOf('No client on this machine'),
    'the store problem should be the first thing on the page',
  );
});

test('a review left open is reported, and is not called a fault', (t) => {
  const { io, home, printed } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  const store = openStore({ file, now: () => '2026-08-18T09:00:00.000Z' });
  beginReview(store, { owner: LOCAL_OWNER, reviewer: 'an agent that then stopped' });
  store.close();

  const result = diagnose(io);

  assert.equal(result.store.state, SOUND);
  assert.match(result.store.says.join(' '), /1 review is still open/u);
  assert.match(result.store.says.join(' '), /an agent that then stopped/u);

  // The honest part. This cannot tell an abandoned review from one in progress,
  // so it says both and does not turn the exit code red for it.
  assert.match(result.store.says.join(' '), /Nothing here can tell those apart/u);
  assert.equal(reportDiagnosis(io, result), 0);
  assert.match(printed(), /The memory store:/u);
  assert.match(printed(), /undo-review/u);
});

test('a closed review is not an open one', (t) => {
  const { io, home } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  const store = openStore({ file, now: () => '2026-08-18T09:00:00.000Z' });
  const started = beginReview(store, { owner: LOCAL_OWNER, reviewer: 'an agent' });
  closeReview(store, { owner: LOCAL_OWNER, pass: /** @type {number} */ (started.pass_id) });
  store.close();

  const { store: checked } = diagnose(io);

  assert.equal(checked.state, SOUND);
  assert.match(checked.says.join(' '), /No review is open/u);
});

/**
 * Store `count` memories and archive `archive` of them in one review.
 *
 * @param {string} file
 * @param {number} count
 * @param {number} archive
 * @returns {import('../src/gate.js').GateResult}
 */
function reviewedStore(file, count, archive) {
  let clock = Date.parse('2026-08-18T09:00:00.000Z');
  const store = openStore({ file, now: () => new Date(clock).toISOString() });

  try {
    for (let n = 1; n <= count; n += 1) {
      clock += 1000;
      submit(store, { owner: LOCAL_OWNER, text: `A fact about me, number ${n}` });
    }

    clock += 1000;
    const pass = /** @type {number} */ (
      beginReview(store, { owner: LOCAL_OWNER, reviewer: 'an agent with a plausible reason' }).pass_id
    );

    for (const memory of listMemories(store, LOCAL_OWNER).slice(0, archive)) {
      clock += 1000;
      review(store, {
        owner: LOCAL_OWNER,
        pass,
        id: memory.id,
        outcome: 'overtaken',
        reasoning: 'This reads as something that was true at the time and is not obviously current.',
        derivedFrom: [memory.id],
      });
    }

    clock += 1000;
    return closeReview(store, { owner: LOCAL_OWNER, pass });
  } finally {
    store.close();
  }
}

test('a review that took the whole store is said out loud, and is still not called a fault', (t) => {
  const { io, home, printed } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  // The review's own output first. This is the scenario that decided the
  // reviewer's answer to "would you let this run unattended": forty memories
  // out of forty, plausible reasons, one agent, and the pass closed cleanly.
  const closed = reviewedStore(file, 40, 40);
  assert.match(closed.explanation, /changed 40 memories/u);
  assert.match(closed.explanation, /Nothing is being shown now/u);

  const { store } = diagnose(io);
  const said = store.says.join(' ');

  // What this command used to say about all of that was "the memory store
  // opens, and no review is open".
  assert.match(said, /Review 1, by "an agent with a plausible reason"/u);
  assert.match(said, /put away 40 memories/u);
  assert.match(said, /Nothing is being shown now/u);
  assert.match(said, /moved most of this store in one go/u);
  assert.match(said, /undo-review 1/u);

  // Reported, not judged. Somebody may have asked for exactly this, and a
  // command that went red for it would be red for good afterwards — which is a
  // command nobody reads.
  assert.equal(store.state, SOUND);
  assert.equal(reportDiagnosis(io, diagnose(io)), 0);
  assert.match(printed(), /worth seeing rather than because anything is wrong/u);
});

test('an ordinary tidy-up is reported without the sentence about most of the store', (t) => {
  const { io, home } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  reviewedStore(file, 20, 2);
  const said = diagnose(io).store.says.join(' ');

  assert.match(said, /put away 2 memories/u);
  assert.match(said, /18 memories are being shown now/u);
  assert.match(said, /undo-review 1` puts it back/u);
  assert.doesNotMatch(said, /most of this store/u);
});

test('a review that has been put back is not something to tell anybody about', (t) => {
  const { io, home } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  reviewedStore(file, 20, 20);

  const store = openStore({ file, now: () => '2026-08-19T09:00:00.000Z' });
  undoReview(store, { owner: LOCAL_OWNER, pass: 1 });
  store.close();

  const said = diagnose(io).store.says.join(' ');
  assert.match(said, /No review has changed anything that is still standing/u);
  assert.doesNotMatch(said, /Review 1/u);
});

test('when there are more reviews than it will show, it says how many it left out', (t) => {
  const { io, home } = machine(t);
  const file = path.join(home, '.nosyparker', 'memory.sqlite');

  // Seven reviews, each archiving one memory. A report that quietly stopped at
  // five would be the shape `listDecisions` refuses to have: a caller unable to
  // tell a complete answer from a shortened one.
  let clock = Date.parse('2026-08-18T09:00:00.000Z');
  const store = openStore({ file, now: () => new Date(clock).toISOString() });
  for (let n = 1; n <= 7; n += 1) {
    clock += 1000;
    const id = /** @type {number} */ (
      submit(store, { owner: LOCAL_OWNER, text: `A fact about me, number ${n}` }).memory_id
    );
    clock += 1000;
    const pass = /** @type {number} */ (
      beginReview(store, { owner: LOCAL_OWNER, reviewer: `agent ${n}` }).pass_id
    );
    clock += 1000;
    review(store, { owner: LOCAL_OWNER, pass, id, outcome: 'overtaken',
      reasoning: 'the moment this named has gone by', derivedFrom: [id] });
    clock += 1000;
    closeReview(store, { owner: LOCAL_OWNER, pass });
  }
  store.close();

  const said = diagnose(io).store.says.join(' ');
  assert.match(said, /2 older reviews are not shown here/u);
  assert.match(said, /log` has every one of them/u);

  // Newest first, so the five it does show are the recent ones.
  assert.match(said, /agent 7/u);
  assert.doesNotMatch(said, /agent 1"/u);
});

test('doctor sees an entry in a file the client wrote for itself', (t) => {
  // `alsoRemoveFrom` is new in this branch, and `doctor` was never taught about
  // it. So with a live entry in `~/.config/Cursor/User/settings.json`, doctor
  // said "No client on this machine has an entry for nosyparker" and exited 0
  // while uninstall removed one from that very file. Two commands reading the
  // same table and contradicting each other, in the one whose whole job is
  // telling the truth about the machine.
  const { io, home, printed } = machine(t);

  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(theirs, '{\n\t"mcp": { "servers": { "nosyparker": { "command": "/usr/bin/node" } } }\n}\n');

  // Wired in its primary file too, which is the ordinary case and the one the
  // first version of this fixture left out. With only the second surface there
  // was exactly one finding, so counting it twice and counting it once looked
  // identical and the double-count below was invisible from here.
  const primary = path.join(home, '.cursor', 'mcp.json');
  fs.writeFileSync(primary,
    '{\n  "mcpServers": { "nosyparker": { "command": "/usr/bin/node" } }\n}\n');

  const found = diagnose(io);
  reportDiagnosis(io, found);

  const said = printed();
  assert.doesNotMatch(said, /No client on this machine has an entry/u,
    'it said nothing is set up while an entry was sitting there');
  assert.match(said, /settings\.json/u, 'the file holding the entry is not named');
  assert.match(said, /Cursor/u);

  // One client, wired in two of its files, is one client. It was two findings
  // under the same id, so the headline said eight clients were set up on a
  // machine with seven, and `log.record('done', {checked})` was inflated with
  // it.
  assert.equal(found.findings.filter((finding) => finding.client === 'cursor').length, 1,
    'Cursor is reported twice because it is wired in two of its own files');
  assert.match(said, /settings\.json/u);
  assert.equal((said.match(/^ {2}Cursor$/gmu) ?? []).length, 1,
    'Cursor is listed more than once in the report');

  // Read-only, like the rest of the command.
  assert.match(fs.readFileSync(theirs, 'utf8'), /nosyparker/u, 'doctor changed something');
});

test('doctor does not read a working note of ours', (t) => {
  // A third review called this creep and was right. `doctor` is a shipped
  // command; making what it reports depend on WINDOWS.md — a note that is
  // deliberately not in the package — means it behaves one way from a clone and
  // another from an install, for a reason the person running it cannot see.
  //
  // This edited the tracked WINDOWS.md and put it back in an `after` hook, and
  // a fifth review pulled that forward as a tomorrow problem: that file is the
  // run sheet a Windows session follows literally, on the platform where a
  // mid-run kill is most likely, and a suite that dies between the write and
  // the hook leaves a corrupted brief in the working tree of the session
  // reading it. The line it appended was itself a stale `node src/cli.js`
  // instruction — the exact wording we swept the documents of.
  //
  // So it runs on a copy. The question is the same one: with the note present
  // and stale, does the check read it when nobody asked it to?
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-note-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const real = fileURLToPath(new URL('..', import.meta.url));
  for (const name of ['CLIENTS.md', 'README.md', 'CONNECTING.md', 'DECISIONS.md', 'package.json']) {
    fs.copyFileSync(path.join(real, name), path.join(root, name));
  }
  for (const dir of ['src', 'scripts']) {
    fs.cpSync(path.join(real, dir), path.join(root, dir), { recursive: true });
  }

  fs.writeFileSync(path.join(root, 'WINDOWS.md'),
    'Run `node src/cli.js doctor` on the Windows side.\n');

  /** @param {string[]} [notes] */
  const noticed = (notes) => checkDocumentation(root, notes)
    .filter((check) => !check.ok)
    .flatMap((check) => check.wrong)
    .filter((wrong) => wrong.includes('WINDOWS.md'));

  // What doctor passes: nothing. The note is right there, and stale, and no
  // check goes near it.
  assert.deepEqual(noticed(), [],
    'the checks read a working note when the caller did not ask for it');

  // And the suite still gets what it asks for, so the rule is kept rather than
  // deleted — this is the half that would make the assertion above vacuous.
  assert.equal(noticed(['WINDOWS.md']).length, 1,
    'passing the note in no longer reads it, so the check above proves nothing');

  // Read-only against the real repository: whatever is in the working tree,
  // doctor never names it.
  const { io, printed } = machine(t);
  reportDiagnosis(io, diagnose(io));
  assert.doesNotMatch(printed(), /WINDOWS\.md/u, 'doctor named a note we keep for ourselves');

  // Nothing of ours was written outside the copy.
  assert.equal(
    fs.readFileSync(path.join(real, 'WINDOWS.md'), 'utf8').includes('on the Windows side'), false,
    'the test wrote into the tracked run sheet');
});
test('doctor does not tell somebody their settings hold an entry that is not there', (t) => {
  // Round two, finding four, reproduced inside the code written to close round
  // two, finding eleven. Deleting the `hasEntry` check from `secondSurfacesOf`
  // left all 455 tests green, and with it gone doctor tells every Cursor user
  // that `settings.json` has our entry in it when it holds a font size.
  //
  // The same shape as the line in `cleanSecondSurfaces` that guards uninstall
  // against rewriting that file: the surface exists, and that is not the same
  // as our entry being in it.
  const { io, home, printed } = machine(t);

  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(theirs, '{\n\t"editor.fontSize": 13\n}\n');

  reportDiagnosis(io, diagnose(io));

  assert.doesNotMatch(printed(), /settings\.json/u,
    'doctor named a file of theirs that holds nothing of ours');
});
