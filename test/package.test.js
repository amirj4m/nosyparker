/**
 * What actually goes in the tarball.
 *
 * Asked of `npm pack` rather than worked out from `package.json`, because the
 * rules for what npm includes are npm's — a whitelist, plus files it adds
 * whatever you say, plus files it removes whatever you say — and a test that
 * reimplemented them would be checking a model of the thing rather than the
 * thing. This runs the real command and reads the real list.
 *
 * It exists because of a defect that was one commit from shipping. `doctor`
 * runs the documentation checks, and those read CLIENTS.md, CONNECTING.md,
 * DECISIONS.md and README.md off disk at run time. A `files` list chosen for
 * what a user "needs to read" leaves three of those out, the package installs
 * cleanly, every other command works, and `doctor` crashes with ENOENT on a
 * document nobody thought was part of the program.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The paths npm would publish, from npm.
 *
 * @returns {Set<string>}
 */
function packed() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Set(JSON.parse(out)[0].files.map((/** @type {{path: string}} */ f) => f.path));
}

test('everything the program reads at run time is in the package', () => {
  const inside = packed();

  // Read out of the source rather than listed here. A fifth document added to
  // the checks is covered the day it is added, which is the half of this that
  // a written-out list would not do.
  const documents = [...fs.readFileSync(path.join(ROOT, 'src/documentation.js'), 'utf8')
    .matchAll(/\bread\('([^']+)'\)/gu)].map((match) => match[1]);

  assert.ok(documents.length >= 4, 'no documents were found in documentation.js');

  for (const document of documents) {
    assert.ok(inside.has(document),
      `${document} is read at run time and is not in the package, so doctor will fail on it`);
  }
});

test('every way in is in the package', () => {
  const inside = packed();

  for (const entry of [
    'src/cli.js',
    'src/mcp-server.js',
    'src/clients.json',
    'scripts/purge.mjs',
    'scripts/purge-main.mjs',
    'package.json',
    'README.md',
    'LICENSE',
  ]) {
    assert.ok(inside.has(entry), `${entry} is not in the package`);
  }
});

test('what is ours rather than theirs stays out of the package', () => {
  const inside = packed();
  const shipped = [...inside];

  // 1,206 lines of frozen research, a test suite, a vendored copy of somebody
  // else's table and a CI workflow. All of them belong in the repository and
  // none of them belongs on the disk of a person who wanted a memory store.
  assert.equal(inside.has('PHASE3-RESEARCH.md'), false);
  assert.equal(shipped.some((file) => file.startsWith('test/')), false, 'the test suite is in the package');
  assert.equal(shipped.some((file) => file.startsWith('vendor/')), false);
  assert.equal(shipped.some((file) => file.startsWith('.github/')), false);
  assert.equal(inside.has('scripts/drift.mjs'), false, 'the drift watcher is ours, not theirs');
  assert.equal(inside.has('tsconfig.json'), false);
});
