/**
 * The migration, and the verification that decides whether it is allowed to
 * finish.
 *
 * The verification is the part worth testing hardest. A check nobody has seen
 * fail is a check that might be looking at nothing, and this project has found
 * four of those by going and looking. So every check here is shown failing
 * against a copy damaged in exactly the way that check exists to notice, and
 * the seventh — that a query which found a memory still finds it — is damaged
 * by leaving one row behind, which is the precise regression this release
 * exists to prevent.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import {
  copyStore, paths, queriesStillFind, recompute, sentenceFor, survey, verify,
} from '../src/migrate.js';
import { normaliseForComparison } from '../src/text.js';
import { openStore, searchMemories } from '../src/store.js';
import { submit } from '../src/gate.js';
import { sandboxEnv } from './helpers.js';

const MIGRATE = path.join(import.meta.dirname, '..', 'scripts', 'migrate.mjs');
const OWNER = 'local';

/**
 * A store with memories in two digit scripts, so a fold has something to do.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{home: string, file: string}}
 */
function workspace(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nosyparker-migrate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const file = path.join(home, '.nosyparker', 'memory.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const store = openStore({ file, now: () => new Date().toISOString() });
  const inScript = (/** @type {string} */ text, /** @type {number} */ zero) =>
    text.replace(/[0-9]/gu, (d) => String.fromCodePoint(zero + Number(d)));

  for (const text of [
    'my locker downstairs is number 10',
    inScript('the meeting is on floor 12', 0x06F0),
    inScript('the bus I take is the 34', 0x0660),
    'I have lived here since 2019',
    inScript('my flat number is 7', 0x0966),
    'the neighbour keeps a spare key',
  ]) {
    submit(store, { owner: OWNER, text });
  }
  store.close();

  // Written by this build, so every key is already the new one and there would
  // be nothing to migrate. The fixture has to look like a store written before
  // the change, so the keys are put back to what the old rule produced: NFKC,
  // trimmed, whitespace collapsed, lowercased, and no digit folding. Without
  // this the whole file passes by testing a migration that does nothing, which
  // is how the first version of it went green while proving nothing.
  const old = (/** @type {string} */ text) =>
    text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

  const db = new DatabaseSync(file);
  try {
    const rows = /** @type {{id: number, text: string}[]} */ (
      /** @type {unknown} */ (db.prepare('SELECT id, text FROM memories').all())
    );
    const put = db.prepare('UPDATE memories SET text_normalised = ? WHERE id = ?');
    for (const row of rows) put.run(old(String(row.text)), row.id);

    // And the folded search index rebuilt from those keys, so the fixture is a
    // store as it really would be: written under the old rule, then opened once
    // by this version, which builds the index over whatever the keys say at the
    // time. Without this the index still holds the *new* keys — put there by the
    // insert trigger when the fixture was written — and the migration appears to
    // keep it in step while doing nothing of the sort. Renaming the update
    // trigger left every test here passing, which is how this was found.
    db.exec("INSERT INTO memories_fts_folded(memories_fts_folded) VALUES('rebuild')");
  } finally {
    db.close();
  }

  return { home, file };
}

/**
 * A migrated copy, ready to be damaged.
 *
 * @param {string} file
 * @returns {string} the path to the copy
 */
function migratedCopy(file) {
  const copy = `${file}.copy`;
  fs.rmSync(copy, { force: true });
  copyStore(file, copy);
  recompute(copy);
  return copy;
}

/**
 * @param {string} file
 * @param {(db: DatabaseSync) => void} breakIt
 * @returns {void}
 */
function damage(file, breakIt) {
  const db = new DatabaseSync(file);
  try {
    // Deliberate corruption, so the constraints that exist to prevent it are
    // in the way. A verification is only worth anything against a file that
    // has actually been damaged.
    db.exec('PRAGMA foreign_keys = OFF');
    breakIt(db);
  } finally {
    db.close();
  }
}

test('a clean migration passes every check', (t) => {
  const { file } = workspace(t);
  const copy = migratedCopy(file);

  const checks = [...verify(file, copy), queriesStillFind(file, copy)];
  const failed = checks.filter((c) => !c.ok);

  assert.deepEqual(failed.map((c) => `${c.name}: ${c.wrong.join('; ')}`), []);
  assert.equal(checks.length, 7, 'a check was added or lost without this test noticing');
});

test('each check fails when the thing it watches is broken', (t) => {
  // The whole point of the file. A verification nobody has seen fail is a
  // verification that may be looking at nothing, and this project has found
  // four checks in that state by going and looking.
  const { file } = workspace(t);

  /** @param {(db: DatabaseSync) => void} breakIt @returns {string[]} */
  const namesThatFail = (breakIt) => {
    const copy = migratedCopy(file);
    damage(copy, breakIt);
    const failing = [...verify(file, copy), queriesStillFind(file, copy)]
      .filter((c) => !c.ok).map((c) => c.name);
    fs.rmSync(copy, { force: true });
    return failing;
  };

  // 1. A row goes missing.
  assert.ok(
    namesThatFail((db) => db.prepare('DELETE FROM memories WHERE id = 6').run())
      .some((n) => n.includes('same number of rows')),
    'losing a memory did not fail the row-count check');

  // 2. The text itself is altered, keeping its length so a length check would
  //    not notice.
  assert.ok(
    namesThatFail((db) => db.prepare('UPDATE memories SET text = ? WHERE id = 1').run('my locker downstairs is number 99'))
      .some((n) => n.includes('byte for byte')),
    'changing a memory\'s text did not fail the byte check');

  // 3. A key that is not what the rule produces.
  assert.ok(
    namesThatFail((db) => db.prepare('UPDATE memories SET text_normalised = ? WHERE id = 1').run('something else'))
      .some((n) => n.includes('own text')),
    'a wrong key did not fail the key check');

  // 4. The decision log edited.
  assert.ok(
    namesThatFail((db) => db.prepare('UPDATE decisions SET input_excerpt = ? WHERE id = 1').run('tampered'))
      .some((n) => n.includes('decision log')),
    'editing the decision log did not fail its check');

  // 5. The search index damaged. Deleting from `memories_fts` does nothing
  //    useful here — it is an external-content table, so its rows come from
  //    `memories` — so the damage is done to the shadow table that holds the
  //    actual index, which is what real corruption looks like.
  assert.ok(
    namesThatFail((db) => db.prepare(
      'DELETE FROM memories_fts_data WHERE id = (SELECT max(id) FROM memories_fts_data)',
    ).run())
      .some((n) => n.includes('search index')),
    'a damaged search index did not fail its check');

  // 6. The schema version moved.
  assert.ok(
    namesThatFail((db) => db.exec('PRAGMA user_version = 99'))
      .some((n) => n.includes('schema version')),
    'a moved schema version did not fail its check');

  // 7. The *folded* search index damaged. There are two indexes now — one over
  //    the text as written, one over the folded text — and search reads the
  //    folded one, so a check that only looked at the raw one would be watching
  //    the index nothing uses.
  assert.ok(
    namesThatFail((db) => db.prepare(
      'DELETE FROM memories_fts_folded_data WHERE id = (SELECT max(id) FROM memories_fts_folded_data)',
    ).run())
      .some((n) => n.includes('search index')),
    'a damaged folded index did not fail its check');
});

test('a memory left behind is caught by the query check, and by nothing else', (t) => {
  // The regression this release exists to prevent, reproduced exactly: one row
  // still keyed under the old rule. Its text is intact, the counts are right,
  // the log is untouched and the index is whole — every hygiene check passes,
  // and the memory has quietly stopped being findable in the script it was
  // written in.
  const { file } = workspace(t);
  const copy = migratedCopy(file);

  const before = new DatabaseSync(file, { readOnly: true });
  const stale = /** @type {{id: number, text_normalised: string}} */ (
    /** @type {unknown} */ (before.prepare(
      'SELECT id, text_normalised FROM memories WHERE text GLOB ? LIMIT 1',
    ).get('*[۰-۹]*'))
  );
  before.close();
  assert.ok(stale, 'the fixture has no Persian-digit memory to leave behind');

  damage(copy, (/** @type {DatabaseSync} */ db) => db.prepare('UPDATE memories SET text_normalised = ? WHERE id = ?')
    .run(stale.text_normalised, stale.id));

  const hygiene = verify(file, copy).filter((c) => !c.ok);
  const queries = queriesStillFind(file, copy);

  assert.deepEqual(
    hygiene.map((c) => c.name).filter((n) => !n.includes('own text')),
    [],
    'a hygiene check other than the key check noticed — the fixture is not isolating this');

  assert.equal(queries.ok, false, 'the query check did not notice a memory going unfindable');
  assert.match(queries.wrong.join(' '), /no longer finds/u);
  fs.rmSync(copy, { force: true });
});

test('the query check allows finding more, and only objects to finding less', (t) => {
  // Folding digits is supposed to make a Persian query reach an ASCII row. That
  // is the feature, so a term returning extra memories afterwards must pass —
  // asserted rather than assumed, because an equality check here would have
  // failed the migration for working correctly.
  const { file } = workspace(t);
  const copy = migratedCopy(file);

  assert.equal(queriesStillFind(file, copy).ok, true);

  const db = new DatabaseSync(copy, { readOnly: true });
  const hits = (/** @type {string} */ term) => /** @type {{c: number}} */ (
    /** @type {unknown} */ (db.prepare(
      "SELECT count(*) c FROM memories WHERE state = 'active' AND instr(text_normalised, ?) > 0",
    ).get(normaliseForComparison(term)))
  ).c;

  assert.equal(hits('12'), hits('۱۲'), 'the two scripts still disagree after the fold');
  assert.ok(hits('12') > 0, 'the fold found nothing at all');
  db.close();
  fs.rmSync(copy, { force: true });
});

test('it refuses when two memories that are both shown would share a key', (t) => {
  // The one case where proceeding would decide something on somebody's behalf.
  const { file } = workspace(t);

  const db = new DatabaseSync(file);
  db.prepare(
    "INSERT INTO memories (owner, text, text_normalised, created_at, state, state_reason, state_at) VALUES (?,?,?,?,'active',NULL,?)",
  ).run(OWNER, 'my locker downstairs is number ۱۰', 'my locker downstairs is number ۱۰', 'now', 'now');
  db.close();

  const found = survey(file);
  assert.ok(found.collisions.length > 0, 'two memories folding together were not noticed');
  assert.match(found.collisions[0], /would share one key/u);

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing/u);
  assert.match(run.stderr, /Nothing was changed/u);
});

