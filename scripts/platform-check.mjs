#!/usr/bin/env node
/**
 * The run sheet, as a program: what the table claims about this machine, and
 * whether the machine agrees. For a person verifying a platform the table has
 * never been watched on — PLATFORMS.md says which and why.
 *
 *   node scripts/platform-check.mjs                 before setup: what is here, where each row would write
 *   node scripts/platform-check.mjs --after-setup   after setup: is our entry in each file, does it name a real Node
 *   node scripts/platform-check.mjs --after-uninstall
 *   node scripts/platform-check.mjs --template      a results table to fill in and paste into PLATFORMS.md
 *
 * It reads and prints. It never writes to any file — not a client's, not the
 * store, not the action log — and it does not run any client's command. The
 * writing is `nosyparker setup`'s job and the asking is `doctor`'s; this is the
 * clipboard between them, so that a paid hour on a rented machine is spent
 * reading output rather than working out what to look at.
 *
 * Not shipped in the package: it is ours, like the drift watcher.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { clientById, configPathFor, expandPath, loadClients, PLATFORMS, surfacePath } from '../src/clients.js';
import { detect, INSTALLED_PATH_UNKNOWN, NOT_INSTALLED, thisMachine } from '../src/detect.js';
import { hasEntry } from '../src/edit.js';
import { editRequest, readOrEmpty } from '../src/write.js';

const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!startedDirectly) throw new Error('platform-check.mjs is run from a terminal, not imported.');

const mode = process.argv[2] ?? '--before';
if (!['--before', '--after-setup', '--after-uninstall', '--template'].includes(mode)) {
  process.stderr.write(`platform-check takes --before (the default), --after-setup, --after-uninstall or --template, not ${mode}.\n`);
  process.exit(1);
}

const machine = thisMachine();
const platform = /** @type {'linux'|'darwin'|'win32'} */ (machine.platform);
const name = loadClients().serverName;
const NAMES = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/** @param {string} text */
const out = (text) => process.stdout.write(`${text}\n`);

if (mode === '--template') {
  template();
  process.exit(0);
}

out(`${NAMES[platform] ?? platform} ${os.release()} on ${os.arch()}, Node ${process.versions.node}, home ${machine.home}`);
out(`Table: ${loadClients().clients.length} rows; ${loadClients().clients.filter((c) => c.configPaths[platform]).length} carry a ${NAMES[platform]} path.`);
out('');

/** @type {{id: string, verdict: string, note: string}[]} */
const results = [];

for (const client of loadClients().clients) {
  const tablePath = client.configPaths[platform];
  const found = detect(client, machine);
  const configPath = tablePath === null ? null : configPathFor(client, machine);

  out(`## ${client.name}  (${client.id})`);

  if (tablePath === null) {
    if (found.state === NOT_INSTALLED) {
      out(`   no ${NAMES[platform]} path in the table, and nothing of it found here. Nothing to do unless you install it.`);
      results.push({ id: client.id, verdict: 'absent, no path', note: '' });
    } else {
      out(`   FOUND (${found.evidence.join(', ')}) but the table has no ${NAMES[platform]} path for it.`);
      out(`   This is a row you can add: open the application once, then find where it wrote its MCP`);
      out(`   configuration and note the exact path. Setup will report it as "no path for this platform" until then.`);
      results.push({ id: client.id, verdict: 'installed, path unknown', note: 'record where it keeps its MCP config' });
    }
    out('');
    continue;
  }

  out(`   table path:  ${configPath}`);
  out(`   detected:    ${found.state}${found.evidence.length ? `  (${found.evidence.join(', ')})` : ''}`);
  out(`   written by:  ${client.write.method === 'cli' ? `its own command — ${client.write.argv.slice(0, 3).join(' ')}` : 'setup, editing the file'}`);
  out(`   checked by:  ${client.verify.method === 'file-reread' ? 'reading the file only — open the app and ask the agent' : `its own command — ${client.verify.argv.join(' ')}`}`);

  if (found.state === NOT_INSTALLED) {
    out('   → not on this machine. Install it if you want this row closed today.');
    results.push({ id: client.id, verdict: 'not installed', note: '' });
    out('');
    continue;
  }
  if (found.state === INSTALLED_PATH_UNKNOWN || configPath === null) {
    results.push({ id: client.id, verdict: 'installed, path unknown', note: '' });
    out('');
    continue;
  }

  const exists = fs.existsSync(configPath);
  const text = exists ? readOrEmpty(configPath) : '';
  const request = editRequest(client, { name, command: process.execPath, serverPath: '' });
  const present = text !== '' && hasEntry(text, request);

  if (mode === '--before') {
    out(`   file:        ${exists ? 'exists' : 'does not exist yet'}${present ? ', and already holds our entry' : ''}`);
    out('   → claim 1 to settle: is this where the application reads? Open the application once, then look for');
    out(`     the file it created or changed. If it is somewhere else, that is the finding; write it down.`);
    results.push({ id: client.id, verdict: exists ? 'file exists' : 'file absent', note: '' });
  }

  if (mode === '--after-setup') {
    if (!present) {
      out(`   FAIL  our entry is not in ${configPath}. Read setup's own report for this client — it says why.`);
      results.push({ id: client.id, verdict: 'FAIL: entry not written', note: '' });
    } else {
      const named = interpreterIn(text, client);
      const real = named !== null && fs.existsSync(named);
      out(`   ok    entry present${named === null ? '' : `, names ${named}${real ? ' (exists)' : ' (NOT FOUND)'}`}`);
      out(`   → now: ${restartLine(client)}`);
      out('     then ask the agent something only the shared memory knows. Record yes / no / could not sign in.');
      results.push({ id: client.id, verdict: real || named === null ? 'entry written' : 'FAIL: interpreter missing', note: '' });
    }
  }

  if (mode === '--after-uninstall') {
    if (present) {
      out(`   FAIL  our entry is still in ${configPath}.`);
      results.push({ id: client.id, verdict: 'FAIL: entry remains', note: '' });
    } else {
      out(`   ok    no entry of ours in ${configPath}${exists ? ' (file kept)' : ' (file gone)'}`);
      results.push({ id: client.id, verdict: 'clean', note: '' });
    }
  }

  for (const surface of client.alsoRemoveFrom ?? []) {
    const wanted = surfacePath(surface, platform);
    if (wanted === null) continue;
    const file = expandPath(wanted, machine);
    const held = fs.existsSync(file) && hasEntry(readOrEmpty(file), { name, rootKey: surface.rootKey, format: surface.format, entry: {} });
    out(`   second file: ${file} — ${fs.existsSync(file) ? (held ? 'holds our entry' : 'exists, nothing of ours') : 'not there'}  (inferred: ${surface.path[platform].inferred})`);
  }
  for (const extra of client.extraConfigPaths ?? []) {
    out(`   also real:   ${expandPath(extra.path, machine)} — ${extra.status}`);
  }
  if (client.writeRequiresQuit) out(`   quit first:  ${client.name} rewrites its file while running; quit it before setup.`);
  if (mode === '--before' && client.traps.length) {
    out('   traps:');
    for (const trap of client.traps.slice(0, 3)) out(`     - ${trap.length > 160 ? `${trap.slice(0, 157)}…` : trap}`);
  }
  out('');
}

