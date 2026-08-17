/**
 * The command: find every MCP client on this machine, write our entry into each
 * one, and say honestly what happened to each.
 *
 * Three things this deliberately does not do.
 *
 * It does not touch the memory store. Nothing here produces text a store will
 * hold, so nothing here needs the gate — and because that is a claim rather
 * than an accident, there is a test that enumerates every module reaching
 * `store.js` or `gate.js` and will fail if this one ever joins the list.
 *
 * It does not fetch anything. The table ships with the product. A person
 * installing this must not have their install depend on somebody else's URL
 * being up, which is also why the drift watcher runs weekly in a repository and
 * never here.
 *
 * It does not flatten. The summary reads as three groups — confirmed, written
 * but unconfirmable, and not done — and a client we could not check is in a
 * group that says so rather than being counted with the ones we could. A single
 * line saying "installed into 6 clients" would be the tick this whole phase
 * exists to avoid printing. Three groups is not that: it is the same honesty
 * with the taxonomy taken out of the reader's way.
 *
 * The last thing it prints is the restart list, because that is the last
 * required step of the install and not a footnote. Every client examined needs
 * a restart or an explicit reload; an entry written into a running application
 * is an entry nothing has read.
 */

import {
  clientById,
  configPathFor,
  entryJsonWithName,
  expandPath,
  fillTokens,
  loadClients,
  serverCommand,
} from './clients.js';
import {
  detect,
  INSTALLED_PATH_UNKNOWN,
  NOT_INSTALLED,
  thisMachine,
} from './detect.js';
import {
  editRequest,
  FAILED,
  NOT_WRITTEN,
  REMOVED,
  removeFromClient,
  UNCHANGED,
  WRITTEN,
  writeToClient,
} from './write.js';
import { defaultBackupDir } from './backup.js';
import {
  CONFIG_CONFIRMED,
  CONNECTED,
  IN_FILE,
  UNCHECKED,
  UNVERIFIABLE,
  verifyClient,
} from './verify.js';

/**
 * @typedef {object} Io
 * @property {(text: string) => void} out
 * @property {import('./detect.js').Machine} machine
 * @property {string} backupDir
 * @property {string} now
 * @property {string} name
 * @property {string} command
 * @property {string} serverPath
 * @property {(argv: string[]) => {status: number|null, stdout: string, stderr: string}} [run]
 */

/**
 * @param {Partial<Io>} [overrides]
 * @returns {Io}
 */
export function defaultIo(overrides = {}) {
  const machine = overrides.machine ?? thisMachine();
  const server = serverCommand();

  return {
    out: (text) => process.stdout.write(text),
    machine,
    backupDir: defaultBackupDir(machine.home),
    now: new Date().toISOString(),
    name: loadClients().serverName,
    command: server.command,
    serverPath: server.serverPath,
    ...overrides,
  };
}

/**
 * @typedef {object} Outcome
 * @property {any} client
 * @property {import('./detect.js').Detection} found
 * @property {import('./write.js').WriteResult|null} written
 * @property {import('./verify.js').Verification|null} verified
 */

/**
 * Write to every client that is here, and check every one that can be checked.
 *
 * @param {Io} io
 * @returns {Outcome[]}
 */
export function install(io) {
  /** @type {Outcome[]} */
  const outcomes = [];

  // Every client is looked for before any client is written to, and that is not
  // a tidiness. Installing into one client creates directories, and on a live
  // run `code --add-mcp` created `~/.vscode/extensions` — which the Cline row
  // was then using as evidence that Cline was installed. We wrote a
  // configuration file for a client that has never been on the machine. The
  // row's evidence has been narrowed since, but interleaving the two passes is
  // what made a bad detector into a wrong answer, and separating them means no
  // client can ever be detected on the strength of what installing another one
  // left behind.
  const detected = loadClients().clients.map((client) => ({ client, found: detect(client, io.machine) }));

  for (const { client, found } of detected) {
    if (found.state === NOT_INSTALLED || found.state === INSTALLED_PATH_UNKNOWN) {
      outcomes.push({ client, found, written: null, verified: null });
      continue;
    }

    const options = {
      name: io.name,
      command: io.command,
      serverPath: io.serverPath,
      configPath: /** @type {string} */ (found.configPath),
      clientCommand: found.command,
      backupDir: io.backupDir,
      now: io.now,
      machine: io.machine,
      run: io.run,
    };

    const written = writeToClient(client, options);

    // A write that failed, or that was deliberately not attempted, leaves
    // nothing to verify. Asking anyway would produce a second sentence about
    // the same problem, and for a client that is running it would produce a
    // reassuring one about a file we did not write.
    const verified = written.outcome === FAILED || written.outcome === NOT_WRITTEN
      ? null
      : verifyClient(client, {
        ...options,
        machine: io.machine,
        editRequest: editRequest(client, options),
      });

    outcomes.push({ client, found, written, verified });
  }

  return outcomes;
}