test('without --yes it explains itself and changes nothing', (t) => {
  const { file } = workspace(t);
  const before = fs.readFileSync(file);

  const run = spawnSync(process.execPath, [MIGRATE], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /--yes/u);
  assert.match(run.stderr, /kept beside it as a backup/u);
  assert.deepEqual(fs.readFileSync(file), before, 'it touched the store without being told to');
});

test('it is not something to import', async () => {
  await assert.rejects(() => import(`file://${MIGRATE}`), /not something to import/u);
});

test('the backup it leaves is a working store, and it is never deleted', (t) => {
  const { file } = workspace(t);
  const wasCount = (() => {
    const db = new DatabaseSync(file, { readOnly: true });
    const n = /** @type {{n: number}} */ (/** @type {unknown} */ (db.prepare('SELECT count(*) n FROM memories').get())).n;
    db.close();
    return n;
  })();

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  assert.equal(run.status, 0, run.stderr);

  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.backup-'));
  assert.equal(backups.length, 1, 'exactly one backup should have been left');

  const backup = path.join(path.dirname(file), backups[0]);
  const db = new DatabaseSync(backup, { readOnly: true });
  assert.equal(
    /** @type {{integrity_check: string}} */ (/** @type {unknown} */ (db.prepare('PRAGMA integrity_check').get())).integrity_check,
    'ok', 'the backup is not a sound database');
  assert.equal(
    /** @type {{n: number}} */ (/** @type {unknown} */ (db.prepare('SELECT count(*) n FROM memories').get())).n,
    wasCount, 'the backup does not hold what the store held');
  db.close();

  // And it holds the *old* keys, which is what makes it a way back.
  assert.match(run.stdout, /Delete it yourself/u);
  assert.match(run.stdout, /mv /u, 'it does not say how to put it back');
});

