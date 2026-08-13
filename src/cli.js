#!/usr/bin/env node
/**
 * A thin command line tool, so the storage layer and the gate can be tried by
 * hand. It parses arguments, calls one function, and prints the result in
 * plain sentences. There is no logic here that is not about printing.
 */

import { LOCAL_OWNER, defaultStorePath, systemClock } from './config.js';
import { forget, restore, submit } from './gate.js';
import { listDecisions, listMemories, openStore, searchMemories } from './store.js';

const USAGE = `nosyparker

  nosyparker add "<text>" [--replaces <id>]   store a sentence
  nosyparker search "<query>" [--all]         find stored sentences
  nosyparker list [--all]                     show what is currently active
  nosyparker log                              show every decision ever made
  nosyparker forget <id> "<reason>"           stop showing a memory
  nosyparker restore <id>                     show it again

  --all also shows memories that were replaced or forgotten.

The store is at ${defaultStorePath()}
`;

main(process.argv.slice(2));

/**
 * @param {string[]} argv
 */
function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const store = openStore({ file: defaultStorePath(), now: systemClock });

  try {
    switch (command) {
      case 'add':
        runAdd(store, rest);
        break;
      case 'search':
        runSearch(store, rest);
        break;
      case 'list':
        runList(store, rest);
        break;
      case 'log':
        runLog(store);
        break;
      case 'forget':
        runForget(store, rest);
        break;
      case 'restore':
        runRestore(store, rest);
        break;
      default:
        fail(`There is no command called "${command}".\n\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

/**
 * @param {import('./store.js').Store} store
 * @param {string[]} args
 */
function runAdd(store, args) {
  /** @type {number|null} */
  let replaces = null;
  /** @type {string[]} */
  const words = [];

  // Walked once from the front, so that a flag given twice is noticed rather
  // than half removed. Removing arguments by index after the fact went wrong
  // the moment there were two of them.
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--replaces') {
      words.push(args[index]);
      continue;
    }

    if (replaces !== null) fail('--replaces was given more than once. Give it once.');

    const raw = args[index + 1];
    if (raw === undefined) fail('--replaces needs the id of the memory being replaced.');
    replaces = toId(raw);
    index += 1;
  }

  const text = words.join(' ');
  if (words.length === 0) fail('Say what you want to store: nosyparker add "<text>"');

  const result = submit(store, { owner: LOCAL_OWNER, text, replaces });
  printOutcome(result);
}

/**
 * @param {import('./store.js').Store} store
 * @param {string[]} args
 */
function runSearch(store, args) {
  const includeArchived = args.includes('--all');
  const query = args.filter((arg) => arg !== '--all').join(' ');
  if (query.trim() === '') fail('Say what to look for: nosyparker search "<query>"');

  const found = searchMemories(store, LOCAL_OWNER, query, { includeArchived });
  if (found.length === 0) {
    process.stdout.write('Nothing matched.\n');
    return;
  }

  process.stdout.write(`${found.length} match${found.length === 1 ? '' : 'es'}:\n\n`);
  for (const memory of found) process.stdout.write(formatMemory(memory));
}

/**
 * @param {import('./store.js').Store} store
 * @param {string[]} args
 */
function runList(store, args) {
  const includeArchived = args.includes('--all');
  const memories = listMemories(store, LOCAL_OWNER, { includeArchived });

  if (memories.length === 0) {
    process.stdout.write('Nothing stored yet.\n');
    return;
  }

  for (const memory of memories) process.stdout.write(formatMemory(memory));
}

/**
 * @param {import('./store.js').Store} store
 */
function runLog(store) {
  const decisions = listDecisions(store, LOCAL_OWNER);

  if (decisions.length === 0) {
    process.stdout.write('Nothing has happened yet.\n');
    return;
  }

  for (const decision of decisions) {
    process.stdout.write(`${decision.decided_at}  ${decision.verdict} (${decision.rule})\n`);
    if (decision.memory_id !== null) {
      process.stdout.write(`  memory: ${decision.memory_id}\n`);
    }
    if (decision.related_memory_id !== null) {
      process.stdout.write(`  other memory: ${decision.related_memory_id}\n`);
    }
    if (decision.input_excerpt !== '') {
      process.stdout.write(`  text: ${decision.input_excerpt}\n`);
    }
    process.stdout.write(`  ${decision.explanation}\n\n`);
  }
}

/**
 * @param {import('./store.js').Store} store
 * @param {string[]} args
 */
function runForget(store, args) {
  const [rawId, ...reasonParts] = args;
  if (rawId === undefined) fail('Which one? nosyparker forget <id> "<reason>"');

  const reason = reasonParts.join(' ');
  if (reason.trim() === '') fail('Say why: nosyparker forget <id> "<reason>"');

  printOutcome(forget(store, { owner: LOCAL_OWNER, id: toId(rawId), reason }));
}

/**
 * @param {import('./store.js').Store} store
 * @param {string[]} args
 */
function runRestore(store, args) {
  const [rawId] = args;
  if (rawId === undefined) fail('Which one? nosyparker restore <id>');

  printOutcome(restore(store, { owner: LOCAL_OWNER, id: toId(rawId) }));
}

/**
 * @param {import('./gate.js').GateResult} result
 */
function printOutcome(result) {
  if (result.memory_id !== null && result.verdict !== 'refused') {
    process.stdout.write(`${result.explanation} (memory ${result.memory_id})\n`);
  } else {
    process.stdout.write(`${result.explanation}\n`);
  }
}

/**
 * @param {import('./store.js').Memory} memory
 * @returns {string}
 */
function formatMemory(memory) {
  const lines = [`${memory.id}. ${memory.text}`];

  if (memory.state !== 'active') {
    const reason = memory.state_reason ? `: ${memory.state_reason}` : '';
    lines.push(`   [${memory.state}${reason}]`);
  }

  return lines.join('\n') + '\n';
}

/**
 * @param {string} raw
 * @returns {number}
 */
function toId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) fail(`"${raw}" is not a memory id.`);
  return id;
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(1);
}
