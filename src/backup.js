/**
 * One copy of each file we are about to touch, taken once, kept for ever.
 *
 * The rule is narrow on purpose. A backup is taken the first time this project
 * writes to a given file and never again — not on the second run, not on an
 * upgrade, not on an uninstall. That is the opposite of a rotation, and it is
 * the right shape here for one reason: the copy worth having is the one from
 * before anything of ours existed. Every later state of that file contains our
 * entry, so a later copy is a copy of a file we have already changed. Rotating
 * would eventually evict the only one that matters with five that do not.
 *
 * Claude Desktop's Debian launcher rotates five copies before every launch and
 * only when the content changed, which is the right shape for its problem —
 * it is guarding against an app that wipes its own config at unpredictable
 * times. Ours is a different problem with a single moment of risk in it.
 *
 * After the first touch there is nothing left to guard. Every subsequent change
 * to that file is our entry going in or coming out, and `uninstall` reverses it
 * without needing a copy of anything.
 *
 * A file that did not exist gets a manifest row and no copy, because there is
 * nothing to copy. The row still matters: it is how a later run knows this file
 * has been touched before, and it is how a person reading the manifest can tell
 * "we created this" from "we edited this".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the copies live. Ours, under our own directory, not beside theirs. */
export const BACKUP_DIR_NAME = path.join('.nosyparker', 'backups');

/** The index of what was copied, and from where. */
export const MANIFEST_NAME = 'manifest.json';

/**
 * @typedef {object} BackupResult
 * @property {boolean} made true only on the first touch of this file
 * @property {string|null} backupPath null when there was nothing to copy
 * @property {boolean} existed whether the file was there before we arrived
 */

/**
 * @param {string} [home]
 * @returns {string}
 */
export function defaultBackupDir(home) {
  return path.join(home ?? os.homedir(), BACKUP_DIR_NAME);
}

/**
 * Copy this file, unless we already have.
 *
 * @param {object} request
 * @param {string} request.file the config file about to be written
 * @param {string} request.clientId
 * @param {string} request.backupDir
 * @param {string} request.now an ISO 8601 timestamp
 * @returns {BackupResult}
 */
export function backupOnce({ file, clientId, backupDir, now }) {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);

  const already = Object.values(manifest).find((row) => row.path === file);
  if (already !== undefined) {
    return { made: false, backupPath: already.backup, existed: already.existed };
  }

  const existed = fs.existsSync(file);
  const name = backupNameFor(file, clientId, manifest);
  const backupPath = existed ? path.join(backupDir, name) : null;

  // Which directories are about to come into existence because of us. Recorded
  // before anything is written, because afterwards there is no way to tell a
  // directory we made from one that was always there — and an uninstall that
  // cannot tell leaves either a mess or a hole.
  const created = existed ? [] : missingAncestors(file);

  fs.mkdirSync(backupDir, { recursive: true });

  if (existed && backupPath !== null) {
    // copyFile rather than read-and-write: it keeps the bytes exactly, and it
    // refuses rather than truncating if something is already there, which is
    // the guarantee this whole module exists to make.
    fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, fs.statSync(file).mode & 0o777);
  }

  manifest[name] = { path: file, backup: backupPath, existed, takenAt: now, client: clientId, created };
  writeManifest(manifestPath, manifest);

  return { made: existed, backupPath, existed };
}

/**
 * What this file was recorded as, if anything.
 *
 * @param {string} file
 * @param {string} backupDir
 * @returns {{existed: boolean, created: string[]}|null}
 */
export function manifestRowFor(file, backupDir) {
  const row = Object.values(readManifest(path.join(backupDir, MANIFEST_NAME)))
    .find((candidate) => candidate.path === file);

  return row === undefined ? null : { existed: row.existed, created: row.created ?? [] };
}

/**
 * The directories on the way to this file that are not there yet.
 *
 * Nearest first, which is the order they have to be removed in.
 *
 * @param {string} file
 * @returns {string[]}
 */
function missingAncestors(file) {
  /** @type {string[]} */
  const missing = [];

  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    missing.push(dir);
    dir = path.dirname(dir);
  }

  return missing;
}

/**
 * @param {string} manifestPath
 * @returns {Record<string, {path: string, backup: string|null, existed: boolean, takenAt: string, client: string, created?: string[]}>}
 */
export function readManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {string} manifestPath
 * @param {Record<string, unknown>} manifest
 */
function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

/**
 * A name that says which client and which file, and that no other file has.
 *
 * Four of the clients call their file `mcp.json`, so the client id has to be in
 * the name; and one client has two of them, so a collision still has to be
 * resolved rather than silently overwriting the first copy with the second.
 *
 * @param {string} file
 * @param {string} clientId
 * @param {Record<string, unknown>} manifest
 * @returns {string}
 */
function backupNameFor(file, clientId, manifest) {
  const base = `${clientId}.${path.basename(file)}`;
  if (!(base in manifest)) return base;

  for (let n = 2; ; n += 1) {
    const candidate = `${clientId}.${n}.${path.basename(file)}`;
    if (!(candidate in manifest)) return candidate;
  }
}
