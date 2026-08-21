/**
 * The client table, and the three things that have to be done to a row before
 * anything else can use it: find the file on this machine, fill in the entry,
 * and say what the row is allowed to claim.
 *
 * The table itself is `clients.json` and it is data, not code. Everything in it
 * comes from PHASE3-RESEARCH.md, which is the result of installing each client
 * on one machine and testing it. Nothing in it was taken from documentation
 * where the research measured something different, and where the research could
 * not establish a value the field is `null` rather than a guess. A null path
 * means we do not install that client on that operating system and say so.
 *
 * Three fields decide what the installer may print at the end, and they are
 * kept apart on purpose:
 *
 *   write.method   how the entry gets there — the client's own CLI, or us
 *   verify.method  what we can ask afterwards
 *   verify.tier    how much that answer is worth
 *
 * They do not line up. Gemini has a CLI that reports success and writes
 * nothing, so it is written by file and verified by CLI. Codex has a CLI that
 * writes correctly and a list command that reports a nonexistent binary as
 * enabled, so it is written by CLI and its read-back proves the config parsed
 * and nothing more. A single "does it work" flag would have to lie about one
 * of them.
 *
 * `lastVerified` is per field group rather than per row because the groups age
 * differently: a config path is wrong the day a vendor moves it, and a
 * verification tier is wrong the day a vendor ships a health check. The
 * community table this is diffed against has no such field at all, which is
 * why ours is the one that ages honestly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {Record<string, unknown>} Row */

/**
 * @typedef {object} ClientTable
 * @property {number} tableVersion
 * @property {string} serverName
 * @property {string} sourceOfTruth
 * @property {string[]} fieldsUpstreamDoesNotModel
 * @property {any[]} clients
 */

/** @type {ClientTable|null} */
let cached = null;

/**
 * The table, read once.
 *
 * @param {string|URL} [file] the table to read, for tests that want a different one
 * @returns {ClientTable}
 */
export function loadClients(file) {
  if (file === undefined && cached !== null) return cached;

  const source = file ?? new URL('./clients.json', import.meta.url);
  const table = JSON.parse(fs.readFileSync(source, 'utf8'));
  validateTable(table);

  if (file === undefined) cached = table;
  return table;
}

/**
 * @param {string} id
 * @param {ClientTable} [table]
 * @returns {any|null}
 */
export function clientById(id, table) {
  const clients = (table ?? loadClients()).clients;
  return clients.find((client) => client.id === id) ?? null;
}

/**
 * Where this client's file is on this machine, or null if we do not know.
 *
 * A null is not a failure to look. It is the research declining to state a path
 * it could not establish — Devin's directory on macOS, Zed's on anything but
 * Linux — and the installer reports those as unsupported on that platform
 * rather than writing to a path somebody guessed.
 *
 * @param {any} client
 * @param {object} env
 * @param {string} env.home
 * @param {string} env.platform
 * @param {string} [env.appData] %APPDATA% on Windows
 * @returns {string|null}
 */
export function configPathFor(client, env) {
  const raw = client.configPaths[env.platform] ?? null;
  return raw === null ? null : expandPath(raw, env);
}

/**
 * @param {string} raw
 * @param {object} env
 * @param {string} env.home
 * @param {string} [env.appData]
 * @returns {string}
 */
export function expandPath(raw, env) {
  if (raw.startsWith('%APPDATA%')) {
    const appData = env.appData ?? path.join(env.home, 'AppData', 'Roaming');
    return path.join(appData, ...raw.slice('%APPDATA%'.length).split(/[\\/]/u).filter(Boolean));
  }
  if (raw.startsWith('~/')) return path.join(env.home, raw.slice(2));
  return raw;
}

/** The three this table speaks about, in the order sentences name them. */
export const PLATFORMS = /** @type {const} */ (['linux', 'darwin', 'win32']);

/** What a person calls each of them. */
const PLATFORM_NAMES = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/**
 * Where a second surface lives on this platform, or null.
 *
 * @param {any} surface
 * @param {string} platform
 * @returns {string|null}
 */
export function surfacePath(surface, platform) {
  return surface.path[platform]?.at ?? null;
}

/**
 * One sentence saying which of a surface's paths anybody has actually watched.
 *
 * Generated rather than written, and this is the point of it. The claim used to
 * exist three times — as `measuredOn`, as English in the row's `why`, and again
 * in CLIENTS.md — and the copies went out of step inside a day: a clause was
 * removed from the table and left standing in the document that ships. A
 * sentence built from the flags has one source, so removing the admission means
 * removing the flag, and removing the flag fails the table at load.
 *
 * @param {any} surface
 * @returns {string}
 */
