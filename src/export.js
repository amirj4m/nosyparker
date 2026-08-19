/**
 * Everything, in a file anybody can open.
 *
 * Three reasons, and they decided the shape between them. It is insurance if a
 * migration ever goes wrong. It is what the claim that these memories are the
 * person's actually means in practice. And a tool that will not let you take
 * your data out is holding it.
 *
 * **Everything, not the showcase.** Every memory in every state — active,
 * superseded, forgotten, overtaken — every review pass, and the whole decision
 * log. The log is not an extra: it is where the reasoning lives, and it is the
 * only record of what a review concluded and why. An export of the active
 * memories alone would be a copy of what `list` already shows and would leave
 * out the half a person would want if something had gone wrong.
 *
 * **JSON.** Not this project's format, which is a SQLite file with a schema
 * somebody has to know. Every language opens JSON, every editor shows it, and a
 * person can read it — the memories come out as a list of plain objects with the
 * text in them. Indented, so it reads down the page rather than sideways.
 *
 * **Whole rows, not chosen fields.** Each row goes out as the store has it,
 * which is what makes "everything" checkable rather than a claim: a column added
 * later appears here without anybody remembering to add it, and a column left
 * out cannot be left out quietly.
 *
 * **Not re-importable, deliberately, and not foreclosed either.** There is no
 * `import` command and building one would mean a door into the store that
 * cannot go through the gate: restoring a memory under its original id is not
 * something the gate can express, and one that assigned new ids would break
 * every reference in the exported decision log. So the choice was
 * readable-and-complete over round-trippable. What is here is every field and
 * every id, so somebody who needs to rebuild a store from this can, in about as
 * much code as reading it takes — we are not the ones who have to write it, and
 * nothing in the format stops them.
 *
 * It reads and writes nothing to the store. It is not an MCP tool either: a
 * command that hands an agent the person's entire memory in one call is a shape
 * worth not having, and this is something a person does on purpose at a
 * terminal.
 */

import fs from 'node:fs';

import { listDecisions, listMemories, listPasses, SCHEMA_VERSION } from './store.js';

/**
 * The whole store as one JSON document.
 *
 * @param {import('./store.js').Store} store
 * @param {string} owner
 * @returns {string}
 */
export function exportAll(store, owner) {
  const memories = listMemories(store, owner, { includeArchived: true });

  return `${JSON.stringify({
    nosyparker: version(),
    schema_version: SCHEMA_VERSION,
    exported: store.now(),
    store: store.file,
    owner,
    counts: {
      memories: memories.length,
      shown: memories.filter((memory) => memory.state === 'active').length,
      review_passes: listPasses(store, owner).length,
      decisions: listDecisions(store, owner).length,
    },
    // Oldest first, all three of them, so the file reads like the store
    // happened rather than like a query answered it.
    memories,
    review_passes: [...listPasses(store, owner)].reverse(),
    decisions: listDecisions(store, owner),
  }, null, 2)}\n`;
}

/**
 * Write it, and never over the top of something that is already there.
 *
 * An export is insurance, and the one moment somebody reaches for it is the
 * moment they are already in trouble — which is exactly when a command that
 * silently replaced yesterday's copy with today's would cost them the copy they
 * meant to keep. Refusing takes one more keystroke and cannot lose anything.
 *
 * @param {string} file
 * @param {string} contents
 * @returns {string} what to tell the person
 */
export function writeExport(file, contents) {
  // wx: create, and fail if it is there. Asking first and writing afterwards
  // would leave a gap between the two, and this project has already paid for
  // one of those.
  fs.writeFileSync(file, contents, { flag: 'wx' });
  return `Written to ${file} (${contents.length.toLocaleString('en')} characters).`;
}

/**
 * Which version of this program wrote the file, from the one place that knows.
 *
 * @returns {string}
 */
function version() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}
