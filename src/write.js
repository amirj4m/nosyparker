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
 *
 * What this refuses to write, and the three things it deliberately does not
 * refuse, are listed together in DECISIONS.md under "What Phase 3 refuses to
 * write, and why" — each one is there because something was found, and the list
 * is more use in one place than spread across the checks that enforce it.
 *
 * One boundary on that guarantee, stated because it is real and small rather
 * than left to be discovered. Every byte outside the container our entry goes
 * into is untouched, across the whole round trip. The container's own interior
 * whitespace is not: a `"mcpServers": {}` written on one line opens onto two
 * when our entry goes in, and stays open when it comes out. Closing it again
 * would mean having recorded the whitespace that was inside it, and the cheap
 * alternative — collapsing any empty object we find — is guessing at somebody's
 * formatting rather than restoring it. A container that was not there at all
 * before we ran is removed entirely, which is the case that actually mattered.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { fillArgv, fillTokens, invocation } from './clients.js';
import { manifestRowFor, recordFirstTouch, recordRemoval } from './backup.js';
import { anyRunning } from './detect.js';
import { noLog } from './log.js';
import {
  canEdit,
  hadRootKey,
  hasEntry,
  insertEntry,
  removeEmptyRootKey,
  removeEntry,
  stripComments,
  usedAsKey,
  withoutBom,
  withoutTrailingCommas,
} from './edit.js';

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

/** Why nothing was written: the application would overwrite it. */
export const RUNNING = 'running';

/** Why nothing was written: somebody set the file read-only. */
export const READ_ONLY = 'read-only';

