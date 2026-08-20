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
 * It checks five things, and the first is the one that could not be checked at
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
 * **The store opens, and no review was left half done.** Phase 4's addition,
 * and the reason this file reaches the store at all — it is on the entrances
 * list now, and it reads and never writes. Two things can be wrong. A store
 * written by an older version of this program is refused at the door with a
 * sentence naming the file, and somebody who has just updated will run this
 * command before anything else, so it has to be the thing that says so rather
 * than a stack trace from `add`. And a review begun by an agent that then
 * stopped stays open for good: nothing tidies it away, because nothing here
 * decides on its own that a thing has been abandoned. So it is reported and
 * left, and reported honestly — this cannot tell a review nobody will finish
 * from one an agent is in the middle of, and it says so rather than picking.
 *
 * The store is only opened if the file is already there. Asking after somebody's
 * memories must not be what creates them, which is the same reason `setup`,
 * `uninstall` and this command are all answered before the store is opened at
 * the terminal.
 *
 * What a later phase has to do with all this is in DECISIONS.md under "A new
 * entrance goes into `doctor` in the same commit" — the same rule the entrances
 * test applies to the import graph, applied to the running machine, because
 * this command decays into a reassuring noise the moment it stops keeping up
 * with what the project touches.
 *
 * It never changes anything. If it finds a broken entry it says to run `setup`;
 * it does not run it. The one thing it writes is a line in our own action log
 * saying it ran, which is the same record `setup` leaves and is not a change to
 * anything of anybody else's. Asking a client to verify does start our server,
 * because that is what those commands do — so a machine with no memory store
 * yet will have an empty one afterwards, exactly as after `setup`.
 */

import fs from 'node:fs';

import { configPathFor, expandPath, fillTokens, invocation, loadClients } from './clients.js';
import { detect, NOT_INSTALLED } from './detect.js';
import { hasEntry, insertEntry, stripComments, withoutBom, withoutTrailingCommas } from './edit.js';
import { checkDocumentation } from './documentation.js';
import { editRequest, readOrEmpty, resolveTarget } from './write.js';
import { manifestRowFor } from './backup.js';
import { CONFIG_CONFIRMED, CONNECTED, verifyClient } from './verify.js';
import { defaultStorePath, LOCAL_OWNER, systemClock } from './config.js';
import { openPasses, openStore } from './store.js';
import { reviewSummaries } from './gate.js';

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
 * @typedef {object} StoreCheck
 * @property {string} state one of the three above
 * @property {string[]} says one line each
 */

/**
 * Look at everything, change nothing.
 *
 * @param {import('./setup.js').Io} io
 * @returns {{findings: Finding[], documents: import('./documentation.js').Check[], store: StoreCheck}}
 */