test('a store nothing needs doing to is left alone', (t) => {
  const { file } = workspace(t);

  const first = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8', env: { ...process.env, NOSYPARKER_STORE: file },
  });
  assert.equal(first.status, 0, first.stderr);

  const after = fs.readFileSync(file);
  const second = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8', env: { ...process.env, NOSYPARKER_STORE: file },
  });

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Nothing to do/u);
  assert.deepEqual(fs.readFileSync(file), after, 'a second run rewrote a store it had nothing to do to');
  assert.equal(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.backup-')).length, 1,
    'a run with nothing to do still took a backup');
});

test('killed at any point, he is left with a store he can read', (t) => {
  // His machine has been killed by the OOM killer five times this week, so this
  // is not hypothetical. The dangerous moment is the swap, and what makes it
  // dangerous is the write-ahead log: the live store has sidecars belonging to
  // the old file, and a new file renamed in underneath them is a corruption
  // waiting to be opened. The order exists to close that window — sidecars
  // first, rename last — and the only way to believe it is to kill the thing.
  //
  // Judged by what the program itself can read afterwards rather than by which
  // files exist, because the question he would ask is "are my memories there".
  const { file, home } = workspace(t);
  const pristine = fs.readFileSync(file);

  let clean = 0;
  let recovered = 0;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    fs.writeFileSync(file, pristine);
    for (const sidecar of ['-wal', '-shm', '-journal']) fs.rmSync(`${file}${sidecar}`, { force: true });
    for (const left of fs.readdirSync(path.dirname(file))) {
      if (left.includes('.migrating.') || left.includes('.backup-')) {
        fs.rmSync(path.join(path.dirname(file), left), { force: true });
      }
    }

    // The child inherits the sandboxed environment rather than being handed a
    // home of its own, so this goes through `sandboxEnv` like everything else
    // that spawns. `NOSYPARKER_STORE` is cleared on purpose: the default path
    // is what the migration resolves, and it is the path being tested.
    const child = spawnSync(process.execPath, [
      '-e',
      `const {spawn}=require('node:child_process');`
      + `const c=spawn(process.argv[1],[process.argv[2],'--yes'],{stdio:'ignore'});`
      + `setTimeout(()=>{try{process.kill(c.pid,'SIGKILL')}catch{}},${40 + attempt * 45});`
      + `setTimeout(()=>process.exit(0),1200);`,
      process.execPath, MIGRATE,
    ], { encoding: 'utf8', timeout: 20_000, env: sandboxEnv(home, { NOSYPARKER_STORE: '' }) });
    assert.ok(child.status === 0 || child.status === null, 'the harness itself failed');

    assert.ok(fs.existsSync(file), 'the store is gone entirely — no window may leave nothing');

    const hot = fs.existsSync(`${file}-journal`);
    const read = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli.js'), 'list'], {
      encoding: 'utf8', env: sandboxEnv(home, { NOSYPARKER_STORE: '' }),
    });

    assert.equal(read.status, 0,
      `after a kill the program cannot read the store: ${read.stderr.slice(0, 200)}`);
    assert.match(read.stdout, /^1\./mu, 'the store reads as empty after a kill');

    if (hot) recovered += 1; else clean += 1;
  }

  assert.equal(clean + recovered, 8);
});


