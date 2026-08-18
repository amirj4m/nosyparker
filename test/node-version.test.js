/**
 * Refusing to start on a Node too old to run this.
 *
 * The boundary version is tested rather than a couple of round numbers,
 * because the whole value of the check is that it is right at the edge: 22.4
 * has no `node:sqlite` and 22.5 does, and a check that is one release out is a
 * check that either fails on a machine that works or lets through a machine
 * that does not.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isSupported, OLDEST_SUPPORTED, requireSupportedNode, tooOldMessage } from '../src/node-version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the boundary is where node:sqlite actually arrived', () => {
  assert.deepEqual(OLDEST_SUPPORTED, { major: 22, minor: 5 });

  assert.equal(isSupported('22.4.1'), false);
  assert.equal(isSupported('22.5.0'), true);
  assert.equal(isSupported('22.5.1'), true);
  assert.equal(isSupported('22.23.2'), true);
  assert.equal(isSupported('23.0.0'), true);
  assert.equal(isSupported('24.1.0'), true);

  assert.equal(isSupported('18.19.1'), false);
  assert.equal(isSupported('20.11.0'), false);
  assert.equal(isSupported('21.7.3'), false);
});

test('the Node running these tests is one this project supports', () => {
  assert.equal(isSupported(), true);
});

test('what it says names the version needed, the version found, and one thing to do', () => {
  const said = tooOldMessage('18.19.1');

  assert.match(said, /needs Node 22\.5 or newer/u);
  assert.match(said, /This is Node 18\.19\.1/u);
  assert.match(said, /Install a newer Node from nodejs\.org/u);

  // Nothing about module loaders, builtins, or which import failed, and nothing
  // about SQLite: that is our reason for needing the version, not the reader's
  // problem, and a person who has met this from any other command line tool is
  // not expecting an explanation.
  assert.doesNotMatch(said, /ERR_UNKNOWN_BUILTIN_MODULE|ModuleLoader|node:sqlite|SQLite/u);

  // It reads for somebody who has never heard of a version manager: the plain
  // instruction comes first and stands alone, and the clause for people who do
  // have one names itself rather than assuming the word.
  const [instruction] = said.split('\n').filter((line) => line.startsWith('Install'));
  assert.ok(instruction.includes('nodejs.org'));
  assert.match(said, /a tool like nvm/u);
  assert.ok(said.indexOf('nodejs.org') < said.indexOf('nvm'), 'the plain route comes first');

  // Short. Four lines including the blank one.
  assert.ok(said.split('\n').length <= 4, `${said.split('\n').length} lines is too many`);
});

test('a supported Node is let through without a word', () => {
  let said = '';
  requireSupportedNode({ version: '22.5.0', err: (text) => { said += text; }, exit: () => { throw new Error('exited'); } });

  assert.equal(said, '');
});

test('an unsupported Node is told, on stderr, and stops', () => {
  let said = '';
  /** @type {number|null} */
  let code = null;

  requireSupportedNode({
    version: '18.19.1',
    err: (text) => { said += text; },
    exit: (given) => { code = given; return /** @type {never} */ (undefined); },
  });

  assert.match(said, /needs Node 22\.5 or newer/u);
  assert.equal(code, 1);
});

test('every launcher checks before it can import anything that needs SQLite', () => {
  // The defect this exists for was not a missing check, it was a check in the
  // wrong place: `cli-main.js` answers `setup` before it opens the store, and
  // still statically imports `store.js`, so `node:sqlite` loads while the
  // module is being evaluated and the command never runs at all.
  //
  // A static import is hoisted above everything. So the guard has to sit in the
  // launcher, above the dynamic import — which is the same reason the warning
  // filter is there, and the same shape.
  for (const launcher of ['src/cli.js', 'src/mcp-server.js', 'scripts/purge.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, launcher), 'utf8');

    const guard = source.indexOf('requireSupportedNode()');
    const dynamic = source.indexOf('await import(');

    assert.notEqual(guard, -1, `${launcher} does not check the Node version`);
    assert.notEqual(dynamic, -1, `${launcher} no longer defers its work`);
    assert.ok(guard < dynamic, `${launcher} checks after it has already loaded the work`);

    // And the launcher itself must not reach the store, or the check would be
    // running after the thing it is guarding against.
    assert.doesNotMatch(source, /from '\.\.?\/(src\/)?store\.js'/u, launcher);
  }
});

test('an old Node gets the sentence and not a stack trace, for real', () => {
  // Run out of process against a genuinely old Node if the machine has one.
  // This is the assertion that would have caught the regression, because every
  // in-process test here passes on the Node running them.
  const old = ['/usr/bin/node', '/usr/local/bin/node'].find((candidate) => {
    try {
      return Number(execFileSync(candidate, ['--version'], { encoding: 'utf8' }).slice(1).split('.')[0]) < 22;
    } catch {
      return false;
    }
  });

  if (old === undefined) return; // nothing old enough here to try it on

  let output = '';
  let status = 0;
  try {
    execFileSync(old, ['src/cli.js', 'setup'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const failure = /** @type {any} */ (error);
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    status = failure.status;
  }

  assert.equal(status, 1);
  assert.match(output, /needs Node 22\.5 or newer/u);
  assert.doesNotMatch(output, /ERR_UNKNOWN_BUILTIN_MODULE/u);
  assert.doesNotMatch(output, /at ModuleLoader/u);
});

test('package.json says the same thing to anything that reads it', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(manifest.engines.node, '>=22.5.0');
});