export function diagnose(io) {
  /** @type {Finding[]} */
  const findings = [];

  io.log.record('run', { interpreter: io.command, server: io.serverPath, cwd: io.machine.cwd });

  for (const client of loadClients().clients) {
    const found = detect(client, io.machine);
    if (found.state === NOT_INSTALLED || found.configPath === null) continue;

    const request = editRequest(client, io);
    const { text, gone } = readConfig(found.configPath);
    /** @type {string[]} */
    const says = [];

    if (gone !== null || !hasEntry(text, request)) {
      // Not installed into is not broken: somebody may never have run setup for
      // this client, or may have taken it out on purpose. But a client the
      // manifest says we *did* install into, with no entry in it now, is the
      // single most likely reason anybody runs this command — and it was being
      // reported as nothing at all. Four ways of destroying a config produced
      // "Nothing is broken" and an exit code of zero.
      //
      // The manifest is what tells the two apart, and it was already being read
      // three lines further down for something else.
      const row = manifestRowFor(found.configPath, io.backupDir);

      if (row === null) {
        io.log.record('check', { client: client.id, path: found.configPath, result: 'absent' });
        continue;
      }

      const unparseable = gone === null && !readable(text, client);
      const why = gone ?? (unparseable
        ? `its contents cannot be read as ${client.format.toUpperCase()} any more`
        : 'its entry is no longer in it');

      io.log.record('check', { client: client.id, path: found.configPath, result: BROKEN, reason: why });
      findings.push({
        client: client.id,
        name: client.name,
        state: BROKEN,
        says: [
          `This installed into ${found.configPath}, and ${why}.`,
          // Three different situations and three different things to do. Saying
          // "run setup" for the unreadable one would be advice that cannot
          // work, and saying it for the unparseable one would be worse: setup
          // refuses to touch a file it cannot parse, on purpose, because
          // editing around a syntax error is how a whole config disappears at
          // the next launch.
          gone === UNREADABLE
            ? 'Nothing here can read it, so nothing can say whether the entry is still there. Check who is allowed to read that file.'
            : unparseable
              ? `Setup will not touch a file it cannot parse, so that has to be put right first — then \`${invocation()} setup\` will add the entry back.`
              : `Run \`${invocation()} setup\` to put it back.`,
        ],
      });
      continue;
    }

    // Where the entry actually lives now, against where it lived when we wrote
    // it. A comparison of contents cannot see a change of path: replacing a
    // symlink with a regular file leaves a file that does contain the entry,
    // and everything else here would have said it was fine.
    const row = manifestRowFor(found.configPath, io.backupDir);
    const wasTarget = row?.target ?? null;
    const isTarget = resolveTarget(found.configPath);
    let state = SOUND;

    if (wasTarget !== null && wasTarget !== isTarget) {
      state = BROKEN;
      says.push(`This wrote into ${wasTarget}, which ${found.configPath} used to point at. It does not any more`
        + `${isTarget === found.configPath ? ' — it is a plain file now' : `, it points at ${isTarget}`}.`);
      says.push(`Whatever reads ${wasTarget} is no longer seeing this entry. Putting the link back and running `
        + `\`${invocation()} setup\` restores both.`);
    }

    const named = interpreterIn(text, client, io.name);

    if (named === null) {
      // Two different reasons, and blaming the format for both was wrong: for
      // JSON the format read perfectly well and it is the entry that has no
      // interpreter in it, which is a thing worth saying out loud.
      says.push(readable(text, client) && (client.format === 'json' || client.format === 'jsonc')
        ? 'Its entry is there and has no interpreter in it that this can read, so the check that matters most here could not be made.'
        : `Its entry is there. This cannot read an interpreter back out of ${client.format.toUpperCase()}, so that part is unchecked.`);
    } else if (!fs.existsSync(named)) {
      state = BROKEN;
      says.push(`Its entry names ${named}, which is not there any more — so nothing can start the server from this client.`);
      says.push('That is what happens when a Node version is switched or removed. Run setup again to rewrite it.');
    } else if (named !== io.command) {
      says.push(`Its entry names ${named}, which exists but is not the interpreter running now (${io.command}).`);
    }

    // Only for the files this project writes itself. For a client written
    // through its own command, "what setup would write" is not our formatting —
    // it is whatever that command produces, tabs and extra keys and all — so
    // comparing against our own serialiser would report every one of them as
    // broken. Which it did, on the first real run, behind a crash that was
    // hiding it.
    if (client.write.method === 'file') {
      if (state !== BROKEN && insertEntry(text, request) !== text) {
        state = BROKEN;
        says.push(`Its entry is not the one setup would write now. Run \`${invocation()} setup\` to bring it up to date.`);
      }
    } else {
      says.push(`${client.name} writes this file with its own command, so this checks that the entry is there and points somewhere real, and not how it is laid out.`);
    }

    io.log.record('check', {
      client: client.id,
      path: found.configPath,
      target: isTarget === found.configPath ? undefined : isTarget,
      result: state,
      interpreter: named ?? undefined,
    });

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

    findings.push({ client: client.id, name: client.name, state, says });
  }

  for (const client of loadClients().clients) {
    for (const line of secondSurfacesOf(client, io)) {
      findings.push({ client: client.id, name: client.name, state: NOT_ASKABLE, says: [line] });
    }
  }

  const documents = checkDocumentation();
  const store = checkStore(io);

  io.log.record('done', {
    checked: findings.length,
    broken: findings.filter((finding) => finding.state === BROKEN).length,
    documents: documents.filter((check) => !check.ok).length,
    store: store.state,
  });

  return { findings, documents, store };
}

