/**
 * The only place in this project where a store is rewritten.
 *
 *   node scripts/migrate.mjs --yes
 *
 * This file is the launcher, and it exists for the same three reasons
 * `purge.mjs` does: it refuses to be imported, it takes Node's experimental
 * SQLite warning off the terminal before `node:sqlite` is loaded, and it is
 * what `migrate-main.mjs` checks for before agreeing to run. Splitting the
 * script in two is not a way around that check.
 *
 * Why a command a person types rather than something that happens on open:
 * this store is opened by MCP servers that a desktop application spawns
 * without anybody watching, several at once. A migration that ran there would
 * run unattended, concurrently, on a file somebody is in the middle of using.
 * It runs when a person asks and when nothing else has the store.
 */

import { pathToFileURL } from 'node:url';

import { requireSupportedNode } from '../src/node-version.js';
import { silenceSqliteExperimentalWarning } from '../src/warnings.js';

const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!startedDirectly) {
  throw new Error('migrate.mjs is run by hand from a terminal. It is not something to import.');
}

requireSupportedNode();
silenceSqliteExperimentalWarning();

const { main } = await import('./migrate-main.mjs');

// The catch-all. `main` says its own refusals in sentences and exits; anything
// that reaches here is a failure nobody foresaw, and it still must not arrive
// as a stack trace. See `sentenceFor` for why.
try {
  await main(process.argv.slice(2));
} catch (error) {
  const { sentenceFor } = await import('../src/migrate.js');
  process.stderr.write(`${sentenceFor(error)}\n`);
  process.exit(1);
}
