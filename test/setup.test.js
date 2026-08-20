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

import { defaultIo, install, printConfig, refuseNpxCache, report, reportRemoval, uninstall } from '../src/setup.js';
import { ABSENT, REMOVED } from '../src/write.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {object} shape
 * @param {string[]} [shape.files]
 * @param {string[]} [shape.pathDirs]
 * @param {(argv: string[]) => {status: number, stdout: string, stderr: string}} [shape.run]
 * @param {'linux'|'darwin'|'win32'} [shape.platform]
 * @returns {{io: any, printed: () => string, home: string}}
 */
function machine(t, { files = [], pathDirs = [], run, platform = 'linux' } = {}) {
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
      platform,
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

  assert.match(printed(), /0 of 0 clients on this machine are wired up\./u);
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

test('clients that cannot be asked are one group with one instruction', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude_desktop_config.json', '.local/bin/zed', '.cursor/',
      '.config/Devin/'],
    pathDirs: [],
  });

  report(io, install(io));

  // Three clients written by us, none of which can be asked. They are named
  // together on one line rather than given three blocks of near-identical
  // vocabulary, because the reader's next action is the same for all three.
  const group = printed().slice(printed().indexOf('Written, but unconfirmed'));
  for (const name of ['Claude Desktop', 'Zed', 'Cursor']) {
    assert.match(group.split('\n')[0], new RegExp(name, 'u'), name);
  }

  // And the instruction that makes the group actionable, once.
  assert.match(printed(), /open it and ask the agent something it could only know from your shared memory/u);
  assert.equal(printed().match(/Ten seconds\./gu)?.length, 1, 'said once, not per client');

  // Said as a fact about those applications rather than as an apology.
  assert.match(printed(), /a\n  limitation of theirs, not a sign anything went wrong here/u);

  // Devin is here with no config file, and is written through its own command
  // — which is not on this machine, so it lands in "not done" with its reason.
  assert.match(printed(), /Not done:/u);
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

  // The group says an answer came back; the clause says what the answer was.
  assert.match(printed(), /Confirmed — this one answered us:/u);
  assert.match(printed(), /Claude Code — it started the server and reported that it connected/u);
});

test('the three groups are three, and a client appears in exactly one', (t) => {
  const { io, printed } = machine(t, {
    files: ['.local/bin/goose', '.local/bin/zed', '.config/Claude/claude_desktop_config.json'],
    pathDirs: [],
  });

  const wired = {
    ...io,
    machine: { ...io.machine, pathDirs: [path.join(io.machine.home, '.local', 'bin')] },
    run: () => ({ status: 0, stdout: 'extensions:\n  nosyparker:\n    enabled: true\n', stderr: '' }),
  };

  report(wired, install(wired));

  const text = printed();
  assert.match(text, /Confirmed — this one answered us:/u);
  assert.match(text, /Goose — it showed us its own parsed config/u);
  assert.match(text, /Written, but unconfirmed — /u);

  // Goose answered, so it is not also in the group for clients that cannot be
  // asked. The groups partition; they do not overlap.
  const unconfirmed = text.slice(text.indexOf('Written, but unconfirmed')).split('\n')[0];
  assert.doesNotMatch(unconfirmed, /Goose/u);
  assert.match(unconfirmed, /Zed/u);
  assert.match(unconfirmed, /Claude Desktop/u);
});

test('a client that could not be checked is never counted with the ones that were', (t) => {
  // The whole point of the grouping surviving the summary. Codex and Goose are
  // in the confirmed group with a clause that says their config was read back;
  // only Claude Code is allowed the sentence about the server starting.
  const { io, printed } = machine(t, {
    files: ['.local/bin/goose'],
    pathDirs: [],
  });

  const wired = {
    ...io,
    machine: { ...io.machine, pathDirs: [path.join(io.machine.home, '.local', 'bin')] },
    // The real shape. A name line on its own is no longer enough, because a
    // line reporting a problem with our extension has that too.
    run: () => ({ status: 0, stdout: '  extensions:\n    nosyparker:\n      enabled: true\n', stderr: '' }),
  };

  report(wired, install(wired));

  assert.match(printed(), /which is not the same as having started it/u);
  assert.doesNotMatch(printed(), /it started the server and reported/u);
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

  const group = printed().slice(printed().indexOf('Written, but unconfirmed'));
  assert.match(group.split('\n')[0], /VS Code/u);
  assert.match(group.split('\n')[0], /Claude Desktop/u);
  assert.match(printed(), /may appear more than once/u);
});

