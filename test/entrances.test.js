/**
 * Every way into the store, listed.
 *
 * The Phase 2 reviewer's recommendation, and the most useful thing in that
 * review. The rule this project keeps having to relearn is that a bound put at
 * the entrances is a bound that a new entrance walks past — it has happened
 * three times now, twice with the length limit and once with a check that lived
 * in an adapter rather than in the gate. Each time the new entrance was correct
 * code that nobody thought to check against a rule written down somewhere else,
 * and each time it was caught by a person reading a diff.
 *
 * A person reading a diff is not a mechanism. This is: the list below is every
 * module that can reach `store.js` or `gate.js`, directly or through anything
 * else, and a module that joins it fails a test.
 *
 * It matters most for the modules that write to files other programs own. None
 * of them may touch the store — including the action log, which is the newest
 * and the one most likely to be mistaken for a caller. It writes a file beside
 * the store and has nothing to do with it: the decision log inside `store.js`
 * is about memories and is written through the gate, and this is about paths on
 * disk. Different subject, different file, and neither reads the other. If one ever needs to —
 * if setup ever records something about what it did — this test fails, and the
 * fix is to go through `gate.submit` and add the module here, in that order.
 *
 * This is the same shape as the gate's vocabulary test and it was verified the
 * same way: by making the mutation it exists to catch and watching it fail.
 * Adding a single import of `store.js` to `setup.js` fails this test with the
 * new entrance named.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every module that can reach the store, however many hops it takes.
 *
 * Written out rather than counted, and written out in full rather than as a
 * prefix or a pattern, for the reason the gate's vocabulary test gives: a
 * check loosened to a count or a subset stops being a check the first time
 * somebody adds something that fits the pattern.
 */
const ENTRANCES = [
  'src/cli-main.js',
  'src/cli.js',
  'src/doctor.js',
  'src/gate.js',
  'src/mcp-main.js',
  'src/mcp-server.js',
  'src/tools.js',
  'scripts/purge-main.mjs',
  'scripts/purge.mjs',
];

/**
 * The modules Phase 3 added, none of which may be on that list.
 *
 * Naming them separately is not redundant with the list above. The list says
 * what does reach the store; this says what must not, so that a module deleted
 * from the codebase cannot quietly satisfy the first assertion by not existing.
 *
 * `doctor.js` was on this list and moved to the other one in Phase 4, which is
 * the first time anything has crossed. It reads the store: whether the file
 * opens under this version at all, and whether a review was left open. Both are
 * things a person runs that command to find out, and neither can be answered
 * without looking. It writes nothing to the store, and it does not open the
 * file if it is not already there — asking after somebody's memories must not
 * be what creates them.
 *
 * The rest stay where they are, and the action log is still the one most likely
 * to be mistaken for a caller. Review activity is recorded in the decision log
 * inside `store.js`, where every other decision about a memory goes, and not in
 * the action log, which is about paths on disk.
 */
const PHASE_3 = [
  'src/backup.js',
  'src/clients.js',
  'src/detect.js',
  'src/documentation.js',
  'src/edit.js',
  'src/log.js',
  'src/setup.js',
  'src/verify.js',
  'src/write.js',
  'scripts/drift.mjs',
];

test('every way into the store is one of these, and there are no others', () => {
  const graph = importGraph();
  // `store.js` is the thing, not a way to it. `gate.js` stays on the list: it
  // is the one module every other one is supposed to go through, and leaving
  // it off would make the list read as though nothing reached the store
  // directly except by accident.
  const reaching = [...reachers(graph, ['src/store.js', 'src/gate.js'])]
    .filter((file) => file !== 'src/store.js');

  assert.deepEqual(reaching.sort(), [...ENTRANCES].sort());
});

test('nothing that writes to another program\'s files can reach the store, and all of it is still here', () => {
  const graph = importGraph();
  const reaching = reachers(graph, ['src/store.js', 'src/gate.js']);

  for (const file of PHASE_3) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is gone, so this test is not checking it`);
    assert.equal(reaching.has(file), false,
      `${file} now reaches the store. Everything that produces text a store will hold goes through gate.submit — add it there first, then add it to ENTRANCES.`);
  }
});

test('the walk follows a dynamic import two hops from the store', () => {
  // This is the test's own mutation check. `src/cli.js` reaches the store only
  // through `await import('./cli-main.js')`, which is not a static import and
  // does not appear in any import statement. A walker that quietly stopped
  // resolving those would report a shorter, cleaner, wrong list — and the
  // assertion above would still pass if this one did not exist, because a
  // missing entrance looks exactly like an entrance that was never there.
  const graph = importGraph();

  assert.ok(graph.get('src/cli.js')?.includes('src/cli-main.js'), 'the dynamic import is an edge');
  assert.equal(graph.get('src/cli.js')?.includes('src/store.js'), false, 'and it is not a direct one');
  assert.equal(reachers(graph, ['src/store.js']).has('src/cli.js'), true);
});

test('a type annotation mentioning the store is not a way into it', () => {
  // Several modules carry `{import('./store.js').Store}` in a doc comment.
  // Counting those as edges would put half the codebase on the list and the
  // list would stop meaning anything.
  const graph = importGraph();

  assert.ok(
    fs.readFileSync(path.join(ROOT, 'src/setup.js'), 'utf8').includes("import('./detect.js')"),
    'setup.js does carry type annotations of that shape',
  );
  assert.equal(graph.get('src/setup.js')?.includes('src/store.js'), false);
});

/**
 * Which files import which, as repository-relative paths.
 *
 * @returns {Map<string, string[]>}
 */
function importGraph() {
  /** @type {Map<string, string[]>} */
  const graph = new Map();

  for (const file of sourceFiles()) {
    const source = withoutBlockComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    /** @type {string[]} */
    const edges = [];

    for (const pattern of [
      /\bfrom\s+['"]([^'"]+)['"]/gu,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
      /\bimport\s+['"]([^'"]+)['"]/gu,
    ]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        edges.push(path.relative(ROOT, path.resolve(ROOT, path.dirname(file), specifier)));
      }
    }

    graph.set(file, edges);
  }

  return graph;
}

/**
 * Everything that can get to one of these, following edges as far as they go.
 *
 * @param {Map<string, string[]>} graph
 * @param {string[]} targets
 * @returns {Set<string>}
 */
function reachers(graph, targets) {
  const found = new Set(targets);

  for (let changed = true; changed;) {
    changed = false;
    for (const [file, edges] of graph) {
      if (found.has(file)) continue;
      if (edges.some((edge) => found.has(edge))) {
        found.add(file);
        changed = true;
      }
    }
  }

  return found;
}

/**
 * @returns {string[]}
 */
function sourceFiles() {
  /** @type {string[]} */
  const files = [];

  for (const dir of ['src', 'scripts']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js') || name.endsWith('.mjs')) files.push(`${dir}/${name}`);
    }
  }

  return files;
}

/**
 * Doc comments removed, so a type annotation is not read as an import.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutBlockComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
}
