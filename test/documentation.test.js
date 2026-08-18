/**
 * The documents, checked against the program.
 *
 * The checks themselves moved into `src/documentation.js`, because `doctor`
 * runs them too and a person running a command should get the same answer the
 * suite gets rather than a second implementation of it. What is left here is
 * the assertion that they all hold, and the mutations proving they would notice
 * if they did not.
 *
 * This file exists because of a specific failure. A commit message said every
 * checkable claim in the four documents had been compared against the program
 * "by a script". The comparison was real and it did run; the script was a line
 * of shell that was never saved. So the record asserted a mechanism that did
 * not exist — which is `gemini mcp add` reporting that it added a server, and
 * `kimi doctor` reporting that a file it never opened is valid, committed by us
 * about us. The documents were true. That is not the point: something reported
 * that it checked, and nothing checked.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkDocumentation } from '../src/documentation.js';

test('every document agrees with the program', () => {
  for (const check of checkDocumentation()) {
    assert.deepEqual(check.wrong, [], check.what);
    assert.equal(check.ok, true, check.what);
  }
});

test('there are fourteen of them, and each says what it is checking', () => {
  // Counted so that a check cannot be quietly dropped, and each one's sentence
  // is what `doctor` prints, so an empty one would be a blank line in front of
  // somebody trying to work out what is wrong.
  const checks = checkDocumentation();

  assert.equal(checks.length, 14);
  for (const check of checks) assert.ok(check.what.length > 10, `a check with no sentence: ${check.what}`);
});

test('a document that stops being true is noticed', (t) => {
  // The mutations that were run by hand when this was a throwaway. They are the
  // whole value of the file: a checker that cannot fail is the thing it was
  // written to replace.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const real = new URL('..', import.meta.url).pathname;
  for (const name of ['CLIENTS.md', 'README.md', 'CONNECTING.md', 'DECISIONS.md', 'package.json']) {
    fs.copyFileSync(path.join(real, name), path.join(root, name));
  }
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync(path.join(real, 'src/write.js'), path.join(root, 'src/write.js'));
  // The check reads the scripts too, since a command nobody has can be named
  // there as easily as anywhere else.
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(real, 'scripts/drift.mjs'), path.join(root, 'scripts/drift.mjs'));

  const failing = () => checkDocumentation(root).filter((check) => !check.ok).length;
  assert.equal(failing(), 0, 'the copy starts clean');

  /** @type {[string, string, string][]} */
  const mutations = [
    ['README.md', 'twenty clients', 'nineteen clients'],
    ['CLIENTS.md', 'Wired through `codex mcp add`', 'Wired through its own tool'],
    ['README.md', 'Node 22.5', 'Node 22'],
    ['CLIENTS.md', '/permissions trust', '/permissions grant'],
    ['CLIENTS.md', 'we do not use it', 'we rely on it'],
    ['DECISIONS.md', 'What Phase 3 refuses to write', 'What the installer will not do'],
    ['README.md', '```\nnode src/cli.js doctor\n```', '`node src/cli.js doctor`'],
    ['README.md', '/issues', '/discussions'],
    ['README.md', 'actions.log', 'actions-log'],
    ['CLIENTS.md', '**Continue**, **Warp**', '**Cline**, **Continue**, **Warp**'],
  ];

  // And the one that is about the program rather than a document: a usage
  // string naming a command nobody has.
  const cli = path.join(root, 'src', 'cli-main.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'fail("Which one? nosyparker restore <id>");');
  assert.ok(failing() > 0, 'a usage string naming a command nobody has was not noticed');
  fs.rmSync(cli);

  // And the half that was not held at all: two of the seven original instances
  // were in documents, fixed by hand with nothing watching them. Each of the
  // four documents and the scripts, one at a time.
  for (const file of ['README.md', 'CLIENTS.md', 'CONNECTING.md', 'DECISIONS.md', 'scripts/drift.mjs']) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');

    fs.writeFileSync(target, `${original}\n\`nosyparker setup\` is the command.\n`);
    assert.ok(failing() > 0, `a command nobody has, named in ${file}, was not noticed`);
    fs.writeFileSync(target, original);
  }

  for (const [file, from, to] of mutations) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    assert.ok(original.includes(from), `${file} no longer contains "${from}"`);

    // Every occurrence, not the first: the claim is that the document says this
    // at all, and leaving a second copy behind tests nothing. `actions.log`
    // appears twice in the README and the first version of this passed because
    // of it.
    fs.writeFileSync(target, original.replaceAll(from, to));
    assert.ok(failing() > 0, `changing "${from}" in ${file} was not noticed`);
    fs.writeFileSync(target, original);
  }

  assert.equal(failing(), 0, 'and everything is put back');
});