/**
 * Take our entry out of every client that has one.
 *
 * Every client, not only the ones the manifest says we wrote to: an install may
 * have happened from a different copy of this project, or on a machine that has
 * since been restored from a backup, and an uninstall that only undid what this
 * particular run remembered would leave those behind.
 *
 * @param {Io} io
 * @returns {Outcome[]}
 */
export function uninstall(io) {
  /** @type {Outcome[]} */
  const outcomes = [];

  for (const client of loadClients().clients) {
    const found = detect(client, io.machine);

    if (found.configPath === null) {
      outcomes.push({ client, found, written: null, verified: null });
      continue;
    }

    const removed = removeFromClient(client, {
      name: io.name,
      command: io.command,
      serverPath: io.serverPath,
      configPath: found.configPath,
      clientCommand: found.command,
      backupDir: io.backupDir,
      now: io.now,
      run: io.run,
    });

    outcomes.push({ client, found, written: removed, verified: null });
  }

  return outcomes;
}

/**
 * What to paste, and where, for a client we do not carry.
 *
 * Nobody reaches a dead end. A client this table has never heard of costs the
 * person a copy and a paste rather than a bug report and a wait, and the shape
 * printed is the one that is correct in the most places: `mcpServers`, with an
 * explicit `"type": "stdio"`, which is what the draft standard for this file
 * converges on and what every client in the table accepts even where it is
 * optional.
 *
 * Given a client we do know, it prints that client's own shape and its own
 * path instead, which is the same escape hatch for the case where the automatic
 * write failed and somebody wants to finish the job by hand.
 *
 * @param {Io} io
 * @param {string|null} clientId
 */
export function printConfig(io, clientId) {
  const values = { name: io.name, command: io.command, serverPath: io.serverPath };

  if (clientId === null) {
    io.out([
      'Paste this into your client\'s MCP configuration file:',
      '',
      indent(JSON.stringify({
        mcpServers: { [io.name]: { type: 'stdio', command: io.command, args: [io.serverPath] } },
      }, null, 2)),
      '',
      'Most clients call that file mcp.json and keep it under a folder of their',
      'own in your home directory. Some name the top-level key differently:',
      'VS Code and Devin use "servers", Zed uses "context_servers", Goose uses',
      '"extensions" in YAML with `cmd` in place of `command`, and Codex uses TOML.',
      '',
      `To see the exact shape and path for a client this knows about, name it:`,
      `  nosyparker setup --print-config <client>`,
      '',
      `Known: ${loadClients().clients.map((client) => client.id).join(', ')}`,
      '',
      'After pasting, restart the application. None of them re-read this file',
      'while they are running.',
      '',
    ].join('\n'));
    return;
  }

  const client = clientById(clientId);
  if (client === null) {
    io.out(`There is no client called "${clientId}" in the table. Run --print-config with no name for the shape that works nearly everywhere.\n`);
    return;
  }

  const configPath = configPathFor(client, io.machine);

  io.out(`${client.name}\n\n`);

  if (client.entry === null) {
    io.out([
      `${client.name} is written through its own command rather than by editing a file:`,
      '',
      indent(shellCommand(client, values)),
      '',
    ].join('\n'));
  } else if (client.format.startsWith('yaml')) {
    io.out([
      `Add this under \`${client.rootKey}:\` in ${configPath ?? 'its configuration file'}:`,
      '',
      indent(yamlPreview(client, values)),
      '',
    ].join('\n'));
  } else {
    io.out([
      `Add this under "${client.rootKey}" in ${configPath ?? 'its configuration file'}:`,
      '',
      indent(`${JSON.stringify(io.name)}: ${JSON.stringify(fillTokens(client.entry, values), null, 2)}`),
      '',
    ].join('\n'));
  }

  if (configPath === null) {
    io.out(`This table has no path for ${client.name} on ${io.machine.platform}: the research behind it could not establish one, and a guess here would be a file nobody reads.\n\n`);
  }

  // The other surface, where there is one. Two clients have two configuration
  // files apiece — Devin and Kiro, both VS Code forks that added their own
  // agent — and in both cases we write one of them and the other is real. That
  // is a property of the row rather than anything special-cased in code, which
  // is what made the second one cost nothing to add; and this is where somebody
  // who cannot find the entry in their client needs to be told the other file
  // exists.
  for (const other of client.extraConfigPaths ?? []) {
    io.out(`${client.name} has a second MCP configuration file, ${other.status}:\n\n`);
    io.out(`  ${expandPath(other.path, io.machine)}   (key "${other.rootKey}")\n\n`);
    io.out(`  ${other.says}\n\n`);
  }

  if (client.traps.length > 0) {
    io.out(`Worth knowing about ${client.name}:\n\n`);
    for (const trap of client.traps) io.out(`  - ${trap}\n`);
    io.out('\n');
  }

  io.out(`${client.restart}\n`);
}