/**
 * @typedef {object} WriteResult
 * @property {string} outcome
 * @property {string} method 'cli' or 'file'
 * @property {string|null} path
 * @property {import('./backup.js').BackupResult|null} backup
 * @property {string|null} error
 * @property {string|null} reason why, for an outcome that has more than one
 *   cause — `not-written` happens both because an application is running and
 *   because a file is read-only, and those need different things done about
 *   them
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
 * @property {import('./log.js').Log} [log] where to record what was touched
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
      log(options).record('refused', { client: client.id, path: options.configPath, reason: RUNNING });
      return result(client.write.method, options.configPath, null, NOT_WRITTEN,
        `${client.name} is running. ${client.writeRequiresQuit.says} Quit it and run this again.`,
        RUNNING);
    }

    const protectedFile = readOnlyRefusal(client, options.configPath);
    if (protectedFile !== null) {
      log(options).record('refused', { client: client.id, path: options.configPath, reason: READ_ONLY });
      return result(client.write.method, options.configPath, null, NOT_WRITTEN, protectedFile, READ_ONLY);
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

    const protectedFile = readOnlyRefusal(client, options.configPath);
    if (protectedFile !== null && hasEntry(before, request)) {
      return result('file', options.configPath, null, NOT_WRITTEN, protectedFile, READ_ONLY);
    }

    if (client.remove.method === 'cli' && options.clientCommand !== null) {
      if (!hasEntry(before, request)) return absentOrOutOfReach(before, options, request, 'cli');

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

      log(options).record('removed', { client: client.id, path: options.configPath, by: path.basename(argv[0]) });
      removeWhatWasOnlyEverOurs(client, options, request);
      return result('cli', options.configPath, null, REMOVED, null);
    }

    if (!hasEntry(before, request)) return absentOrOutOfReach(before, options, request);

    // The fallback exists so an uninstall works on a machine where the client
    // has been deleted, upgraded or moved off PATH. For one client it cannot:
    // Codex's file is TOML, which this project has no writer for, because Codex
    // has always written its own. Saying so with the path and the section name
    // is worth more than an internal sentence about formats.
    if (!canEdit(client.format)) {
      return result('file', options.configPath, null, FAILED,
        `${client.name} is normally unwired with its own command, which is not on this machine, `
        + `and its configuration is ${client.format.toUpperCase()}, which this cannot edit. `
        + `Remove the [${client.rootKey}.${options.name}] section from ${options.configPath} by hand, `
        + 'or put that command back and run this again.');
    }

    // Our entry, and then the container we put it in if that was ours too. A
    // file that already existed is never deleted, but leaving an empty
    // `mcpServers` key in it that was not there before is still a change we
    // made and did not reverse — observed in three real files before this was
    // closed.
    const row = manifestRowFor(options.configPath, options.backupDir);
    const after = row !== null && !row.rootKeyExisted
      ? removeEmptyRootKey(removeEntry(before, request), request)
      : removeEntry(before, request);

    writePreservingMode(options.configPath, after);
    log(options).record('removed', {
      client: client.id, path: options.configPath, by: 'us', was: before.length, now: after.length,
    });

    const readBack = readOrEmpty(options.configPath);
    if (readBack !== after) {
      return result('file', options.configPath, null, FAILED,
        'The file changed between being written and being read back.');
    }

    // It came out, and it worked. Written down because the second `uninstall`
    // cannot otherwise tell an ordinary repeat from a table that names the
    // wrong file — see `recordRemoval`.
    recordRemoval(options.configPath, options.backupDir);
    if (hasEntry(readBack, request)) {
      return result('file', options.configPath, null, FAILED,
        'The entry is still in the file after being removed from it.');
    }

    removeWhatWasOnlyEverOurs(client, options, request);
    return result('file', options.configPath, null, REMOVED, null);
  } catch (error) {
    return result('file', options.configPath, null, FAILED, sentence(error));
  }
}

/**
 * A file that exists only because we ran, and now holds nothing.
 *
 * The rule everywhere else is that we never remove what we did not add. This is
 * the other half of the same rule: a config file for a client that had none, an
 * empty `mcpServers` object nobody wrote, and a directory tree made to hold
 * them are things we did add, and leaving them behind is not "everything else
 * untouched" — it is litter that outlives the install.
 *
 * It bit us. A run created `.../globalStorage/saoudrizwan.claude-dev/` for
 * Cline, and after uninstalling, that directory was still the evidence that
 * Cline was installed. The next setup would have found it again.
 *
 * Two conditions, and both have to hold.
 *
 * **The file was not there before we ran.** That is read from the manifest,
 * which recorded it at the moment before the first write, because it cannot be
 * established afterwards. A file that was already there is never removed, no
 * matter how empty it looks.
 *
 * **What is left in it holds nothing.** Not "equals a string we can predict" —
 * that was the first version of this and it was too narrow, because the file is
 * not always ours to predict. VS Code's and Devin's own `--add-mcp` write
 * `"inputs": []` alongside the servers object, in their own tab indentation,
 * and neither of those is something we asked for or could have guessed. So the
 * test is on the content: every top-level value must be an empty object or an
 * empty array, and there must be no comments. `{"servers":{},"inputs":[]}`
 * passes. `{"servers":{"theirs":{…}}}` does not, because `servers` has a key.
 * `{"theme":"dark"}` does not, because a string is content. A comment does not,
 * because a person wrote it.
 *
 * The narrower rule and the wider one agree on every case the narrower one
 * covered; the wider one additionally covers scaffolding a client wrote for
 * itself inside a file that exists only because we ran.
 *
 * @param {any} client
 * @param {WriteOptions} options
 * @param {import('./edit.js').EditRequest} request
 */
function removeWhatWasOnlyEverOurs(client, options, request) {
  const row = manifestRowFor(options.configPath, options.backupDir);
  if (row === null || row.existed) return;

  if (!holdsNothing(readOrEmpty(options.configPath), client.format)) return;

  fs.rmSync(options.configPath, { force: true });
  log(options).record('deleted', { client: client.id, path: options.configPath, what: 'file' });

  for (const dir of row.created) {
    try {
      fs.rmdirSync(dir);
      log(options).record('deleted', { client: client.id, path: dir, what: 'directory' });
    } catch {
      return; // something else is in it, and it is not ours to empty
    }
  }
}

/**
 * The log this call was given, or one that goes nowhere.
 *
 * @param {WriteOptions} options
 * @returns {import('./log.js').Log}
 */
