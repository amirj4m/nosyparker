/**
 * The storage layer.
 *
 * Two tables. `memories` holds what was stored, `decisions` holds why. A
 * memory is never removed here: it changes state, and the old state stays
 * readable. There is no DELETE statement anywhere in this file, and no code
 * path in this project deletes a row except `scripts/purge.mjs`, which a
 * person runs by hand.
 *
 * Nothing outside this file ever holds the database handle. It is not on the
 * Store object and it is not passed to callers: `recordDecision` hands the
 * caller a small set of named actions instead, one for each change a memory is
 * allowed to undergo, and every one of them is written alongside the decision
 * row that explains it.
 *
 * That is the whole of the guarantee, and it is worth being precise about why
 * it holds. A caller cannot write arbitrary SQL because it is never given
 * anything that runs SQL. It cannot keep the actions and use them after the
 * fact either: they stop working the moment the transaction ends. So there is
 * no sequence of calls, on any object reachable from here, that changes a
 * memory without also writing down why.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { controlCharacterIn, namedCodePoint, normaliseForComparison } from './text.js';

/**
 * A note on the driver, because the question will be asked again.
 *
 * A U+0000 in a text value is written faithfully and read back cut off at the
 * NUL. Measured, one file, both drivers writing and both reading, 42
 * characters offered:
 *
 *     on disk, either writer   42 bytes, and hex() shows all of them
 *     read by node:sqlite      20 characters
 *     read by better-sqlite3   42 characters
 *
 * So the storage is faithful and the truncation is in this binding, which
 * takes the length of the C string rather than asking SQLite how many bytes
 * there are. SQLite's own `length()` on a TEXT value stops at the NUL too, so
 * the engine is not blameless, but `length(CAST(text AS BLOB))` and `hex()`
 * both report the whole thing: nothing is lost, it is only hidden on the way
 * out.
 *
 * We stay on node:sqlite, and the reason is not inertia. Nothing can put a NUL
 * in a memory any more — the gate refuses one, with a row, before it reaches
 * this file — so the difference between the two drivers cannot be reached
 * through this program. And if it ever needs reading anyway, this binding can
 * do it: `SELECT CAST(text AS BLOB)` and decoding the bytes in JavaScript
 * returns all 42 characters, faithfully, for a row written by either driver.
 * The fix is available at our own layer and does not need a dependency.
 *
 * What swapping would cost, since it was weighed rather than assumed: 27 MB
 * and a native module against nothing at all, on a project whose distribution
 * story is that a stranger runs one command. It ships prebuilt binaries for
 * every platform this needs, Windows included, and falls back to compiling
 * with node-gyp when none matches — which is a class of install failure this
 * project does not have today.
 *
 * What swapping would not buy: anything at all for the memory defect. The same
 * 0.4 MB degenerate corpus and 999-character query costs 868 MB under
 * node:sqlite and 875 MB under better-sqlite3. It is the same SQLite and the
 * same FTS5 underneath, so the trigram position lists are identical. The
 * database is not the problem there and a different binding is not the fix.
 */

/**
 * FTS5's report on its own vocabulary, per connection and never on disk.
 *
 * One name, used by the statement that reads it and by the statement that
 * creates it, so the two cannot drift apart.
 */
const VOCABULARY = 'temp.memories_vocabulary';

/** Trigram search needs at least three characters to match on. */
const MIN_SEARCH_LENGTH = 3;

