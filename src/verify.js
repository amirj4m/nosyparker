/**
 * What we actually know, per client, after writing to it.
 *
 * This is the part of the phase that decides whether the rest of it was worth
 * building. Every client can be written to. Almost none of them can tell you
 * whether that worked. An installer that prints the same green tick for all of
 * them has not verified anything — it has agreed with itself.
 *
 * So there are six answers and they are not ranks of the same thing, they are
 * different claims:
 *
 *   connected          the client started our server and said it connected.
 *                      Two clients can reach this. It is the only answer that
 *                      is about the server rather than about a file.
 *   config-confirmed   the client parsed its own config, holds our entry, and
 *                      has it enabled. It never tried to run anything: Codex
 *                      reported a server pointing at a nonexistent binary as
 *                      `enabled`, so this claim stops exactly where it stops.
 *   written            the entry is in the file, put there by the client's own
 *                      command. Nothing has read it back but us.
 *   written-unverified the entry is in the file and there is no mechanism of
 *                      any kind to confirm the client ever reads it. Zed logs
 *                      nothing about context servers at any level; Kimi needs
 *                      an account before it will load one at all.
 *   failed             something said no, or the entry is not where it should
 *                      be. A write that returned without an error and did not
 *                      land arrives here, which is the whole reason the check
 *                      exists.
 *   unchecked          the check itself could not be run.
 *
 * Blockers are kept apart from all six on purpose. A setting that would stop a
 * client loading a perfectly good entry — VS Code's `chat.mcp.access`, Gemini's
 * folder trust, an org allowlist — is a fact about the client, not a verdict on
 * our write, and folding it into the status would produce a word that means two
 * things again. They are reported alongside, in their own sentence.
 *
 * That was reconsidered for Gemini's folder trust specifically, which is the
 * one blocker that actually fires in ordinary use: the entry is written and
 * valid, and Gemini ignores it because the folder is not trusted. It does not
 * get a status of its own. The current answer — a failure, with the blocker
 * sentence naming the file and the fix — already says everything a status would
 * say, in words rather than in vocabulary, and it says it for every blocker
 * rather than for the one we happened to hit. A seventh word would be
 * client-specific vocabulary in a list that is deliberately not, and it would
 * push against the thing the report was just simplified to do.
 *
 * Nothing here trusts a vendor's tool to tell the truth about itself. Three of
 * them were caught lying by a control test, in three different ways: one
 * reports success and writes nothing, one validates a file it never opens, one
 * calls a nonexistent binary enabled. The rule that survives all three is that
 * a command's output is evidence only of what that command was measured to
 * check, and the table records that per client rather than assuming it.
 */

import { expandPath, fillTokens } from './clients.js';
import { hasEntry, stripComments, withoutBom } from './edit.js';
import { readOrEmpty, runCommand } from './write.js';

/** The client started the server and said so. */
export const CONNECTED = 'connected';

/** The client parsed its config and holds our entry, enabled. */
export const CONFIG_CONFIRMED = 'config-confirmed';

/** The entry is in the file, put there by the client's own command. */
export const IN_FILE = 'written';

/** The entry is in the file and nothing can confirm the client reads it. */
export const UNVERIFIABLE = 'written-unverified';

/** Something said no, or the entry is not there. */
export const VERIFY_FAILED = 'failed';

/** The check could not be run at all. */
export const UNCHECKED = 'unchecked';

/**
 * @typedef {object} Verification
 * @property {string} status one of the six above
 * @property {string} tier the tier actually reached
 * @property {string} declaredTier the tier the table claims for this client
 * @property {string} says one sentence: what was done, in words
 * @property {string|null} cannotProve what this check does not establish
 * @property {string[]} blockers settings found that could stop it loading anyway
 */

/**
 * @typedef {object} VerifyOptions
 * @property {string} name
 * @property {string} configPath
 * @property {string|null} clientCommand
 * @property {import('./detect.js').Machine} machine
 * @property {any} editRequest
 * @property {(argv: string[]) => {status: number|null, stdout: string, stderr: string}} [run]
 */

/**
 * @param {any} client
 * @param {VerifyOptions} options
 * @returns {Verification}
 */
