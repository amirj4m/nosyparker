/**
 * Getting our entry into a client, by whichever of the two routes that client's
 * row calls for.
 *
 * Through the client's own CLI where the research found one that genuinely
 * works. A CLI is a maintained interface and a file path is an implementation
 * detail, so where a vendor ships `--add-mcp` it knows things we do not — which
 * profile the user works in, where its own file has moved to since the docs
 * were written. Five rows are written that way.
 *
 * By file where the CLI does not work, and Gemini is why that sentence is not
 * "where there is no CLI". `gemini mcp add` prints that it added the server and
 * writes nothing, anywhere, on any disk. The rule the research settled on is
 * the only one that survives a vendor like that: use a CLI to write only when
 * the result can be read back independently, and never treat its success
 * message as evidence of anything.
 *
 * So both routes end in the same place. Read the file back and look for the
 * entry. A write that returned without an error and did not land is a failure
 * and is reported as one — which is exactly the case a green tick is worst at,
 * because everything that produced it looked fine.
 *
 * For a file we write ourselves there is a stronger check available and it is
 * taken: the text is computed first, written second, and read third, and the
 * three have to be identical. That is what "everything else survives byte for
 * byte" means as an assertion rather than an intention. It also means we notice
 * an application that rewrote the file underneath us between our write and our
 * read — Devin and Claude Desktop both do that while they are running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fillArgv, fillTokens } from './clients.js';
import { backupOnce } from './backup.js';
import { anyRunning } from './detect.js';
import { hasEntry, insertEntry, removeEntry } from './edit.js';

/** The entry went in, and was found again afterwards. */
export const WRITTEN = 'written';

/** It was already there and identical, so nothing was changed. */
export const UNCHANGED = 'unchanged';

/** Something went wrong, and `error` says what in a sentence. */
export const FAILED = 'failed';

/** There was nothing of ours in the file, so nothing to take out. */
export const ABSENT = 'absent';

/** Our entry was taken out. */
export const REMOVED = 'removed';

/**
 * Nothing was written, and nothing went wrong.
 *
 * Its own word rather than a failure, because nothing was attempted and
 * nothing is broken. Two clients rewrite their config from memory while they
 * run, so writing to one of them now would put an entry in a file that the
 * application overwrites minutes later — a success that quietly stops being
 * true. The honest move is to write nothing and say which application to quit.
 */
export const NOT_WRITTEN = 'not-written';

/**
 * @typedef {object} WriteResult
 * @property {string} outcome
 * @property {string} method 'cli' or 'file'
 * @property {string|null} path
 * @property {import('./backup.js').BackupResult|null} backup
 * @property {string|null} error
 */

/**
 * @typedef {object} WriteOptions
 * @property {string} name
 * @property {string} command
 * @property {string} serverPath
 * @property {string} configPath
 * @property {string|null} clientCommand the client's own executable, resolved
 * @property {string} backupDir
 * @property {string} now
 * @property {import('./detect.js').Machine} [machine]
 * @property {(argv: string[]) => {status: number|null, stdout: string, stderr: string}} [run]
 */

/**
 * @param {any} client
 * @param {WriteOptions} options
 * @returns {WriteResult}
 */
export function writeToClient(client, options) {
  const request = editRequest(client, options);

  try {
    const running = client.writeRequiresQuit === undefined || options.machine === undefined
      ? false
      : anyRunning(client.writeRequiresQuit.processes, options.machine);

    if (running === true) {
      return result(client.write.method, options.configPath, null, NOT_WRITTEN,
        `${client.name} is running. ${client.writeRequiresQuit.says} Quit it and run this again.`);
    }

    return client.write.method === 'cli'
      ? writeThroughCli(client, options, request)
      : writeThroughFile(client, options, request);
  } catch (error) {
    return result(client.write.method, options.configPath, null, FAILED, sentence(error));
  }
}