/**
 * The longest query this store will run.
 *
 * This is not the bound that makes the search safe. `SEARCH_WORK_LIMIT` is,
 * and it was added after this one turned out to be at the wrong end of the
 * problem. This one stays because it is cheap and it caps the multiplier, but
 * on its own it does nothing.
 *
 * The cost is roughly the length of the query multiplied by how much matching
 * text is already stored, and the second factor has no limit at all. This
 * comment once said the number below was "the one thing standing between a
 * caller and the machine going down", and that was wrong. Measured, with a
 * query one character inside this bound, against one memory of a repeated
 * character:
 *
 *     stored 0.1 MB   ->   273 MB
 *     stored 0.4 MB   ->   874 MB
 *     stored 0.8 MB   ->   killed at 1225 MB
 *     stored 1.6 MB   ->   killed at 1210 MB
 *
 * That text is ordinary input: through `add`, which bounds nothing, or through
 * about a hundred `remember` calls each inside the adapter's own limit. So the
 * ten gigabyte allocation is still reachable, and no number chosen here can
 * close it, because the term this bound multiplies against keeps growing.
 *
 * Why it stays anyway: it is the cheap half. It stops a single caller turning
 * one search into a thousandfold multiplier, and it costs nothing to keep. It
 * is a mitigation, not a guarantee, and it must not be read as one.
 *
 * What the shape of the problem is, measured rather than reasoned about:
 *
 *   - Bounding the length of a single term does not help. Cut into 199 terms
 *     of four characters, the same 999 characters cost more, not less.
 *   - SQLite's own `hard_heap_limit` and `soft_heap_limit` are inert here.
 *     They are accepted and read back, and 871 MB was still allocated against
 *     a 128 MB limit, because Node's build sets DEFAULT_MEMSTATUS=0 and there
 *     is no accounting behind them.
 *   - `node:sqlite` exposes no interrupt and no progress handler, so a query
 *     already running cannot be stopped from JavaScript, and it is synchronous
 *     so nothing else in the process runs while it finishes.
 *   - Ordinary text is not affected. Real sentences, even the same sentence
 *     repeated to 1.6 MB, answer in single-digit milliseconds. Only text with
 *     very few distinct trigrams — repeated characters, base64, logs, pasted
 *     blobs — behaves this way.
 *   - The substring path this file already has for short terms is bounded and
 *     fast against exactly that text: 153 MB and 35 ms against a 12.8 MB store
 *     of one repeated character, where the index path dies at 0.8 MB.
 *
 * The answer in the end was neither a longer nor a shorter number here, but
 * asking the index what the search would cost and refusing it when the answer
 * is too much. That is `SEARCH_WORK_LIMIT`, below.
 */
export const SEARCH_QUERY_LIMIT = 1000;

/**
 * The most work a single search is allowed to be worth, before it is refused.
 *
 * This is the bound the query length could not be. What costs the memory is
 * not how long the query is but how much of one stored memory each of its
 * trigrams matches, so the only honest place to decide is with both in hand —
 * which is here, once, before the search runs.
 *
 * The measure is the number of trigrams in the query multiplied by the largest
 * average occurrences-per-memory among them, asked of the index itself rather
 * than guessed at. Measured against real searches:
 *
 *     0.4 MB in one memory, 999-char query      418,169,716    869 MB
 *     0.1 MB in one memory, 999-char query      104,540,435    269 MB
 *     1.0 MB across 100 memories                 10,451,551    220 MB, 10.6 s
 *     25 MB of ordinary text, 999-char query        745,299     59 MB, 8 ms
 *     6.4 MB of ordinary text, 999-char query       763,280     62 MB, 7 ms
 *     25 MB of ordinary text, one word                5,140     89 MB, 72 ms
 *
 * The two groups are a hundredfold apart, and the number below sits between
 * them with about six times the headroom over the worst ordinary search
 * measured. Nothing a person or an agent searches for in earnest comes near
 * it: reaching it needs a memory made of very few distinct trigrams — a run of
 * one character, base64, a pasted log — which is exactly the text this was
 * always about.
 *
 * It refuses. It does not quietly return the cheap part of the answer, and it
 * must never be changed into something that does. Phase 1 took out a fifty
 * result cap and a two hundred row cap for that reason: a caller cannot tell a
 * complete answer from a shortened one, and neither can the person reading it.
 * A search this store will not run is a sentence saying so.
 */
export const SEARCH_WORK_LIMIT = 5_000_000;

/**
 * The shape of file this code knows how to read. Raise it whenever a column is
 * added, removed or changed.
 *
 * Every statement below says IF NOT EXISTS, which is the right thing for a
 * table that is not there and says nothing at all about a table that is there
 * but is missing a column. A store written before `text_normalised` existed
 * therefore opened without complaint, read without complaint, and then failed
 * on the first write with `no such column: text_normalised`, which names a
 * column the person has never heard of and points at no file. The number below
 * is written into new stores and checked whenever an existing one is opened,
 * in either direction, so that the failure happens at the door and in a
 * sentence.
 *
 * Exported so that the tests can check against it rather than against a copy
 * of the number, which would go red on the first bump for reasons that had
 * nothing to do with the change being made.
 */