function log(options) {
  return options.log ?? noLog();
}

/**
 * Is there anything at all in this file that somebody would miss.
 *
 * Deliberately conservative in one direction only: it is allowed to say "no,
 * there is something here" about a file that is in fact empty, and that costs
 * nothing but a file left behind. It must never say "nothing here" about a file
 * with something in it, because that costs somebody their configuration.
 *
 * So an object holds nothing only when it has no keys at all. A key whose value
 * is an empty object still counts as content — somebody named it — which keeps
 * `{"servers":{"theirs":{}}}` safe even though the entry inside is empty.
 *
 * @param {string} text
 * @param {string} format
 * @returns {boolean}
 */
function holdsNothing(text, format) {
  if (text.trim() === '') return true;

  // YAML and TOML are not parsed anywhere in this project, so anything left in
  // one of those beyond whitespace is treated as content. Our own removal takes
  // the block header with it, so a file that was only ever ours ends up blank
  // and is caught by the line above.
  if (format !== 'json' && format !== 'jsonc') return false;

  // A comment is something a person wrote, and it survives everything else here
  // precisely so that it can.
  const stripped = stripComments(text);
  if (stripped !== text) return false;

  let parsed;
  try {
    parsed = JSON.parse(withoutBom(withoutTrailingCommas(stripped)));
  } catch {
    return false;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  return Object.values(parsed).every((value) =>
    (Array.isArray(value) && value.length === 0)
    || (value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 0));
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

  // No copy: the entry goes in through the application's own published
  // interface, so we are not the ones changing this file and there is nothing
  // of ours to undo. `~/.claude.json` is why the rule is worth stating — it is
  // a live credential store, and copying one to guard against an edit we never
  // make is the wrong trade.
  const backup = recordFirstTouch({
    file: options.configPath,
    clientId: client.id,
    backupDir: options.backupDir,
    now: options.now,
    weEdit: false,
    log: options.log,
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
  log(options).record('ran', {
    client: client.id,
    command: path.basename(argv[0]),
    exit: ran.status,
  });

  if (ran.status !== 0) {
    return result('cli', options.configPath, backup, FAILED,
      `${path.basename(argv[0])} exited ${ran.status}: ${firstLine(ran.stderr || ran.stdout)}`);
  }

  const after = readOrEmpty(options.configPath);
  if (!hasEntry(after, request)) {
    log(options).record('wrote', {
      client: client.id, path: options.configPath, outcome: FAILED, reason: 'entry-not-found-after-cli',
    });
    return result('cli', options.configPath, backup, FAILED,
      `${path.basename(argv[0])} reported success and the entry is not in ${options.configPath}.`);
  }

  log(options).record('wrote', {
    client: client.id, path: options.configPath, outcome: WRITTEN, by: path.basename(argv[0]), now: after.length,
  });
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
  log(options).record('read', { client: client.id, path: options.configPath, bytes: before.length });

  const wanted = insertEntry(before, request);

  const backup = recordFirstTouch({
    file: options.configPath,
    clientId: client.id,
    backupDir: options.backupDir,
    now: options.now,
    weEdit: true,
    rootKeyExisted: hadRootKey(before, request),
    log: options.log,
  });

  // A previous run that was killed between opening its temporary file and
  // renaming it leaves one behind, and cannot come back to tidy up. This is the
  // next run doing it for them, before adding one of its own.
  clearAbandonedTemporaries(options.configPath);

  if (wanted === before) {
    log(options).record('wrote', { client: client.id, path: options.configPath, outcome: UNCHANGED });
    return result('file', options.configPath, backup, UNCHANGED, null);
  }

  writePreservingMode(options.configPath, wanted);
  log(options).record('wrote', {
    client: client.id,
    path: options.configPath,
    outcome: WRITTEN,
    by: 'us',
    was: before.length,
    now: wanted.length,
  });

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
  const target = resolveTarget(file);
  const mode = existingMode(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // A name no other process can be holding at the same time. The first version
  // of this built `.nosyparker.<basename>.tmp` from the filename alone, so every
  // process on the machine chose the same path and two writers blended into one
  // file — measured, and at four concurrent writers it destroyed data that was
  // not ours. The read-back check downstream catches that, but only after the
  // file is already ruined, which is the wrong end.
  //
  // `O_EXCL` is the part that actually makes it safe rather than merely
  // unlikely: if the name somehow does exist, the open fails instead of
  // truncating whatever is there. The pid and the random suffix are what make
  // that failure never happen in practice.
  const temporary = path.join(
    path.dirname(target),
    `.nosyparker.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(handle, text);
    fs.fchmodSync(handle, mode);
    fs.fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(handle);

  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    // The rename is the only step that cannot half-happen. If it fails, the
    // original is untouched and the only thing left to do is not litter.
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Where a path really leads, following any links to the end.
 *
 * A rename replaces the name, not what the name points at. So writing to
 * `~/.cursor/mcp.json` when that is a link into somebody's dotfiles repository
 * replaced the link with a regular file: their repository was silently
 * disconnected from their live config, the entry went somewhere the repository
 * never saw, and uninstall could not put the link back because by then there
 * was no link. That is the rule this whole phase is built on — never change
 * what we did not add — broken on the arrangement most likely to be used by
 * exactly the people who install an MCP server by hand.
 *
 * Four cases, and the choice for each:
 *
 * **A chain of links** is followed to the end, because that is where the
 * content is and what every editor does.
 *
 * **A link whose target does not exist** resolves to the target anyway, so the
 * file is created there and the link starts working. Writing through the link
 * would do the same; replacing the link would not.
 *
 * **A link pointing outside the home directory** is followed. The person made
 * that link deliberately and refusing it would break the case this fixes; the
 * resolved path is recorded and logged, so nothing about it is quiet.
 *
 * **A loop** is refused rather than followed for ever, and the write fails with
 * a sentence instead of hanging.
 *
 * @param {string} file
 * @returns {string}
 */
export function resolveTarget(file) {
  const seen = new Set();
  let current = file;

  for (;;) {
    let entry;
    try {
      entry = fs.lstatSync(current);
    } catch {
      return current; // nothing there, so this is where it goes
    }

    if (!entry.isSymbolicLink()) return current;

    if (seen.has(current)) {
      throw new Error(`${file} is a loop of links and there is nothing at the end of it.`);
    }
    seen.add(current);

    const next = fs.readlinkSync(current);
    current = path.isAbsolute(next) ? next : path.resolve(path.dirname(current), next);
  }
}

/**
 * Temporary files left behind by a process that was killed mid-write.
 *
 * They are inert — nothing reads them, and the unique name means nothing will
 * ever pick one up by mistake — but a directory of somebody else's that slowly
 * fills with our litter is still our litter. A killed process cannot clean up
 * after itself, so the next run does it, and only for names this project owns.
 *
 * @param {string} file the config file whose directory to sweep
 */
export function clearAbandonedTemporaries(file) {
  // Where the writing happens, which is not the same place when the config is
  // a link into somebody's dotfiles.
  const target = resolveTarget(file);
  const dir = path.dirname(target);
  const ours = new RegExp(`^\\.nosyparker\\.${escapeForFilename(path.basename(target))}\\.\\d+\\.[0-9a-f]+\\.tmp$`, 'u');

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!ours.test(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Somebody else's to worry about, or gone already. Either way, not fatal.
    }
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeForFilename(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * A file somebody has deliberately protected.
 *
 * An atomic write does not need permission to write the file — it writes a new
 * one beside it and renames over the top, which POSIX allows with nothing but
 * permission on the directory. So a config at `0444` was being rewritten
 * happily, and because the mode is carried over onto the replacement, the
 * person who set it could not tell afterwards.
 *
 * That is standard behaviour for an atomic write and it is still the wrong
 * answer here. Read-only on a configuration file is not an accident of the
 * filesystem, it is somebody saying leave this alone, and the one thing this
 * phase must never do is make a change the owner of the file cannot see. So it
 * is refused, in the same words as an application that is running: nothing was
 * attempted, nothing is broken, and here is the thing to do about it.
 *
 * Only for files we edit ourselves. Where the client's own command does the
 * writing, what it makes of a read-only file is between them.
 *
 * @param {any} client
 * @param {string} file
 * @returns {string|null} a sentence, or null to go ahead
 */
function readOnlyRefusal(client, file) {
  if (client.write.method !== 'file') return null;

  let mode;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    return null; // not there yet, which is not the same as protected
  }

  if ((mode & 0o200) !== 0) return null;

  return `${file} is read-only (${(mode & 0o777).toString(8).padStart(4, '0')}). `
    + 'Nothing was written, because a file set read-only is somebody saying to leave it alone, '
    + 'and rewriting it anyway would not have shown up in its permissions afterwards. '
    + `Make it writable and run this again, or add the entry by hand with `
    + `\`${invocation()} setup --print-config ${client.id}\`.`;
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
 * "Not there" and "there, and the root key cannot reach it" are different
 * answers, and this path gave the first for both.
 *
 * `hasEntry` looks under the row's root key. When the row is wrong about where
 * a client keeps its servers — which has happened, for Cursor — it answers no
 * while our entry sits in the file, and uninstall said "absent" and moved on.
 * The conscience added to `removeEntry` never fired here, because this returns
 * before `removeEntry` is ever called.
 *
 * @param {string} before
 * @param {any} options
 * @param {import('./edit.js').EditRequest} request
 * @param {string} [method]
 * @returns {any}
 */
function absentOrOutOfReach(before, options, request, method = 'file') {
  // Comments first. The regex below is blunt on purpose, and a JSONC comment
  // saying "nosyparker: I took this out myself" is not an entry — it read as
  // one, and the whole accusation that followed was false.
  const text = stripComments(before);

  // Three things all have to be true before this program tells somebody its own
  // table is wrong about their machine. It used to be one, and the one was a
  // regex over the raw text of every primary config — including `~/.claude.json`,
  // which holds project-scoped entries that are somebody else's and an OAuth
  // token that is nobody's business.
  //
  //   we wrote here      a file we never touched proves nothing about our table
  //   we have not already taken it out of here successfully — because then the
  //                      table was right, and this is the ordinary second run
  //   the container is missing   if the row's key is in the file and our name
  //                              is not under it, we were removed properly
  //   the name is a key  and not prose, a path, or a comment
  //
  // The second condition arrived last, from a third review that measured what
  // three were not enough for. Install into `~/.cursor/mcp.json`, paste a copy
  // of the entry at the wrong level by hand — which is what the output of
  // `setup --print-config` invites — then uninstall twice. The first run takes
  // our entry and the container we made for it; on the second all three of the
  // others are true and the program accuses its own table, while the README
  // says running it twice is not an error.
  const row = manifestRowFor(options.configPath, options.backupDir);
  const weWroteHere = row !== null;

  if (!weWroteHere || row.removedFrom
    || hadRootKey(text, request) || !usedAsKey(text, options.name)) {
    return result(method, options.configPath, null, ABSENT, null);
  }

  return result(method, options.configPath, null, FAILED,
    `This installed into ${options.configPath}, "${options.name}" is still somewhere in it, and `
    + `there is no "${request.rootKey}" for it to be under — so nothing was removed and the file `
    + 'is exactly as it was. That most likely means the client table is wrong about where this '
    + 'client keeps its servers, which is ours to fix. Please report it with the name of this '
    + 'client. Do not edit the file to work around it: some of these hold credentials.');
}

/**
 * @param {string} method
 * @param {string|null} file
 * @param {import('./backup.js').BackupResult|null} backup
 * @param {string} outcome
 * @param {string|null} error
 * @param {string|null} [reason]
 * @returns {WriteResult}
 */
function result(method, file, backup, outcome, error, reason = null) {
  return { outcome, method, path: file, backup, error, reason };
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
