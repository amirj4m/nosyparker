#!/usr/bin/env node
/**
 * The launcher.
 *
 * It takes Node's experimental SQLite warning off the terminal and then starts
 * the command line tool proper, which is in `cli-main.js`.
 *
 * Why this is a file of its own rather than four lines at the top of that one.
 * The filter has to be installed before `node:sqlite` is loaded. Static imports
 * are evaluated in the order they are written, so putting the filter first in
 * `cli-main.js` would work today and would quietly stop working the moment
 * somebody sorted the imports alphabetically or moved a line while tidying. A
 * dynamic import cannot be hoisted above anything: it runs where it is written,
 * which is after the line below it.
 */

import { silenceSqliteExperimentalWarning } from './warnings.js';

silenceSqliteExperimentalWarning();

await import('./cli-main.js');