test('it refuses while something else has the store open, and refuses before it copies', (t) => {
  // His own run, reproduced. The check that was there asked `BEGIN IMMEDIATE`,
  // which in WAL mode succeeds alongside any number of readers — so a client
  // sitting with the store open passed it. The migration then copied the store,
  // rewrote 154 rows, ran all seven verifications, and only met the truth at
  // the swap, where `PRAGMA journal_mode = DELETE` needs the file to itself and
  // said `database is locked`.
  //
  // Measured rather than reasoned: with a second connection open, `BEGIN
  // IMMEDIATE` succeeds, `journal_mode = DELETE` fails, and an exclusive
  // locking-mode write fails in the same way as the swap. So the early check
  // has to be the exclusive one, and this asserts on the working file rather
  // than on the exit code, because exiting 1 after doing all the work is
  // exactly the behaviour being removed.
  const { file } = workspace(t);
  const { working } = paths(file, 'unused');

  const holder = new DatabaseSync(file);
  holder.prepare('SELECT count(*) FROM memories').get();

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  holder.close();

  assert.equal(run.status, 1, 'it did not refuse');
  assert.equal(
    fs.existsSync(working), false,
    'it copied the store before finding out it could not finish, and left the copy behind',
  );
  assert.match(run.stderr, /open/u, 'it did not say what was wrong');
  assert.match(run.stderr, /Nothing was changed/u);
});