/**
 * @param {any} client
 * @param {{name: string, command: string, serverPath: string}} values
 * @returns {string}
 */
function shellCommand(client, values) {
  return client.write.argv
    .map((/** @type {string} */ argument) => {
      const filled = argument === '{{entryJsonWithName}}'
        ? entryJsonWithName(client, values)
        : fillTokens(argument, values);
      return /[^A-Za-z0-9_./-]/u.test(filled) ? `'${filled.replaceAll("'", "'\\''")}'` : filled;
    })
    .join(' ');
}

/**
 * @param {any} client
 * @param {{name: string, command: string, serverPath: string}} values
 * @returns {string}
 */
function yamlPreview(client, values) {
  const entry = fillTokens(client.entry, values);
  const lines = [];

  for (const [key, value] of Object.entries(entry)) {
    if (Array.isArray(value)) {
      lines.push(`  ${key}:`);
      for (const item of value) lines.push(`    - ${item}`);
    } else {
      lines.push(`  ${key}: ${value}`);
    }
  }

  return client.format === 'yaml-list'
    ? `- ${lines.join('\n').trimStart()}`
    : `${values.name}:\n${lines.join('\n')}`;
}

/**
 * The report: three groups, not a column of statuses.
 *
 * The six internal statuses are right and they stay. They are just not what a
 * person needs at the end of an install. Eleven rows of vocabulary asks the
 * reader to learn a taxonomy before they can find out whether the thing worked;
 * three groups tells them what to do next, which is the only question they
 * arrived with.
 *
 *   confirmed     the client itself answered us
 *   check these   the entry is in place and this client offers no way to ask
 *   not done      with the reason, and what to do about it
 *
 * The distinction the whole phase is about survives inside the first group, in
 * the clause after each name: one client started the server and said so, and two
 * showed us their parsed config, which is not the same thing and does not
 * pretend to be.
 *
 * The second group gets one line of instruction for all of them, because the
 * check is the same check: open the client and ask the agent something it could
 * only know from the shared memory. That is the only test that works on a client
 * with no read-back, and it is ten seconds.
 *
 * It is said plainly and without apology. Most of these applications have no way
 * to be asked whether they loaded a server. That is a fact about them, not a
 * shortcoming of this install and not a complaint about them either.
 *
 * @param {Io} io
 * @param {Outcome[]} outcomes
 */
