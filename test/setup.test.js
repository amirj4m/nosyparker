/**
 * The command, its report, and the escape hatch.
 *
 * Every one of these runs against a described machine and a temporary
 * directory. The report tests are assertions about words, because the words are
 * the deliverable: six statuses that mean six different things, and a client we
 * could not check saying so rather than being quietly counted with the ones we
 * could.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultIo, install, printConfig, report, reportRemoval, uninstall } from '../src/setup.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {object} shape
 * @param {string[]} [shape.files]
 * @param {string[]} [shape.pathDirs]
 * @param {(argv: string[]) => {status: number, stdout: string, stderr: string}} [shape.run]
 * @returns {{io: any, printed: () => string, home: string}}
 */
function machine(t, { files = [], pathDirs = [], run } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  // The described files are made for real under the temporary home, so the
  // writer has somewhere to write and the reader has something to read. The
  // real home directory is never named anywhere in this file.
  for (const file of files) {
    const full = path.join(home, file);
    if (file.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (!fs.existsSync(full)) fs.writeFileSync(full, '');
    }
  }

  let printed = '';

  const io = defaultIo({
    out: (/** @type {string} */ text) => {
      printed += text;
    },
    machine: {
      home,
      platform: 'linux',
      appData: undefined,
      cwd: path.join(home, 'work'),
      pathDirs,
      // Nothing outside the temporary home is visible, so a real /usr/share/code
      // on the machine running the tests cannot make a test pass or fail. This
      // is the fake machine's whole job and it has to be airtight: the first
      // version of it fell through to the real filesystem for absolute paths
      // and duly discovered the VS Code that is actually installed here.
      exists: (/** @type {string} */ file) => file.startsWith(home) && fs.existsSync(file),
      // Nothing is running on this machine either, unless a test says so.
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
    backupDir: path.join(dir, 'backups'),
    now: '2026-08-17T10:00:00.000Z',
    command: '/usr/bin/node',
    serverPath: '/srv/mcp-server.js',
    run,
  });

  return { io, printed: () => printed, home };
}

test('a machine with nothing on it installs nothing and says so', (t) => {
  const { io, printed } = machine(t, {});

  report(io, install(io));

  assert.match(printed(), /Looked for 14 clients\. Found 0\./u);
  assert.match(printed(), /Not on this machine: /u);
  assert.doesNotMatch(printed(), /connected/u);
});

test('a client that is here is written to, checked, and reported in its own words', (t) => {
  const { io, printed, home } = machine(t, { files: ['.gemini/'] });

  const outcomes = install(io);
  report(io, outcomes);

  const gemini = outcomes.find((outcome) => outcome.client.id === 'gemini-cli');
  assert.equal(gemini?.written?.outcome, 'written');

  // Written by file, because gemini's own add command reports success and
  // writes nothing.
  assert.equal(gemini?.written?.method, 'file');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')),
    { mcpServers: { nosyparker: { command: '/usr/bin/node', args: ['/srv/mcp-server.js'] } } },
  );

  // And it could not be checked, because gemini's binary is not on this
  // machine's PATH, so the report must not claim it connected.
  assert.doesNotMatch(printed(), /started the server/u);
});

test('the report never gives two clients the same word for different knowledge', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude_desktop_config.json', '.local/bin/zed', '.cursor/',
      '.config/Devin/'],
    pathDirs: [],
  });

  report(io, install(io));

  // Three clients written by us, none of which can be asked — and each says so
  // with its own reason rather than sharing one.
  assert.match(printed(), /Claude Desktop — written-unverified/u);
  assert.match(printed(), /Zed — written-unverified/u);
  assert.match(printed(), /Cursor — written-unverified/u);
  assert.match(printed(), /nothing on this machine can confirm Zed reads it/u);
  assert.match(printed(), /the debug log contains no mention of context servers/u);
  assert.match(printed(), /Its own --add-mcp writes nothing/u);
  assert.match(printed(), /a per-server log file that appears after the app next starts/u);

  // Devin is here with no config file, and is written through its own command
  // — which is not on this machine, so it fails rather than having its file
  // written behind its back.
  assert.match(printed(), /Devin Desktop \(formerly Windsurf\) — failed/u);
  assert.match(printed(), /its own command could not be found/u);
});

