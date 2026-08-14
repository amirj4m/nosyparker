/**
 * The only place in this project where anything is deleted.
 *
 *   node scripts/purge.mjs --id 4 --yes
 *
 * Both flags are required. There is no way to run this from inside the
 * program: it exports nothing, and it refuses to run unless `purge.mjs` next
 * door is what started the process, which itself refuses to run unless a
 * person started it. Nothing schedules it, nothing calls it, and it never runs
 * on its own.
 *
 * Why the file is handled the way it is below. In WAL mode a committed change
 * lives in the write ahead log while the old page, with the old bytes, is
 * still sitting in the main file. A crash in that window would leave the row
 * gone but its bytes readable. So the store is taken out of WAL mode first,
 * and `secure_delete` is turned on, which makes SQLite overwrite the freed
 * bytes as part of the delete itself rather than merely marking the space
 * free. After that the order is:
 *
 *   checkpoint  fold anything already in the write ahead log into the file
 *   no WAL      so the delete has no second file to leave a copy in
 *   delete      with secure_delete on, the freed bytes are overwritten
 *   vacuum      rebuild the file so no stale page survives anywhere in it
 *   WAL again   put the store back the way the rest of the program expects
 *
 * A crash before the delete commits leaves the memory intact, which is safe.
 * A crash after it commits leaves nothing behind, because at that moment the
 * bytes have already been overwritten and there is no write ahead log holding
 * a copy of them.
 */

import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { defaultStorePath } from '../src/config.js';
import { PURGED_REPLACEMENT_REASON, supersededReason } from '../src/store.js';

// Started by a person, through the launcher, or not at all.
//
// `purge.mjs` is what a person types, and it is the only thing allowed to
// start this. Checked here as well as there, because otherwise splitting the
// script in two would have handed anybody who wanted to delete a memory from
// inside the program a second door with no lock on it.
const startedByLauncher =
  process.argv[1] !== undefined &&
  new URL('./purge.mjs', import.meta.url).href === pathToFileURL(process.argv[1]).href;

if (!startedByLauncher) {
  throw new Error('purge.mjs is run by hand from a terminal. It is not something to import.');
}

const USAGE = `Permanently remove one memory. This cannot be undone.

  node scripts/purge.mjs --id <id> --yes

Both flags are required.
`;

main(process.argv.slice(2));

/**
 * @param {string[]} argv
 */
