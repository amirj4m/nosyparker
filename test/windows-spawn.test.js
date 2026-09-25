/**
 * Starting a client's own command on Windows.
 *
 * Every client written through its own command failed on the first Windows
 * machine this ran on, and all in one of two ways. Codex and VS Code resolved
 * to the extension-less POSIX script npm and VS Code put beside the real shim,
 * and `spawnSync` said ENOENT; Claude Code was not found at all, because the
 * bare name was looked for and the file is `claude.exe`. The file-written
 * clients on the same machine were fine, which is how it went unnoticed: the
 * suite describes machines rather than running commands.
 *
 * So this file does both. The resolution is described, and holds anywhere. The
 * running is real, and only means something on Windows: a batch file shaped
 * like the shims the clients are installed as, in a directory whose name has
 * the characters cmd.exe gives meanings to, is handed the arguments this
 * program actually passes, and has to receive every one of them byte for byte.
 * DECISIONS.md, "Starting a client's command on Windows", says what fails here
 * without each half of the fix.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clientById } from '../src/clients.js';
import { resolveCommand } from '../src/detect.js';
import { batchCommandLine, isBatchFile, runCommand } from '../src/write.js';

/**
 * A Windows machine with exactly the files named.
 *
 * @param {string[]} files
 * @param {string[]} pathDirs
 * @param {string[]} [pathExt]
 * @returns {import('../src/detect.js').Machine}
 */
function windows(files, pathDirs, pathExt) {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return {
    home: 'C:\\Users\\p',
    platform: 'win32',
    appData: 'C:\\Users\\p\\AppData\\Roaming',
    cwd: 'C:\\Users\\p',
    pathDirs,
    ...(pathExt === undefined ? {} : { pathExt }),
    exists: (file) => present.has(file.replaceAll('/', '\\').toLowerCase()),
    processes: () => null,
    readdir: (dir) => {
      const prefix = `${dir.replaceAll('/', '\\')}\\`.toLowerCase();
      const names = new Set();
      for (const file of present) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('\\')[0]);
      }
      return [...names];
    },
  };
}

const NPM = 'C:\\Users\\p\\AppData\\Roaming\\npm';

test('on Windows the shim is found, not the POSIX script npm leaves beside it', () => {
  const found = resolveCommand(
    clientById('codex-cli'),
    windows([`${NPM}\\codex`, `${NPM}\\codex.cmd`, `${NPM}\\codex.ps1`], [NPM]),
  );

  assert.equal(found, `${NPM}\\codex.cmd`);
});

test('on Windows a bare name finds its .exe', () => {
  const bin = 'C:\\Users\\p\\.local\\bin';
  assert.equal(resolveCommand(clientById('claude-code'), windows([`${bin}\\claude.exe`], [bin])), `${bin}\\claude.exe`);
});

test('PATHEXT order is kept, and only what can be started is tried', () => {
  const dir = 'C:\\tools';
  const machine = (/** @type {string[]} */ files) => windows(files, [dir], ['.JS', '.CMD', '.EXE']);

  assert.equal(resolveCommand(clientById('codex-cli'), machine([`${dir}\\codex.exe`, `${dir}\\codex.cmd`])), `${dir}\\codex.cmd`);
  // `.js` is in the default PATHEXT and means Windows Script Host.
  assert.equal(resolveCommand(clientById('codex-cli'), machine([`${dir}\\codex.js`])), null);
  // The extension-less file alone is not a command on Windows.
  assert.equal(resolveCommand(clientById('codex-cli'), machine([`${dir}\\codex`])), null);
});

test('only a .cmd or .bat on Windows goes through cmd.exe', () => {
  assert.equal(isBatchFile('C:\\npm\\codex.cmd', 'win32'), true);
  assert.equal(isBatchFile('C:\\npm\\CODEX.BAT', 'win32'), true);
  assert.equal(isBatchFile('C:\\bin\\claude.exe', 'win32'), false);
  assert.equal(isBatchFile('/usr/bin/codex.cmd', 'linux'), false);
});

