/**
 * The drift watcher.
 *
 * Nothing here reaches the network. Upstream is a string the test writes, which
 * is the only way to test the case that matters most — upstream having gone
 * quiet for three months — without waiting three months.
 *
 * The last test in this file is the one that would catch the watcher being
 * turned into a rubber stamp: it runs against the real vendored copy and the
 * real table and asserts silence, so the four divergences that are deliberate
 * stay recorded with their reasons and a fifth one cannot appear unnoticed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { checkDrift, hash, renderDrift, STALE_AFTER_DAYS } from '../scripts/drift.mjs';

const TABLE = JSON.parse(fs.readFileSync(new URL('../src/clients.json', import.meta.url), 'utf8'));
const VENDORED = fs.readFileSync(new URL('../vendor/clients.json', import.meta.url), 'utf8');
const META = JSON.parse(fs.readFileSync(new URL('../vendor/clients.meta.json', import.meta.url), 'utf8'));

/**
 * A tiny upstream table, so a test can say what changed in one line.
 *
 * @param {any[]} clients
 * @returns {string}
 */
function upstreamOf(clients) {
  return JSON.stringify({ name: 'clients', version: '1.0.0', clients });
}

const CURSOR = {
  id: 'cursor',
  name: 'Cursor',
  category: 'deeplink',
  transports: ['stdio'],
  config: { format: 'json', rootKey: 'mcpServers', paths: { linux: '~/.cursor/mcp.json' } },
};

/**
 * @param {object} shape
 * @returns {any}
 */
function run(shape) {
  return checkDrift({
    upstream: null,
    vendored: upstreamOf([CURSOR]),
    meta: { acceptedDivergences: [], contentLastChanged: '2026-08-01', source: 'x' },
    table: { clients: [] },
    today: '2026-08-17',
    ...shape,
  });
}

test('a network failure is not a build failure', () => {
  const result = run({ upstream: null });

  assert.equal(result.exitCode, 0);
  assert.match(result.notes.join(' '), /could not be fetched/u);
  assert.match(result.notes.join(' '), /not a failure of this repository/u);
});

