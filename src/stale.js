/**
 * The one line the terminal says when the wiring has stopped pointing at
 * anything.
 *
 * Every entry setup writes names the interpreter by its full path, because a
 * client started from a desktop icon has no PATH to find `node` on. The cost,
 * written down the day it was chosen, is that a version manager moves that
 * path when a Node version is switched or removed — and then every entry points
 * at nothing, silently, because a client that cannot start a server mostly does
 * not say so. `doctor` finds that. Nothing made anybody run `doctor`.
 *
 * This is the prompt. `write.js` records, on each manifest row, which
 * interpreter and which copy of the server an entry was last written with. The
 * next time a person runs any command that opens the store — which they do on
 * whatever Node is current in their shell — this compares what was recorded
 * with what is running now, and if the recorded path is no longer on the disk,
 * says so in one line on stderr. It fires exactly once per situation, in the
 * place a person is already looking, and says what to run.
 *
 * What it does not do, and why. It does not read a single client's config
 * file: those belong to other programs, and reading twenty-two of them on every
 * `list` is a cost this project has refused before. It does not fire when the
 * recorded interpreter still exists — the shell may be on a newer Node while
 * the one the entries name is still installed, and those entries still work.
 * It does not fire for entries written before the field existed: it cannot
 * compare against a record that was never taken, and a guess in either
 * direction would be a sentence about somebody's machine that nothing stands
 * behind. And it is on stderr, so a search piped into another program sees
 * exactly what it saw before.
 *
 * It reaches no store and no client file. It reads one JSON file of ours.
 */

import fs from 'node:fs';
import path from 'node:path';

import { MANIFEST_NAME, readManifest } from './backup.js';
import { invocation } from './clients.js';

/**
 * @param {object} now
 * @param {string} now.backupDir where the manifest lives
 * @param {string} now.interpreter the Node running this command
 * @param {string} now.serverPath this copy's server
 * @returns {string|null} the sentence to print, or null when nothing is stale
 */
export function staleWiring({ backupDir, interpreter, serverPath }) {
  const rows = Object.values(readManifest(path.join(backupDir, MANIFEST_NAME)))
    .filter((row) => row.wroteWith !== undefined);

  /** @type {Set<string>} */
  const goneInterpreters = new Set();
  /** @type {Set<string>} */
  const goneServers = new Set();
  const clients = new Set();

  for (const row of rows) {
    const wrote = /** @type {{interpreter: string, serverPath: string}} */ (row.wroteWith);
    let stale = false;

    if (wrote.interpreter !== interpreter && !exists(wrote.interpreter)) {
      goneInterpreters.add(wrote.interpreter);
      stale = true;
    }
    if (wrote.serverPath !== serverPath && !exists(wrote.serverPath)) {
      goneServers.add(wrote.serverPath);
      stale = true;
    }
    if (stale) clients.add(row.client);
  }

  if (clients.size === 0) return null;

  const count = clients.size === 1 ? 'one client' : `${clients.size} clients`;
  const parts = [];

  if (goneInterpreters.size > 0) {
    parts.push(
      `The entries setup wrote for ${count} start the server with `
      + `${list(goneInterpreters)}, which is not there any more — usually a Node version that was `
      + 'switched or removed — so those clients cannot start it.',
    );
  }
  if (goneServers.size > 0) {
    parts.push(
      `${goneInterpreters.size > 0 ? 'They' : `The entries setup wrote for ${count}`} point at `
      + `${list(goneServers)}, which is not there any more; this copy is at ${serverPath}.`,
    );
  }
  parts.push(
    `Run \`${invocation()} setup\` to rewrite them. \`${invocation()} doctor\` says which clients.`,
  );

  return parts.join(' ');
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Set<string>} paths
 * @returns {string}
 */
function list(paths) {
  return [...paths].join(' and ');
}