/**
 * Take our entry back out.
 *
 * By the client's own remove command where the row names one and it is still on
 * the machine, and by editing the file otherwise.
 *
 * That order is not a preference, it is a requirement for one client. Claude
 * Code's `~/.claude.json` is the CLI's live state file — it holds the OAuth
 * account, the machine id and every project's history, and the application
 * rewrites it constantly. Editing it by hand is exactly what its own
 * documentation says not to do, and an uninstall that did so would be racing a
 * running application over a file full of things that are not ours.
 *
 * The file remains the fallback, and it is the reason the fallback exists: an
 * uninstall has to work on a machine where the client has since been deleted,
 * upgraded, or moved off PATH, and the file outlives the tool that wrote it.
 *
 * @param {any} client
 * @param {WriteOptions} options
 * @returns {WriteResult}
 */
export function removeFromClient(client, options) {
  const request = editRequest(client, options);

  try {
    const before = readOrEmpty(options.configPath);

    if (client.remove.method === 'cli' && options.clientCommand !== null) {
      if (!hasEntry(before, request)) return result('cli', options.configPath, null, ABSENT, null);

      const argv = fillArgv(client.remove.argv, client, options);
      const run = options.run ?? runCommand;
      const ran = run([options.clientCommand, ...argv.slice(1)]);

      if (ran.status !== 0) {
        return result('cli', options.configPath, null, FAILED,
          `${path.basename(argv[0])} exited ${ran.status}: ${firstLine(ran.stderr || ran.stdout)}`);
      }

      // The same rule as writing: its success message is not evidence.
      if (hasEntry(readOrEmpty(options.configPath), request)) {
        return result('cli', options.configPath, null, FAILED,
          `${path.basename(argv[0])} reported success and the entry is still in ${options.configPath}.`);
      }

      return result('cli', options.configPath, null, REMOVED, null);
    }

    if (!hasEntry(before, request)) return result('file', options.configPath, null, ABSENT, null);

    const after = removeEntry(before, request);
    writePreservingMode(options.configPath, after);

    const readBack = readOrEmpty(options.configPath);
    if (readBack !== after) {
      return result('file', options.configPath, null, FAILED,
        'The file changed between being written and being read back.');
    }
    if (hasEntry(readBack, request)) {
      return result('file', options.configPath, null, FAILED,
        'The entry is still in the file after being removed from it.');
    }

    return result('file', options.configPath, null, REMOVED, null);
  } catch (error) {
    return result('file', options.configPath, null, FAILED, sentence(error));
  }
}

/**
 * @param {any} client
 * @param {WriteOptions} options
 * @param {import('./edit.js').EditRequest} request
 * @returns {WriteResult}
 */
function writeThroughCli(client, options, request) {
  if (options.clientCommand === null) {
    return result('cli', options.configPath, null, FAILED,
      `${client.name} is installed but its own command could not be found, and this client is only written through it.`);
  }

  const backup = backupOnce({
    file: options.configPath,
    clientId: client.id,
    backupDir: options.backupDir,
    now: options.now,
  });

  const run = options.run ?? runCommand;

  // Take our own entry out before putting it back, where the client offers a
  // way to. `claude mcp add` refuses outright — `MCP server nosyparker already
  // exists in user config`, exit 1 — so without this, running setup a second
  // time reports a failure over a client that is working perfectly. And a
  // second run is not an unusual thing to do: the entry names an absolute path
  // to the Node that is running, so upgrading Node is a reason to run it again,
  // and re-adding is the only way that update ever lands.
  if (hasEntry(readOrEmpty(options.configPath), request)
    && client.remove.method === 'cli' && client.remove.argv !== null) {
    run([options.clientCommand, ...fillArgv(client.remove.argv, client, options).slice(1)]);
  }

  const argv = fillArgv(client.write.argv, client, options);
  const ran = run([options.clientCommand, ...argv.slice(1)]);

  if (ran.status !== 0) {
    return result('cli', options.configPath, backup, FAILED,
      `${path.basename(argv[0])} exited ${ran.status}: ${firstLine(ran.stderr || ran.stdout)}`);
  }

  const after = readOrEmpty(options.configPath);
  if (!hasEntry(after, request)) {
    return result('cli', options.configPath, backup, FAILED,
      `${path.basename(argv[0])} reported success and the entry is not in ${options.configPath}.`);
  }

  return result('cli', options.configPath, backup, WRITTEN, null);
}

