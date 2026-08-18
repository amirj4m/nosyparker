/**
 * Which file imports which, and what that lets you work out.
 *
 * This was inside `entrances.test.js` and is here because a second test needs
 * it, and needed it for a reason worth writing down. The date guard in
 * `review.test.js` used to carry its own hand-written list of the modules near
 * a memory. `doctor.js` joined the entrances in Phase 4 and was not added to
 * that list — in the same commit whose test says "if a module joins that one it
 * joins this one, in the same commit, for the same reason". Two lists kept by
 * hand had drifted apart inside the change that promised they would not.
 *
 * So there is one list now and nobody keeps it. `entrances.test.js` still holds
 * a written-out list, on purpose: that test exists to compare a list a person
 * accepted against what the code actually does, and deriving both sides of a
 * comparison from the same place would leave it comparing nothing. Everything
 * else derives.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Which files import which, as repository-relative paths.
 *
 * @returns {Map<string, string[]>}
 */
export function importGraph() {
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
export function reachers(graph, targets) {
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
 * Everything these can get to, which is the other direction.
 *
 * @param {Map<string, string[]>} graph
 * @param {string[]} roots
 * @returns {Set<string>}
 */
export function reached(graph, roots) {
  const found = new Set(roots);
  const queue = [...roots];

  while (queue.length > 0) {
    for (const edge of graph.get(/** @type {string} */ (queue.pop())) ?? []) {
      if (found.has(edge)) continue;
      found.add(edge);
      queue.push(edge);
    }
  }

  return found;
}

/**
 * Every module on the path a memory takes, in both directions from the store.
 *
 * Up: everything that can reach `store.js`, which is the entrances — the CLI,
 * the tools, the MCP server, the purge scripts, and since Phase 4 `doctor.js`.
 * Down: everything `store.js` and `gate.js` themselves call, which is where a
 * rule about a memory could be hidden one level below the gate.
 *
 * It is deliberately not "the whole codebase". `log.js` stamps the action log
 * with a real clock and is right to; `setup.js` does the same. Neither can
 * reach a memory and neither is reached from one, so neither is here. The set
 * is the answer to "where would a decision about a memory have to live", and
 * that is a question the import graph answers rather than a person.
 *
 * @param {Map<string, string[]>} [graph]
 * @returns {string[]} sorted, so a failure reads the same way twice
 */
export function onTheMemoryPath(graph = importGraph()) {
  const roots = ['src/store.js', 'src/gate.js'];
  return [...new Set([...reachers(graph, roots), ...reached(graph, roots)])].sort();
}

/**
 * @returns {string[]}
 */
export function sourceFiles() {
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
export function withoutBlockComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
}