test('a client with a working command reaches connected, and only then', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude-code/2.1.227/claude', '.claude.json'],
    run: (argv) => {
      if (argv[1] === 'mcp' && argv[2] === 'add') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: 'nosyparker: node /srv/mcp-server.js - ✔ Connected\n', stderr: '' };
    },
  });

  // The client's own add command is the thing being stood in for, so the file
  // has to end up holding the entry or the read-back correctly calls it a
  // failure. Write it the way `claude mcp add --scope user` does.
  const claudeJson = path.join(io.machine.home, '.claude.json');
  const io2 = { ...io, run: (/** @type {string[]} */ argv) => {
    if (argv[1] === 'mcp' && argv[2] === 'add') {
      fs.writeFileSync(claudeJson, JSON.stringify({
        mcpServers: { nosyparker: { command: '/usr/bin/node', args: ['/srv/mcp-server.js'] } },
      }));
      return { status: 0, stdout: 'Added stdio MCP server nosyparker\n', stderr: '' };
    }
    return { status: 0, stdout: 'nosyparker: node /srv/mcp-server.js - ✔ Connected\n', stderr: '' };
  } };

  report(io2, install(io2));

  assert.match(printed(), /Claude Code — connected/u);
  assert.match(printed(), /started the server and reported that it connected/u);
});

test('a client that is connected is not in the restart list, because it already works', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude-code/2.1.227/claude', '.claude.json', '.local/bin/zed'],
  });

  const claudeJson = path.join(io.machine.home, '.claude.json');
  const wired = { ...io, run: (/** @type {string[]} */ argv) => {
    if (argv[2] === 'add') {
      fs.writeFileSync(claudeJson, '{"mcpServers":{"nosyparker":{"command":"/usr/bin/node"}}}');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: 'nosyparker - ✔ Connected\n', stderr: '' };
  } };

  report(wired, install(wired));

  const restarts = printed().slice(printed().indexOf('close and reopen these'));
  assert.match(restarts, /Zed/u);
  assert.doesNotMatch(restarts, /Claude Code/u);
});

test('the duplicate registration hazard is named when both sides of it are present', (t) => {
  // VS Code 1.133 reads Claude Desktop's and Cursor's config files as well as
  // its own. Somebody who sees the same server listed twice deserves to know
  // why rather than assuming they installed it twice.
  const { io, printed, home } = machine(t, {
    files: ['.local/bin/code', '.config/Code/User/', '.config/Claude/claude_desktop_config.json'],
    pathDirs: ['/home/nowhere'],
  });

  const wired = {
    ...io,
    machine: { ...io.machine, pathDirs: [path.join(home, '.local', 'bin')] },
    run: (/** @type {string[]} */ argv) => {
      const blob = JSON.parse(argv[2]);
      const { name, ...entry } = blob;
      fs.writeFileSync(
        path.join(home, '.config', 'Code', 'User', 'mcp.json'),
        JSON.stringify({ servers: { [name]: entry } }, null, 2),
      );
      return { status: 0, stdout: '', stderr: '' };
    },
  };

  report(wired, install(wired));

  assert.match(printed(), /VS Code — written\n/u);
  assert.match(printed(), /Claude Desktop — written-unverified/u);
  assert.match(printed(), /may appear more than once/u);
});

test('with only one side of it present there is nothing to warn about', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude_desktop_config.json'],
  });

  report(io, install(io));

  assert.match(printed(), /Claude Desktop — written-unverified/u);
  assert.doesNotMatch(printed(), /may appear more than once/u);
});

test('uninstall takes our entry out and leaves everything else alone', (t) => {
  const { io } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(io.machine.home, '.gemini', 'settings.json');

  fs.writeFileSync(settings, '{\n  "theme": "dark",\n  "mcpServers": {\n    "theirs": {"command": "x"}\n  }\n}\n');
  const before = fs.readFileSync(settings, 'utf8');

  install(io);
  assert.notEqual(fs.readFileSync(settings, 'utf8'), before);

  const outcomes = uninstall(io);
  assert.equal(outcomes.find((outcome) => outcome.client.id === 'gemini-cli')?.written?.outcome, 'removed');
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
});