/**
 * Entries in a file a client's own command wrote for itself.
 *
 * `alsoRemoveFrom` is new, `uninstall` cleans those files, and this command was
 * never taught to look at them — so with a live entry in Cursor's settings this
 * said "No client on this machine has an entry" and exited 0 while uninstall
 * removed one from that very file. Two commands reading one table and
 * contradicting each other, in the one whose whole job is saying what is true
 * of the machine.
 *
 * Not called broken. An entry there is a working entry; it is simply somewhere
 * we do not install and most people would never look.
 *
 * @param {any} client
 * @param {import('./setup.js').Io} io
 * @returns {string[]}
 */
function secondSurfacesOf(client, io) {
  /** @type {string[]} */
  const says = [];

  for (const surface of client.alsoRemoveFrom ?? []) {
    const wanted = surface.path[io.machine.platform] ?? null;
    if (wanted === null) continue;

    const file = expandPath(wanted, io.machine);
    if (!io.machine.exists(file)) continue;

    const text = readOrEmpty(file);
    if (text === '' || !hasEntry(text, {
      name: io.name, rootKey: surface.rootKey, format: surface.format, entry: {},
    })) continue;

    says.push(
      `${client.name} also has an entry in ${file}, which its own command writes rather than `
      + `this one. It works, and \`${invocation()} uninstall\` takes it out along with ours.`,
    );
  }

  return says;
}

/**
 * Open the memory store and ask it two questions.
 *
 * Read-only, like the rest of this command. It opens the store, reads, and
 * closes it, and the one thing it writes anywhere is the line in our own action
 * log saying it asked.
 *
 * @param {import('./setup.js').Io} io
 * @returns {StoreCheck}
 */
function checkStore(io) {
  const file = io.storePath ?? defaultStorePath();

  if (!fs.existsSync(file)) {
    // Not a fault. Nothing has ever been stored, which is the ordinary state of
    // a machine that has just been set up, and creating the file to find that
    // out would make asking the question change the answer.
    io.log.record('store', { path: file, result: 'absent' });
    return {
      state: NOT_ASKABLE,
      says: [`There is no memory store at ${file} yet. Nothing has been stored on this machine.`],
    };
  }

  /** @type {import('./store.js').Store} */
  let store;
  try {
    store = openStore({ file, now: systemClock });
  } catch (error) {
    // The upgrade case. A store written by Phase 3 does not open under Phase 4,
    // and the sentence `openStore` throws names the file and says what to do,
    // so it is passed on whole rather than summarised.
    io.log.record('store', { path: file, result: BROKEN, reason: 'will-not-open' });
    return {
      state: BROKEN,
      says: [error instanceof Error ? error.message : String(error)],
    };
  }

  try {
    const open = openPasses(store, LOCAL_OWNER);
    const did = whatReviewsDid(store);

    io.log.record('store', {
      path: file,
      result: SOUND,
      openReviews: open.length,
      reviewsReported: did.length,
    });

    /** @type {string[]} */
    const says = [`The memory store at ${file} opens.`];

    if (open.length === 0) says.push('No review is open.');
    else {
      says.push(`${open.length} ${open.length === 1 ? 'review is' : 'reviews are'} still open: `
        + `${open.map((pass) => `${pass.id} (${pass.reviewer}, begun ${pass.began_at})`).join(', ')}.`);
      // Said rather than decided. An open review is a review an agent may be
      // in the middle of this second, and it is also what an agent that
      // crashed leaves behind, and nothing on this machine can tell those
      // apart. Reporting it as a fault would be this command claiming a
      // judgement it has no way to make — and it is why an open review does
      // not change the exit code.
      says.push('That may be a review in progress, or one an agent began and never finished. '
        + 'Nothing here can tell those apart, and nothing will close it on its own.');
      says.push(`An agent closes one with \`review_end\`. To put back everything a review `
        + `changed, run \`${invocation()} undo-review <number>\`.`);
    }

    for (const line of did) says.push(line);

    return { state: SOUND, says };
  } finally {
    store.close();
  }
}