export function provenance(surface) {
  const named = (/** @type {string[]} */ list) => list
    .map((platform) => PLATFORM_NAMES[/** @type {'linux'} */ (platform)])
    .join(' and ');

  const present = PLATFORMS.filter((platform) => surfacePath(surface, platform) !== null);
  const watched = present.filter((platform) => surface.path[platform].inferred === false);
  const guessed = present.filter((platform) => surface.path[platform].inferred === true);

  if (guessed.length === 0) return `measured on ${named(watched)}`;
  if (watched.length === 0) return `inferred on ${named(guessed)}, and watched on none of them`;
  return `measured on ${named(watched)}, and inferred on ${named(guessed)}`;
}

/**
 * Fill the tokens in a row's entry.
 *
 * The tokens are `{{name}}`, `{{command}}` and `{{serverPath}}`, and they are
 * substituted through the whole structure rather than into a string, so a row
 * that puts the command in a differently named field — Goose's `cmd` — needs no
 * code of its own.
 *
 * @param {unknown} shape
 * @param {object} values
 * @param {string} values.name
 * @param {string} values.command
 * @param {string} values.serverPath
 * @returns {any}
 */
export function fillTokens(shape, values) {
  if (typeof shape === 'string') {
    return shape
      .replaceAll('{{name}}', values.name)
      .replaceAll('{{command}}', values.command)
      .replaceAll('{{serverPath}}', values.serverPath);
  }
  if (Array.isArray(shape)) return shape.map((item) => fillTokens(item, values));
  if (shape !== null && typeof shape === 'object') {
    /** @type {Record<string, unknown>} */
    const filled = {};
    for (const [key, value] of Object.entries(shape)) filled[key] = fillTokens(value, values);
    return filled;
  }
  return shape;
}

/**
 * The JSON blob a client's own `--add-mcp` takes, which is the entry with the
 * server's name inside it rather than as a key above it.
 *
 * @param {any} client
 * @param {object} values
 * @param {string} values.name
 * @param {string} values.command
 * @param {string} values.serverPath
 * @returns {string}
 */
export function entryJsonWithName(client, values) {
  return JSON.stringify({ name: values.name, ...fillTokens(client.entry, values) });
}

/**
 * The argument list for a row's CLI, with `{{entryJsonWithName}}` handled as
 * well as the ordinary tokens.
 *
 * @param {string[]} argv
 * @param {any} client
 * @param {object} values
 * @param {string} values.name
 * @param {string} values.command
 * @param {string} values.serverPath
 * @returns {string[]}
 */
export function fillArgv(argv, client, values) {
  return argv.map((argument) =>
    argument === '{{entryJsonWithName}}'
      ? entryJsonWithName(client, values)
      : fillTokens(argument, values),
  );
}

/**
 * Where the running copy of this project keeps its server, and what starts it.
 *
 * The command is the absolute path of the interpreter running this installer,
 * never the word `node`, and that is not a preference — it is a defect we
 * watched happen. In opencode, an entry of `["node", …]` fails with
 * `Connection closed` and no useful explanation; the same entry with the full
 * path connects. opencode does not inherit the shell's environment, so a
 * version-managed Node — nvm, fnm, asdf — is simply invisible to it. Zed and
 * Gemini only work with a bare `node` because they deliberately import the
 * shell environment, which is a choice those two made and not something to rely
 * on. Any application started from a desktop icon has the same problem.
 *
 * `process.execPath` rather than a search of PATH, because it is the
 * interpreter actually running rather than the one we would find if we went
 * looking. Node reports it already resolved and absolute.
 *
 * **What happens when that path goes away.** Under a version manager it will:
 * switching or uninstalling a Node version moves or deletes the directory this
 * path names, and every entry written by a previous run then points at nothing.
 * The failure is silent, because a client that cannot start a server mostly
 * does not say so.
 *
 * We do not try to survive it. The alternatives are all worse: writing `node`
 * and hoping the client has a PATH, writing a wrapper script of our own into
 * somebody's home directory, or writing a stabler-looking path that is not the
 * interpreter we verified against. So the honest answer is that changing Node
 * means running `setup` again, and the honest thing to do is say so — which the
 * report does, naming the exact path it wrote, every time it writes one.
 *
 * @returns {{command: string, serverPath: string}}
 */
export function serverCommand() {
  return {
    command: process.execPath,
    serverPath: fileURLToPath(new URL('./mcp-server.js', import.meta.url)),
  };
}

/**
 * How to run this program again, in words a person can paste.
 *
 * It matters that this is derived rather than written down. Every message that
 * ends "run setup again" said `nosyparker setup`, and there is no such command:
 * nothing is released, nothing is on anybody's PATH, and a person copying that
 * gets `command not found` at the moment they are already stuck. The documents
 * said `node src/cli.js setup` and were right, which is the program and a
 * document disagreeing about what to do next — the class this project keeps
 * having to close.
 *
 * The script path is absolute so the line works from wherever the person is
 * standing. The interpreter is not, and that is the difference between this and
 * a config entry: an entry is started by an application with no PATH, and this
 * is a line a person pastes into the shell they are already using — the shell
 * they just ran this program from. Naming the interpreter in full here would
 * double the length of the sentence to solve a problem that shell does not
 * have, and if their `node` is too old the version guard says so in a sentence.
 *
 * @returns {string}
 */
