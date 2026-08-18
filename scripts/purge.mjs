/**
 * The only place in this project where anything is deleted.
 *
 *   node scripts/purge.mjs --id 4 --yes
 *
 * This file is the launcher. It refuses to be imported, takes Node's
 * experimental SQLite warning off the terminal, and then starts the script
 * itself, which is in `purge-main.mjs`. The filter has to be installed before
 * `node:sqlite` is loaded, and a dynamic import is the one kind that cannot be
 * hoisted above the line that installs it.
 *
 * `purge-main.mjs` refuses to run unless this file is what started the
 * process, so splitting the script in two is not a way around the check below.
 */

import { pathToFileURL } from 'node:url';

import { requireSupportedNode } from '../src/node-version.js';
import { silenceSqliteExperimentalWarning } from '../src/warnings.js';

// Started by a person, or not at all.
const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!startedDirectly) {
  throw new Error('purge.mjs is run by hand from a terminal. It is not something to import.');
}

requireSupportedNode();
silenceSqliteExperimentalWarning();

await import('./purge-main.mjs');