/**
 * How many reviews this says anything about before it starts counting instead.
 *
 * Five, and the number it stopped at is named in the report. `listDecisions`
 * refuses to truncate at all, and is right to — a caller cannot tell a complete
 * answer from a shortened one. This can, because it says so, which is the whole
 * of the difference.
 */
const REVIEWS_SHOWN = 5;

/**
 * What the reviews on this machine actually did to somebody's memories.
 *
 * The reason this exists, in one sentence: a reviewer ran a single pass that
 * archived forty memories out of forty — the whole store, with plausible
 * reasons, from one agent — the pass closed cleanly, and this command then said
 * "the memory store opens, and no review is open". Nothing wrong. Everything
 * gone from `list`, the only trace in `why`, which a person has to think to go
 * and read. Fully reversible if you notice, and unattended means nobody is
 * noticing. So an invisible event becomes a visible one.
 *
 * Undone reviews are left out. Something that has been put back is not a thing
 * to tell somebody about, and including them would push the reviews that still
 * stand off the bottom of a list that has to stay short enough to read.
 *
 * The line about a review having taken most of the store is a report and not a
 * rule. Why it is here rather than in the gate, why it does not change the exit
 * code, and why that was settled the way it was: DECISIONS.md, "Saying it
 * louder, and not acting on it". Nothing refuses on it, nothing caps on it, and the same review would
 * have been written exactly the same way with this file deleted. It is a
 * sentence in front of a person, and where the sentence starts appearing is a
 * decision about telling rather than about memories, which is why the number
 * lives here and not in the gate.
 *
 * @param {import('./store.js').Store} store
 * @returns {string[]}
 */
function whatReviewsDid(store) {
  const stood = reviewSummaries(store, LOCAL_OWNER)
    .filter((row) => row.changed > 0 && row.pass.undone_at === null);

  if (stood.length === 0) return ['No review has changed anything that is still standing.'];

  /** @type {string[]} */
  const says = [];

  for (const { pass, changed, undecided, showing } of stood.slice(0, REVIEWS_SHOWN)) {
    const most = changed > showing;

    says.push(`Review ${pass.id}, by "${pass.reviewer}", ${pass.closed_at === null
      ? `begun ${pass.began_at} and still open`
      : `closed ${pass.closed_at}`}: it put away ${changed} `
      + `${changed === 1 ? 'memory' : 'memories'}`
      + `${undecided > 0 ? ` and left ${undecided} undecided` : ''}. `
      + `${showing === 0 ? 'Nothing is being shown now' : `${showing} `
        + `${showing === 1 ? 'memory is' : 'memories are'} being shown now`}.`);

    if (most) {
      says.push(`  That is more than is left on show, so review ${pass.id} moved most of this `
        + 'store in one go. That may be exactly what somebody asked for. It is here because it '
        + 'is the kind of thing worth seeing rather than because anything is wrong with it — '
        + `\`${invocation()} undo-review ${pass.id}\` puts it all back.`);
    } else {
      says.push(`  \`${invocation()} undo-review ${pass.id}\` puts it back.`);
    }
  }

  if (stood.length > REVIEWS_SHOWN) {
    says.push(`${stood.length - REVIEWS_SHOWN} older `
      + `${stood.length - REVIEWS_SHOWN === 1 ? 'review is' : 'reviews are'} not shown here. `
      + `\`${invocation()} log\` has every one of them, oldest first, with the reasoning.`);
  }

  return says;
}

/** The file is not there at all. */
const MISSING = 'it is not there any more';

/** It is there and this cannot read it. */
const UNREADABLE = 'it cannot be read';

/**
 * The config, and what stopped us if anything did.
 *
 * `readOrEmpty` gives an empty string for a file that is missing, one that is
 * unreadable and one that is genuinely empty, and those need different things
 * said about them: a deleted config is put back by running setup, and a config
 * nobody is allowed to read is not.
 *
 * @param {string} file
 * @returns {{text: string, gone: string|null}}
 */
