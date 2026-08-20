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

test('there are eighteen of them, and each says what it is checking', () => {
  // Counted so that a check cannot be quietly dropped, and each one's sentence
  // is what `doctor` prints, so an empty one would be a blank line in front of
  // somebody trying to work out what is wrong.
  const checks = checkDocumentation();

  assert.equal(checks.length, 18);
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
  // The whole of src and scripts, not a couple of files: the checks read every
  // source for a command nobody has, and every source for the pointers into
  // DECISIONS.md. Copying two of them made the copy look broken before any
  // mutation had been applied.
  for (const dir of ['src', 'scripts']) {
    fs.mkdirSync(path.join(root, dir));
    for (const name of fs.readdirSync(path.join(real, dir))) {
      fs.copyFileSync(path.join(real, dir, name), path.join(root, dir, name));
    }
  }

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
    ['README.md', '```\nnosyparker doctor\n```', '`nosyparker doctor`'],
    ['README.md', '/issues', '/discussions'],
    ['README.md', 'actions.log', 'actions-log'],
    ['CLIENTS.md', '**Continue**, **Warp**', '**Cline**, **Continue**, **Warp**'],
    ['DECISIONS.md', 'where a bound belongs  [record]', 'where a bound belongs'],
  ];
  // And the one that is about the program rather than a document. Until 0.0.2
  // this mutation added a usage string naming a command nobody had; the command
  // exists now, so the mutation that matters is the other direction — take the
  // `bin` out of the manifest and every one of those strings, in the program and
  // in four documents, becomes a lie again.
  const manifest = path.join(root, 'package.json');
  const kept = fs.readFileSync(manifest, 'utf8');
  const withoutBin = JSON.parse(kept);
  delete withoutBin.bin;
  fs.writeFileSync(manifest, `${JSON.stringify(withoutBin, null, 2)}\n`);
  assert.ok(failing() > 0, 'losing the command while the documents still name it was not noticed');
  fs.writeFileSync(manifest, kept);

  // Telling somebody to run it by path now that the command exists. Six of
  // these shipped in three documents in the release whose headline was the
  // command, because the check that caught the opposite direction discarded
  // the whole document list the moment `bin` appeared.
  //
  // Appended to a document rather than swapped inside one, because swapping
  // `nosyparker setup` for the old form in CLIENTS.md trips a different check
  // as well — which would have made this guard look like it worked while
  // guarding nothing.
  for (const file of ['CLIENTS.md', 'CONNECTING.md', 'DECISIONS.md']) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');

    fs.writeFileSync(target, `${original}\nRun \`node src/cli.js doctor\` to check.\n`);
    const noticed = checkDocumentation(root)
      .filter((check) => !check.ok)
      .flatMap((check) => check.wrong)
      .some((wrong) => wrong.includes(file) && wrong.includes('by path'));
    fs.writeFileSync(target, original);

    assert.ok(noticed, `${file} telling somebody to run it by path was not noticed`);
  }
  // And the half that was not held at all: two of the seven original instances
  // were in documents, fixed by hand with nothing watching them. The documents
  // are read, and this is what says so — with the command gone from the
  // manifest, every file that names it has to be named back.
  const gone = JSON.parse(kept);
  delete gone.bin;
  fs.writeFileSync(manifest, `${JSON.stringify(gone, null, 2)}\n`);

  for (const file of ['README.md', 'CLIENTS.md', 'CONNECTING.md', 'DECISIONS.md']) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    if (!/nosyparker (setup|doctor|uninstall|export|undo-review)\b/u.test(original)) continue;

    const named = checkDocumentation(root)
      .filter((check) => !check.ok)
      .flatMap((check) => check.wrong)
      .some((wrong) => wrong.includes(file));
    assert.ok(named, `${file} names the command and was not named back when it went away`);
  }

  fs.writeFileSync(manifest, kept);

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
