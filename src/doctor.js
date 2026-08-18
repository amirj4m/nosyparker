/**
 * A command that exercises the real composition against the real machine and
 * says what it finds.
 *
 * The argument for it is a number. Phase 3 shipped with sixteen defects found
 * after it was written — nine by running the whole thing on a real machine,
 * seven by an independent review — and the suite was green at every one of
 * those moments. The suite stops them coming back. It cannot find them, because
 * nothing in it composes the real table with the real filesystem and the real
 * client commands, and nothing in it can. Until now the only way to do that was
 * for somebody to decide to. This makes that decision cheap.
 *
 * It checks four things, and the first is the one that could not be checked at
 * all before.
 *
 * **The interpreter still exists.** Every entry names an absolute path to the
 * Node that wrote it, because a client started from a desktop icon has no PATH
 * to find `node` on. The cost, documented since the day it was chosen, is that
 * a version manager moves that path when you switch versions and every entry
 * then points at nothing — silently, because a client that cannot start a
 * server mostly does not mention it. That was a known failure with no detection
 * behind it. This is the detection.
 *
 * **The entry is still ours.** Present, well-formed, and identical to what
 * `setup` would write today. The last part is free and is the interesting one:
 * if inserting our entry into the file as it stands changes nothing, then what
 * is in the file is exactly what we would put there.
 *
 * **The clients that can answer are asked again.** Same verification, same
 * three groups, same six words. A client that cannot be asked is reported as
 * not askable, never as fine.
 *
 * **The documents still match the program.** The checks a test already runs,
 * run again where a person can see them.
 *
 * It never changes anything. If it finds a broken entry it says to run `setup`;
 * it does not run it. The one thing it writes is a line in our own action log
 * saying it ran, which is the same record `setup` leaves and is not a change to
 * anything of anybody else's. Asking a client to verify does start our server,
 * because that is what those commands do — so a machine with no memory store
 * yet will have an empty one afterwards, exactly as after `setup`.
 */

import fs from 'node:fs';

import { configPathFor, fillTokens, loadClients } from './clients.js';
import { detect, NOT_INSTALLED } from './detect.js';
import { hasEntry, insertEntry, stripComments, withoutBom, withoutTrailingCommas } from './edit.js';
import { checkDocumentation } from './documentation.js';
import { editRequest, readOrEmpty } from './write.js';
import { manifestRowFor } from './backup.js';
import { CONFIG_CONFIRMED, CONNECTED, verifyClient } from './verify.js';

/** Everything it looked at is as it should be. */
export const SOUND = 'sound';

/** Something is wrong and a person has to do something about it. */
export const BROKEN = 'broken';

/** It is here and there is nothing this can establish about it. */
export const NOT_ASKABLE = 'not-askable';

/**
 * @typedef {object} Finding
 * @property {string} client
 * @property {string} name
 * @property {string} state one of the three above
 * @property {string[]} says one line each, in the order a person would read them
 */

/**
 * Look at everything, change nothing.
 *
 * @param {import('./setup.js').Io} io
 * @returns {{findings: Finding[], documents: import('./documentation.js').Check[]}}
 */
export function diagnose(io) {
  /** @type {Finding[]} */
  const findings = [];

  io.log.record('run', { interpreter: io.command, server: io.serverPath, cwd: io.machine.cwd });

  for (const client of loadClients().clients) {
    const found = detect(client, io.machine);
    if (found.state === NOT_INSTALLED || found.configPath === null) continue;

    const request = editRequest(client, io);
    const text = readOrEmpty(found.configPath);
    /** @type {string[]} */
    const says = [];

    if (!hasEntry(text, request)) {
      // Not installed into is not broken. Somebody may simply never have run
      // setup for this client, or may have taken it out on purpose.
      io.log.record('check', { client: client.id, path: found.configPath, result: 'absent' });
      continue;
    }

    const named = interpreterIn(text, client, io.name);
    let state = SOUND;

    if (named === null) {
      says.push(`Its entry is there. This cannot read the interpreter back out of a ${client.format} file, so that part is unchecked.`);
    } else if (!fs.existsSync(named)) {
      state = BROKEN;
      says.push(`Its entry names ${named}, which is not there any more — so nothing can start the server from this client.`);
      says.push('That is what happens when a Node version is switched or removed. Run setup again to rewrite it.');
    } else if (named !== io.command) {
      says.push(`Its entry names ${named}, which exists but is not the interpreter running now (${io.command}).`);
    }

    if (state !== BROKEN && insertEntry(text, request) !== text) {
      state = BROKEN;
      says.push('Its entry is not the one setup would write now. Something has edited it, or it was written by an older version. Run setup again.');
    }

    const verified = found.command === null && client.verify.method !== 'file-reread'
      ? null
      : verifyClient(client, {
        name: io.name,
        configPath: found.configPath,
        clientCommand: found.command,
        machine: io.machine,
        editRequest: request,
        run: io.run,
      });

    if (verified !== null) {
      const answered = verified.status === CONNECTED || verified.status === CONFIG_CONFIRMED;
      if (answered) says.push(verified.says);
      else if (client.verify.method === 'file-reread') {
        if (state === SOUND) state = NOT_ASKABLE;
        says.push(`${client.name} offers no way to ask whether it loaded a server, so this cannot tell you it is working.`);
      } else {
        state = BROKEN;
        says.push(verified.says);
      }
      for (const blocker of verified.blockers) says.push(blocker);
    } else {
      if (state === SOUND) state = NOT_ASKABLE;
      says.push(`${client.name}'s own command is not on this machine, so its entry could not be checked with it.`);
    }

    io.log.record('check', {
      client: client.id,
      path: found.configPath,
      result: state,
      interpreter: named ?? undefined,
    });

    findings.push({ client: client.id, name: client.name, state, says });
  }

  const documents = checkDocumentation();

  io.log.record('done', {
    checked: findings.length,
    broken: findings.filter((finding) => finding.state === BROKEN).length,
    documents: documents.filter((check) => !check.ok).length,
  });

  return { findings, documents };
}

