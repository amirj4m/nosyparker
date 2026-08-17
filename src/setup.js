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
 * It does not summarise. Every client gets its own answer in its own words,
 * including the ones that say we wrote a file and cannot tell whether anybody
 * read it. A single line at the end saying "installed into 6 clients" would be
 * the tick this whole phase exists to avoid printing.
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
  ABSENT,
  editRequest,
  FAILED,
  REMOVED,
  removeFromClient,
  UNCHANGED,
  WRITTEN,
  writeToClient,
} from './write.js';
import { defaultBackupDir } from './backup.js';
import { CONNECTED, verifyClient } from './verify.js';

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

  for (const client of loadClients().clients) {
    const found = detect(client, io.machine);

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
      run: io.run,
    };

    const written = writeToClient(client, options);

    // A write that failed leaves nothing to verify, and asking anyway would
    // produce a second sentence about the same problem.
    const verified = written.outcome === FAILED
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
 * The report.
 *
 * One block per client, with the word for what we know first and the sentence
 * that unpacks it underneath. Never a column of ticks: the six words mean six
 * different things and only one of them means the server ran.
 *
 * @param {Io} io
 * @param {Outcome[]} outcomes
 */
export function report(io, outcomes) {
  const here = outcomes.filter((outcome) => outcome.found.state !== NOT_INSTALLED);
  const missing = outcomes.filter((outcome) => outcome.found.state === NOT_INSTALLED);

  io.out(`Looked for ${outcomes.length} clients. Found ${here.length}.\n\n`);

  for (const outcome of here) io.out(blockFor(outcome));

  if (missing.length > 0) {
    io.out(`Not on this machine: ${missing.map((outcome) => outcome.client.name).join(', ')}.\n\n`);
  }

  const duplicates = duplicateRegistrationWarning(here);
  if (duplicates !== null) io.out(`${duplicates}\n\n`);

  const restarts = here.filter((outcome) =>
    outcome.written !== null && outcome.written.outcome !== FAILED
    && outcome.verified?.status !== CONNECTED);

  if (restarts.length === 0) return;

  io.out('Before any of this takes effect, close and reopen these:\n\n');
  for (const outcome of restarts) {
    io.out(`  ${outcome.client.name}\n    ${outcome.client.restart}\n`);
  }
  io.out('\n');
}

/**
 * @param {Outcome} outcome
 * @returns {string}
 */
function blockFor({ client, found, written, verified }) {
  if (found.state === INSTALLED_PATH_UNKNOWN) {
    return `${client.name} — skipped\n`
      + `    It is on this machine, and the table has no configuration path for it on `
      + `${client.configPaths.linux === null ? 'this platform' : 'this platform'}. `
      + `The research behind the table could not establish one, and a guess would be a file nobody reads.\n`
      + `    nosyparker setup --print-config ${client.id} prints what is known.\n\n`;
  }

  if (written === null) return `${client.name} — skipped\n\n`;

  if (written.outcome === FAILED) {
    return `${client.name} — failed\n    ${written.error}\n`
      + `    Nothing was changed. nosyparker setup --print-config ${client.id} prints what to add by hand.\n\n`;
  }

  const lines = [`${client.name} — ${verified?.status ?? written.outcome}`];

  if (verified !== null) {
    lines.push(`    ${verified.says}`);
    if (verified.cannotProve !== null) lines.push(`    It does not prove ${lower(verified.cannotProve)}`);
    for (const blocker of verified.blockers) lines.push(`    It may not load anyway: ${blocker}`);
  }

  if (written.outcome === UNCHANGED) lines.push('    It was already there, so nothing was changed.');
  if (written.outcome === REMOVED) lines.push('    The entry was removed.');
  if (written.outcome === ABSENT) lines.push('    There was nothing of ours to remove.');
  if (written.backup?.made) lines.push(`    A copy of the file as it was is at ${written.backup.backupPath}`);

  lines.push(`    ${written.path}`);

  return `${lines.join('\n')}\n\n`;
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
function lower(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}