test('with only one side of it present there is nothing to warn about', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude_desktop_config.json'],
  });

  report(io, install(io));

  assert.match(printed(), /Written, but unconfirmed — Claude Desktop\./u);
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

test('a config file that exists only because we made it goes away again', (t) => {
  // The other half of "never remove what we did not add". A file for a client
  // that had none, and the directories made to hold it, are things we did add.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install(io);
  assert.equal(fs.existsSync(settings), true);

  uninstall(io);

  assert.equal(fs.existsSync(settings), false, 'no empty shell left behind');
  assert.equal(fs.existsSync(path.join(home, '.gemini')), true, 'and their directory is still theirs');
});

test('the directories we made to hold it go too, or a client stays detected for ever', (t) => {
  // This is the Cline case. A run created
  // .../globalStorage/saoudrizwan.claude-dev/settings/ for a client that was
  // never installed, and after uninstalling, that directory was still the
  // evidence that it was.
  const { io, home } = machine(t, {
    files: ['.config/Code/User/globalStorage/saoudrizwan.claude-dev/'],
  });
  const settings = path.join(home, '.config', 'Code', 'User', 'globalStorage',
    'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');

  install(io);
  assert.equal(fs.existsSync(settings), true);

  uninstall(io);

  assert.equal(fs.existsSync(path.dirname(settings)), false, 'the settings directory was ours');
  assert.equal(
    fs.existsSync(path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')),
    true,
    'the extension\'s own directory was not',
  );
});

test('scaffolding a client wrote for itself does not save a file we caused', (t) => {
  // The case that made the first version of this rule too narrow. VS Code's and
  // Devin's own --add-mcp write `"inputs": []` beside the servers object, in
  // their own tab indentation. Neither is something we asked for or could have
  // predicted, and on a real machine both files survived their own uninstall
  // because of it — on a machine where neither file had existed an hour before.
  const { io, home } = machine(t, { files: ['.local/bin/code'] });
  const mcp = path.join(home, '.config', 'Code', 'User', 'mcp.json');

  const wired = {
    ...io,
    machine: { ...io.machine, pathDirs: [path.join(home, '.local', 'bin')] },
    run: (/** @type {string[]} */ argv) => {
      const { name, ...entry } = JSON.parse(argv[2]);
      fs.mkdirSync(path.dirname(mcp), { recursive: true });
      fs.writeFileSync(mcp, `{\n\t"servers": {\n\t\t${JSON.stringify(name)}: ${JSON.stringify(entry)}\n\t},\n\t"inputs": []\n}`);
      return { status: 0, stdout: '', stderr: '' };
    },
  };

  assert.equal(install(wired).find((outcome) => outcome.client.id === 'vscode')?.written?.outcome, 'written');
  assert.equal(fs.existsSync(mcp), true);

  // Removal leaves `{"servers":{},"inputs":[]}`, which holds nothing anybody
  // would miss, in a file that did not exist before we ran.
  const removed = { ...wired, run: () => ({ status: 0, stdout: '', stderr: '' }) };
  uninstall(removed);

  assert.equal(fs.existsSync(mcp), false);
});

test('an empty container is not the same as an empty-named entry', (t) => {
  // `{"servers":{"theirs":{}}}` holds something: somebody named `theirs`. The
  // check is conservative in exactly one direction — it may leave a file that
  // was in fact empty, and must never remove one that was not.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install(io);

  const held = JSON.parse(fs.readFileSync(settings, 'utf8'));
  held.mcpServers.theirs = {};
  fs.writeFileSync(settings, JSON.stringify(held));

  uninstall(io);

  assert.equal(fs.existsSync(settings), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { mcpServers: { theirs: {} } });
});

test('a comment in a file we created keeps that file, because a person wrote it', (t) => {
  const { io, home } = machine(t, { files: ['.local/bin/zed'] });
  const settings = path.join(home, '.config', 'zed', 'settings.json');

  install(io);

  const text = fs.readFileSync(settings, 'utf8');
  fs.writeFileSync(settings, `// I turned this off on purpose\n${text}`);

  uninstall(io);

  assert.equal(fs.existsSync(settings), true);
  assert.match(fs.readFileSync(settings, 'utf8'), /I turned this off on purpose/u);
});

test('a file with one byte of somebody else\'s in it stays, however empty of ours', (t) => {
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');

  install(io);

  const withTheirs = JSON.parse(fs.readFileSync(settings, 'utf8'));
  withTheirs.theme = 'dark';
  fs.writeFileSync(settings, JSON.stringify(withTheirs, null, 2));

  uninstall(io);

  // The file stays, because a person's `theme` is in it. The empty mcpServers
  // container does not, because that key was not in the file before we ran and
  // is as much ours to take back as the entry inside it was.
  assert.equal(fs.existsSync(settings), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { theme: 'dark' });
});

test('a container that was already in the file is left where it is', (t) => {
  // The other side of the same rule, and the one that has to hold: an empty
  // `mcpServers` a person wrote themselves is not ours to tidy away.
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');
  fs.writeFileSync(settings, '{\n  "mcpServers": {},\n  "theme": "dark"\n}\n');

  install(io);
  uninstall(io);

  const after = fs.readFileSync(settings, 'utf8');
  assert.match(after, /"mcpServers"/u, 'their key survived');
  assert.match(after, /"theme": "dark"/u, 'and so did the line after it');
  assert.deepEqual(JSON.parse(after), { mcpServers: {}, theme: 'dark' });

  // The one thing that does not come back exactly. Inserting into an object
  // written as `{}` opens it onto two lines, and removing our entry leaves it
  // open. Restoring that would mean having recorded the whitespace inside it,
  // and the alternative — collapsing any empty object we find — is guessing at
  // somebody's formatting rather than restoring it. So the guarantee is stated
  // where it actually holds: every byte outside the container our entry goes
  // into is untouched, and the container's own interior whitespace is not
  // covered by it.
  assert.equal(after, '{\n  "mcpServers": {\n  },\n  "theme": "dark"\n}\n');
});

test('a file that was there before we arrived is never deleted', (t) => {
  const { io, home } = machine(t, { files: ['.gemini/'] });
  const settings = path.join(home, '.gemini', 'settings.json');
  fs.writeFileSync(settings, '{"mcpServers": {}}\n');

  install(io);
  uninstall(io);

  assert.equal(fs.existsSync(settings), true);
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

  assert.match(printed(), /in a folder it does not trust/u);
  assert.match(printed(), /run `\/permissions trust`/u);
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

  const found = printConfig(io, 'some-editor-released-last-tuesday');

  assert.match(printed(), /There is no client called "some-editor-released-last-tuesday"/u);
  assert.match(printed(), /--print-config with no name/u);

  // And it says no to its caller as well as to the reader. It printed something
  // helpful either way, but a script that asked about a client and got a zero
  // has every reason to think it was handed an entry.
  assert.equal(found, false);
});

test('--print-config says yes when it did print an entry', (t) => {
  const { io } = machine(t, {});

  assert.equal(printConfig(io, null), true, 'the shape that works nearly everywhere');
  assert.equal(printConfig(io, 'zed'), true, 'a client written by file');
  assert.equal(printConfig(io, 'claude-code'), true, 'a client written by its own command');
  assert.equal(printConfig(io, 'goose'), true, 'a client whose file is YAML');
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

test('--print-config names the second file, for the clients that have one', (t) => {
  // Two clients have two configuration files apiece, and both are VS Code forks
  // that added their own agent — Devin first, then Kiro. That is a pattern
  // rather than a quirk, and it costs no code: the second surface is a field on
  // the row, so the second client to have one needed a row and nothing else.
  const { io, printed } = machine(t, {});

  printConfig(io, 'kiro');

  assert.match(printed(), /Kiro has a second MCP configuration file/u);
  assert.match(printed(), /\.kiro\/settings\/mcp\.json/u);
  assert.match(printed(), /\(key "mcpServers"\)/u);
  assert.match(printed(), /this is the file to add it to by hand/u);
});

test('--print-config for opencode prints the shape that is unlike all the others', (t) => {
  const { io, printed } = machine(t, {});

  printConfig(io, 'opencode');

  assert.match(printed(), /Add this under "mcp"/u);
  assert.match(printed(), /"type": "local"/u);

  // One array holding the program and its arguments together. Getting this
  // wrong is a hard failure rather than an ignored field.
  assert.match(printed(), /"command": \[\n\s+"\/usr\/bin\/node",\n\s+"\/srv\/mcp-server\.js"\n\s+\]/u);
  assert.doesNotMatch(printed(), /"args"/u);
});

test('--print-config for a client with no path on this platform says why', (t) => {
  const { io, printed } = machine(t, {});
  io.machine.platform = 'darwin';

  printConfig(io, 'zed');

  assert.match(printed(), /could not establish one, and a guess here would be a file nobody reads/u);
});

test('a read-only config is not reported as an application to quit', (t) => {
  // `not-written` has two causes and they want opposite things done. Selecting
  // the closing line on the outcome told somebody to quit Cursor, which was not
  // running — its configuration file was read-only.
  const { io, printed, home } = machine(t, { files: ['.cursor/', '.config/Claude/claude_desktop_config.json'] });

  const cursor = path.join(home, '.cursor', 'mcp.json');
  fs.writeFileSync(cursor, '{"mcpServers": {}}\n');
  fs.chmodSync(cursor, 0o444);

  const wired = {
    ...io,
    machine: { ...io.machine, processes: () => ['claude-desktop'] },
  };

  report(wired, install(wired));

  // Two clients, both not written, for two different reasons — and each gets
  // the instruction that matches its own.
  assert.match(printed(), /Quit Claude Desktop and run this again to finish\./u);
  assert.match(printed(), /The configuration file for Cursor is read-only\./u);

  // The thing that was wrong: Cursor must not appear in the quit line.
  const quit = printed().split('\n').find((line) => line.startsWith('Quit ')) ?? '';
  assert.doesNotMatch(quit, /Cursor/u);
});

test('two applications running are named together, as before', (t) => {
  const { io, printed } = machine(t, {
    files: ['.config/Claude/claude_desktop_config.json', '.local/Devin/', '.config/Devin/'],
  });

  const wired = {
    ...io,
    machine: { ...io.machine, processes: () => ['claude-desktop', 'devin-desktop'] },
  };

  report(wired, install(wired));

  // Named in the table's order, which puts Devin before Claude Desktop.
  assert.match(printed(), /Quit Devin Desktop \(formerly Windsurf\) and Claude Desktop and run this again/u);
  assert.doesNotMatch(printed(), /read-only/u);
});

test('uninstall cleans a second file the client wrote for itself, not only ours', (t) => {
  // The Cursor case, end to end. `cursor --add-mcp` puts the entry in
  // ~/.config/Cursor/User/settings.json under `mcp` -> `servers`; we write
  // ~/.cursor/mcp.json. Before this, uninstall cleaned ours and left theirs —
  // an entry we caused, pointing at a path a reinstall makes stale, in a file
  // we never told anybody we had touched.
  const { io, home } = machine(t, { files: ['.cursor/', '.config/Cursor/User/'] });

  const ours = path.join(home, '.cursor', 'mcp.json');
  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');

  fs.writeFileSync(ours, JSON.stringify({
    mcpServers: { nosyparker: { command: '/usr/bin/node', args: ['/srv/mcp-server.js'] } },
  }, null, 2));
  fs.writeFileSync(theirs, [
    '{',
    '\t"window.autoDetectColorScheme": true,',
    '\t"mcp": {',
    '\t\t"servers": {',
    '\t\t\t"nosyparker": {',
    '\t\t\t\t"command": "/usr/bin/node"',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
  ].join('\n'));

  uninstall(io);

  assert.equal(fs.readFileSync(ours, 'utf8').includes('nosyparker'), false, 'our own file');
  assert.equal(fs.readFileSync(theirs, 'utf8').includes('nosyparker'), false,
    'the file cursor --add-mcp wrote is still holding the entry');

  const left = fs.readFileSync(theirs, 'utf8');
  assert.match(left, /"window\.autoDetectColorScheme": true/u, 'his own setting must survive');
  assert.ok(left.includes('\t'), 'the tabs it was written with must survive');
  assert.doesNotThrow(() => JSON.parse(left));
});

test('setup refuses to write a path inside an npx cache, rather than writing one that rots', (t) => {
  // The hazard that kept `bin` out of 0.0.1, now that `bin` is in. It is real
  // but it is not what DECISIONS.md said it was: `npm cache clean --force`
  // removes `_cacache` and leaves `_npx` alone, measured on npm 10.9.8. What
  // actually rots is subtler — `npx nosyparker` and `npx nosyparker@0.0.3`
  // resolve to different `_npx/<hash>` directories, so a config written by one
  // keeps pointing at a copy that still exists and is silently a version behind
  // for ever.
  //
  // Either way it is a cache, npm promises nothing about it, and twenty config
  // files pointing into one is not something to do quietly. So it is refused.
  const { io } = machine(t, {
    files: ['.cursor/'],
  });

  io.serverPath = '/home/somebody/.npm/_npx/c4ff8d2d86f44296/node_modules/nosyparker/src/mcp-server.js';

  assert.throws(() => install(io), /npx/iu,
    'installing from an npx cache should refuse, not write twenty rotting paths');

  assert.equal(fs.existsSync(path.join(io.machine.home, '.cursor', 'mcp.json')), false,
    'nothing should have been written');
});

test('an ordinary path is not mistaken for an npx cache', (t) => {
  const { io } = machine(t, { files: ['.cursor/'] });

  // A global install, which is the recommended route, and a checkout. Neither
  // is a cache and neither may be refused: a guard that fires on the ordinary
  // case is worse than no guard.
  for (const good of [
    '/usr/lib/node_modules/nosyparker/src/mcp-server.js',
    '/home/somebody/.nvm/versions/node/v22.23.2/lib/node_modules/nosyparker/src/mcp-server.js',
    '/home/somebody/projects/nosyparker/src/mcp-server.js',
    '/home/somebody/_npxproject/src/mcp-server.js',
  ]) {
    io.serverPath = good;
    assert.doesNotThrow(() => install(io), `${good} should be allowed`);
  }
});

test('a second surface that cannot be cleaned does not stop the rest of the uninstall', (t) => {
  // Found by sweeping this branch's own new code for the shape that produced
  // the last three defects: something that claims to have done a thing without
  // checking. `cleanSecondSurfaces` wrote and logged "removed" without reading
  // the file back, and any failure in it came straight out of `uninstall` — so
  // one unwritable directory aborted the whole command and left every other
  // client's entry in place. Worse than the orphan it was added to remove.
  const { io, home } = machine(t, { files: ['.cursor/', '.config/Cursor/User/'] });

  const ours = path.join(home, '.cursor', 'mcp.json');
  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');

  fs.writeFileSync(ours, JSON.stringify({
    mcpServers: { nosyparker: { command: '/usr/bin/node' } },
  }, null, 2));
  fs.writeFileSync(theirs, '{\n\t"mcp": {\n\t\t"servers": {\n\t\t\t"nosyparker": {}\n\t\t}\n\t}\n}');

  fs.chmodSync(path.dirname(theirs), 0o500);
  try {
    assert.doesNotThrow(() => uninstall(io), 'one unwritable surface must not abort the command');
    assert.equal(fs.readFileSync(ours, 'utf8').includes('nosyparker'), false,
      'the client we can clean must still be cleaned');
  } finally {
    // Restored here rather than in an `after` hook: the hook that removes the
    // whole temporary home runs first, and chmod on a deleted path throws.
    fs.chmodSync(path.dirname(theirs), 0o700);
  }
});

test('a second surface the person marked read-only is left alone, like every other config', (t) => {
  // The primary path refuses to touch a read-only config on purpose — an atomic
  // write would replace it anyway and leave the permissions looking untouched,
  // so read-only is taken to mean what it says. The second-surface path went
  // round that and rewrote the file.
  const { io, home } = machine(t, { files: ['.config/Cursor/User/'] });

  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
  const before = '{\n\t"mcp": {\n\t\t"servers": {\n\t\t\t"nosyparker": {}\n\t\t}\n\t}\n}';
  fs.writeFileSync(theirs, before);
  fs.chmodSync(theirs, 0o444);

  try {
    uninstall(io);
    assert.equal(fs.readFileSync(theirs, 'utf8'), before,
      'a read-only file must be left exactly as it was');
  } finally {
    fs.chmodSync(theirs, 0o644);
  }
});

test('cleaning a second surface is backed up, recorded, and reported like every other edit', (t) => {
  // The injury this project exists to avoid, found by an independent review.
  // `cleanSecondSurfaces` rewrote the file where a person keeps their font size
  // and colour theme, took no backup, wrote no manifest row, and the command
  // printed "Nothing to remove". Every other file we edit goes through
  // `recordFirstTouch` first; this path called `writePreservingMode` directly.
  // `.cursor/` too, so Cursor is *detected*. Without it the client falls down
  // uninstall's not-on-this-machine branch, and the first version of this test
  // passed through that branch while the ordinary one silently dropped the
  // report. Second time this exact vacuity has bitten in this branch.
  const { io, home, printed } = machine(t, { files: ['.config/Cursor/User/', '.cursor/'] });

  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
  const before = '{\n\t"editor.fontSize": 13,\n\t"mcp": {\n\t\t"servers": {\n\t\t\t"nosyparker": {}\n\t\t}\n\t}\n}';
  fs.writeFileSync(theirs, before);

  // The real path: the terminal runs `reportRemoval(io, uninstall(io))`.
  reportRemoval(io, uninstall(io));

  assert.equal(fs.readFileSync(theirs, 'utf8').includes('nosyparker'), false, 'the entry should go');

  // A copy of what was there, taken before the first change, exactly as for
  // every other config this program edits.
  const manifest = path.join(io.backupDir, 'manifest.json');
  assert.ok(fs.existsSync(manifest), 'no manifest row was written for a file we edited');

  const rows = Object.values(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  const row = rows.find((/** @type {any} */ r) => r.path === theirs);
  assert.ok(row, 'the file we edited is not in the manifest');
  assert.ok(row.backup, 'no backup was taken of a file we edited');
  assert.equal(fs.readFileSync(row.backup, 'utf8'), before, 'the backup is not what was there');

  // And the row says what the file said. This field was hardcoded `true` once;
  // computing it is only worth anything if the computed value is the one that
  // lands, and a manifest row outlives the run that wrote it. Note that true is
  // the only answer reachable through this surface today — our entry cannot be
  // inside a container that is absent — so what this holds is that the value
  // comes off the file at all. The false case waits on a second surface we
  // create ourselves, and there is not one yet.
  assert.equal(row.rootKeyExisted, true,
    'the manifest does not record that their `mcp` block was already there');

  // And the person is told. "Nothing to remove" while having just edited their
  // editor settings is the part that made this the worst finding on the list.
  const said = printed();
  assert.equal(said.includes('Nothing to remove'), false, 'it said it did nothing');
  assert.match(said, /settings\.json/u, 'the file it edited is not named in the output');
});

test('uninstall run twice is not an error, even when they pasted a copy by hand', (t) => {
  // Measured by the third review, on a primary config rather than a second
  // surface. `setup --print-config` prints an entry for somebody to paste, and
  // pasting it at the wrong level is the mistake that invites. Install,
  // uninstall, uninstall: the first run takes our entry and the container we
  // made for it, and on the second all three conditions guarding the "our table
  // is wrong" message are true again — we wrote here, there is no container,
  // and the name is a key. The README says running it twice is not an error.
  const { io, home } = machine(t, { files: ['.cursor/'] });
  const theirs = path.join(home, '.cursor', 'mcp.json');

  install(io);
  assert.match(fs.readFileSync(theirs, 'utf8'), /nosyparker/u, 'setup wrote nothing to work with');

  // Their copy, at a level we do not look at, exactly as pasted.
  const withPaste = JSON.parse(fs.readFileSync(theirs, 'utf8'));
  withPaste.projects = { '/w': { nosyparker: { command: '/usr/bin/node' } } };
  fs.writeFileSync(theirs, JSON.stringify(withPaste, null, 2));

  const first = uninstall(io).find((o) => o.client.id === 'cursor');
  assert.equal(first?.written?.outcome, REMOVED, 'the first uninstall did not remove our entry');

  const second = uninstall(io).find((o) => o.client.id === 'cursor');
  assert.equal(second?.written?.outcome, ABSENT,
    `the second uninstall said "${second?.written?.error}"`);

  // And their paste is still theirs.
  assert.match(fs.readFileSync(theirs, 'utf8'), /projects/u, 'their own entry was touched');
});

test('an empty container in their settings is nothing to do, not an accusation', (t) => {
  // Measured by the third review. `removeEntry` carried its own copy of the
  // guess that fix #1 gated at the other end of the program — `usedAsKey` over
  // raw text, no comment stripping, no manifest, no root-key check — and
  // `cleanSecondSurfaces` is its caller, so it ran over somebody's editor
  // settings. A `settings.json` holding an empty `"mcp": {"servers": {}}`
  // produced "nosyparker is in this file but not under mcp.servers... a bug in
  // the table... report it". There is nothing to report and nothing to do.
  //
  // The first version of this listed an empty container with our name nowhere in
  // the file, which could not have accused anything under any implementation —
  // `usedAsKey` had nothing to match. It passed with the defect restored. The
  // cases below each put the name somewhere that is not under the container,
  // which is the only way to reach the code being tested, plus the plain no-op
  // to prove silence is not coming from the name being absent.
  for (const [what, before] of [
    ['an empty container, our name at another level',
      '{\n\t"editor.fontSize": 13,\n\t"mcp": {\n\t\t"servers": {}\n\t},\n'
      + '\t"other": {\n\t\t"nosyparker": {}\n\t}\n}'],
    ['a comment',
      '{\n\t// nosyparker: I took this out myself\n\t"mcp": {\n\t\t"servers": {}\n\t}\n}'],
    ['an empty container and nothing of ours at all',
      '{\n\t"editor.fontSize": 13,\n\t"mcp": {\n\t\t"servers": {}\n\t}\n}'],
  ]) {
    const { io, home, printed } = machine(t, { files: ['.config/Cursor/User/', '.cursor/'] });
    const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
    fs.writeFileSync(theirs, before);

    reportRemoval(io, uninstall(io));

    assert.equal(fs.readFileSync(theirs, 'utf8'), before, `${what}: their file was changed`);
    const said = printed();
    assert.doesNotMatch(said, /bug in the (client )?table/u, `${what}: it accused the table`);
    assert.doesNotMatch(said, /Report it/u, `${what}: it asked them to report a non-problem`);
    assert.doesNotMatch(said, /settings\.json/u, `${what}: it named a file it did not touch`);
  }
});

test('a second surface is looked for where that platform keeps it', (t) => {
  // The path is a three-platform map, and the code indexes it by the platform
  // it is running on. Every other test here runs on the Linux entry, so a
  // mutation reading `path.linux` outright was invisible: it is the correct
  // answer on the machine the suite runs on and wrong everywhere else. The
  // macOS and Windows rows are inferred from where those builds of VS Code
  // keep user settings, not measured — `measuredOn` says so, and this test
  // holds the indexing, not the paths.
  const { io, home } = machine(t, {
    platform: 'darwin',
    files: ['Library/Application Support/Cursor/User/', '.cursor/'],
  });

  const theirs = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
  fs.writeFileSync(theirs, '{\n\t"mcp": {\n\t\t"servers": {\n\t\t\t"nosyparker": {}\n\t\t}\n\t}\n}');

  reportRemoval(io, uninstall(io));

  assert.equal(fs.readFileSync(theirs, 'utf8').includes('nosyparker'), false,
    'the macOS surface was not cleaned on a macOS machine');
});

test('one bad second surface is one client failing, not the whole command', (t) => {
  // The defect a previous commit was written to fix and did not. The errno
  // filter rethrew anything without a `code`, and the two errors this path
  // raises deliberately have none — so our own "the table is wrong" refusal
  // aborted the command at client 11 of 20 and left the rest wired.
  const { io, home, printed } = machine(t, {
    files: ['.config/Cursor/User/', '.cursor/', '.config/zed/'],
  });

  // Our name where `mcp.servers` cannot reach it: `removeEntry` refuses, loudly.
  fs.writeFileSync(path.join(home, '.config', 'Cursor', 'User', 'settings.json'),
    '{\n\t"nosyparker": "why not",\n\t"mcp": { "servers": {} }\n}');

  const zed = path.join(home, '.config', 'zed', 'settings.json');
  fs.writeFileSync(zed, '{\n  "context_servers": {\n    "nosyparker": { "command": "/usr/bin/node" }\n  }\n}');

  assert.doesNotThrow(() => reportRemoval(io, uninstall(io)), 'one surface must not abort the command');
  assert.equal(fs.readFileSync(zed, 'utf8').includes('nosyparker'), false,
    'a client after the failing one was left wired');
  assert.match(printed(), /settings\.json/u, 'the failure names no file');
});

test('the npx guard knows a Windows cache path too', () => {
  // `invocation()` has an explicit Windows branch; this had a POSIX-only
  // pattern beside it, so the same package run through npx on Windows would
  // have written twenty entries into a cache the guard could not see.
  for (const cache of [
    '/home/somebody/.npm/_npx/c4ff8d2d/node_modules/nosyparker/src/mcp-server.js',
    'C:\\Users\\somebody\\AppData\\Local\\npm-cache\\_npx\\c4ff8d2d\\node_modules\\nosyparker\\src\\mcp-server.js',
  ]) {
    assert.throws(() => refuseNpxCache(cache), /npx/iu, `${cache} should be refused`);
  }

  for (const fine of [
    'C:\\Program Files\\nodejs\\node_modules\\nosyparker\\src\\mcp-server.js',
    '/usr/lib/node_modules/nosyparker/src/mcp-server.js',
    'C:\\projects\\_npxproject\\src\\mcp-server.js',
  ]) {
    assert.doesNotThrow(() => refuseNpxCache(fine), `${fine} should be allowed`);
  }
});

test('a write that leaves the entry behind is caught, not reported as removed', (t) => {
  // The read-back after writing a second surface was held by nothing: deleting
  // it changed no test. Forced here with a file that names our server twice
  // under the same key — which JSON permits textually and a hand-edited config
  // can easily contain. `removeMemberFrom` takes the first, the second stays,
  // and without the read-back the command would report a clean removal.
  const { io, home, printed } = machine(t, { files: ['.config/Cursor/User/', '.cursor/'] });

  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
  fs.writeFileSync(theirs, [
    '{',
    '\t"mcp": {',
    '\t\t"servers": {',
    '\t\t\t"nosyparker": { "command": "/one" },',
    '\t\t\t"nosyparker": { "command": "/two" }',
    '\t\t}',
    '\t}',
    '}',
  ].join('\n'));

  reportRemoval(io, uninstall(io));

  assert.match(fs.readFileSync(theirs, 'utf8'), /nosyparker/u, 'one copy is still in the file');
  assert.doesNotMatch(printed(), /also removed from a file its own command wrote/u,
    'it reported a clean removal while the entry was still there');
  assert.match(printed(), /could not clean/u, 'the failure was not reported');
});

test('a second surface with nothing of ours in it is not touched, backed up, or claimed', (t) => {
  // The first review's worst finding, one deleted line away and held by nobody.
  // Removing `if (after === before) continue;` leaves all 441 tests green while
  // uninstall rewrites a settings.json holding only somebody's font size and
  // colour theme, takes a backup of it, and reports having removed something
  // that was never there.
  const { io, home, printed } = machine(t, { files: ['.config/Cursor/User/', '.cursor/'] });

  const theirs = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
  const before = '{\n\t"editor.fontSize": 13,\n\t"workbench.colorTheme": "Solarized Light"\n}\n';
  fs.writeFileSync(theirs, before);
  const stamp = fs.statSync(theirs).mtimeMs;

  reportRemoval(io, uninstall(io));

  assert.equal(fs.readFileSync(theirs, 'utf8'), before, 'the file was rewritten');
  assert.equal(fs.statSync(theirs).mtimeMs, stamp, 'the file was touched');
  assert.equal(fs.existsSync(io.backupDir), false, 'a backup was taken of a file we never edited');
  assert.match(printed(), /Nothing to remove/u, 'it claimed to have removed something');
});