export const SCHEMA_VERSION = 1;

/**
 * @typedef {object} Memory
 * @property {number} id
 * @property {string} owner
 * @property {string} text
 * @property {string} text_normalised
 * @property {string} created_at
 * @property {'active'|'superseded'|'forgotten'} state
 * @property {string|null} state_reason
 * @property {string} state_at
 * @property {number|null} supersedes
 * @property {number|null} superseded_by
 */

/**
 * @typedef {object} Decision
 * @property {number} id
 * @property {string} owner
 * @property {string} decided_at
 * @property {string} verdict
 * @property {string} rule
 * @property {string} explanation
 * @property {number|null} memory_id
 * @property {number|null} related_memory_id
 * @property {string} input_excerpt
 */

/**
 * A store, as seen from outside this module. Note what is not on it: there is
 * no database handle to borrow.
 *
 * @typedef {object} Store
 * @property {() => string} now
 * @property {string} file
 * @property {() => void} close
 */

/**
 * @typedef {object} Handle
 * @property {DatabaseSync} db
 * @property {boolean} deciding whether a decision is open on this store
 */

/**
 * The database handles, kept here and nowhere else.
 *
 * @type {WeakMap<Store, Handle>}
 */
const handles = new WeakMap();

/**
 * @param {Store} store
 * @returns {Handle}
 */
function handleOf(store) {
  const handle = handles.get(store);
  if (handle === undefined) {
    throw new TypeError('That is not an open store.');
  }
  return handle;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY,
  owner         TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  -- The same text after NFKC, trimming, collapsing runs of whitespace and
  -- lowercasing. It is written once, when the memory is stored, so that asking
  -- "is this already stored?" is a question the database can answer by itself
  -- rather than one that drags every active memory into JavaScript on every
  -- write, inside the lock every other agent is waiting on. Case folding
  -- happens here, in JavaScript, because SQLite's own lower() only knows ASCII.
  text_normalised TEXT  NOT NULL,
  created_at    TEXT    NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'active'
                CHECK (state IN ('active', 'superseded', 'forgotten')),
  state_reason  TEXT,
  state_at      TEXT    NOT NULL,
  supersedes    INTEGER REFERENCES memories(id),
  superseded_by INTEGER REFERENCES memories(id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id                INTEGER PRIMARY KEY,
  owner             TEXT    NOT NULL,
  decided_at        TEXT    NOT NULL,
  verdict           TEXT    NOT NULL,
  rule              TEXT    NOT NULL,
  explanation       TEXT    NOT NULL,
  memory_id         INTEGER REFERENCES memories(id),
  related_memory_id INTEGER REFERENCES memories(id),
  input_excerpt     TEXT    NOT NULL
);

-- Trigram, not unicode61. unicode61 finds nothing in Chinese or Japanese
-- because it splits on spaces, and this has to work in every language.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Nothing in this project deletes a memory row. This trigger exists so that
-- the search index still matches the table after somebody runs the purge
-- script by hand.
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

/**
 * Open the store, creating the file and the tables if they are not there yet.
 *
 * @param {object} options
 * @param {string} options.file absolute path to the SQLite file
 * @param {() => string} options.now clock, returns an ISO 8601 timestamp
 * @returns {Store}
 */
export function openStore({ file, now }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  // busy_timeout comes first, and that order matters. Setting the journal mode
  // takes a lock, and so does creating the tables. With several agents opening
  // the same store at the same moment, whichever one arrives second fails
  // outright with "database is locked" unless it has already been told to wait.
  // Every statement after this line waits its turn instead of giving up.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  try {
    prepareSchema(db, file);

    // FTS5's own view of its vocabulary, which is what tells a search what it
    // would cost before it runs. Created in `temp`, on purpose: it belongs to
    // this connection and nothing about the file on disk changes, so no schema
    // version moves and a store written by this code still opens under the
    // version before it.
    db.exec(`CREATE VIRTUAL TABLE ${VOCABULARY} USING fts5vocab(main, memories_fts, 'row')`);
  } catch (error) {
    // Nothing is handed back, so nothing else can close this.
    db.close();
    throw error;
  }

  /** @type {Store} */
  const store = {
    now,
    file,
    close() {
      db.close();
      handles.delete(store);
    },
  };

  handles.set(store, { db, deciding: false });
  return store;
}