export function verifyClient(client, options) {
  const blockers = findBlockers(client, options);
  const declared = client.verify.tier;

  const method = client.verify.method;
  const runnable = method !== 'file-reread' && options.clientCommand !== null;

  if (method !== 'file-reread' && !runnable) {
    // Its own command has gone missing. Fall back to reading the file, and say
    // out loud that the answer is worth less than the table promised rather
    // than quietly reporting the weaker check under the stronger name.
    const fallback = fromFile(client, options, blockers);
    return {
      ...fallback,
      declaredTier: declared,
      says: `${fallback.says} ${client.name}'s own command could not be found, so the check the table calls for did not run.`,
    };
  }

  switch (method) {
    case 'cli-lines':
      return fromLines(client, options, blockers);
    case 'cli-json':
      return fromJson(client, options, blockers);
    case 'file-reread':
      return fromFile(client, options, blockers);
    default:
      return {
        status: UNCHECKED,
        tier: 'C',
        declaredTier: declared,
        says: `There is no way to check ${client.name}.`,
        cannotProve: client.verify.cannotProve,
        blockers,
      };
  }
}

/**
 * A client that prints a line per server, with a mark on it.
 *
 * Claude Code and Gemini both start the server to produce that line, which is
 * what makes them the only two that can honestly say `connected`. Goose prints
 * the same shape of thing from a config it has merely parsed, and its row says
 * so — the difference is in the tier, not in the parsing.
 *
 * @param {any} client
 * @param {VerifyOptions} options
 * @param {string[]} blockers
 * @returns {Verification}
 */
function fromLines(client, options, blockers) {
  const run = options.run ?? runCommand;
  const argv = fillTokens(client.verify.argv, { name: options.name, command: '', serverPath: '' });
  const ran = run([/** @type {string} */ (options.clientCommand), ...argv.slice(1)]);

  const output = `${ran.stdout}\n${ran.stderr}`;

  // The exit code is deliberately not consulted. `claude mcp list` exits 0 with
  // no servers configured at all, so a zero here means the command ran, not
  // that it found anything.
  if (matches(client.verify.failed, options.name, output)) {
    return {
      status: VERIFY_FAILED,
      tier: client.verify.tier,
      declaredTier: client.verify.tier,
      says: `${client.name} was asked and reported that it could not use the server.`,
      cannotProve: client.verify.cannotProve,
      blockers,
    };
  }

  if (matches(client.verify.connected, options.name, output)) {
    const connected = client.verify.tier === 'A';
    return {
      status: connected ? CONNECTED : CONFIG_CONFIRMED,
      tier: client.verify.tier,
      declaredTier: client.verify.tier,
      says: connected
        ? `${client.name} started the server and reported that it connected.`
        : `${client.name} read its own config back and our entry is in it, enabled.`,
      cannotProve: client.verify.cannotProve,
      blockers,
    };
  }

  return {
    status: VERIFY_FAILED,
    tier: client.verify.tier,
    declaredTier: client.verify.tier,
    says: `${client.name} was asked and did not mention the server at all.`,
    cannotProve: client.verify.cannotProve,
    blockers,
  };
}

/**
 * Codex, whose read-back is structured and honest about being a read-back.
 *
 * @param {any} client
 * @param {VerifyOptions} options
 * @param {string[]} blockers
 * @returns {Verification}
 */
function fromJson(client, options, blockers) {
  const run = options.run ?? runCommand;
  const argv = fillTokens(client.verify.argv, { name: options.name, command: '', serverPath: '' });
  const ran = run([/** @type {string} */ (options.clientCommand), ...argv.slice(1)]);

  const found = findNamed(parseOrNull(ran.stdout), options.name);

  if (found === null) {
    return {
      status: VERIFY_FAILED,
      tier: client.verify.tier,
      declaredTier: client.verify.tier,
      says: `${client.name} listed its servers and ours was not among them.`,
      cannotProve: client.verify.cannotProve,
      blockers,
    };
  }

  if (found.enabled === false) {
    return {
      status: VERIFY_FAILED,
      tier: client.verify.tier,
      declaredTier: client.verify.tier,
      says: `${client.name} has our entry and has it disabled, so it will not be loaded.`,
      cannotProve: client.verify.cannotProve,
      blockers,
    };
  }

  return {
    status: CONFIG_CONFIRMED,
    tier: client.verify.tier,
    declaredTier: client.verify.tier,
    says: `${client.name} read its own config back and our entry is in it, enabled.`,
    cannotProve: client.verify.cannotProve,
    blockers,
  };
}

