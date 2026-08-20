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

test('a working document of ours does not ship to people who wanted a memory store', () => {
  // WINDOWS.md is a brief for a session that will run on the other half of a
  // dual-boot laptop. It names our commit, our unverified table columns and the
  // things we have not measured yet — a note between the people building this,
  // and noise on the disk of somebody who installed a memory store.
  //
  // Listed by exclusion rather than by name, so the next working document is
  // covered on the day it is written rather than the day somebody remembers.
  // `files` is a whitelist, so this holds by default: the point of the test is
  // that widening `files` to a glob cannot quietly take our notes with it.
  const shipped = [...packed()].filter((file) => file.endsWith('.md'));
  const meantToShip = ['README.md', 'CLIENTS.md', 'CONNECTING.md', 'DECISIONS.md'];

  assert.deepEqual(shipped.filter((file) => !meantToShip.includes(file)), [],
    'a markdown file that is ours rather than theirs is in the package');

  // And it is here to be excluded, rather than absent and trivially passing.
  assert.ok(fs.existsSync(path.join(ROOT, 'WINDOWS.md')), 'WINDOWS.md is gone');
});

test('nothing in the package names the machine it was built on', () => {
  // A reviewer appended `const LEAK = '/home/amirjam/…'` to `src/config.js` and
  // nothing fired. Every absolute path this program uses is worked out at run
  // time from the machine it is on; one written down instead would be wrong for
  // everybody who installed it, and would also tell them the name of somebody's
  // home directory. Both of those are worth a line.
  //
  // Checked against the files npm would actually ship, not against `src/`, so a
  // document or a script added to the package is covered by the same rule.
  const inside = [...packed()];
  /** @type {string[]} */
  const leaks = [];

  for (const file of inside) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const shape of [/\/home\/[a-z][\w.-]*/iu, /\/Users\/[A-Za-z][\w.-]*/u, /[A-Z]:\\Users\\/u]) {
      const found = shape.exec(text);
      if (found !== null) leaks.push(`${file}: ${found[0]}`);
    }
  }

  assert.deepEqual(leaks, []);
});

test('there is one runtime dependency, and it is the MCP SDK', () => {
  // Load-bearing for four phases and asserted by nobody. Everything else here
  // is Node's own: `node:sqlite`, `node:fs`, `node:test`. A second dependency
  // is a decision about what somebody installs onto their machine along with a
  // memory store, and it should not be possible to take it by accident.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@modelcontextprotocol/sdk']);
  assert.equal(manifest.bundleDependencies ?? undefined, undefined);
  assert.equal(manifest.peerDependencies ?? undefined, undefined);
  assert.equal(manifest.optionalDependencies ?? undefined, undefined);
});

test('there is a command, and it is named after the package', () => {
  // The promise this project opened with was one command that wires every agent
  // up. What 0.0.1 shipped was `node "$(npm root -g)/nosyparker/src/cli.js"
  // setup`, which is not that, and the reason recorded for it did not survive
  // being measured — see DECISIONS.md.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.deepEqual(Object.keys(manifest.bin ?? {}), ['nosyparker'],
    'a global install has to put exactly one command on PATH, named after the package');
  assert.equal(manifest.bin.nosyparker, 'src/cli.js');

  // npx works out what to run by matching the bin name against the package
  // name. A mismatch is the difference between a working `npx nosyparker` and
  // "could not determine executable to run", which is what 0.0.1 gave.
  assert.equal(Object.keys(manifest.bin)[0], manifest.name);

  // And it has to be in the tarball, with the shebang that makes it runnable.
  assert.ok(packed().has('src/cli.js'));
  assert.match(fs.readFileSync(path.join(ROOT, 'src/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node/u);
});

test('the one change that can reach a public registry is held by something', () => {
  // `publish.yml` was read by no test. Its `if: github.event_name == 'release'`
  // is the only line in this project that can put a tarball in front of
  // strangers, and it is the only change nothing could fail on. The condition
  // used to include `|| inputs.dry_run == false`, which let a manual run publish
  // with no release and therefore without the tag-versus-manifest check.
  const yaml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');

  // Read as text on purpose: there is no YAML parser in this project's
  // dependencies and adding one to read one file would be a second runtime
  // dependency's worth of argument for a nine-line check.
  const step = yaml.slice(yaml.indexOf('- name: publish'));
  const condition = /^\s*if:\s*(.+)$/mu.exec(step);

  assert.ok(condition, 'the publish step has no condition at all');
  assert.equal(condition[1].trim(), "github.event_name == 'release'",
    'the publish step must fire on a published release and on nothing else');

  // The guards that stand between a release and the registry, each named.
  for (const guard of [
    'only this repository, only its owner',
    'npm run typecheck',
    'npm test',
    'the release tag and package.json must say the same version',
    'that version must not already be published',
  ]) {
    assert.ok(yaml.includes(guard), `the publish workflow lost its "${guard}" step`);
  }

  // And the publish step has to come after them, not beside them.
  assert.ok(yaml.indexOf('- name: publish') > yaml.indexOf('that version must not already be published'));
});