test('nothing it prints when it refuses is a stack trace', (t) => {
  // Every other refusal in this project is a sentence. This one printed a raw
  // Node trace with a file path and a line number to somebody whose editor was
  // open — which is the commonest way to arrive here, not a rare one.
  const { file } = workspace(t);

  const holder = new DatabaseSync(file);
  holder.prepare('SELECT count(*) FROM memories').get();
  const locked = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  holder.close();

  for (const [what, output] of [['the locked message', locked.stderr]]) {
    assert.doesNotMatch(output, /^\s*at .+:\d+:\d+\)?$/mu, `${what} contains a stack frame`);
    assert.doesNotMatch(output, /\bError:/u, `${what} shows a raw error class`);
    assert.doesNotMatch(output, /migrate-main\.mjs/u, `${what} names a source file`);
  }
});

test('a working file left by a run that changed nothing says so, and says what to do', (t) => {
  // It left him stuck. Refusing because the working file is there is right; the
  // sentence was not, because it described the dangerous case — a run that got
  // far enough that the copy might be the only thing that finished — when in
  // fact the run had failed at the swap and his store was untouched.
  //
  // The two are told apart from the store itself rather than from a marker file
  // that could also be left behind: if the live store still holds rows keyed
  // under the old rule, the swap did not happen and nothing of his changed.
  const { file } = workspace(t);
  const { working } = paths(file, 'unused');
  fs.writeFileSync(working, 'not a store, and it does not need to be');

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(working.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    'it did not name the file it is refusing over');
  assert.match(run.stderr, /Your store was not changed|nothing was changed/iu,
    'it did not say his store is untouched');
  assert.doesNotMatch(run.stderr, /only thing that finished/u,
    'it gave the dangerous-case sentence for the safe case');
  assert.equal(fs.existsSync(file), true);
});

test('and a working file beside an already-migrated store keeps the careful sentence', (t) => {
  // The other side of it. If the store no longer has anything to migrate and a
  // working file is still there, what that file is cannot be told from here,
  // and the cautious wording is the right one. Without this the fix would be a
  // rewording that always says the reassuring thing.
  const { file } = workspace(t);

  const first = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  assert.equal(first.status, 0, `the first migration failed: ${first.stderr.slice(0, 300)}`);

  const { working } = paths(file, 'unused');
  fs.writeFileSync(working, 'left over from something nobody can identify');

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /only thing that finished/u,
    'it reassured about a file it cannot account for');
});


test('a failure that is not a lock is not reported as one, and is still a sentence', (t) => {
  // The first version of the exclusive-lock check treated every error the same
  // way, so a directory it could not write reported that somebody had the store
  // open — sending a person to close editors that were already closed. The
  // check has to say which of the two it met.
  const { file, home } = workspace(t);
  const directory = path.dirname(file);

  // Put back inside the test rather than in an `after` hook: the workspace's own
  // cleanup is registered first and runs first, and it cannot delete a store
  // inside a directory it may not write.
  fs.chmodSync(directory, 0o500);

  // If the process can write anyway — running as root — this proves nothing, so
  // say so rather than passing.
  let writable = true;
  try { fs.writeFileSync(path.join(directory, '.probe'), ''); fs.rmSync(path.join(directory, '.probe')); }
  catch { writable = false; }
  assert.equal(writable, false, 'the directory is still writable, so this test cannot run');

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  fs.chmodSync(directory, 0o700);

  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, /has your store open/u,
    'it blamed a client for a problem with the file');
  assert.match(run.stderr, /Nothing was changed/u);
  assert.doesNotMatch(run.stderr, /^\s*at .+:\d+:\d+\)?$/mu, 'it printed a stack frame');
  assert.ok(home);
});

