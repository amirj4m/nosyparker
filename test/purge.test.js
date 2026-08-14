/**
 * The purge script: the one thing in the project that deletes anything.
 *
 * What is checked here is that it is hard to trigger by accident, that it
 * leaves the store consistent, that it really removes the text, and that it
 * leaves the decision log alone, which is deliberate.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  getMemory,
  listDecisions,
  listMemories,
  openStore,
  supersededReason,
} from '../src/store.js';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');
const PURGE = path.join(import.meta.dirname, '..', 'scripts', 'purge.mjs');
const CLI_OWNER = 'local';

test('it refuses without both flags, and changes nothing', (t) => {
  const { run, purge, read } = workspace(t);
  run(['add', 'I live in Tehran']);

  const noFlags = purge([]);
  assert.equal(noFlags.code, 1);
  assert.match(noFlags.err, /Which memory/u);
  assert.match(noFlags.err, /--id <id> --yes/u, 'how it was typed is the problem, so say how');

  const noYes = purge(['--id', '1']);
  assert.equal(noYes.code, 1);
  assert.match(noYes.err, /Add --yes/u);
  assert.match(noYes.err, /--id <id> --yes/u);

  const noId = purge(['--yes']);
  assert.equal(noId.code, 1);

  const notANumber = purge(['--id', 'one', '--yes']);
  assert.equal(notANumber.code, 1);

  read((store) => {
    assert.equal(listMemories(store, CLI_OWNER).length, 1, 'nothing should have been removed');
  });
});

test('it refuses an id that is not there', (t) => {
  const { run, purge, file } = workspace(t);
  run(['add', 'I live in Tehran']);

  const missing = purge(['--id', '99', '--yes']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no memory 99/u);

  // The command was typed correctly. Answering it with syntax would send the
  // reader looking for a mistake that is not there.
  assert.equal(missing.err.includes('--id <id> --yes'), false, 'no usage for this one');
  assert.equal(missing.err.includes('ExperimentalWarning'), false, 'nor a Node warning');

  // Whether the row is there is now asked inside the transaction, which is
  // after the store has been taken out of WAL. Finding nothing has to put that
  // back, or a purge of a wrong id quietly changes the file it refused to
  // touch. Read raw, because opening a store sets the mode itself.
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  const mode = /** @type {{journal_mode: string}} */ (
    /** @type {unknown} */ (db.prepare('PRAGMA journal_mode').get())
  );
  assert.equal(mode.journal_mode, 'wal', 'the store was left in the wrong journal mode');
});

test('it removes the memory, keeps the log, and leaves nothing dangling', (t) => {
  const { run, purge, read, file } = workspace(t);

  run(['add', 'I live in Tehran']);
  run(['add', 'I live in Berlin', '--replaces', '1']);
  run(['add', 'I answer email in the morning']);

  const result = purge(['--id', '1', '--yes']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Memory 1 is gone/u);
  assert.match(result.out, /log is deliberately left alone/u);
  assert.equal(result.err, '', `stderr should be empty, got: ${result.err}`);

  read((store) => {
    const memories = listMemories(store, CLI_OWNER, { includeArchived: true });
    assert.deepEqual(
      memories.map((memory) => memory.id),
      [2, 3],
      'only the named memory should be gone',
    );

    // The memory that replaced it no longer claims to have replaced anything.
    assert.equal(memories[0].supersedes, null);

    // The log still has every entry, including the text of what was removed.
    const decisions = listDecisions(store, CLI_OWNER);
    assert.equal(decisions.length, 3);
    assert.equal(decisions[0].input_excerpt, 'I live in Tehran');
    assert.equal(decisions[0].memory_id, null, 'but it no longer points at a row that is gone');
  });

  assert.deepEqual(foreignKeyViolations(file), [], 'the store should be referentially consistent');
});

test('the part of a purged memory that the log does not keep is gone from the file', (t) => {
  const { run, purge, file } = workspace(t);

  // The log keeps the first 160 characters of what was offered, on purpose, so
  // a short memory survives a purge in full in the log. What this test proves
  // is narrower: the part of a memory that is past the excerpt exists nowhere
  // in the file or the write ahead log once it has been purged.
  const tail = 'ZEBRAFINCHMARKER';
  run(['add', `a memory about ${'padding '.repeat(30)}${tail}`]);
  run(['add', 'something else entirely']);

  assert.equal(fileContains(file, tail), true, 'the marker should be there before the purge');

  assert.equal(purge(['--id', '1', '--yes']).code, 0);

  assert.equal(fileContains(file, tail), false, 'the marker survived in the database file');
  assert.equal(fileContains(`${file}-wal`, tail), false, 'the marker survived in the log file');
});