export function report(io, outcomes) {
  const here = outcomes.filter((outcome) => outcome.found.state !== NOT_INSTALLED);
  const missing = outcomes.filter((outcome) => outcome.found.state === NOT_INSTALLED);

  const confirmed = here.filter((outcome) => outcome.verified !== null
    && (outcome.verified.status === CONNECTED || outcome.verified.status === CONFIG_CONFIRMED));
  const unconfirmed = here.filter((outcome) => outcome.verified !== null
    && (outcome.verified.status === IN_FILE || outcome.verified.status === UNVERIFIABLE
      || outcome.verified.status === UNCHECKED));
  const notDone = here.filter((outcome) =>
    !confirmed.includes(outcome) && !unconfirmed.includes(outcome));

  io.out(`${confirmed.length + unconfirmed.length} of ${here.length} clients on this machine are wired up.\n\n`);

  if (confirmed.length > 0) {
    io.out(`Confirmed — ${plural(confirmed.length, 'this one', 'these')} answered us:\n\n`);
    for (const outcome of confirmed) {
      io.out(`  ${outcome.client.name} — ${confirmationClause(outcome)}\n`);
      for (const blocker of outcome.verified?.blockers ?? []) {
        io.out(`      One thing that could still stop it: ${blocker}\n`);
      }
    }
    io.out('\n');
  }

  if (unconfirmed.length > 0) {
    io.out(`Written, but unconfirmed — ${unconfirmed.map((outcome) => outcome.client.name).join(', ')}.\n\n`);
    io.out('  These applications offer no way to ask whether they loaded a server. That is a\n');
    io.out('  limitation of theirs, not a sign anything went wrong here. To check one yourself:\n');
    io.out('  open it and ask the agent something it could only know from your shared memory.\n');
    io.out('  If it knows, it is working. Ten seconds.\n\n');
    for (const outcome of unconfirmed) {
      for (const blocker of outcome.verified?.blockers ?? []) {
        io.out(`  ${outcome.client.name} — one thing that could stop it: ${blocker}\n`);
      }
    }
  }

  if (notDone.length > 0) {
    io.out('Not done:\n\n');
    for (const outcome of notDone) io.out(blockFor(outcome));
    io.out('\n');
  }

  if (missing.length > 0) {
    io.out(`Not on this machine: ${missing.map((outcome) => outcome.client.name).join(', ')}.\n\n`);
  }

  const copies = here.filter((outcome) => outcome.written?.backup?.made);
  if (copies.length > 0) {
    io.out(`A copy of each file as it was before this ran is in ${io.backupDir}\n\n`);
  }

  // Said every time an entry is written, and said with the path in it. The
  // entries name one interpreter by its full path, because a client started
  // from a desktop icon has no PATH to find it on — opencode fails with
  // `Connection closed` and nothing else if you give it a bare `node`. The cost
  // of the full path is that a version manager moves it, and when it does,
  // every entry stops working without saying anything.
  if (confirmed.length + unconfirmed.length > 0) {
    io.out(`Those entries start the server with this exact interpreter:\n  ${io.command}\n\n`);
    io.out('  It has to be the full path — an application started from a desktop icon has no\n');
    io.out('  PATH to find `node` on. If you switch or remove that version of Node, nvm and\n');
    io.out('  fnm and asdf all move that directory, the entries stop working with no message,\n');
    io.out('  and running setup again is what fixes it.\n\n');
  }

  const duplicates = duplicateRegistrationWarning(here);
  if (duplicates !== null) io.out(`${duplicates}\n\n`);

  const waiting = here.filter((outcome) => outcome.written?.outcome === NOT_WRITTEN);
  if (waiting.length > 0) {
    io.out(`Quit ${waiting.map((outcome) => outcome.client.name).join(' and ')} and run this again to finish.\n\n`);
  }

  // Only the clients that are actually waiting on a restart. A client in the
  // "not done" group has its own instruction in its own block, and telling
  // somebody to reopen an application that is not going to work yet is telling
  // them to do the wrong thing twice.
  const restarts = [...confirmed, ...unconfirmed]
    .filter((outcome) => outcome.verified?.status !== CONNECTED);

  if (restarts.length === 0) return;

  io.out('Before any of this takes effect, close and reopen these:\n\n');
  for (const outcome of restarts) {
    io.out(`  ${outcome.client.name}\n    ${outcome.client.restart}\n`);
  }
  io.out('\n');
}

/**
 * What it was that answered, for a client that answered.
 *
 * Two different things and two different clauses. One client started our server
 * and reported the connection; two showed us their own parsed configuration
 * with the entry in it, which is worth having and is not the same claim. The
 * grouping puts them together because the reader's next action is the same for
 * both — nothing — and the clause keeps them apart because the claims are not.
 *
 * @param {Outcome} outcome
 * @returns {string}
 */