test('uninstall run twice is not an error the second time', (t) => {
  const { io } = machine(t, { files: ['.gemini/'] });

  install(io);
  uninstall(io);
  const again = uninstall(io);

  assert.equal(again.find((outcome) => outcome.client.id === 'gemini-cli')?.written?.outcome, 'absent');
});

test('uninstall removes from a client whose entry its own command put there', (t) => {
  // Removal is always by editing the file, never by the client's own remove
  // subcommand, so an uninstall works on a machine where that command has since
  // been upgraded, moved, or deleted. Here it is simply gone.
  const { io, home } = machine(t, { files: ['.cursor/'] });
  const configPath = path.join(home, '.cursor', 'mcp.json');

  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      theirs: { command: 'x' },
      nosyparker: { type: 'stdio', command: '/usr/bin/node', args: ['/srv/mcp-server.js'] },
    },
  }, null, 2));

  const outcomes = uninstall(io);

  assert.equal(outcomes.find((outcome) => outcome.client.id === 'cursor')?.written?.outcome, 'removed');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    mcpServers: { theirs: { command: 'x' } },
  });
});

test('uninstall takes nothing out of a client that has somebody else\'s servers only', (t) => {
  const { io, home } = machine(t, { files: ['.cursor/', '.gemini/'] });
  const cursor = path.join(home, '.cursor', 'mcp.json');
  const before = '{\n  "mcpServers": {\n    "theirs": {"command": "x"},\n    "and-theirs": {"command": "y"}\n  }\n}\n';
  fs.writeFileSync(cursor, before);

  uninstall(io);

  assert.equal(fs.readFileSync(cursor, 'utf8'), before);
});

test('the uninstall report says what went and what is still holding it open', (t) => {
  const { io, printed } = machine(t, { files: ['.gemini/'] });

  install(io);
  reportRemoval(io, uninstall(io));

  assert.match(printed(), /Gemini CLI — removed/u);
  assert.match(printed(), /Nothing else in any of those files was touched, and no memory was deleted/u);
  assert.match(printed(), /still running the server until they are closed and reopened/u);

  // The install report's restart line means the opposite thing and must not
  // appear here.
  assert.doesNotMatch(printed().slice(printed().indexOf('removed')), /Before any of this takes effect/u);
});

test('the uninstall report on a machine with nothing of ours says exactly that', (t) => {
  const { io, printed } = machine(t, { files: ['.gemini/'] });

  reportRemoval(io, uninstall(io));

  assert.match(printed(), /Nothing to remove/u);
});

test('the backup taken at install is left alone by uninstall', (t) => {
  const { io } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(io.machine.home, '.gemini', 'settings.json');
  fs.writeFileSync(settings, '{"theme": "dark"}\n');

  install(io);
  const backups = fs.readdirSync(io.backupDir).sort();

  uninstall(io);

  // The copy is of the file from before this project existed. Removing it as
  // part of an uninstall would throw away the only thing that could not be
  // reconstructed.
  assert.deepEqual(fs.readdirSync(io.backupDir).sort(), backups);
  assert.equal(
    fs.readFileSync(path.join(io.backupDir, 'gemini-cli.settings.json'), 'utf8'),
    '{"theme": "dark"}\n',
  );
});

