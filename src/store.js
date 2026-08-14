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

import { normaliseForComparison } from './text.js';

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

  // busy_timeout comes first, and that order matters. Setting the journal mode
  // takes a lock, and so does creating the tables. With several agents opening
  // the same store at the same moment, whichever one arrives second fails
  // outright with "database is locked" unless it has already been told to wait.
  // Every statement after this line waits its turn instead of giving up.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
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
 * Counted in characters, not in the sixteen bit pieces JavaScript stores them
 * in. `"…".length` lies about anything outside the first sixty five thousand
 * code points, which is most of the world's writing and every emoji, and
 * cutting by that count can slice a single character in half and leave an
 * unpaired surrogate in the log. This counts the same way
 * `credentialPlaceholder` does.
 *
 * @param {string} text
 * @returns {string}
 */
export function excerpt(text) {
  const flattened = text.replace(/\s+/gu, ' ').trim();
  const characters = [...flattened];
  if (characters.length <= EXCERPT_LIMIT) return flattened;
  return characters.slice(0, EXCERPT_LIMIT - 1).join('') + '…';
}

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
        [`Replaced by memory ${supersededBy}`, at, supersededBy, id, owner],
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
            SET state = 'active', state_at = ?, superseded_by = NULL
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
 * @param {(actions: StoreActions, at: string) => DecisionPlan} decide
 * @returns {{decision_id: number, memory_id: number|null, related_memory_id: number|null, plan: DecisionPlan}}
 */
export function recordDecision(store, decide) {
  const at = store.now();
  const handle = handleOf(store);
  const { db } = handle;
  const { actions, revoke } = actionsFor(db);

  // A decision taken while another decision is still open joins it rather than
  // trying to start a second transaction, which SQLite will not allow. The
  // inner one gets a savepoint of its own, so it can fail and be undone
  // without taking the outer one down with it.
  const nested = handle.depth > 0;
  const savepoint = `nosyparker_${(savepointCount += 1)}`;

  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  handle.depth += 1;

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

    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');

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
      db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    } catch {
      // Nothing to undo, or nothing that can be undone. Either way the
      // original failure below is the one worth reporting.
    }
    throw error;
  } finally {
    // Whatever happened, the actions handed out for this decision stop working
    // now. Keeping one past this point buys a caller nothing.
    revoke();
    handle.depth -= 1;
  }
}

/** Makes each savepoint name its own, since they can be nested. */
let savepointCount = 0;

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
