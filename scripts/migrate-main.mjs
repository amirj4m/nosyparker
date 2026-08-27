/**
 * The migration, and the order of its steps.
 *
 * It exports `main` and nothing else, and it refuses to run unless
 * `migrate.mjs` next door started the process, exactly as the purge script
 * does. Nothing schedules it and nothing calls it: it runs when a person types
 * it, with their clients closed.
 *
 * **Why it is not automatic.** The obvious place to migrate a store is when it
 * is opened. This store is opened by MCP servers that a desktop application
 * spawns without anybody watching, several at once — on this machine, five at a
 * time. A migration there would run unattended and concurrently on a file
 * somebody is in the middle of using, which is the worst set of conditions any
 * of this could have.
 *
 * **The order, and what an interruption leaves behind.** The dangerous moment
 * is the swap, and what makes it dangerous is the write-ahead log: the live
 * store has `-wal` and `-shm` sidecars belonging to the *old* file, and a new
 * file renamed into place underneath them is a corruption waiting to be opened.
 * So the sidecars go first and the rename goes last:
 *
 *   1. survey        refuse if two live memories would end up sharing a key
 *   2. copy          `VACUUM INTO` a working file beside the store
 *   3. recompute     rewrite the derived column on the copy
 *   4. verify        seven checks against the untouched original
 *   5. backup        a second `VACUUM INTO`, the copy he keeps
 *   6. checkpoint    fold the live WAL in and remove the sidecars
 *   7. rename        atomic, one filesystem, replaces the original
 *
 * Interrupted before 7, the live store is the original and nothing has changed.
 * Interrupted during 7, `rename` is atomic: the path holds the old file or the
 * new one and never neither. Interrupted after 7, the new store is live with
 * the backup beside it. There is no window in which he is left with nothing,
 * and none in which a new file sits under an old WAL.
 *
 * The backup is his. Nothing here deletes it, and nothing here will delete it
 * later either.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { defaultStorePath } from '../src/config.js';
import { copyStore, paths, queriesStillFind, recompute, survey, verify } from '../src/migrate.js';

const startedByLauncher =
  process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href.endsWith('/scripts/migrate.mjs');

if (!startedByLauncher) {
  throw new Error('migrate-main.mjs is started by migrate.mjs. It is not something to import.');
}

/** @param {string} message */
function stop(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** @param {string} message */
function say(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Is anything else holding the store, and if not, what is wrong instead.
 *
 * Asked by taking an *exclusive* lock and giving it straight back, which is not
 * what this used to do. It used to ask `BEGIN IMMEDIATE`, and in WAL mode a
 * write transaction is allowed to start alongside any number of readers — so a
 * client sitting with the store open passed the check. Measured on this
 * machine, with a second connection open: `BEGIN IMMEDIATE` succeeds,
 * `PRAGMA journal_mode = DELETE` fails with `database is locked`, and an
 * exclusive locking-mode write fails the same way.
 *
 * That matters because `journal_mode = DELETE` is step 6 of the swap. The
 * owner's own run passed the old check, copied his store, rewrote 154 rows, ran
 * all seven verifications, and only then found out it could not finish. A check
 * has to ask the question the last step will ask, or it is not a check — it is
 * a delay.
 *
 * It returns which failure it met rather than a boolean, because the first
 * version of this did not: a directory it could not write came back as `false`
 * and sent somebody off to close editors that were already closed. A lock and a
 * file it cannot open are different problems and need different sentences.
 *
 * The locking mode is per-connection and the connection is closed either way,
 * so nothing here can leave the store locked.
 *
 * @param {string} file
 * @returns {{free: true} | {free: false, locked: boolean, why: string}}
 */
function storeIsFree(file) {
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN IMMEDIATE');
      db.exec('COMMIT');
      db.exec('PRAGMA locking_mode = NORMAL');
      return { free: true };
    } finally {
      db.close();
    }
  } catch (error) {
    const why = String(error instanceof Error ? error.message : error).split('\n')[0].trim();
    return { free: false, locked: /database is locked|database is busy/iu.test(why), why };
  }
}

/**
 * Does the live store still hold rows keyed under the old rule.
 *
 * The one question that tells a leftover working file apart from a dangerous
 * one. If the store still has something to migrate then the swap never
 * happened, so nothing of the person's has changed and the working file is a
 * partial copy they can throw away. If it does not, a working file sitting
 * beside it cannot be accounted for from here and the careful wording stands.
 *
 * Read from the store itself rather than from a marker file, because a marker
 * file is one more thing a stopped run can leave behind, and the situation this
 * exists to explain is somebody already holding a file they did not expect.
 *
 * @param {string} file
 * @returns {boolean}
 */
function stillToMigrate(file) {
  try {
    return survey(file).changing > 0;
  } catch {
    return false;
  }
}

/**
 * Why it cannot start, in words, for each of the two reasons it cannot.
 *
 * @param {{free: false, locked: boolean, why: string}} found
 * @param {string} store
 * @returns {string}
 */
