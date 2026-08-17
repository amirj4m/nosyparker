/**
 * The drift watcher.
 *
 * A weekly job that compares our client table against the community
 * `clients.json` and says something when they disagree. It is a second opinion
 * and never a source of truth: `clients.json` is community-maintained,
 * unverified, and lists neither Claude Desktop's Linux path nor Kimi Code at
 * all, while every row of ours came from installing the thing. So when they
 * disagree, ours wins and the correct response is a pull request upstream.
 *
 * **This job raises questions. It never edits the table.**
 *
 * It compares three artefacts, not two, and the middle one is the point:
 *
 *   upstream    fetched now, a moving target nobody reviewed
 *   vendored    `vendor/clients.json`, a copy a human read and accepted
 *   ours        `src/clients.json`
 *
 * Diffing upstream against the vendored copy asks "has the community's picture
 * changed since somebody looked?". Diffing the vendored copy against ours asks
 * "have we drifted from the picture we last agreed with?". A single diff of
 * upstream against ours would answer neither, because it re-reports every
 * difference we have already considered and accepted, every week, until nobody
 * reads it.
 *
 * Those accepted differences are written down in `vendor/clients.meta.json`
 * with a reason each. That list is the reviewed part of the baseline: a
 * difference on it is silence, a difference not on it is a finding.
 *
 * The hard part is what this cannot catch, and it is worth being plain about.
 * `clients.json` has no `lastUpdated` field of any kind, so a clean diff proves
 * only that upstream has not changed — not that upstream is right, and not that
 * the world has not moved. If upstream goes quiet the job goes quiet with it,
 * at exactly the moment we would most want noise. Hence the staleness clock:
 * when upstream's content has not moved in ninety days the job fails and says
 * to re-verify the top tier by hand. Silence becomes a signal instead of an
 * absence of one.
 *
 * It never runs at install time. A stranger installing this must not depend on
 * a third party's URL being up.
 *
 * A network failure is not a build failure. It reports that it could not check
 * and exits zero, because an upstream outage is not a defect in this repository.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** How long upstream may sit unchanged before we stop calling it maintained. */
export const STALE_AFTER_DAYS = 90;

/** Their platform names, and ours. */
const PLATFORMS = [['linux', 'linux'], ['darwin', 'mac'], ['win32', 'windows']];

/**
 * @typedef {object} Finding
 * @property {string} kind
 * @property {string} what
 * @property {string} action
 */

/**
 * @typedef {object} DriftInput
 * @property {{text: string, lastModified: string|null}|null} upstream null when it could not be fetched
 * @property {string} vendored
 * @property {any} meta
 * @property {any} table our client table
 * @property {string} today an ISO date
 */

/**
 * @param {DriftInput} input
 * @returns {{findings: Finding[], notes: string[], exitCode: number}}
 */
export function checkDrift({ upstream, vendored, meta, table, today }) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const notes = [];

  const vendoredTable = JSON.parse(vendored);
  const accepted = new Set((meta.acceptedDivergences ?? []).map((/** @type {any} */ row) => row.id));

  // Second diff first, because it needs nothing from the network. Somebody
  // editing our table without re-vendoring is a finding whether or not the
  // internet is reachable today.
  findings.push(...ourDrift(table, vendoredTable, accepted));

  if (upstream === null) {
    notes.push('Upstream could not be fetched, so the community table was not compared. That is not a failure of this repository.');
    return { findings, notes, exitCode: findings.length > 0 ? 1 : 0 };
  }

  const liveHash = hash(upstream.text);
  const vendoredHash = hash(vendored);

  if (liveHash !== vendoredHash) {
    findings.push({
      kind: 'upstream-changed',
      what: `The community table has changed since it was vendored (${vendoredHash.slice(0, 12)} → ${liveHash.slice(0, 12)}).`,
      action: 'Read the differences below, then re-vendor with a pull request if they are right.',
    });
    findings.push(...upstreamDrift(JSON.parse(upstream.text), vendoredTable, table));
  } else {
    const changed = upstream.lastModified ?? meta.contentLastChanged;
    const days = daysBetween(changed, today);
    notes.push(`Upstream is unchanged, and was last modified ${changed} (${days} days ago).`);

    if (days > STALE_AFTER_DAYS) {
      findings.push({
        kind: 'stale',
        what: `Upstream has not changed in ${days} days. Treat it as unmaintained.`,
        action: 'Re-verify the tier 1 clients by hand against real installations. A quiet canary is not a healthy one.',
      });
    }
  }

  return { findings, notes, exitCode: findings.length > 0 ? 1 : 0 };
}

