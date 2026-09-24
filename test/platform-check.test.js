/**
 * The run-sheet script: it reads, it prints, it writes nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { loadClients } from '../src/clients.js';
import { sandboxEnv } from './helpers.js';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'platform-check.mjs');

/**
 * @param {import('node:test').TestContext} t
 * @returns {{home: string, run: (args: string[]) => {status: number|null, out: string, err: string}}}
 */
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-platform-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (/** @type {string[]} */ args) => {
    const ran = spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], {
      encoding: 'utf8',
      // An empty PATH, so nothing installed on the machine running the tests
      // is found; the fake home is the whole machine.
      env: { ...sandboxEnv(home), PATH: '' },
    });
    return { status: ran.status, out: ran.stdout, err: ran.stderr };
  };
  return { home, run };
}

test('the template names every row, and says which have no path on this platform', (t) => {
  const { run } = sandbox(t);
  const { status, out } = run(['--template']);
  assert.equal(status, 0);
  for (const client of loadClients().clients) {
    assert.match(out, new RegExp(`^\\| \`${client.id}\` \\|`, 'mu'), `${client.id} is missing from the template`);
    if (client.configPaths[process.platform] === null) {
      assert.match(out, new RegExp(`\`${client.id}\` \\| — \\| no path in table`, 'u'));
    }
  }
});

test('before setup it reports what is here and where each row would write, and touches nothing', (t) => {
  const { home, run } = sandbox(t);
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const before = fs.readdirSync(home);

  const { status, out } = run(['--before']);
  assert.equal(status, 0);
  assert.match(out, /## Gemini CLI {2}\(gemini-cli\)/u);
  assert.match(out, /detected: {4}installed-no-config/u);
  assert.match(out, /table path: {2}.*\.gemini.settings\.json/u);
  assert.match(out, /Next: .*nosyparker setup/u);

  assert.deepEqual(fs.readdirSync(home), before, 'the script wrote something into the home');
  assert.equal(fs.existsSync(path.join(home, '.nosyparker')), false, 'the script created our folder');
});

test('after setup it says whether the entry landed, and after uninstall whether it is gone', (t) => {
  const { home, run } = sandbox(t);
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });

  // The file as setup writes it, naming this interpreter.
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
    mcpServers: { nosyparker: { command: process.execPath, args: ['/srv/mcp-server.js'] } },
  }));
  const wired = run(['--after-setup']);
  assert.equal(wired.status, 0);
  assert.match(wired.out, /ok {4}entry present, names .*\(exists\)/u);
  assert.match(wired.out, /gemini-cli {7}entry written/u);

  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{"mcpServers": {}}');
  const cleaned = run(['--after-uninstall']);
  assert.match(cleaned.out, /ok {4}no entry of ours/u);
  const notCleaned = run(['--after-setup']);
  assert.match(notCleaned.out, /FAIL {2}our entry is not in/u);
});

test('a mode it does not have is refused, and the script is not in the package', (t) => {
  const { run } = sandbox(t);
  const { status, err } = run(['--nope']);
  assert.equal(status, 1);
  assert.match(err, /--after-setup/u);

  const packed = JSON.parse(spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout);
  const first = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  assert.equal(first.files.some((/** @type {{path: string}} */ f) => f.path === 'scripts/platform-check.mjs'), false,
    'the run-sheet script is ours and shipped anyway');
});