test('an unexpected failure is turned into a sentence rather than a trace', () => {
  // The catch-all, tested where it lives. Every failure this migration can be
  // driven into from outside is now handled and named — a lock, a file it
  // cannot write, a store that is not one — so manufacturing an unforeseen
  // failure end to end would mean putting a hook in the program to break
  // itself, and a test-only branch in the one script that rewrites somebody's
  // store is a worse thing than the gap it closes. The formatter is tested
  // directly instead, and the three reachable failures are asserted for stack
  // frames above.
  const shown = sentenceFor(new Error('ENOSPC: no space left on device, write'));

  assert.doesNotMatch(shown, /^\s*at .+:\d+:\d+\)?$/mu, 'it kept a stack frame');
  assert.doesNotMatch(shown, /migrate-main\.mjs/u, 'it named a source file');
  assert.match(shown, /ENOSPC: no space left on device/u, 'it threw away what went wrong');
  assert.match(shown, /Nothing was changed/u);
  assert.match(shown, /report/iu, 'it did not ask for the failure to be reported');

  // A thrown non-Error still has to come out as prose.
  assert.match(sentenceFor('just a string'), /just a string/u);
  assert.doesNotMatch(sentenceFor({ nope: true }), /\[object Object\]/u);
});

test('after the migration, the two scripts find the same memories', (t) => {
  // The upgrade path for anybody who is not already on 0.0.4, run end to end.
  // The folded index is built when this version first opens the store — which
  // happens *before* the migration, so it is built over keys the old rule
  // produced and is briefly as wrong as they are. The migration then rewrites
  // those keys, the index triggers follow, and the two scripts agree.
  //
  // The term has to be three characters or more *and* sit in a row whose key
  // the migration changes, or it never reaches the index at all. The first
  // version of this test used `۱۲` and `٣٤`, which are two characters and go to
  // the substring path, and `2019`, which is ASCII and does not change — so it
  // passed with the folded index's update trigger deleted outright. A digit run
  // long enough to be a trigram, in a script the fold moves, is the whole point.
  const { file } = workspace(t);

  const old = (/** @type {string} */ text) =>
    text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const persian = 'the storage unit is number ۱۲۳';

  const seed = new DatabaseSync(file);
  seed.prepare(
    "INSERT INTO memories (owner, text, text_normalised, created_at, state, state_reason, state_at)"
    + " VALUES (?,?,?,?,'active',NULL,?)",
  ).run(OWNER, persian, old(persian), 'now', 'now');
  seed.exec("INSERT INTO memories_fts_folded(memories_fts_folded) VALUES('rebuild')");
  seed.close();

  const run = spawnSync(process.execPath, [MIGRATE, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NOSYPARKER_STORE: file },
  });
  assert.equal(run.status, 0, `the migration failed: ${run.stderr.slice(0, 300)}`);

  const store = openStore({ file, now: () => new Date().toISOString() });
  t.after(() => store.close());

  /** @param {string} term @returns {string[]} */
  const found = (term) => searchMemories(store, OWNER, term).map((m) => m.text).sort();

  assert.deepEqual(found('123'), [persian], 'the ASCII form does not find the Persian memory');
  assert.deepEqual(found('۱۲۳'), [persian], 'the Persian form does not find its own memory');
  assert.deepEqual(found('123'), found('۱۲۳'));

  // And the short terms, which went through the substring path all along.
  for (const [a, b] of [['12', '۱۲'], ['34', '٣٤']]) {
    assert.deepEqual(found(a), found(b), `"${a}" and "${b}" disagree after the migration`);
  }
});