test('no memory is left giving a reason that names the purged one', (t) => {
  const { run, purge, read } = workspace(t);
  const archived = { includeArchived: true };

  run(['add', 'I live in Tehran']); // 1, about to be retired by 2
  run(['add', 'I live in Berlin', '--replaces', '1']); // 2
  run(['add', 'I am vegetarian']); // 3, forgotten for a reason of its own
  run(['forget', '3', 'I eat fish again']);

  read((store) => {
    assert.equal(
      getMemory(store, CLI_OWNER, 1, archived)?.state_reason,
      supersededReason(2),
      'the sentence this test is about, asked for the way the gate writes it',
    );
  });

  assert.equal(purge(['--id', '2', '--yes']).code, 0);

  read((store) => {
    const reason = /** @type {string} */ (getMemory(store, CLI_OWNER, 1, archived)?.state_reason);
    assert.equal(reason.includes('memory 2'), false, 'it still names a memory that is gone');
    assert.match(reason, /has since been purged/u);

    // Nothing else was rewritten. A reason of somebody's own is not this
    // script's to touch.
    assert.equal(getMemory(store, CLI_OWNER, 3, archived)?.state_reason, 'I eat fish again');
  });

  // Bringing it back clears the reason outright, so there is nothing left for
  // a later purge to be wrong about either.
  run(['restore', '1']);
  read((store) => {
    assert.equal(getMemory(store, CLI_OWNER, 1)?.state_reason, null);
  });

  // The case that decides how this is matched. A memory that was replaced and
  // then forgotten still points at its replacement, but its reason is the
  // person's own words. Purging the replacement must leave those words alone,
  // which matching on superseded_by would not have done.
  run(['add', 'I take the bus']); // 4
  run(['add', 'I cycle to work', '--replaces', '4']); // 5
  run(['forget', '4', 'I sold the bike']);

  assert.equal(purge(['--id', '5', '--yes']).code, 0);

  read((store) => {
    assert.equal(
      getMemory(store, CLI_OWNER, 4, archived)?.state_reason,
      'I sold the bike',
      'a purge painted over a reason somebody wrote',
    );
  });
});

test('restoring a memory whose replacement was purged says the replacement is gone', (t) => {
  const { run, purge } = workspace(t);

  run(['add', 'I live in Tehran']); // 1
  run(['add', 'I live in Berlin', '--replaces', '1']); // 2
  assert.equal(purge(['--id', '2', '--yes']).code, 0);

  // The purge cleared superseded_by, which is the pointer this message used to
  // be built from, so restoring said only that the memory was back and left
  // the person to work out for themselves that memory 2 no longer exists.
  const restored = run(['restore', '1']);
  assert.equal(restored.code, 0);
  assert.match(restored.out, /being shown again/u);
  assert.match(restored.out, /was purged/u);

  // And an ordinary restore, with nothing missing, still says only what it did.
  run(['add', 'I keep Sundays free']); // 3
  run(['forget', '3', 'not any more']);
  const plain = run(['restore', '3']);
  assert.equal(plain.code, 0);
  assert.equal(plain.out.includes('purged'), false, 'nothing was purged in this one');
});

test('the search index forgets a purged memory', (t) => {
  const { run, purge } = workspace(t);

  run(['add', '我住在柏林并且喜欢安静的办公室']);
  run(['add', 'I answer email in the morning']);
  purge(['--id', '1', '--yes']);

  assert.match(run(['search', '柏林']).out, /Nothing matched/u);
  assert.match(run(['search', '办公室']).out, /Nothing matched/u);
  assert.match(run(['search', 'email']).out, /1 match/u);
});

test('it explains itself in a sentence when an agent is holding the store', (t) => {
  const { run, purge, read, file } = workspace(t);
  run(['add', 'I live in Tehran']);

  // An agent, connected and holding the store open, which is the ordinary
  // state of this tool rather than an unusual one.
  const agent = openStore({ file, now: () => new Date().toISOString() });
  t.after(() => {
    try {
      agent.close();
    } catch {
      // Already closed by the test body.
    }
  });

  const result = purge(['--id', '1', '--yes']);

  assert.equal(result.code, 1);
  assert.match(result.err, /something else is using it/u);
  assert.match(result.err, /agent connected to your memories/u);
  assert.equal(result.err.includes('at main'), false, 'it should not print a stack trace');
  assert.equal(result.err.includes('ERR_SQLITE_ERROR'), false);
  assert.equal(result.err.includes('--id <id> --yes'), false, 'nor a block of syntax');

  // Nothing was lost while it was refusing.
  read((store) => {
    assert.equal(listMemories(store, CLI_OWNER).length, 1);
  });

  // And once the agent lets go, the same command works.
  agent.close();
  assert.equal(purge(['--id', '1', '--yes']).code, 0);
});

test('it cannot be imported, only run', async () => {
  await assert.rejects(() => import(`file://${PURGE}`), /not something to import/u);

  // Splitting the script into a launcher and a body must not have left a
  // second way in with no lock on it.
  const body = path.join(import.meta.dirname, '..', 'scripts', 'purge-main.mjs');
  await assert.rejects(() => import(`file://${body}`), /not something to import/u);
});

/**
 * A store of its own, plus the two ways of talking to it.
 *
 * @param {import('node:test').TestContext} t
 */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-purge-'));
  const file = path.join(dir, 'memory.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * @param {string} script
   * @param {string[]} args
   */
  const start = (script, args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NOSYPARKER_STORE: file },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };

  return {
    file,
    /** @param {string[]} args */
    run: (args) => start(CLI, args),
    /** @param {string[]} args */
    purge: (args) => start(PURGE, args),
    /** @param {(store: import('../src/store.js').Store) => void} inspect */
    read: (inspect) => {
      const store = openStore({ file, now: () => new Date().toISOString() });
      try {
        inspect(store);
      } finally {
        store.close();
      }
    },
  };
}

/**
 * Ask SQLite itself whether anything points at a row that is not there.
 *
 * Asked in a separate process, because this is a question about the file as it
 * sits on disk rather than about anything this test has open.
 *
 * @param {string} file
 * @returns {unknown[]}
 */
function foreignKeyViolations(file) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const {DatabaseSync} = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       process.stdout.write(JSON.stringify(db.prepare('PRAGMA foreign_key_check').all()));`,
      file,
    ],
    { encoding: 'utf8' },
  );

  return JSON.parse(result.stdout);
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {boolean}
 */
function fileContains(file, text) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file).includes(Buffer.from(text, 'utf8'));
}