function cannotStart(found, store) {
  if (found.locked) {
    return 'Something else has your store open — that will be an editor or an assistant '
      + 'connected to your memories. Close them and run this again.\n\n'
      + 'Nothing was changed, and nothing was copied: this is asked before any work '
      + 'starts, because the last step of the swap needs the file to itself and there '
      + 'is no point finding that out at the end.';
  }

  return `Your store at ${store} could not be opened for writing:\n\n  ${found.why}\n\n`
    + 'That is not another program holding it — it is the file or the folder it sits in. '
    + 'Check that both are yours to write and that the disk is not full, then run this '
    + 'again. Nothing was changed.';
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function main(argv) {
  const store = defaultStorePath();

  if (!argv.includes('--yes')) {
    stop(
      'This rewrites how your memories are indexed, so that a number written in '
      + 'Persian, Arabic or another script counts as the same number as one written '
      + `in ASCII.\n\n  node scripts/migrate.mjs --yes\n\nYour store is ${store}. `
      + 'It is copied first and the copy is checked before anything is replaced, '
      + 'and the original is kept beside it as a backup for you to delete.',
    );
  }

  if (!fs.existsSync(store)) stop(`There is no store at ${store}. Nothing to migrate.`);

  const before = storeIsFree(store);
  if (!before.free) stop(cannotStart(before, store));

  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const { working, backup } = paths(store, stamp);

  if (fs.existsSync(working)) {
    // Two situations, and they need opposite things said about them. The store
    // answers which one this is: if it still has rows to migrate, the swap never
    // happened and this file is a partial copy of a run that changed nothing.
    stop(stillToMigrate(store)
      ? `${working} is already there, left by a run that stopped before anything was `
        + 'replaced.\n\nYour store was not changed — it still holds every memory it held, '
        + 'keyed the way it was keyed. That file is a partial copy and nothing depends on '
        + `it. Move it aside and run this again:\n\n  mv ${working} ${working}.old\n  `
        + 'node scripts/migrate.mjs --yes\n\nIt is not deleted here because deleting '
        + 'somebody\'s file to get past an error is not this program\'s decision to make.'
      : `${working} is already there, left by a run that did not finish, and your store `
        + 'has nothing left to migrate.\n\nWhat that file is cannot be told from here. '
        + 'Look at it, then move it out of the way and run this again. It is not deleted '
        + 'here, because it may be the only thing that finished.');
  }

  // 1. What it would do, before it does anything.
  const found = survey(store);
  say(`${found.rows} memories, ${found.changing} of them keyed under the old rule.`);

  if (found.collisions.length > 0) {
    stop(
      'Refusing, because the new rule would give two memories that are both still '
      + 'shown the same key:\n\n'
      + found.collisions.map((line) => `  ${line}`).join('\n')
      + '\n\nWhich of them you meant is a question this cannot answer for you. '
      + 'Nothing was changed.',
    );
  }

  if (found.changing === 0) {
    say('Nothing to do: every memory is already keyed the way this would key it.');
    return;
  }

  // 2, 3. Copy, then rewrite the copy. The original is untouched by both.
  copyStore(store, working);
  const rewritten = recompute(working);
  say(`Copied to ${working} and rewrote ${rewritten}.`);

  // 4. Verify, and say everything that is wrong rather than the first thing.
  const checks = [...verify(store, working), queriesStillFind(store, working)];
  const failed = checks.filter((c) => !c.ok);

  for (const check of checks) {
    say(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}`);
    for (const line of check.wrong.slice(0, 8)) say(`          ${line}`);
    if (check.wrong.length > 8) say(`          ... and ${check.wrong.length - 8} more`);
  }

  if (failed.length > 0) {
    stop(
      `\n${failed.length} of ${checks.length} checks failed, so nothing was replaced. `
      + `Your store is untouched. The copy that failed is at ${working}; look at it, `
      + 'then delete it. Please report this.',
    );
  }

  // 5. His backup, taken the same way the copy was.
  copyStore(store, backup);

  // 6, 7. Sidecars first, rename last. See the note at the top of this file.
  if (!storeIsFree(store).free) {
    fs.rmSync(working, { force: true });
    stop(
      'Something opened your store while this was checking, so nothing was replaced. '
      + `Close it and run this again. The backup at ${backup} is a copy of your store `
      + 'as it is now and can be deleted.',
    );
  }

  const live = new DatabaseSync(store);
  try {
    live.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    live.prepare('PRAGMA journal_mode = DELETE').get();
  } finally {
    live.close();
  }
  fs.rmSync(`${store}-wal`, { force: true });
  fs.rmSync(`${store}-shm`, { force: true });

  fs.renameSync(working, store);

  const back = new DatabaseSync(store);
  try {
    back.prepare('PRAGMA journal_mode = WAL').get();
  } finally {
    back.close();
  }

  say('');
  say('Done. Every check passed before anything was replaced.');
  say(`Your store as it was is at ${backup}`);
  say('Nothing here will ever delete that file. Delete it yourself when you are satisfied.');
  say('If anything looks wrong, put it back with:');
  say(`  mv ${backup} ${store}`);
}