test('installing one client cannot make another look installed', (t) => {
  // This happened. `code --add-mcp` creates ~/.vscode/extensions on its first
  // run, the Cline row was using that directory as evidence, and a live run
  // duly wrote a configuration file for a client that has never been on this
  // machine. Two things were wrong and both are fixed: the evidence, and the
  // interleaving that turned a weak detector into a wrong answer.
  const { io, home } = machine(t, {
    files: ['.local/bin/code'],
    pathDirs: [],
  });

  const wired = {
    ...io,
    machine: { ...io.machine, pathDirs: [path.join(home, '.local', 'bin')] },
    run: () => {
      // What the real command does, including the directory it makes for
      // itself on the way.
      fs.mkdirSync(path.join(home, '.vscode', 'extensions'), { recursive: true });
      fs.mkdirSync(path.join(home, '.config', 'Code', 'User'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.config', 'Code', 'User', 'mcp.json'),
        '{"servers":{"nosyparker":{"type":"stdio","command":"/usr/bin/node","args":["/srv/mcp-server.js"]}}}',
      );
      return { status: 0, stdout: '', stderr: '' };
    },
  };

  const outcomes = install(wired);

  assert.equal(outcomes.find((outcome) => outcome.client.id === 'vscode')?.written?.outcome, 'written');
  assert.equal(outcomes.find((outcome) => outcome.client.id === 'cline')?.written, null,
    'Cline is not installed and nothing was written for it');
  assert.equal(
    fs.existsSync(path.join(home, '.config', 'Code', 'User', 'globalStorage')),
    false,
  );
});

test('Cline is found by its own storage directory and by nothing else', (t) => {
  const { io } = machine(t, {
    files: ['.config/Code/User/globalStorage/saoudrizwan.claude-dev/'],
  });

  const outcomes = install(io);

  assert.equal(outcomes.find((outcome) => outcome.client.id === 'cline')?.written?.outcome, 'written');
});

test('a folder-trust blocker is reported when the file recording trust does not exist', (t) => {
  // The live run's sharpest miss. Gemini reported the server as Disabled
  // because the folder is untrusted, trust is recorded in a file that does not
  // exist until something is trusted, and the blocker check read "no file" as
  // "nothing to report" — so the report said `failed` and said nothing about
  // why, while the client itself was printing the reason.
  const { io, printed } = machine(t, { files: ['.gemini/'] });

  const wired = {
    ...io,
    machine: { ...io.machine, pathDirs: [] },
    run: () => ({ status: 0, stdout: '○ nosyparker: node (stdio) - Disabled\n', stderr: '' }),
  };

  report(wired, install(wired));

  assert.match(printed(), /untrusted folder/u);
});

test('--print-config with no client prints the shape that works nearly everywhere', (t) => {
  const { io, printed } = machine(t, {});

  printConfig(io, null);

  const blob = JSON.parse(printed().slice(printed().indexOf('{'), printed().lastIndexOf('}') + 1));
  assert.deepEqual(blob, {
    mcpServers: {
      nosyparker: { type: 'stdio', command: '/usr/bin/node', args: ['/srv/mcp-server.js'] },
    },
  });

  // And the two things a person needs after pasting it.
  assert.match(printed(), /"servers".*"context_servers".*"extensions"/su);
  assert.match(printed(), /restart the application/u);
});

test('--print-config for a client nobody has heard of does not dead-end', (t) => {
  const { io, printed } = machine(t, {});

  printConfig(io, 'some-editor-released-last-tuesday');

  assert.match(printed(), /There is no client called "some-editor-released-last-tuesday"/u);
  assert.match(printed(), /--print-config with no name/u);
});

test('--print-config for a known client prints its own shape, not the common one', (t) => {
  const { io, printed } = machine(t, {});

  printConfig(io, 'goose');

  assert.match(printed(), /cmd: \/usr\/bin\/node/u, 'cmd, because Goose is the one that says cmd');
  assert.match(printed(), /enabled: true/u);
  assert.doesNotMatch(printed(), /"mcpServers"/u);
  assert.match(printed(), /config\.yaml/u);
});

test('--print-config names the traps, so a hand install hits none of them', (t) => {
  const { io, printed } = machine(t, {});

  printConfig(io, 'zed');

  assert.match(printed(), /source: "custom"` is not required/u);
  assert.match(printed(), /Quit and reopen Zed/u);
});

test('--print-config for a client with no path on this platform says why', (t) => {
  const { io, printed } = machine(t, {});
  io.machine.platform = 'darwin';

  printConfig(io, 'zed');

  assert.match(printed(), /could not establish one, and a guess here would be a file nobody reads/u);
});