/**
 * Have we drifted from the copy somebody reviewed.
 *
 * @param {any} table
 * @param {any} vendoredTable
 * @param {Set<string>} accepted
 * @returns {Finding[]}
 */
function ourDrift(table, vendoredTable, accepted) {
  /** @type {Finding[]} */
  const findings = [];
  const theirs = byId(vendoredTable);

  for (const client of table.clients) {
    if (client.upstreamId === null) continue;

    const other = theirs.get(client.upstreamId);
    if (other === undefined) {
      findings.push({
        kind: 'missing-upstream',
        what: `We carry ${client.id} and map it to upstream "${client.upstreamId}", which the vendored table does not have.`,
        action: 'Fix the mapping, or record it in acceptedDivergences with a reason.',
      });
      continue;
    }

    for (const difference of compare(client, other)) {
      if (accepted.has(`${client.id}:${difference.field}`)) continue;
      findings.push({
        kind: 'we-differ',
        what: `${client.id}: ${difference.what}`,
        action: 'Our verified row wins. Either this is a divergence to accept in vendor/clients.meta.json with a reason, or somebody edited the table without re-vendoring.',
      });
    }
  }

  return findings;
}

/**
 * What has changed upstream, restricted to what matters to us.
 *
 * @param {any} live
 * @param {any} vendoredTable
 * @param {any} table
 * @returns {Finding[]}
 */
function upstreamDrift(live, vendoredTable, table) {
  /** @type {Finding[]} */
  const findings = [];

  const before = byId(vendoredTable);
  const after = byId(live);
  const carried = new Map(table.clients
    .filter((/** @type {any} */ client) => client.upstreamId !== null)
    .map((/** @type {any} */ client) => [client.upstreamId, client]));

  for (const id of after.keys()) {
    if (before.has(id)) continue;
    findings.push({
      kind: 'new-client',
      what: `Upstream has a client we have never seen: ${id}.`,
      action: 'Put it on the watch list. Install and verify it only if it runs on Linux and somebody has asked for it.',
    });
  }

  for (const id of before.keys()) {
    if (after.has(id)) continue;
    findings.push({
      kind: 'client-gone',
      what: `Upstream no longer lists ${id}${carried.has(id) ? ', and we carry it' : ''}.`,
      action: 'Check for a rename before assuming it is discontinued. Windsurf became Devin and block/goose became aaif-goose, and both were one HTTP request away.',
    });
  }

  for (const [id, row] of after) {
    const old = before.get(id);
    if (old === undefined) continue;

    for (const difference of compare(null, row, old)) {
      const ours = carried.get(id);
      findings.push({
        kind: 'upstream-field-changed',
        what: `${id}: ${difference.what}`,
        action: ours === undefined
          ? 'We do not carry this client. Note it and move on.'
          : ours.evidence === 'MACHINE' || ours.evidence === 'BINARY'
            ? 'We carry this and verified it against a real installation. Re-run the install-and-verify loop on a machine before changing our row.'
            : 'We carry this from documentation only. Update our row from the new documentation and keep it marked unverified.',
      });
    }
  }

  return findings;
}

/**
 * The fields both sides actually model, compared.
 *
 * Called two ways. With `client` it compares our row against an upstream row.
 * With `client` null it compares two upstream rows to each other, which needs
 * no translation at all.
 *
 * @param {any|null} client our row, or null
 * @param {any} upstreamRow
 * @param {any} [previous] the other upstream row, when comparing upstream to itself
 * @returns {{field: string, what: string}[]}
 */