test('upstream unchanged and recently modified is silence', () => {
  const vendored = upstreamOf([CURSOR]);
  const result = run({
    vendored,
    upstream: { text: vendored, lastModified: '2026-08-01' },
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.exitCode, 0);
});

test('upstream gone quiet for ninety days fails the job, which is the point', () => {
  // A clean diff proves only that upstream has not changed. `clients.json` has
  // no lastUpdated field of any kind, so if it were abandoned tomorrow this job
  // would go quiet at exactly the moment we would want noise. The clock is what
  // turns that silence into a signal.
  const vendored = upstreamOf([CURSOR]);
  const result = run({
    vendored,
    upstream: { text: vendored, lastModified: '2026-01-01' },
    today: '2026-08-17',
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.findings[0].kind, 'stale');
  assert.match(result.findings[0].what, new RegExp(`not changed in \\d+ days`, 'u'));
  assert.match(result.findings[0].action, /Re-verify the tier 1 clients by hand/u);
});

test('the staleness clock is ninety days and is not a round number by accident', () => {
  const vendored = upstreamOf([CURSOR]);
  const justInside = run({
    vendored,
    upstream: { text: vendored, lastModified: '2026-05-20' },
    today: '2026-08-17',
  });
  assert.equal(justInside.findings.filter((/** @type {any} */ f) => f.kind === 'stale').length, 0);

  assert.equal(STALE_AFTER_DAYS, 90);
});

test('a new client upstream is a question, not a change', () => {
  const result = run({
    upstream: { text: upstreamOf([CURSOR, { id: 'brand-new-editor', category: 'config' }]), lastModified: '2026-08-16' },
  });

  const found = result.findings.find((/** @type {any} */ f) => f.kind === 'new-client');
  assert.match(found.what, /brand-new-editor/u);
  assert.match(found.action, /watch list/u);
});

test('a client vanishing upstream points at a rename before a funeral', () => {
  const result = run({
    upstream: { text: upstreamOf([]), lastModified: '2026-08-16' },
  });

  const found = result.findings.find((/** @type {any} */ f) => f.kind === 'client-gone');
  assert.match(found.what, /cursor/u);
  assert.match(found.action, /Windsurf became Devin/u);
});

test('a path changing upstream for a client we verified says re-run the loop', () => {
  const moved = { ...CURSOR, config: { ...CURSOR.config, paths: { linux: '~/.config/cursor/mcp.json' } } };

  const result = run({
    upstream: { text: upstreamOf([moved]), lastModified: '2026-08-16' },
    table: {
      clients: [{
        id: 'cursor', upstreamId: 'cursor', evidence: 'BINARY', rootKey: 'mcpServers',
        write: { method: 'cli' }, configPaths: { linux: '~/.cursor/mcp.json', darwin: null, win32: null },
      }],
    },
    meta: { acceptedDivergences: [], contentLastChanged: '2026-08-01', source: 'x' },
  });

  const found = result.findings.find((/** @type {any} */ f) => f.kind === 'upstream-field-changed');
  assert.match(found.what, /linux path was ~\/.cursor\/mcp.json, now ~\/.config\/cursor\/mcp.json/u);
  assert.match(found.action, /Re-run the install-and-verify loop on a machine/u);
});

test('the same change for a client we only read about says update the row cheaply', () => {
  const moved = { ...CURSOR, id: 'warp', config: { ...CURSOR.config, paths: { linux: '~/.warp/mcp.json' } } };
  const vendored = upstreamOf([{ ...CURSOR, id: 'warp', config: { ...CURSOR.config, paths: { linux: '~/.warp/.mcp.json' } } }]);

  const result = run({
    vendored,
    upstream: { text: upstreamOf([moved]), lastModified: '2026-08-16' },
    table: {
      clients: [{
        id: 'warp', upstreamId: 'warp', evidence: 'DOCS', rootKey: 'mcpServers',
        write: { method: 'file' }, configPaths: { linux: '~/.warp/.mcp.json', darwin: null, win32: null },
      }],
    },
    meta: { acceptedDivergences: [], contentLastChanged: '2026-08-01', source: 'x' },
  });

  const found = result.findings.find((/** @type {any} */ f) => f.kind === 'upstream-field-changed');
  assert.match(found.action, /keep it marked unverified/u);
});

test('a client dropping stdio is called what it is', () => {
  const noStdio = { ...CURSOR, transports: ['http'] };

  const result = run({
    upstream: { text: upstreamOf([noStdio]), lastModified: '2026-08-16' },
  });

  assert.match(
    result.findings.map((/** @type {any} */ f) => f.what).join(' '),
    /no longer lists stdio, which would be a hard break/u,
  );
});

test('our table drifting from the reviewed baseline is caught with no network at all', () => {
  const result = run({
    upstream: null,
    table: {
      clients: [{
        id: 'cursor', upstreamId: 'cursor', evidence: 'BINARY', rootKey: 'servers',
        write: { method: 'cli' }, configPaths: { linux: '~/.cursor/mcp.json', darwin: null, win32: null },
      }],
    },
  });

  assert.equal(result.exitCode, 1);
  const found = result.findings.find((/** @type {any} */ f) => f.kind === 'we-differ');
  assert.match(found.what, /our root key is "servers", upstream says "mcpServers"/u);
  assert.match(found.action, /Our verified row wins/u);
});

test('a divergence somebody wrote down a reason for is silence', () => {
  const result = run({
    upstream: null,
    table: {
      clients: [{
        id: 'cursor', upstreamId: 'cursor', evidence: 'BINARY', rootKey: 'servers',
        write: { method: 'cli' }, configPaths: { linux: '~/.cursor/mcp.json', darwin: null, win32: null },
      }],
    },
    meta: {
      acceptedDivergences: [{ id: 'cursor:rootKey', reason: 'measured on a real install', acceptedOn: '2026-08-17' }],
      contentLastChanged: '2026-08-01',
      source: 'x',
    },
  });

  assert.deepEqual(result.findings, []);
});

test('a client we carry that upstream has never heard of is not compared at all', () => {
  // Kimi Code is not in clients.json. A watcher that treated absence as a
  // finding would report it every week for ever.
  const result = run({
    upstream: null,
    table: { clients: [{ id: 'kimi-code', upstreamId: null }] },
  });

  assert.deepEqual(result.findings, []);
});

test('Windows paths spelled two different ways are the same path', () => {
  const windows = {
    ...CURSOR,
    config: { ...CURSOR.config, paths: { windows: '%USERPROFILE%\\.cursor\\mcp.json' } },
  };

  const result = run({
    upstream: null,
    vendored: upstreamOf([windows]),
    table: {
      clients: [{
        id: 'cursor', upstreamId: 'cursor', evidence: 'BINARY', rootKey: 'mcpServers',
        write: { method: 'cli' }, configPaths: { linux: null, darwin: null, win32: '~/.cursor/mcp.json' },
      }],
    },
  });

  assert.deepEqual(result.findings, []);
});

test('the report says outright that nothing was changed', () => {
  const rendered = renderDrift(run({ upstream: null, table: { clients: [{ id: 'x', upstreamId: 'nope' }] } }));

  assert.match(rendered, /Nothing was changed\. This job only ever asks questions\./u);
});

test('the vendored copy is the one the meta file says it is', () => {
  assert.equal(hash(VENDORED), META.sha256);
  assert.equal(JSON.parse(VENDORED).clients.length, 26);
});

test('the real table against the real baseline is silent, and every difference has a reason', () => {
  // The four accepted divergences are the four things the research went and
  // found out. Gemini's install command that writes nothing, and Devin's
  // category, root key and path — the surface every published document
  // describes being the dormant one. If a fifth appears, somebody edited the
  // table without re-vendoring and this fails.
  const result = checkDrift({
    upstream: null,
    vendored: VENDORED,
    meta: META,
    table: TABLE,
    today: '2026-08-17',
  });

  assert.deepEqual(result.findings, []);

  assert.deepEqual(
    META.acceptedDivergences.map((/** @type {any} */ row) => row.id).sort(),
    ['devin-desktop:category', 'devin-desktop:path.linux', 'devin-desktop:rootKey', 'gemini-cli:category'],
  );

  for (const divergence of META.acceptedDivergences) {
    assert.ok(divergence.reason.length > 80, `${divergence.id} needs a reason, not a note`);
    assert.match(divergence.acceptedOn, /^\d{4}-\d{2}-\d{2}$/u);
  }
});
