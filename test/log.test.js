/**
 * The action log.
 *
 * Two of these tests are about things not happening — a secret not reaching the
 * file, and a broken log not breaking the command — and those are the ones that
 * matter. The rest is format, which matters only because a record nobody can
 * read is not a record.
 *
 * Nothing here writes to the real log. Every path is a temporary directory, and
 * the io helper that carries a real log is a separate function from the one the
 * tests use, so a log cannot be acquired here by forgetting to ask.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultLogPath, LOG_NAME, noLog, openLog } from '../src/log.js';
import { defaultIo, install, uninstall } from '../src/setup.js';

/**
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A described machine with a real temporary home, and a log pointed into it.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [shape]
 * @param {string[]} [shape.files]
 * @param {Record<string, string>} [shape.contents]
 * @returns {{io: any, home: string, logFile: string, lines: () => string[]}}
 */
function machine(t, { files = [], contents = {} } = {}) {
  const dir = directory(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  for (const file of files) {
    const full = path.join(home, file);
    if (file.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents[file] ?? '');
    }
  }

  const logFile = defaultLogPath(home);

  const io = defaultIo({
    out: () => {},
    machine: {
      home,
      platform: 'linux',
      appData: undefined,
      cwd: home,
      pathDirs: [],
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
    now: '2026-08-18T10:00:00.000Z',
    command: '/usr/bin/node',
    serverPath: '/srv/mcp-server.js',
    log: openLog({ file: logFile, command: 'setup', runId: 'aa11bb' }),
  });

  return {
    io,
    home,
    logFile,
    lines: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []),
  };
}

test('every file this touches is in the log, by its full path', (t) => {
  const { io, home, lines } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install(io);

  const events = lines().map((line) => line.split(/\s{2,}/u)[3]);
  for (const wanted of ['run', 'detect', 'read', 'backup', 'wrote', 'verify', 'done']) {
    assert.ok(events.includes(wanted), `nothing recorded a ${wanted}`);
  }

  // The path, in full, on the line that says we wrote.
  const wrote = lines().find((line) => line.includes('  wrote  '));
  assert.ok(wrote?.includes(`path=${settings}`), `the write did not name the file: ${wrote}`);
  assert.match(/** @type {string} */ (wrote), /outcome=written/u);
});

test('a file removed or deleted is recorded too, with which it was', (t) => {
  const { io, home, lines } = machine(t, { files: ['.gemini/'] });

  install(io);
  const removing = { ...io, log: openLog({ file: defaultLogPath(home), command: 'uninstall', runId: 'cc22dd' }) };
  uninstall(removing);

  const text = lines().join('\n');
  assert.match(text, /uninstall {2}removed .*client=gemini-cli/u);
  assert.match(text, /uninstall {2}deleted .*what=file/u);
});

test('nothing that was in one of those files reaches the log', (t) => {
  // Every one of these configs is allowed to hold an API key in an env block.
  // The log records what was touched, never what was in it.
  const secret = 'sk-live-51H8vQe2NEVERLOGME';
  const { io, home, logFile } = machine(t, {
    files: ['.cursor/mcp.json'],
    contents: {
      '.cursor/mcp.json': JSON.stringify({
        mcpServers: { theirs: { command: 'x', env: { API_KEY: secret } } },
      }, null, 2),
    },
  });

  install(io);
  const removing = { ...io, log: openLog({ file: defaultLogPath(home), command: 'uninstall' }) };
  uninstall(removing);

  const written = fs.readFileSync(logFile, 'utf8');

  assert.equal(written.includes(secret), false, 'the log carries a key out of a config file');
  assert.equal(written.includes('API_KEY'), false, 'the log carries the name of one');

  // And the file itself still has it, so the test is about the log rather than
  // about the key having been destroyed.
  assert.ok(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8').includes(secret));
});

test('a log that cannot be written does not stop the command', (t) => {
  // A log that can break `setup` is worse than no log. This makes the log
  // unwritable in the most direct way there is: a directory where the file goes.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  fs.mkdirSync(defaultLogPath(home), { recursive: true });

  const outcomes = install(io);

  assert.equal(outcomes.find((outcome) => outcome.client.id === 'gemini-cli')?.written?.outcome, 'written');
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'settings.json')), true, 'the install still happened');
});

test('a second run appends, and never rewrites what the first one said', (t) => {
  const { io, home, lines } = machine(t, { files: ['.gemini/'] });

  install(io);
  const first = lines();
  assert.ok(first.length > 0);

  const second = { ...io, log: openLog({ file: defaultLogPath(home), command: 'setup', runId: 'ff99ee' }) };
  install(second);

  const after = lines();
  assert.deepEqual(after.slice(0, first.length), first, 'the first run\'s lines are untouched');
  assert.ok(after.length > first.length, 'the second run added its own');

  // Two runs, two run ids, so a week later somebody can tell them apart.
  assert.deepEqual([...new Set(after.map((line) => line.split(/\s{2,}/u)[1]))].sort(), ['aa11bb', 'ff99ee']);
});

test('a line is one line, readable and parseable, whatever is in the fields', (t) => {
  const dir = directory(t);
  const file = path.join(dir, LOG_NAME);
  const log = openLog({ file, command: 'setup', runId: 'a1b2c3', now: () => '2026-08-18T12:00:00.000Z' });

  log.record('wrote', { client: 'cursor', path: '/home/p/my configs/mcp.json', bytes: 312, ok: true });
  log.record('failed', { note: 'two\nlines\rbecome one' });

  const [first, second] = fs.readFileSync(file, 'utf8').trim().split('\n');

  assert.equal(
    first,
    '2026-08-18T12:00:00.000Z  a1b2c3  setup      wrote        client=cursor path="/home/p/my configs/mcp.json" bytes=312 ok=true',
  );

  // One event is one line. A value that could break that would break the format
  // for every reader after it.
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.match(second, /note="two lines become one"/u);
});

test('a field with nothing in it is left out rather than written empty', (t) => {
  const file = path.join(directory(t), LOG_NAME);
  const log = openLog({ file, command: 'doctor', now: () => '2026-08-18T12:00:00.000Z' });

  log.record('detect', { client: 'zed', path: undefined, command: null, state: 'not-installed' });

  const line = fs.readFileSync(file, 'utf8').trim();
  assert.match(line, /client=zed state=not-installed$/u);
  assert.doesNotMatch(line, /path=|command=/u);
});

test('the log is private, like the files it is about', (t) => {
  const file = path.join(directory(t), LOG_NAME);
  openLog({ file, command: 'setup' }).record('run', {});

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a log nobody asked for writes nothing anywhere', () => {
  const quiet = noLog();

  quiet.record('wrote', { path: '/tmp/should-never-exist' });

  assert.equal(quiet.file, '');
  assert.equal(fs.existsSync('/tmp/should-never-exist'), false);
});

test('it lives beside the store and is not the store', (t) => {
  const { home } = machine(t, {});

  assert.equal(defaultLogPath(home), path.join(home, '.nosyparker', LOG_NAME));
  assert.notEqual(LOG_NAME, 'memory.sqlite');
});