function compare(client, upstreamRow, previous) {
  /** @type {{field: string, what: string}[]} */
  const differences = [];

  if (previous !== undefined) {
    if (previous.category !== upstreamRow.category) {
      differences.push({
        field: 'category',
        what: `category was "${previous.category}", now "${upstreamRow.category}".`,
      });
    }
    if ((previous.config?.rootKey ?? null) !== (upstreamRow.config?.rootKey ?? null)) {
      differences.push({
        field: 'rootKey',
        what: `root key was "${previous.config?.rootKey}", now "${upstreamRow.config?.rootKey}".`,
      });
    }
    if (previous.transports?.includes('stdio') && !upstreamRow.transports?.includes('stdio')) {
      differences.push({ field: 'transports', what: 'it no longer lists stdio, which would be a hard break.' });
    }
    for (const [, theirs] of PLATFORMS) {
      const was = normalise(previous.config?.paths?.[theirs]);
      const now = normalise(upstreamRow.config?.paths?.[theirs]);
      if (was !== now) {
        differences.push({ field: `path.${theirs}`, what: `${theirs} path was ${was ?? 'absent'}, now ${now ?? 'absent'}.` });
      }
    }
    return differences;
  }

  const ourCategory = client.write.method === 'cli' ? 'cli' : 'config';
  if (upstreamRow.category !== ourCategory && upstreamRow.category !== 'deeplink') {
    differences.push({
      field: 'category',
      what: `we write it as "${ourCategory}", upstream calls it "${upstreamRow.category}".`,
    });
  }

  const theirRoot = upstreamRow.config?.rootKey ?? null;
  if (theirRoot !== null && theirRoot !== client.rootKey) {
    differences.push({
      field: 'rootKey',
      what: `our root key is "${client.rootKey}", upstream says "${theirRoot}".`,
    });
  }

  if (upstreamRow.transports !== undefined && !upstreamRow.transports.includes('stdio')) {
    differences.push({ field: 'transports', what: 'upstream does not list stdio for it.' });
  }

  for (const [ours, theirs] of PLATFORMS) {
    const mine = normalise(client.configPaths[ours]);
    const other = normalise(upstreamRow.config?.paths?.[theirs]);
    if (other === null || mine === null) continue;
    if (mine !== other) {
      differences.push({
        field: `path.${theirs}`,
        what: `our ${theirs} path is ${mine}, upstream says ${other}.`,
      });
    }
  }

  return differences;
}

/**
 * Two spellings of the same place, made comparable.
 *
 * Upstream writes Windows paths from `%USERPROFILE%` with backslashes and we
 * write them from `~` or `%APPDATA%`. Normalising the separator and the home
 * token is enough to stop that being reported as a difference every week; the
 * roots that genuinely differ, like `%APPDATA%` against `%USERPROFILE%`, still
 * are.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function normalise(value) {
  if (value === null || value === undefined) return null;
  return value.replaceAll('%USERPROFILE%', '~').replaceAll('\\', '/');
}

/**
 * @param {any} parsed
 * @returns {Map<string, any>}
 */
function byId(parsed) {
  return new Map(parsed.clients.map((/** @type {any} */ row) => [row.id, row]));
}

/**
 * @param {string} text
 * @returns {string}
 */
export function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * @param {string} from an ISO date or an HTTP date
 * @param {string} to an ISO date
 * @returns {number}
 */
function daysBetween(from, to) {
  return Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Fetch upstream, or report that we could not.
 *
 * @param {string} url
 * @returns {Promise<{text: string, lastModified: string|null}|null>}
 */
export async function fetchUpstream(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;
    return { text: await response.text(), lastModified: response.headers.get('last-modified') };
  } catch {
    return null;
  }
}

/**
 * @param {{findings: Finding[], notes: string[], exitCode: number}} result
 * @returns {string}
 */
export function renderDrift(result) {
  const lines = [];

  for (const note of result.notes) lines.push(note, '');

  if (result.findings.length === 0) {
    lines.push('No drift. That is not the same as no change in the world — see the staleness note above.', '');
    return lines.join('\n');
  }

  lines.push(`${result.findings.length} thing${result.findings.length === 1 ? '' : 's'} to look at:`, '');
  for (const finding of result.findings) {
    lines.push(`  [${finding.kind}] ${finding.what}`, `    → ${finding.action}`, '');
  }

  lines.push('Nothing was changed. This job only ever asks questions.', '');
  return lines.join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'clients.meta.json'), 'utf8'));

  const result = checkDrift({
    upstream: await fetchUpstream(meta.source),
    vendored: fs.readFileSync(path.join(root, 'vendor', 'clients.json'), 'utf8'),
    meta,
    table: JSON.parse(fs.readFileSync(path.join(root, 'src', 'clients.json'), 'utf8')),
    today: new Date().toISOString().slice(0, 10),
  });

  process.stdout.write(renderDrift(result));
  process.exit(result.exitCode);
}