/**
 * Put the tables in a new file, or refuse one this code does not match.
 *
 * There is no migration here and there is deliberately no place to put one.
 * Failing at the door, naming the file, is the whole of what this does.
 *
 * The version and the tables are read and written inside one transaction,
 * because several agents opening the same new store at the same moment is the
 * ordinary case for this tool. Split across the boundary, the second one can
 * see the first one's tables before it sees the version those tables were
 * written under, and turn a perfectly current file away.
 *
 * @param {DatabaseSync} db
 * @param {string} file
 */
function prepareSchema(db, file) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const version = Number(
      /** @type {{user_version: number}} */ (
        /** @type {unknown} */ (db.prepare('PRAGMA user_version').get())
      ).user_version,
    );

    // Nothing has ever been stored here, so there is no old shape to be wrong
    // about and this is simply a new store.
    const fresh =
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
        .get() === undefined;

    if (fresh) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (version < SCHEMA_VERSION) {
      throw new Error(
        `${file} was written by an older version of nosyparker: it is at schema version ` +
          `${version} and this code needs ${SCHEMA_VERSION}. It is missing at least one column ` +
          'this code writes to, so it has not been opened and nothing in it has been changed. ' +
          'There is no upgrade: move the file aside and start a new store, or go back to the ' +
          'version that wrote it.',
      );
    } else if (version > SCHEMA_VERSION) {
      // The same failure from the other side, and a different problem to be
      // in: the file is fine and this copy of the program is the old one. Said
      // separately, because "move the file aside" would be exactly the wrong
      // advice here. It is the newer memories that would be lost.
      throw new Error(
        `${file} was written by a newer version of nosyparker: it is at schema version ` +
          `${version} and this code only knows ${SCHEMA_VERSION}. It has been left alone rather ` +
          'than written to by code that does not know its shape. Update nosyparker and open it ' +
          'again; the file itself is fine and nothing in it has been changed.',
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing to undo, or nothing that can be undone. The failure above is
      // the one worth reporting either way.
    }
    throw error;
  }
}

/**
 * What a memory's `state_reason` says for as long as it stands replaced.
 *
 * One definition and three readers: the gate writes it when a memory is
 * retired, the purge script goes looking for it when the memory it names is
 * deleted, and the tests check the end of that story. Spelled out separately
 * in each place, as it was, rewording it here would have left the purge script
 * hunting for a sentence nobody writes any more — and failing at that in the
 * worst way available, reporting a successful purge while quietly correcting
 * nothing. Now the wording lives in one place and they cannot drift apart.
 *
 * @param {number} supersededBy id of the memory that replaced this one
 * @returns {string}
 */
export function supersededReason(supersededBy) {
  return `Replaced by memory ${supersededBy}`;
}

/**
 * What that sentence becomes once the memory it named has been purged.
 *
 * Written by the purge script and read by the gate: it is the only trace left
 * that there ever was a replacement, because the purge clears the pointer that
 * used to say so. `restore` reads it to know it should mention that the
 * replacement is gone. Kept here for the same reason as the sentence above —
 * two copies would be one reword away from restore quietly falling silent
 * again.
 */
export const PURGED_REPLACEMENT_REASON =
  'Replaced by a newer memory, which has since been purged.';

/**
 * Everything a decision is allowed to do to a memory. There is nothing here
 * that runs a statement of the caller's choosing, which is deliberate.
 *
 * @typedef {object} StoreActions
 * @property {(row: {owner: string, text: string, at: string, supersedes: number|null}) => number} insertMemory
 * @property {(row: {owner: string, id: number, at: string, supersededBy: number}) => void} retire
 * @property {(row: {owner: string, id: number, at: string, reason: string, wasInState: string}) => void} putAway
 * @property {(row: {owner: string, id: number, at: string, wasInState: string, wasSupersededBy: number|null}) => void} bringBack
 * @property {(row: {owner: string, id: number, noLongerSupersedes: number}) => void} unlinkSupersedes
 */

