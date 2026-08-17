/**
 * What each file looked like before this project first touched it.
 *
 * Two different things live here and they are worth keeping apart, because one
 * of them applies to every client and the other to only some.
 *
 * **The record** is taken for every file, always: did this file exist before we
 * arrived, and which directories had to be created to hold it. Both questions
 * are unanswerable afterwards, and `uninstall` needs both — a file that exists
 * only because of us is ours to remove again, and one that was already there
 * never is.
 *
 * **The copy** is taken only for a file we edit ourselves.
 *
 * That is narrower than it first looks and deliberately so. Four clients are
 * driven through their own command — `claude mcp add`, `codex mcp add`,
 * `code --add-mcp`, `devin-desktop --add-mcp` — and for those we do not write
 * the file at all; the application does, through the interface it publishes for
 * exactly that. There is nothing of ours to undo and so nothing for a copy to
 * protect against. Taking one anyway is not free: `~/.claude.json` holds
 * `oauthAccount`, a user id and a machine id, and duplicating a live credential
 * store to guard against an edit we never make is a bad trade in the one
 * direction that matters.
 *
 * The residual risk is real and is worth naming rather than hiding: if a
 * vendor's own command mangles its own config file, we have no copy of it. That
 * is a risk we are choosing, on the grounds that a supported writer damaging
 * the file it is for is the vendor's defect and not ours to insure against with
 * a copy of somebody's OAuth tokens.
 *
 * The copy, when it is taken, is taken once and kept for ever — not on the
 * second run, not on an upgrade, not on an uninstall. That is the opposite of a
 * rotation, and it is right here for one reason: the copy worth having is the
 * one from before anything of ours existed. Every later state of that file
 * contains our entry, so a later copy is a copy of a file we have already
 * changed, and rotating would eventually evict the only one that matters with
 * five that do not.
 *
 * Claude Desktop's Debian launcher rotates five copies before every launch and
 * only when the content changed, which is right for its problem — it guards
 * against an application that wipes its own config at unpredictable times.
 * Ours is a different problem with a single moment of risk in it.
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
 * Record what was here before we touched it, and copy it if we are the ones
 * about to change it.
 *
 * @param {object} request
 * @param {string} request.file the config file about to be written
 * @param {string} request.clientId
 * @param {string} request.backupDir
 * @param {string} request.now an ISO 8601 timestamp
 * @param {boolean} request.weEdit false when the client's own command writes it
 * @param {boolean} [request.rootKeyExisted] whether the file already had the key
 *   our entry goes under, asked before the first write because it cannot be
 *   asked afterwards
 * @returns {BackupResult}
 */
export function recordFirstTouch({ file, clientId, backupDir, now, weEdit, rootKeyExisted }) {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  const manifest = readManifest(manifestPath);

  const already = Object.values(manifest).find((row) => row.path === file);
  if (already !== undefined) {
    return { made: false, backupPath: already.backup, existed: already.existed };
  }

  const existed = fs.existsSync(file);
  const name = backupNameFor(file, clientId, manifest);
  const copy = existed && weEdit;
  const backupPath = copy ? path.join(backupDir, name) : null;

  // Which directories are about to come into existence because of us. Recorded
  // before anything is written, because afterwards there is no way to tell a
  // directory we made from one that was always there — and an uninstall that
  // cannot tell leaves either a mess or a hole.
  const created = existed ? [] : missingAncestors(file);

  fs.mkdirSync(backupDir, { recursive: true });

  if (backupPath !== null) {
    // copyFile rather than read-and-write: it keeps the bytes exactly, and it
    // refuses rather than truncating if something is already there, which is
    // the guarantee this whole module exists to make.
    fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, fs.statSync(file).mode & 0o777);
  }

  manifest[name] = {
    path: file,
    backup: backupPath,
    existed,
    takenAt: now,
    client: clientId,
    created,
    rootKeyExisted,
    // Written down rather than inferred, so that a person reading the manifest
    // can tell a file we chose not to copy from one there was nothing to copy
    // of. The two look identical from a null.
    whyNoBackup: backupPath !== null ? undefined
      : existed ? 'its own command writes this file, not us'
        : 'the file did not exist',
  };
  writeManifest(manifestPath, manifest);

  return { made: backupPath !== null, backupPath, existed };
}

/**
 * What this file was recorded as, if anything.
 *
 * @param {string} file
 * @param {string} backupDir
 * @returns {{existed: boolean, created: string[], rootKeyExisted: boolean}|null}
 */
export function manifestRowFor(file, backupDir) {
  const row = Object.values(readManifest(path.join(backupDir, MANIFEST_NAME)))
    .find((candidate) => candidate.path === file);

  return row === undefined ? null : {
    existed: row.existed,
    created: row.created ?? [],
    // Absent in a manifest written before this was recorded. Treated as "it was
    // already there", which is the answer that changes nothing.
    rootKeyExisted: row.rootKeyExisted ?? true,
  };
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
 * @returns {Record<string, {path: string, backup: string|null, existed: boolean, takenAt: string, client: string, created?: string[], whyNoBackup?: string, rootKeyExisted?: boolean}>}
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
