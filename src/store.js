/**
 * The storage layer.
 *
 * Two tables. `memories` holds what was stored, `decisions` holds why. A
 * memory is never removed here: it changes state, and the old state stays
 * readable. There is no DELETE statement anywhere in this file, and no code
 * path in this project deletes a row except `scripts/purge.mjs`, which a
 * person runs by hand.
 *
 * The database handle is deliberately not on the Store object. It is held in a
 * WeakMap in this module, so nothing outside this file can reach it, and the
 * only exported function that hands it out is `recordDecision`, which writes
 * the decision row in the same transaction as whatever the caller does with
 * it. That is what makes "no change without a log entry" a property of the
 * code rather than a promise in a comment: there is no exported path to a
 * statement handle that does not also write the log row.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The three states a memory can be in. `active` is the showcase. */
export const STATES = /** @type {const} */ (['active', 'superseded', 'forgotten']);

/** What a decision row can record as its outcome. */
export const VERDICTS = /** @type {const} */ ([
  'stored',
  'superseded',
  'forgotten',
  'restored',
  'refused',
]);

/** Longest excerpt of the offered text kept on a decision row. */
export const EXCERPT_LIMIT = 160;

/** Trigram search needs at least three characters to match on. */
const MIN_SEARCH_LENGTH = 3;

/**
 * @typedef {object} Memory
 * @property {number} id
 * @property {string} owner
 * @property {string} text
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
 * @property {number} depth how many transactions this store is currently inside
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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner         TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'active'
                CHECK (state IN ('active', 'superseded', 'forgotten')),
  state_reason  TEXT,
  state_at      TEXT    NOT NULL,
  supersedes    INTEGER REFERENCES memories(id),
  superseded_by INTEGER REFERENCES memories(id)
);

CREATE INDEX IF NOT EXISTS memories_owner_state ON memories(owner, state);

CREATE TABLE IF NOT EXISTS decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  owner             TEXT    NOT NULL,
  decided_at        TEXT    NOT NULL,
  verdict           TEXT    NOT NULL
                    CHECK (verdict IN ('stored', 'superseded', 'forgotten', 'restored', 'refused')),
  rule              TEXT    NOT NULL,
  explanation       TEXT    NOT NULL,
  memory_id         INTEGER REFERENCES memories(id),
  related_memory_id INTEGER REFERENCES memories(id),
  input_excerpt     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_owner_time ON decisions(owner, decided_at);

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
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  /** @type {Store} */
  const store = {
    now,
    file,
    close() {
      db.close();
      handles.delete(store);
    },
  };

  handles.set(store, { db, depth: 0 });
  return store;
}

/**
 * Cut the offered text down to what a decision row is allowed to keep.
 *
 * @param {string} text
 * @returns {string}
 */
export function excerpt(text) {
  const flattened = text.replace(/\s+/gu, ' ').trim();
  if (flattened.length <= EXCERPT_LIMIT) return flattened;
  return flattened.slice(0, EXCERPT_LIMIT - 1) + '…';
}

/**
 * @typedef {object} DecisionPlan
 * @property {string} owner
 * @property {string} verdict one of VERDICTS
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
 * @param {(db: DatabaseSync, at: string) => DecisionPlan} decide
 * @returns {{decision_id: number, memory_id: number|null, related_memory_id: number|null, plan: DecisionPlan}}
 */
export function recordDecision(store, decide) {
  const at = store.now();
  const { db } = handleOf(store);

  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = decide(db, at);

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
    db.exec('ROLLBACK');
    throw error;
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
  const trimmed = query.trim();
  // A trigram index has nothing to match on below three characters.
  if ([...trimmed].length < MIN_SEARCH_LENGTH) return [];

  const includeArchived = options.includeArchived === true;

  const sql = `
    SELECT m.*
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
     WHERE memories_fts MATCH ?
       AND m.owner = ?
       ${includeArchived ? '' : "AND m.state = 'active'"}
     ORDER BY rank`;

  return /** @type {Memory[]} */ (
    /** @type {unknown} */ (handleOf(store).db.prepare(sql).all(asPhrase(trimmed), owner))
  );
}

/**
 * Wrap a query as a single FTS5 phrase so that whatever the user typed is
 * treated as text to look for, not as query syntax.
 *
 * @param {string} query
 * @returns {string}
 */
function asPhrase(query) {
  return '"' + query.replaceAll('"', '""') + '"';
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