/**
 * The interpreter an entry actually names, or null if it cannot be read back.
 *
 * JSON and JSONC are parsed properly, which covers most of the table. The three
 * formats with no parser here — Goose's YAML, Continue's list, Codex's TOML —
 * get a search for an absolute path against the field each of them uses, and
 * anything it cannot find is reported as unchecked rather than as sound.
 *
 * @param {string} text
 * @param {any} client
 * @param {string} name
 * @returns {string|null}
 */
export function interpreterIn(text, client, name) {
  if (client.format === 'json' || client.format === 'jsonc') {
    try {
      const parsed = JSON.parse(withoutBom(withoutTrailingCommas(stripComments(text))));
      const entry = parsed?.[client.rootKey]?.[name];
      if (entry === undefined) return null;

      // opencode holds the program and its arguments in one array; everybody
      // else has a string, under `command` or, for Goose, `cmd`.
      const command = entry.command ?? entry.cmd;
      const found = Array.isArray(command) ? command[0] : command;
      return typeof found === 'string' && found.startsWith('/') ? found : null;
    } catch {
      return null;
    }
  }

  const match = /^[ \t-]*(?:command|cmd)\s*[:=]\s*"?(\/[^"\s,\]]+)/mu.exec(text);
  return match === null ? null : match[1];
}

/**
 * @param {import('./setup.js').Io} io
 * @param {{findings: Finding[], documents: import('./documentation.js').Check[]}} result
 * @returns {number} the exit code
 */
export function reportDiagnosis(io, { findings, documents }) {
  const broken = findings.filter((finding) => finding.state === BROKEN);
  const unaskable = findings.filter((finding) => finding.state === NOT_ASKABLE);
  const sound = findings.filter((finding) => finding.state === SOUND);
  const wrongDocuments = documents.filter((check) => !check.ok);

  if (findings.length === 0) {
    io.out('No client on this machine has an entry for nosyparker. Run setup to add one.\n\n');
  } else {
    io.out(`${findings.length} ${findings.length === 1 ? 'client has' : 'clients have'} an entry. `
      + `${broken.length === 0 ? 'Nothing is broken.' : `${broken.length} of them ${broken.length === 1 ? 'is' : 'are'} broken.`}\n\n`);
  }

  for (const [title, group] of /** @type {[string, Finding[]][]} */ ([
    ['Broken', broken],
    ['Working, as far as anything here can tell', sound],
    ['Written, and not askable', unaskable],
  ])) {
    if (group.length === 0) continue;
    io.out(`${title}:\n\n`);
    for (const finding of group) {
      io.out(`  ${finding.name}\n`);
      for (const line of finding.says) io.out(`      ${line}\n`);
    }
    io.out('\n');
  }

  io.out(wrongDocuments.length === 0
    ? `The documentation matches the program on all ${documents.length} checks.\n\n`
    : `The documentation disagrees with the program on ${wrongDocuments.length} of ${documents.length} checks:\n\n`);

  for (const check of wrongDocuments) {
    io.out(`  ${check.what}\n`);
    for (const wrong of check.wrong) io.out(`      ${wrong}\n`);
  }
  if (wrongDocuments.length > 0) io.out('\n');

  if (broken.length > 0) {
    io.out('Run `nosyparker setup` to rewrite the broken entries. This command does not\n');
    io.out('change anything itself.\n\n');
  }

  // Zero when nothing was found wrong, one when something was — so that
  // somebody can put this in a cron line or a shell prompt and get an answer
  // rather than a page. A client that cannot be asked is not a failure: it is
  // the ordinary state of most of them, and exiting non-zero for it would make
  // the code mean "you have clients" rather than "something is wrong".
  return broken.length + wrongDocuments.length === 0 ? 0 : 1;
}
