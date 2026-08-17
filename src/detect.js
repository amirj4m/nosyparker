/**
 * Is this client on the machine, and does it have a config file yet.
 *
 * Those are two questions and the answers are three states, kept apart because
 * running them together is a documented way to lose a client. The owner's
 * previous project treated "no config file" as "not installed" and silently
 * skipped Cursor for everyone — Cursor creates `~/.cursor/` on install and does
 * not create `mcp.json` until something writes one, so a fresh Cursor looks
 * exactly like no Cursor to a detector that only looks for the file. The same
 * is true of Zed, whose config directory arrives on first launch containing
 * only `themes/`, and of Gemini, whose `~/.gemini/` arrives with everything in
 * it except `settings.json`.
 *
 * There is a fourth state and it is not a conflation of the other three. Some
 * rows carry a null path for an operating system because the research could not
 * establish one — Zed on macOS, Devin anywhere but Linux. On that machine the
 * client may well be installed and we still have nowhere to write. Reporting
 * that as "not installed" would be a lie about the machine, and reporting it as
 * "installed, no config" would send the writer at a path nobody has. It gets
 * its own answer.
 *
 * Nothing here decides anything from a package manager. Zed installed the way
 * upstream recommends unpacks into `~/.local` and is invisible to `dpkg` and
 * absent from `/usr/share`; Codex, Goose, Kimi and Devin are all the same shape.
 * A detector modelled on the deb-packaged clients would miss five of the six
 * that were installed to write this table. So detection is a command that
 * resolves or a path that exists, and the row says which.
 *
 * Every filesystem question goes through the environment it is handed, which is
 * what lets the tests describe a machine rather than have one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configPathFor, expandPath } from './clients.js';

/** The client is not on this machine. */
export const NOT_INSTALLED = 'not-installed';

/** It is here, and has never had a config file of the kind we write. */
export const INSTALLED_NO_CONFIG = 'installed-no-config';

/** It is here and the file already exists, so something of the user's is in it. */
export const INSTALLED_WITH_CONFIG = 'installed-with-config';

/** It is here and we do not know where its config lives on this platform. */
export const INSTALLED_PATH_UNKNOWN = 'installed-path-unknown';

/**
 * @typedef {object} Machine
 * @property {string} home
 * @property {string} platform
 * @property {string|undefined} [appData]
 * @property {string} [cwd]
 * @property {string[]} pathDirs directories to look in for a command
 * @property {(file: string) => boolean} exists
 * @property {(dir: string) => string[]} readdir returns [] when the directory is not there
 */

/**
 * @typedef {object} Detection
 * @property {string} state one of the four above
 * @property {string|null} configPath
 * @property {string|null} command the executable to run, resolved, or null
 * @property {string[]} evidence what was found, in the words of what was looked for
 */

/**
 * This machine, as something the tests can hand a different version of.
 *
 * @param {Partial<Machine>} [overrides]
 * @returns {Machine}
 */
export function thisMachine(overrides = {}) {
  return {
    home: os.homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    cwd: process.cwd(),
    pathDirs: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    exists: (file) => fs.existsSync(file),
    readdir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    ...overrides,
  };
}

/**
 * @param {any} client
 * @param {Machine} machine
 * @returns {Detection}
 */
export function detect(client, machine) {
  /** @type {string[]} */
  const evidence = [];

  const command = resolveCommand(client, machine, evidence);

  for (const raw of client.detect.paths ?? []) {
    const candidate = expandPath(raw, machine);
    if (machine.exists(candidate)) evidence.push(candidate);
  }

  if (evidence.length === 0) {
    return { state: NOT_INSTALLED, configPath: null, command: null, evidence };
  }

  const configPath = configPathFor(client, machine);
  if (configPath === null) {
    return { state: INSTALLED_PATH_UNKNOWN, configPath: null, command, evidence };
  }

  return {
    state: machine.exists(configPath) ? INSTALLED_WITH_CONFIG : INSTALLED_NO_CONFIG,
    configPath,
    command,
    evidence,
  };
}

/**
 * The executable to run for this client, or null.
 *
 * PATH first, then the places the row names. The fallbacks are not politeness:
 * on the machine this table was written against, Claude Code lives inside
 * Claude Desktop at `~/.config/Claude/claude-code/<version>/claude` and is not
 * on PATH at all, Gemini is under an npm prefix that is not on PATH, and
 * Devin's binary is inside its own unpacked directory. Those three are the
 * clients whose own CLI we most want to use, and without this they would all
 * be unreachable on the one machine where they are known to work.
 *
 * @param {any} client
 * @param {Machine} machine
 * @param {string[]} [evidence]
 * @returns {string|null}
 */
export function resolveCommand(client, machine, evidence) {
  for (const name of client.detect.commands ?? []) {
    const found = onPath(name, machine);
    if (found !== null) {
      evidence?.push(found);
      return found;
    }
  }

  for (const raw of client.detect.commandFallbacks ?? []) {
    for (const candidate of expandStar(expandPath(raw, machine), machine)) {
      if (machine.exists(candidate)) {
        evidence?.push(candidate);
        return candidate;
      }
    }
  }

  return null;
}

/**
 * @param {string} name
 * @param {Machine} machine
 * @returns {string|null}
 */
function onPath(name, machine) {
  for (const dir of machine.pathDirs) {
    const candidate = path.join(dir, name);
    if (machine.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * One `*` in a path, expanded against the directory above it.
 *
 * That is exactly as much globbing as the table needs — Claude Code's version
 * directory — and stopping there means there is no pattern language to get
 * wrong. Newest last, so the highest version sorts to the end and is preferred.
 *
 * @param {string} pattern
 * @param {Machine} machine
 * @returns {string[]}
 */
function expandStar(pattern, machine) {
  const star = pattern.indexOf('*');
  if (star === -1) return [pattern];

  const before = pattern.slice(0, star);
  const after = pattern.slice(star + 1);
  const parent = path.dirname(before + 'x');

  return machine
    .readdir(parent)
    .sort()
    .reverse()
    .map((name) => path.join(parent, name) + after);
}