function main(argv) {
  const confirmed = argv.includes('--yes');
  const idFlag = argv.indexOf('--id');
  const id = idFlag === -1 ? Number.NaN : Number(argv[idFlag + 1]);

  if (!Number.isInteger(id) || id <= 0) {
    stopWithUsage('Which memory? Pass --id <id>.');
  }
  if (!confirmed) {
    stopWithUsage(`This permanently removes memory ${id}. Add --yes if that is what you want.`);
  }

  const file = defaultStorePath();
  const db = new DatabaseSync(file);

  try {
    // Several agents connected at once is the ordinary state of this tool, so
    // any of the steps below can find the store locked.
    //
    // Be exact about what this buys, because the name promises more than it
    // delivers: SQLite does not apply busy_timeout to a change of journal
    // mode, and taking the store out of WAL is the first thing this script
    // does to it. So against a store somebody else is holding, this does not
    // wait ten seconds; it gives up in a few milliseconds. The timeout covers
    // the ordinary statements and not that one. Either way the failure is
    // caught below and answered with a sentence, which is the behaviour that
    // matters here, and nothing has been changed by the time it happens.
    db.exec('PRAGMA busy_timeout = 10000');

    // Left on, so that the database itself refuses to let this script leave a
    // reference pointing at a row that is gone.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA secure_delete = ON');

    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.prepare('PRAGMA journal_mode = DELETE').get();

    db.exec('BEGIN IMMEDIATE');
    try {
      // Whether the memory is there is asked here, under the same lock that
      // deletes it. Asked before the transaction, two purges of the same id
      // both saw the row, both carried on, and both said the memory was gone
      // although only one of them had deleted anything. Every other read in
      // this project that a write depends on was moved inside its transaction
      // for the same reason; this one was left behind.
      const memory = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
      if (memory === undefined) {
        db.exec('ROLLBACK');

        // The store was taken out of WAL a moment ago, before it was known
        // whether there was anything to delete. Put it back before leaving, so
        // that finding nothing does not change the file either.
        db.prepare('PRAGMA journal_mode = WAL').get();
        stop(`There is no memory ${id} in ${file}. Nothing was changed.`);
      }

      // Everything that points at this memory stops pointing at it first, so
      // that the delete cannot leave a reference to a row that is not there.
      // Rows are only ever unlinked here, never removed.
      //
      // The decision log is deliberately not scrubbed, and `input_excerpt`
      // keeps the short piece of text it always held. This is the owner's
      // decision, not an oversight: if something is ever wrong, he wants to be
      // able to see what was removed. A purge that also erased the record of
      // the purge would leave him with a store that had quietly changed and no
      // way to find out how. Please do not "fix" this later by deleting or
      // blanking these rows.
      //
      // A retired memory carries the sentence the gate wrote when it was
      // retired, which names the memory that replaced it. Once that memory is
      // deleted the sentence is false, so it is rewritten here, in the same
      // transaction as the delete, and no row is ever readable while citing a
      // memory that has already gone.
      //
      // The sentence to look for comes from `supersededReason`, the same
      // function the gate writes it with. Spelling it out here as well was a
      // reword away from this script searching for something nobody writes and
      // saying it had put things right.
      //
      // Matched on the sentence rather than on `superseded_by`, which is the
      // wider net and the wrong one. Forgetting a memory that had been replaced
      // keeps the pointer and puts the person's own words in the reason, so
      // matching the pointer would paint over a sentence somebody wrote with
      // one about a purge they never mentioned. Only the gate's own sentence,
      // naming this id, is this script's to correct.
      //
      // That line is deliberate, and it is not an inconsistency to be tidied
      // up later. This script corrects the gate's sentence because the gate
      // wrote it: it is the program's own bookkeeping, and once it names a
      // memory that has been deleted it is simply wrong. A reason somebody
      // typed is a different thing. It is what they meant at the time, it is
      // theirs, and it stays exactly as they wrote it even when it mentions a
      // memory that is now gone. So a person who forgets a memory with the
      // reason "superseded by 4" and later purges memory 4 keeps those words,
      // and that is the intended outcome, not an oversight. The decision log
      // records the reason either way. The owner has been asked and has
      // decided this: we do not edit words a person wrote.
      //
      // It is built in JavaScript rather than joined together in SQL for a
      // second reason: node:sqlite binds a JavaScript number as a REAL, so
      // asking SQLite for `'Replaced by memory ' || ?` with 2 gets back
      // `Replaced by memory 2.0`, which matches nothing at all and fails by
      // quietly doing nothing.
      //
      // The sentence it becomes is shared too, because it is the only trace
      // left that there was ever a replacement: the pointer that used to say
      // so is cleared two lines below. `restore` reads it to tell somebody the
      // replacement is gone.
      db.prepare('UPDATE memories SET state_reason = ? WHERE state_reason = ?').run(
        PURGED_REPLACEMENT_REASON,
        supersededReason(id),
      );

      db.prepare('UPDATE memories SET supersedes = NULL WHERE supersedes = ?').run(id);
      db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(id);
      db.prepare('UPDATE decisions SET memory_id = NULL WHERE memory_id = ?').run(id);
      db.prepare('UPDATE decisions SET related_memory_id = NULL WHERE related_memory_id = ?').run(id);

      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) {
      throw new Error(
        `Refusing to finish: the store has ${broken.length} broken references after this delete.`,
      );
    }

    db.exec('VACUUM');

    db.prepare('PRAGMA journal_mode = WAL').get();
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();

    process.stdout.write(`Memory ${id} is gone from ${file}.\n`);
    process.stdout.write(
      'The decision log still records what happened to it, including a short excerpt ' +
        'of the text. That log is deliberately left alone. Anything that pointed at ' +
        'this memory no longer does.\n',
    );
  } catch (error) {
    // If it is still locked after all that waiting, an agent is holding the
    // store. Say so in a sentence rather than printing a stack trace at
    // somebody who is trying to delete one row.
    if (isLocked(error)) {
      stop(
        'Could not get to the store, because something else is using it. That will be an ' +
          'agent connected to your memories. Close it and run this again. Nothing was changed.',
      );
    }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isLocked(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('database is locked') || message.includes('database table is locked');
}

/**
 * @param {string} message
 * @returns {never}
 */
function stop(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * The same, plus how to type the command.
 *
 * Only the two failures that are actually about how it was typed use this. A
 * store that something else is holding, or an id that is not in the file, has
 * nothing to do with the wording of the command, and answering those with a
 * block of syntax told the reader to look in the wrong place.
 *
 * @param {string} message
 * @returns {never}
 */
function stopWithUsage(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}