function confirmationClause({ verified }) {
  return verified?.status === CONNECTED
    ? 'it started the server and reported that it connected'
    : 'it showed us its own parsed config with the entry in it, which is not the same as having started it';
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(count, one, many) {
  return count === 1 ? one : many;
}

/**
 * @param {Outcome} outcome
 * @returns {string}
 */
function blockFor({ client, found, written, verified }) {
  const byHand = `      nosyparker setup --print-config ${client.id} prints what to add by hand.\n`;

  if (found.state === INSTALLED_PATH_UNKNOWN) {
    return `  ${client.name} — it is here, and this table has no configuration path for it on\n`
      + `      ${found.state === INSTALLED_PATH_UNKNOWN ? 'this platform' : 'this platform'}. `
      + 'The research behind it could not establish one, and a\n'
      + '      guess would be a file nobody reads.\n'
      + byHand;
  }

  if (written === null) return `  ${client.name} — nothing was attempted.\n`;

  // The application is running and would overwrite the entry. Nothing is
  // broken and nothing was tried, so this one ends in an instruction rather
  // than an explanation.
  if (written.outcome === NOT_WRITTEN) return `  ${client.name} — ${written.error}\n`;

  if (written.outcome === FAILED) {
    return `  ${client.name} — ${written.error}\n      Nothing was changed.\n${byHand}`;
  }

  // The write landed and the client was asked and said no. The blockers are
  // usually the whole story here — Gemini's folder trust is the one that
  // actually happens — so they come first and in full.
  const lines = [`  ${client.name} — ${verified?.says ?? 'it could not be checked.'}`];
  for (const blocker of verified?.blockers ?? []) lines.push(`      ${blocker}`);
  lines.push(`      The entry is in ${written.path}, so this may only need the block above lifting.`);

  return `${lines.join('\n')}\n`;
}

/**
 * The report for the other direction.
 *
 * It is a different report and not a flag on the first one, because almost
 * every sentence in it is different. There is no verification to do — the thing
 * being checked is an absence, and the check is that the entry is gone and
 * everything else is not. There is no backup to mention: the copy was taken
 * before the first touch and is deliberately left where it is, because it is a
 * copy of the file from before this project existed and is worth more than any
 * state we could restore. And the restart line means the opposite thing: the
 * applications are still holding a server we have just removed from under them.
 *
 * The entry is removed by editing the file even for clients whose entry went in
 * through their own command, so this works on a machine where that command has
 * since been upgraded, moved or deleted.
 *
 * @param {Io} io
 * @param {Outcome[]} outcomes
 */
export function reportRemoval(io, outcomes) {
  const removed = outcomes.filter((outcome) => outcome.written?.outcome === REMOVED);
  const failed = outcomes.filter((outcome) => outcome.written?.outcome === FAILED);

  if (removed.length === 0 && failed.length === 0) {
    io.out('Nothing to remove: no client on this machine has an entry for nosyparker.\n');
    return;
  }

  for (const outcome of removed) {
    io.out(`${outcome.client.name} — removed\n    ${outcome.written?.path}\n\n`);
  }

  for (const outcome of failed) {
    io.out(`${outcome.client.name} — failed\n    ${outcome.written?.error}\n`
      + `    The entry is still in ${outcome.written?.path} and can be deleted by hand.\n\n`);
  }

  io.out('Nothing else in any of those files was touched, and no memory was deleted:\n');
  io.out('your memories are in ~/.nosyparker/memory.sqlite and this command does not open it.\n\n');

  if (removed.length > 0) {
    io.out('These are still running the server until they are closed and reopened:\n\n');
    for (const outcome of removed) io.out(`  ${outcome.client.name}\n`);
    io.out('\n');
  }
}

/**
 * The one cross-client hazard worth a sentence.
 *
 * VS Code 1.133 ships discovery adapters that read Claude Desktop's and
 * Cursor's configuration files, and Devin's bundle carries the same pattern. So
 * installing into those clients can register the server in VS Code a second
 * time, from a file we did not write for VS Code at all. It is not an error and
 * we do not try to prevent it; somebody seeing the same server listed twice
 * deserves to know why.
 *
 * @param {Outcome[]} here
 * @returns {string|null}
 */
function duplicateRegistrationWarning(here) {
  const ids = new Set(here.filter((outcome) => outcome.written?.outcome === WRITTEN
    || outcome.written?.outcome === UNCHANGED).map((outcome) => outcome.client.id));

  const readers = ['vscode', 'devin-desktop'].filter((id) => ids.has(id));
  const read = ['cursor', 'claude-desktop'].filter((id) => ids.has(id));

  if (readers.length === 0 || read.length === 0) return null;

  return 'One thing to expect: VS Code and Devin read other clients\' MCP configuration files as well as\n'
    + 'their own, so the server may appear more than once in their lists. Both copies are this same\n'
    + 'server and neither is a mistake.';
}

/**
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}