out('## Summary');
for (const row of results) out(`   ${row.id.padEnd(16)} ${row.verdict}${row.note ? ` — ${row.note}` : ''}`);
out('');
out(mode === '--before'
  ? `Next: quit any application marked "quit first", then run \`nosyparker setup\`, then this script with --after-setup.`
  : mode === '--after-setup'
    ? 'Next: open each application in turn as the lines above say, ask the agent, note the answer; then `nosyparker doctor`; then `nosyparker uninstall` and this script with --after-uninstall.'
    : 'Next: paste the --template table into PLATFORMS.md with your findings, and move each verified path into its row\'s lastVerified.');

/**
 * @param {any} client
 * @returns {string}
 */
function restartLine(client) {
  return String(client.restart).replaceAll('{{clientCommand}}', client.detect?.commands?.[0] ?? client.id);
}

/**
 * The interpreter a JSON entry names; null where the format has no parser here.
 *
 * @param {string} text
 * @param {any} client
 * @returns {string|null}
 */
function interpreterIn(text, client) {
  if (client.format !== 'json' && client.format !== 'jsonc') {
    const match = /^[ \t-]*(?:command|cmd)\s*[:=]\s*"?([A-Za-z]:\\[^"\s,\]]+|\/[^"\s,\]]+)/mu.exec(text);
    return match === null ? null : match[1];
  }
  try {
    const stripped = text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');
    const entry = JSON.parse(stripped)?.[client.rootKey]?.[name];
    const command = entry?.command ?? entry?.cmd;
    const found = Array.isArray(command) ? command[0] : command;
    return typeof found === 'string' && path.isAbsolute(found) ? found : null;
  } catch {
    return null;
  }
}

function template() {
  out(`### ${NAMES[platform] ?? platform} run, ${new Date().toISOString().slice(0, 10)}`);
  out('');
  out(`Machine: ${os.release()} ${os.arch()}, Node ${process.versions.node}. Fill every cell; "—" means not tried, not "fine".`);
  out('');
  out('| id | installed | table path right? | actual path if not | setup wrote | agent answered | uninstall clean | notes |');
  out('|---|---|---|---|---|---|---|---|');
  for (const client of loadClients().clients) {
    const p = client.configPaths[platform];
    out(`| \`${client.id}\` | — | ${p === null ? 'no path in table' : '—'} | — | — | — | — |  |`);
  }
  out('');
  out('Then, per row that was right: add the platform to `lastVerified.configPaths` as today\'s date, and for a');
  out('second surface set `inferred: false` and add the platform to `measuredOn`. A row that was wrong gets the');
  out('measured path in `configPaths` and, if it disagrees with the community table, a reason in vendor/clients.meta.json.');
  void clientById;
  void PLATFORMS;
}