function readConfig(file) {
  if (!fs.existsSync(file)) return { text: '', gone: MISSING };
  try {
    return { text: fs.readFileSync(file, 'utf8'), gone: null };
  } catch (error) {
    // Not every failure to read is a permissions problem, and saying it is
    // sends somebody to look at permissions that are fine. A config replaced by
    // a directory is the one that actually happens.
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'EISDIR') return { text: '', gone: 'there is a directory there now, not a file' };
    if (code === 'EACCES' || code === 'EPERM') return { text: '', gone: UNREADABLE };
    return { text: '', gone: `it could not be read (${code ?? 'no reason given'})` };
  }
}

/**
 * Does this still parse as the format its client uses.
 *
 * Only JSON and JSONC can be answered here, which is the honest limit: for the
 * other three the entry simply is not found, and "its entry is no longer in it"
 * is true either way.
 *
 * @param {string} text
 * @param {any} client
 * @returns {boolean}
 */
function readable(text, client) {
  if (client.format !== 'json' && client.format !== 'jsonc') return true;
  try {
    JSON.parse(withoutBom(withoutTrailingCommas(stripComments(text))));
    return true;
  } catch {
    return false;
  }
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
 * @param {ReturnType<typeof diagnose>} result
 * @returns {number} the exit code
 */
export function reportDiagnosis(io, { findings, documents, store }) {
  const broken = findings.filter((finding) => finding.state === BROKEN);
  const unaskable = findings.filter((finding) => finding.state === NOT_ASKABLE);
  const sound = findings.filter((finding) => finding.state === SOUND);
  const wrongDocuments = documents.filter((check) => !check.ok);

  // A store this code cannot open goes first, ahead of everything about
  // clients. Somebody who has just updated runs this command to find out why
  // nothing works, and the sentence that answers them was at the bottom of the
  // page under twenty clients they were not asking about. It stays at the
  // bottom when there is nothing wrong with it: that reader is reading down.
  if (store.state === BROKEN) {
    io.out('The memory store:\n\n');
    for (const line of store.says) io.out(`  ${line}\n`);
    io.out('\n');
  }

  if (findings.length === 0) {
    io.out(`No client on this machine has an entry for nosyparker. Run \`${invocation()} setup\` to add one.\n\n`);
  } else {
    // What this counts is clients this has installed into, not clients with an
    // entry — because one whose entry has since gone is exactly the case worth
    // counting, and calling it a client that "has an entry" would be the same
    // sentence being wrong in a quieter way.
    io.out(`${findings.length} ${findings.length === 1 ? 'client' : 'clients'} on this machine `
      + `${findings.length === 1 ? 'has' : 'have'} been set up. `
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

  if (store.state !== BROKEN) {
    io.out('The memory store:\n\n');
    for (const line of store.says) io.out(`  ${line}\n`);
    io.out('\n');
  }

  if (broken.length > 0) {
    io.out(`Run \`${invocation()} setup\` to rewrite the broken entries.\n`);
    io.out('This command does not change anything itself.\n\n');
  }

  // Zero when nothing was found wrong, one when something was — so that
  // somebody can put this in a cron line or a shell prompt and get an answer
  // rather than a page. A client that cannot be asked is not a failure: it is
  // the ordinary state of most of them, and exiting non-zero for it would make
  // the code mean "you have clients" rather than "something is wrong".
  //
  // A store that will not open counts, because nothing works until it does. An
  // open review does not, and that is the harder call: it is a real thing to
  // act on, and it is also what an agent halfway through a review looks like
  // from here. Making the exit code red for it would put this command in the
  // position of calling somebody's work-in-progress a fault, and there is no
  // way for it to tell. So it is said in the report and left out of the number.
  const storeBroken = store.state === BROKEN ? 1 : 0;
  return broken.length + wrongDocuments.length + storeBroken === 0 ? 0 : 1;
}
