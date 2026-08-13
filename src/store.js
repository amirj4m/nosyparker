/**
 * The storage layer.
 *
 * Two tables. `memories` holds what was stored, `decisions` holds why. A
 * memory is never removed here: it changes state, and the old state stays
 * readable. There is no DELETE statement anywhere in this file, and no code
 * path in this project deletes a row except `scripts/purge.mjs`, which a
 * person runs by hand.
 *
 * The only exported way to change a memory is `recordDecision`, which always
 * writes the decision row in the same transaction as the change. There is no
 * other write function to reach for, so a change without a log entry is not
 * something a caller can express.
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
 * @typedef {object} Store
 * @property {DatabaseSync} db
 * @property {() => string} now
 * @property {string} file
 * @property {() => void} close
 */

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

  return {
    db,
    now,
    file,
    close() {
      db.close();
    },
  };
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
 * Apply a decision: write the log row, and any change to memories, together.
 *
 * The transaction is what makes the log trustworthy. If the change fails the
 * log row is rolled back with it, and if the log row fails the change is
 * rolled back with it. One gate call produces exactly one decision row.
 *
 * @param {Store} store
 * @param {object} plan
 * @param {string} plan.owner
 * @param {string} plan.verdict one of VERDICTS
 * @param {string} plan.rule the rule that fired
 * @param {string} plan.explanation plain language, meant to be read by a person
 * @param {string} plan.input_excerpt already trimmed and, for secrets, already replaced
 * @param {number|null} [plan.memory_id] filled in by `mutate` when it creates a row
 * @param {number|null} [plan.related_memory_id]
 * @param {(db: DatabaseSync, at: string) => {memory_id?: number|null, related_memory_id?: number|null}|void} [plan.mutate]
 * @returns {{decision_id: number, memory_id: number|null, related_memory_id: number|null}}
 */
export function recordDecision(store, plan) {
  const at = store.now();
  const { db } = store;

  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = plan.mutate ? plan.mutate(db, at) || {} : {};

    const memoryId = pickId(changed.memory_id, plan.memory_id);
    const relatedId = pickId(changed.related_memory_id, plan.related_memory_id);

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
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * @param {number|null|undefined} fromMutate
 * @param {number|null|undefined} fromPlan
 * @returns {number|null}
 */
function pickId(fromMutate, fromPlan) {
  if (fromMutate !== undefined && fromMutate !== null) return fromMutate;
  if (fromPlan !== undefined && fromPlan !== null) return fromPlan;
  return null;
}

/**
 * One memory by id, whatever state it is in.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {number} id
 * @returns {Memory|null}
 */
export function getMemory(store, owner, id) {
  const row = store.db
    .prepare('SELECT * FROM memories WHERE id = ? AND owner = ?')
    .get(id, owner);
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
  return /** @type {Memory[]} */ (/** @type {unknown} */ (store.db.prepare(sql).all(owner)));
}

/**
 * Full text search. Active only unless asked otherwise.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {string} query
 * @param {{includeArchived?: boolean, limit?: number}} [options]
 * @returns {Memory[]}
 */
export function searchMemories(store, owner, query, options = {}) {
  const trimmed = query.trim();
  // A trigram index has nothing to match on below three characters.
  if ([...trimmed].length < MIN_SEARCH_LENGTH) return [];

  const includeArchived = options.includeArchived === true;
  const limit = options.limit ?? 50;

  const sql = `
    SELECT m.*
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
     WHERE memories_fts MATCH ?
       AND m.owner = ?
       ${includeArchived ? '' : "AND m.state = 'active'"}
     ORDER BY rank
     LIMIT ?`;

  return /** @type {Memory[]} */ (
    /** @type {unknown} */ (store.db.prepare(sql).all(asPhrase(trimmed), owner, limit))
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
 * The decision log, newest last so it reads like a diary.
 *
 * @param {Store} store
 * @param {string} owner
 * @param {{limit?: number}} [options]
 * @returns {Decision[]}
 */
export function listDecisions(store, owner, options = {}) {
  const limit = options.limit ?? 200;
  const rows = store.db
    .prepare('SELECT * FROM decisions WHERE owner = ? ORDER BY id DESC LIMIT ?')
    .all(owner, limit);
  return /** @type {Decision[]} */ (/** @type {unknown} */ (rows)).reverse();
}