export function invocation() {
  // Started through the shim a global install puts on PATH, npm points argv[1]
  // at that shim, so its basename is the command a person typed. That is the
  // sentence to give them back.
  //
  // On Windows npm writes a `.cmd` wrapper that runs the script directly, so
  // argv[1] is the JS file and this falls through to the path form — correct,
  // if wordier, and the alternative would be guessing.
  // Both separators, because `path.basename` follows the host's rules and a
  // Windows shim path handed to a POSIX basename comes back whole. Checking
  // only one of them made the `.cmd` branch unreachable everywhere it mattered
  // — the same blindness this project had just fixed in the npx guard, in the
  // function that fix's own comment cites as the precedent for handling it.
  const argv = process.argv[1] ?? '';
  const started = [path.basename(argv), path.win32.basename(argv)];
  if (started.includes('nosyparker') || started.includes('nosyparker.cmd')) return 'nosyparker';

  return `node ${fileURLToPath(new URL('./cli.js', import.meta.url))}`;
}


/**
 * Refuse a table that is missing something every reader assumes is there.
 *
 * This runs on load rather than in a test alone, because the table is the one
 * artefact everything else in this phase reads and a row with no `verify` block
 * would otherwise become a client we quietly claim nothing about.
 *
 * @param {any} table
 */
function validateTable(table) {
  const required = ['tableVersion', 'serverName', 'clients', 'fieldsUpstreamDoesNotModel'];
  for (const key of required) {
    if (!(key in table)) throw new Error(`The client table has no "${key}".`);
  }

  const seen = new Set();
  for (const client of table.clients) {
    for (const key of ['id', 'name', 'tier', 'evidence', 'format', 'rootKey', 'configPaths',
      'entry', 'detect', 'write', 'remove', 'verify', 'traps', 'restart', 'lastVerified']) {
      if (!(key in client)) {
        throw new Error(`The client table row "${client.id ?? '?'}" has no "${key}".`);
      }
    }
    if (seen.has(client.id)) throw new Error(`The client table has two rows called "${client.id}".`);
    seen.add(client.id);

    for (const platform of ['linux', 'darwin', 'win32']) {
      if (!(platform in client.configPaths)) {
        throw new Error(`"${client.id}" says nothing about ${platform}. Say null if it is unknown.`);
      }
    }

    if (!['A', 'B+', 'B', 'C'].includes(client.verify.tier)) {
      throw new Error(`"${client.id}" has verification tier "${client.verify.tier}".`);
    }
    for (const surface of client.alsoRemoveFrom ?? []) {
      for (const key of ['path', 'rootKey', 'format', 'why', 'measuredOn']) {
        if (!(key in surface)) {
          throw new Error(`"${client.id}" has a second surface with no "${key}".`);
        }
      }
      if (!Array.isArray(surface.measuredOn) || surface.measuredOn.length === 0) {
        throw new Error(
          `"${client.id}" does not say which platform its second surface was measured on. A path `
          + 'nobody has watched work is inference and has to be labelled as such.',
        );
      }
      for (const platform of PLATFORMS) {
        if (!(platform in surface.path)) {
          throw new Error(
            `"${client.id}" says nothing about ${platform} for ${surface.rootKey}. Say null if `
            + 'it is unknown — a missing key reads as "not on this platform" and cleans nothing.',
          );
        }

        const where = surface.path[platform];
        if (where === null) continue;

        if (typeof where.at !== 'string' || typeof where.inferred !== 'boolean') {
          throw new Error(
            `"${client.id}" gives a ${platform} second-surface path that is not `
            + '{ at, inferred }. A path carries whether anybody has watched it work, next to '
            + 'itself, so that the two cannot be updated separately.',
          );
        }

        // The admission and the list have to agree, in both directions. This is
        // the whole of the mechanism: the claim "nobody has watched this" stops
        // being a sentence somebody wrote in `why` and becomes a boolean, which
        // is the only form a test can check without standing at one remove from
        // it. Three times a regex over that prose passed for a reason unrelated
        // to what it claimed to check.
        //
        // What this cannot do, and nothing here can: tell whether `measuredOn`
        // is *true*. Writing ["linux", "win32"] without going to Windows passes
        // every check in this file. That is a claim about the world and only a
        // measurement settles it — which is what the next two days are for.
        // Read this as internal consistency, not as proof.
        const claimed = !surface.measuredOn.includes(platform);
        if (where.inferred !== claimed) {
          throw new Error(
            `"${client.id}" says its second surface was measured on `
            + `[${surface.measuredOn.join(', ')}] and marks the ${platform} path `
            + `inferred: ${where.inferred}. Those disagree.`,
          );
        }
      }
    }

    if (client.write.method === 'file' && client.entry === null) {
      throw new Error(`"${client.id}" is written by file and has no entry shape.`);
    }
  }
}