/**
 * Everything with no read-back of any kind: open the file and look.
 *
 * The two answers this can give are deliberately different words. A client
 * whose own command wrote the file has had one independent party involved; a
 * client where we wrote the file ourselves and nothing on the machine can be
 * asked about it has had none. Both are honest, and they are not the same
 * claim.
 *
 * @param {any} client
 * @param {VerifyOptions} options
 * @param {string[]} blockers
 * @returns {Verification}
 */
function fromFile(client, options, blockers) {
  const present = hasEntry(readOrEmpty(options.configPath), options.editRequest);

  if (!present) {
    return {
      status: VERIFY_FAILED,
      tier: client.verify.tier,
      declaredTier: client.verify.tier,
      says: `The entry is not in ${options.configPath}.`,
      cannotProve: client.verify.cannotProve,
      blockers,
    };
  }

  const byTheirTool = client.write.method === 'cli';

  return {
    status: byTheirTool ? IN_FILE : UNVERIFIABLE,
    tier: client.verify.tier,
    declaredTier: client.verify.tier,
    says: byTheirTool
      ? `${client.name}'s own command wrote the entry and it is in the file.`
      : `The entry is in the file and nothing on this machine can confirm ${client.name} reads it.`,
    cannotProve: client.verify.cannotProve,
    blockers,
  };
}

/**
 * Settings that would stop a good entry loading.
 *
 * These are read from disk and are therefore only half the story: VS Code's
 * gates all have enterprise `.policy` siblings that are not on disk at all, so
 * a clean result here does not mean there is no policy. That limitation is
 * stated in the row rather than papered over.
 *
 * @param {any} client
 * @param {VerifyOptions} options
 * @returns {string[]}
 */
export function findBlockers(client, options) {
  /** @type {string[]} */
  const found = [];

  for (const blocker of client.blockers ?? []) {
    const file = expandPath(blocker.file, options.machine);
    const settings = parseOrNull(withoutBom(stripComments(readOrEmpty(file))));

    // A missing file is not the absence of a blocker. Gemini's folder trust is
    // recorded in a file that does not exist until something is trusted, so no
    // file means nothing is trusted, which is the strongest form of the very
    // condition being looked for. Reading that as "nothing to report" is how a
    // live run reported Gemini as failed and said nothing about why — the
    // client itself was printing the reason at the time.
    if (settings === null) {
      if (blocker.check === 'json-key-absent') found.push(blocker.says);
      continue;
    }

    if (blocked(blocker, settings, options)) found.push(blocker.says);
  }

  return found;
}

/**
 * @param {any} blocker
 * @param {any} settings
 * @param {VerifyOptions} options
 * @returns {boolean}
 */
function blocked(blocker, settings, options) {
  const fill = (/** @type {string} */ text) => text
    .replaceAll('{{name}}', options.name)
    .replaceAll('{{cwd}}', options.machine.cwd ?? '');

  const key = fill(blocker.key ?? '');

  switch (blocker.check) {
    case 'json-setting-equals':
      return key in settings && settings[key] === blocker.value;
    case 'json-setting-not-equals':
      return key in settings && settings[key] !== blocker.value;
    case 'json-array-contains':
      return Array.isArray(settings[key]) && settings[key].includes(fill(String(blocker.value)));
    case 'json-key-present':
      return Object.keys(settings).some((candidate) => candidate.startsWith(blocker.keyPrefix));
    case 'json-key-absent':
      return !(key in settings);
    default:
      return false;
  }
}

/**
 * @param {string|null} pattern
 * @param {string} name
 * @param {string} output
 * @returns {boolean}
 */
function matches(pattern, name, output) {
  if (pattern === null) return false;
  const filled = pattern.replaceAll('{{name}}', name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(filled, 'mu').test(output);
}

/**
 * The object in this structure that calls itself by our name.
 *
 * Written as a search rather than a path because the shape of `codex mcp list
 * --json` is one vendor's decision and is not something we can hold still.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {any|null}
 */
function findNamed(value, name) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamed(item, name);
      if (found !== null) return found;
    }
    return null;
  }

  if (value === null || typeof value !== 'object') return null;

  const record = /** @type {Record<string, any>} */ (value);
  if (record.name === name) return record;

  for (const [key, item] of Object.entries(record)) {
    if (key === name && item !== null && typeof item === 'object') return item;
    const found = findNamed(item, name);
    if (found !== null) return found;
  }

  return null;
}

/**
 * @param {string} text
 * @returns {any|null}
 */
function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