/**
 * @param {any} client
 * @param {WriteOptions} options
 * @param {import('./edit.js').EditRequest} request
 * @returns {WriteResult}
 */
function writeThroughFile(client, options, request) {
  const before = readOrEmpty(options.configPath);
  const wanted = insertEntry(before, request);

  const backup = backupOnce({
    file: options.configPath,
    clientId: client.id,
    backupDir: options.backupDir,
    now: options.now,
  });

  if (wanted === before) return result('file', options.configPath, backup, UNCHANGED, null);

  writePreservingMode(options.configPath, wanted);

  const readBack = readOrEmpty(options.configPath);
  if (readBack !== wanted) {
    return result('file', options.configPath, backup, FAILED,
      'What is in the file now is not what was written to it. Something else is writing to it; close the application and try again.');
  }
  if (!hasEntry(readBack, request)) {
    return result('file', options.configPath, backup, FAILED,
      'The entry was written and is not in the file.');
  }

  return result('file', options.configPath, backup, WRITTEN, null);
}

/**
 * @param {any} client
 * @param {{name: string, command: string, serverPath: string}} options
 * @returns {import('./edit.js').EditRequest}
 */
export function editRequest(client, options) {
  return {
    format: client.format,
    rootKey: client.rootKey,
    name: options.name,
    entry: client.entry === null ? null : fillTokens(client.entry, options),
  };
}

/**
 * Write a file without changing who may read it.
 *
 * Through a temporary file in the same directory and a rename, so a reader
 * never sees a half-written config; with the original's mode carried over,
 * because several of these files are 0600 and sit beside OAuth token caches,
 * and a config that quietly became world-readable would be a security defect we
 * introduced while being careful about something else. A file we create is 0600
 * for the same reason: these files are allowed to hold API keys in their `env`
 * blocks, and ours is the write that decides the mode.
 *
 * @param {string} file
 * @param {string} text
 */
export function writePreservingMode(file, text) {
  const mode = existingMode(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const temporary = path.join(path.dirname(file), `.nosyparker.${path.basename(file)}.tmp`);
  const handle = fs.openSync(temporary, 'w', mode);
  try {
    fs.writeFileSync(handle, text);
    fs.fchmodSync(handle, mode);
  } finally {
    fs.closeSync(handle);
  }

  fs.renameSync(temporary, file);
}

/**
 * @param {string} file
 * @returns {number}
 */
function existingMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/**
 * @param {string} file
 * @returns {string}
 */
export function readOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {string[]} argv
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function runCommand(argv) {
  const [command, ...rest] = argv;
  const ran = spawnSync(command, rest, { encoding: 'utf8', timeout: 30_000 });

  return {
    status: ran.error ? null : ran.status,
    stdout: ran.stdout ?? '',
    stderr: ran.error ? ran.error.message : (ran.stderr ?? ''),
  };
}

/**
 * @param {string} method
 * @param {string|null} file
 * @param {import('./backup.js').BackupResult|null} backup
 * @param {string} outcome
 * @param {string|null} error
 * @returns {WriteResult}
 */
function result(method, file, backup, outcome, error) {
  return { outcome, method, path: file, backup, error };
}

/**
 * What a client's own tool said, kept to one line.
 *
 * Not the whole of it: these commands read config files that are allowed to
 * hold API keys, and a tool that fails while printing what it just read would
 * otherwise put that on the terminal and into whatever the person pastes into
 * an issue.
 *
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '(it said nothing)';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function sentence(error) {
  return error instanceof Error ? error.message : String(error);
}
