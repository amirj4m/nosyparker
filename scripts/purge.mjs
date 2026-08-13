/**
 * The only place in this project where anything is deleted.
 *
 *   node scripts/purge.mjs --id 4 --yes
 *
 * Both flags are required. There is no way to run this from inside the
 * program: it exports nothing, and it refuses to run unless it was started
 * directly from a terminal. Nothing schedules it, nothing calls it, and it
 * never runs on its own.
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

// Started by a person, or not at all.
const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!startedDirectly) {
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
    stop('Which memory? Pass --id <id>.');
  }
  if (!confirmed) {
    stop(`This permanently removes memory ${id}. Add --yes if that is what you want.`);
  }

  const file = defaultStorePath();
  const db = new DatabaseSync(file);

  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('PRAGMA secure_delete = ON');

    const memory = db.prepare('SELECT id, text FROM memories WHERE id = ?').get(id);
    if (memory === undefined) {
      stop(`There is no memory ${id} in ${file}. Nothing was changed.`);
    }

    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.prepare('PRAGMA journal_mode = DELETE').get();

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    db.exec('VACUUM');

    db.prepare('PRAGMA journal_mode = WAL').get();
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();

    process.stdout.write(`Memory ${id} is gone from ${file}.\n`);
    process.stdout.write(
      'The decision log still records what happened to it, including a short excerpt ' +
        'of the text. That log is deliberately left alone.\n',
    );
  } finally {
    db.close();
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function stop(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}