test('a line break is refused rather than cut off', () => {
  assert.throws(() => batchCommandLine('C:\\npm\\codex.cmd', ['a\nb']), /line break/u);
  assert.throws(() => batchCommandLine('C:\\npm\\codex.cmd', ['a\r']), /line break/u);
});

test('no argument can reach cmd.exe with a character it would act on unescaped', () => {
  // Every special character in the line is behind a caret, so cmd never enters
  // a quoted string and never sees an operator, and the only bare spaces are
  // the ones between arguments. Checked by walking the line the way cmd does:
  // a caret escapes whatever follows it.
  const args = [
    '{"type":"stdio","command":"C:\\\\Program Files\\\\nodejs\\\\node.exe"}',
    'a&b|c>d<e^f%PATH%!x!',
    'trailing\\',
  ];
  const inner = batchCommandLine('C:\\A & B (x86)\\codex.cmd', args).slice(1, -1);

  let separators = 0;
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '^') { i += 1; continue; }
    if (inner[i] === ' ') { separators += 1; continue; }
    assert.doesNotMatch(inner[i], /[()\][%!"`<>&|;,*?=]/u, `unescaped ${inner[i]} at ${i} in ${inner}`);
  }
  assert.equal(separators, args.length);
});

/**
 * The two batch-file shapes the clients in the table are installed as.
 *
 * VS Code's `bin\code.cmd` names an absolute interpreter and passes `%*` on.
 * npm's global shim, copied here from what `npm install -g` wrote on the
 * machine this was measured on, chooses its interpreter in a block and passes
 * `%*` on at the end of a line that is itself full of operators. Its
 * interpreter is `node` from PATH, as it is for anybody without a `node.exe`
 * beside their shims.
 *
 * Each is run from inside the hardest directory name it survives on its own.
 * npm's does not survive `&` or `^`: its `SET dp0=%~dp0` is unquoted, and it
 * fails in such a directory run bare from cmd.exe with no arguments at all —
 * measured, and nothing of ours is involved. That one is npm's to fix.
 *
 * @type {Record<string, {dir: string, shim: (script: string) => string}>}
 */
const SHIMS = {
  'VS Code': {
    dir: 'np spawn & (x86) %TEMP% ^ !',
    shim: (script) => `@ECHO off\r\n"${process.execPath}" "%~dp0\\${script}" %*\r\n`,
  },
  npm: { dir: 'np spawn (x86) %TEMP% !', shim: (script) => [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
  ].join('\r\n') },
};

for (const [shape, { dir, shim: shimFor }] of Object.entries(SHIMS)) {
  test(`a batch file shaped like ${shape}'s receives every argument exactly`, { skip: process.platform !== 'win32' && 'runs cmd.exe' }, (t) => {
    // A directory name with the characters that break naive quoting, as a home
    // directory or an install prefix might have them.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), dir));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const out = path.join(root, 'argv.json');
    fs.writeFileSync(path.join(root, 'probe.js'), [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
    ].join('\n'));

    const shim = path.join(root, 'probe.cmd');
    fs.writeFileSync(shim, shimFor('probe.js'));

    const entry = JSON.stringify({
      name: 'nosyparker',
      type: 'stdio',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\A & B\\100% (x86)\\server.js'],
    });
    const args = [
      'mcp', 'add', 'nosyparker', '--',
      entry,
      'C:\\Program Files (x86)\\node.exe',
      'a&b|c>d<e^f',
      '%PATH% %OS% !PATH!',
      'say "hi" \\"there\\"',
      'trailing backslash\\',
      '',
      '  spaced  ',
      'semi;colon,comma=equals',
    ];

    const ran = runCommand([shim, ...args]);

    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), args);
  });
}

test('a batch file that fails on Windows reports its exit status', { skip: process.platform !== 'win32' && 'runs cmd.exe' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np spawn exit '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const shim = path.join(root, 'fails.cmd');
  fs.writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" -e "process.exit(3)" %*\r\n`);

  assert.equal(runCommand([shim, 'anything']).status, 3);
});

test('an .exe on Windows is started directly', { skip: process.platform !== 'win32' && 'runs an .exe' }, () => {
  const ran = runCommand([process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'a & "b"']);

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'a & "b"');
});