/**
 * Build the actions for one transaction, and a way to switch them off again.
 *
 * @param {DatabaseSync} db
 * @returns {{actions: StoreActions, revoke: () => void}}
 */
function actionsFor(db) {
  let live = true;

  /**
   * @param {string} sql
   * @param {(string|number|null)[]} parameters
   * @param {string} what
   * @param {boolean} [mustChangeARow]
   */
  const change = (sql, parameters, what, mustChangeARow = true) => {
    if (!live) {
      throw new Error(
        'This decision is already written. Changing a memory afterwards would leave ' +
          'no record of why, so it is not something that can be done from here.',
      );
    }

    const { changes } = db.prepare(sql).run(...parameters);
    if (mustChangeARow && Number(changes) !== 1) {
      throw new Error(
        `Could not ${what}: it changed underneath this decision, so nothing was written. ` +
          'Read it again and try again.',
      );
    }
  };

  /** @type {StoreActions} */
  const actions = {
    insertMemory({ owner, text, at, supersedes }) {
      if (!live) throw new Error('This decision is already written.');
      const written = db
        .prepare(
          `INSERT INTO memories
             (owner, text, text_normalised, created_at, state, state_reason, state_at, supersedes)
           VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(owner, text, normaliseForComparison(text), at, at, supersedes);
      return Number(written.lastInsertRowid);
    },

    retire({ owner, id, at, supersededBy }) {
      // The state this was decided on is named in the WHERE clause, so if
      // another writer got there first this changes nothing, throws, and the
      // whole decision rolls back rather than leaving a half linked pair.
      change(
        `UPDATE memories
            SET state = 'superseded', state_reason = ?, state_at = ?, superseded_by = ?
          WHERE id = ? AND owner = ? AND state = 'active' AND superseded_by IS NULL`,
        [supersededReason(supersededBy), at, supersededBy, id, owner],
        `retire memory ${id}`,
      );
    },

    putAway({ owner, id, at, reason, wasInState }) {
      change(
        `UPDATE memories
            SET state = 'forgotten', state_reason = ?, state_at = ?
          WHERE id = ? AND owner = ? AND state = ?`,
        [reason, at, id, owner, wasInState],
        `forget memory ${id}`,
      );
    },

    bringBack({ owner, id, at, wasInState, wasSupersededBy }) {
      change(
        `UPDATE memories
            SET state = 'active', state_reason = NULL, state_at = ?, superseded_by = NULL
          WHERE id = ? AND owner = ? AND state = ? AND superseded_by IS ?`,
        [at, id, owner, wasInState, wasSupersededBy],
        `restore memory ${id}`,
      );
    },

    unlinkSupersedes({ owner, id, noLongerSupersedes }) {
      // Nothing to do if that memory has already stopped claiming it, so this
      // one does not insist on having changed a row.
      change(
        'UPDATE memories SET supersedes = NULL WHERE id = ? AND owner = ? AND supersedes = ?',
        [id, owner, noLongerSupersedes],
        `unlink memory ${id}`,
        false,
      );
    },
  };

  return {
    actions,
    revoke() {
      live = false;
    },
  };
}

/**
 * @typedef {object} DecisionPlan
 * @property {string} owner
 * @property {string} verdict what became of it
 * @property {string} rule the rule that fired
 * @property {string} explanation plain language, meant to be read by a person
 * @property {string} input_excerpt already trimmed and, for secrets, already replaced
 * @property {number|null} [memory_id]
 * @property {number|null} [related_memory_id]
 */

/**
 * Take a decision and write it down, both inside one transaction.
 *
 * The caller's function runs inside `BEGIN IMMEDIATE`, which means the reads it
 * makes to decide are covered by the same write lock as the writes it makes
 * afterwards. That is deliberate: deciding outside the lock and writing inside
 * it is how two agents submitting the same sentence at the same moment both
 * conclude it is new. Everything the decision depends on has to be read in
 * here.
 *
 * If anything throws, the change and the log row roll back together.
 *
 * @param {Store} store
 * @param {(actions: StoreActions, at: string) => DecisionPlan} decide
 * @returns {{decision_id: number, memory_id: number|null, related_memory_id: number|null, plan: DecisionPlan}}
 */
export function recordDecision(store, decide) {
  const at = store.now();
  const handle = handleOf(store);
  const { db } = handle;
  const { actions, revoke } = actionsFor(db);

  if (handle.deciding) {
    throw new Error(
      'A decision is already open on this store. One call, one decision, one row: ' +
        'finish the first before starting another.',
    );
  }

  db.exec('BEGIN IMMEDIATE');
  handle.deciding = true;

  try {
    const plan = decide(actions, at);

    const memoryId = plan.memory_id ?? null;
    const relatedId = plan.related_memory_id ?? null;

    const written = db
      .prepare(
        `INSERT INTO decisions
           (owner, decided_at, verdict, rule, explanation, memory_id, related_memory_id, input_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.owner,
        at,
        plan.verdict,
        plan.rule,
        plan.explanation,
        memoryId,
        relatedId,
        plan.input_excerpt,
      );

    db.exec('COMMIT');

    return {
      decision_id: Number(written.lastInsertRowid),
      memory_id: memoryId,
      related_memory_id: relatedId,
      plan,
    };
  } catch (error) {
    // If COMMIT itself is what failed there is no transaction left to roll
    // back, and asking for one throws. That second error must not be allowed
    // to stand in front of the first: the first one says what actually went
    // wrong.
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing to undo, or nothing that can be undone. Either way the
      // original failure below is the one worth reporting.
    }
    throw error;
  } finally {
    // Whatever happened, the actions handed out for this decision stop working
    // now. Keeping one past this point buys a caller nothing.
    revoke();
    handle.deciding = false;
  }
}

/**
 * One memory by id. Active only unless asked otherwise, like every other read
 * here: seeing what was replaced or forgotten is something a caller opts into.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {number} id
 * @param {{includeArchived?: boolean}} [options]
 * @returns {Memory|null}
 */
export function getMemory(store, owner, id, options = {}) {
  const sql =
    options.includeArchived === true
      ? 'SELECT * FROM memories WHERE id = ? AND owner = ?'
      : "SELECT * FROM memories WHERE id = ? AND owner = ? AND state = 'active'";

  const row = handleOf(store).db.prepare(sql).get(id, owner);
  return row ? /** @type {Memory} */ (/** @type {unknown} */ (row)) : null;
}

/**
 * The active memory that says exactly the same thing, if there is one.
 *
 * Asked as one question of the database, against the normalised copy written
 * when each memory was stored. This runs inside the write lock on every single
 * write, so what it costs is time every other agent spends waiting.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {string} text
 * @returns {Memory|null}
 */
export function findDuplicate(store, owner, text) {
  const row = handleOf(store)
    .db.prepare(
      `SELECT * FROM memories
        WHERE owner = ? AND state = 'active' AND text_normalised = ?
        ORDER BY id
        LIMIT 1`,
    )
    .get(owner, normaliseForComparison(text));

  return row ? /** @type {Memory} */ (/** @type {unknown} */ (row)) : null;
}

/**
 * Memories in the order they were stored. Active only unless asked otherwise.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {{includeArchived?: boolean}} [options]
 * @returns {Memory[]}
 */
export function listMemories(store, owner, options = {}) {
  const includeArchived = options.includeArchived === true;
  const sql = includeArchived
    ? 'SELECT * FROM memories WHERE owner = ? ORDER BY id'
    : "SELECT * FROM memories WHERE owner = ? AND state = 'active' ORDER BY id";
  return /** @type {Memory[]} */ (
    /** @type {unknown} */ (handleOf(store).db.prepare(sql).all(owner))
  );
}

/**
 * Full text search. Active only unless asked otherwise.
 *
 * @param {Store} store
 * @param {string} owner
 * There is no limit and no default page size. A search that quietly returned
 * the first fifty of eighty matches would be worse than useless: the caller
 * cannot tell a complete answer from a truncated one, and neither can the
 * person reading it.
 *
 * @param {string} query
 * @param {{includeArchived?: boolean}} [options]
 * @returns {Memory[]}
 */
export function searchMemories(store, owner, query, options = {}) {
  // First, before the query is split, normalised or handed to anything. A
  // guard against an oversized input has to refuse it while it is still just
  // a string the caller passed; anything this function does to it first is
  // an allocation the size of the input, which is the thing being refused.
  //
  // Length is `.length` rather than a count of characters, for the same
  // reason: counting characters means spreading the string into an array as
  // long as it is. `.length` counts the sixteen bit pieces, so it never
  // reports fewer characters than there are, and a bound that errs towards
  // refusing is the right way for this one to be wrong.
  //
  // Nothing has been read or written at this point. There is no transaction
  // open, no statement prepared, and no row touched, so a refused search
  // leaves the store exactly as it found it.
  if (query.length > SEARCH_QUERY_LIMIT) {
    throw new Error(
      `That search is longer than this store will run: the limit is ${SEARCH_QUERY_LIMIT} ` +
        `characters and this one is ${query.length}. Nothing was searched for. Look for the ` +
        'words that matter rather than for a whole document.',
    );
  }

  // A control character in a query does not survive being handed to FTS5
  // either. The query is built into a quoted string for the MATCH, and a NUL
  // ends that string early inside SQLite's own parser, which answered with
  // `unterminated string` — a C parser's message about its own internals,
  // handed back to a person as though it were something they had done.
  //
  // Refused here rather than translated, and for the same reason the gate
  // refuses it in a memory: a query that cannot be passed on whole is not a
  // query this store can honestly answer. One sentence, from the same idea,
  // for every caller.
  const unreadable = controlCharacterIn(query);
  if (unreadable !== null) {
    throw new Error(
      `That search contains ${namedCodePoint(unreadable)}, which is not something text is ` +
        'made of, so nothing was searched for. A character like that cannot be passed on ' +
        'whole. Send the search again without it.',
    );
  }

  const terms = query.trim().split(/\s+/u).filter((term) => term !== '');
  if (terms.length === 0) return [];

  const includeArchived = options.includeArchived === true;

  // A trigram index has nothing to match on below three characters, and plenty
  // of real words are shorter than that: 柏林 is Berlin, 東京 is Tokyo. Falling
  // back to looking through the text is slower, and on a personal store that
  // does not matter nearly as much as being able to find your own words.
  if (terms.some((term) => [...term].length < MIN_SEARCH_LENGTH)) {
    return searchBySubstring(store, owner, terms, includeArchived);
  }

  refuseIfTooMuchWork(store, terms);

  const sql = `
    SELECT m.*
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
     WHERE memories_fts MATCH ?
       AND m.owner = ?
       ${includeArchived ? '' : "AND m.state = 'active'"}
     ORDER BY rank`;

  return /** @type {Memory[]} */ (
    /** @type {unknown} */ (handleOf(store).db.prepare(sql).all(asMatch(terms), owner))
  );
}

/**
 * The path for queries the trigram index cannot answer.
 *
 * Matching is on plain substrings, so `%` and `_` are two ordinary characters
 * that a person might well have in a memory and are looked for as themselves.
 *
 * Case is folded in JavaScript rather than in SQL. SQLite's `lower` only folds
 * the twenty six ASCII letters, so with it `ÖL` found nothing while `öl` found
 * plenty, and the same was true of Greek, Cyrillic, Armenian and every
 * accented Latin letter. Plenty of those words are one or two characters long,
 * which is exactly the case this path exists to serve.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {string[]} terms
 * @param {boolean} includeArchived
 * @returns {Memory[]}
 */
function searchBySubstring(store, owner, terms, includeArchived) {
  // Both sides were folded in JavaScript: the stored copy when it was written,
  // and the search term just now. So the database can do the looking without
  // needing to know anything about case in any alphabet.
  const conditions = terms.map(() => 'instr(text_normalised, ?) > 0').join(' AND ');

  const sql = `
    SELECT *
      FROM memories
     WHERE owner = ?
       ${includeArchived ? '' : "AND state = 'active'"}
       AND ${conditions}
     ORDER BY id`;

  const wanted = terms.map((term) => normaliseForComparison(term));
  return /** @type {Memory[]} */ (
    /** @type {unknown} */ (handleOf(store).db.prepare(sql).all(owner, ...wanted))
  );
}

/**
 * Ask the index what this search would cost, and refuse it if the answer is
 * too much.
 *
 * The estimate is the number of trigrams the query will look for, multiplied
 * by the largest average occurrences-per-memory among them. `fts5vocab` is
 * where those counts come from: it is FTS5's own view of its vocabulary, so
 * this is the index reporting on itself rather than a guess about it. It costs
 * one statement — single-digit milliseconds against a 25 MB store — and it is
 * the only way to know the price before paying it, since a running query
 * cannot be stopped.
 *
 * Occurrences per memory, not occurrences in total. That distinction is the
 * whole of it, and it was measured rather than assumed: a megabyte of repeated
 * characters spread over a hundred memories has the same total as a megabyte
 * in one, and costs 220 MB instead of 869, because FTS5 builds its position
 * lists a document at a time. Total occurrences predicted neither: an ordinary
 * search over 25 MB has a higher total than the one that took 869 MB, and
 * answers in eight milliseconds.
 *
 * Where this is not exact. It is an estimate of an upper bound, not a
 * simulation. The counts include memories that are archived or belong to
 * another owner, so it can read high, which errs towards refusing. And case
 * folding here is JavaScript's, while the tokeniser does its own, so a term
 * whose folding differs can be looked up and missed — that errs the other way
 * and would let a search through. Both are known and neither is close to the
 * hundredfold gap the limit sits in.
 *
 * @param {Store} store
 * @param {string[]} terms
 */
function refuseIfTooMuchWork(store, terms) {
  /** @type {Map<string, number>} */
  const wanted = new Map();
  let trigrams = 0;

  for (const term of terms) {
    const folded = term.toLowerCase();
    for (let at = 0; at + MIN_SEARCH_LENGTH <= folded.length; at += 1) {
      const gram = folded.slice(at, at + MIN_SEARCH_LENGTH);
      wanted.set(gram, (wanted.get(gram) ?? 0) + 1);
      trigrams += 1;
    }
  }

  if (wanted.size === 0) return;

  const names = [...wanted.keys()];
  const rows = handleOf(store)
    .db.prepare(
      `SELECT term, doc, cnt FROM ${VOCABULARY} WHERE term IN (${names.map(() => '?').join(',')})`,
    )
    .all(...names);

  let densest = 0;
  for (const row of /** @type {{term: string, doc: number, cnt: number}[]} */ (
    /** @type {unknown} */ (rows)
  )) {
    const perMemory = Number(row.cnt) / Math.max(1, Number(row.doc));
    if (perMemory > densest) densest = perMemory;
  }

  const work = Math.round(trigrams * densest);
  if (work <= SEARCH_WORK_LIMIT) return;

  throw new Error(
    'That search would have to read through roughly ' +
      `${work.toLocaleString('en')} positions inside a single memory, which is more than ` +
      'this store will do at once, so nothing was searched for and nothing was returned. ' +
      'Something stored is made of very few distinct three-character runs — a long run of ' +
      'one character, base64, or a pasted log — and any search matching it costs far more ' +
      'than an ordinary one. Search for something more specific, or forget the memory ' +
      'holding that text. You have not been shown a partial answer: there is no answer here.',
  );
}

/**
 * Turn what somebody typed into an FTS5 query that looks for all of it.
 *
 * Each word becomes a quoted phrase, and the phrases are joined with AND. Two
 * things follow from that. Searching for "coffee morning" finds a memory that
 * says "coffee in the morning", which is what a person expects and what a
 * single quoted phrase would have refused to do. And a word like OR or NEAR(
 * is inside quotes, so it is text to look for rather than an instruction to
 * carry out.
 *
 * @param {string[]} terms
 * @returns {string}
 */
function asMatch(terms) {
  return terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' AND ');
}

/**
 * The whole decision log, oldest first so it reads like a diary.
 *
 * All of it, always. This is an append only record of everything that was ever
 * decided, and the oldest entries are the ones a person goes looking for when
 * something seems wrong. Handing back the most recent two hundred and saying
 * nothing about the rest would hide exactly the part that matters.
 *
 * @param {Store} store
 * @param {string} owner
 * @returns {Decision[]}
 */
export function listDecisions(store, owner) {
  const rows = handleOf(store)
    .db.prepare('SELECT * FROM decisions WHERE owner = ? ORDER BY id')
    .all(owner);
  return /** @type {Decision[]} */ (/** @type {unknown} */ (rows));
}
