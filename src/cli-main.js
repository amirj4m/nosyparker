/**
 * A thin command line tool, so the storage layer and the gate can be tried by
 * hand. It parses arguments, calls one function, and prints the result in
 * plain sentences. There is no logic here that is not about printing.
 *
 * Started through `cli.js`, which quietens one Node warning before anything
 * here loads `node:sqlite`. Run this file directly and the tool still works;
 * the only difference is the warning.
 */

import { defaultStorePath, systemClock } from './config.js';
import { forget, restore, submit } from './gate.js';
import { listDecisions, listMemories, openStore, searchMemories } from './store.js';

/** Phase 1 is one person on one machine, so there is one owner. */
const LOCAL_OWNER = 'local';

main(process.argv.slice(2));

/**
 * @param {string[]} argv
 */
function main(argv) {
  const [command, ...rest] = argv;

  if (!command) fail('No command was given.');

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
        runLog(store, rest);
        break;
      case 'forget':
        runForget(store, rest);
        break;
      case 'restore':
        runRestore(store, rest);
        break;
      default:
        fail(`There is no command called "${command}".`);
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
  const query = args.join(' ');
  if (query.trim() === '') fail('Say what to look for: nosyparker search "<query>"');

  const found = searchMemories(store, LOCAL_OWNER, query);
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
  refuseExtra('list', args);

  const memories = listMemories(store, LOCAL_OWNER);

  if (memories.length === 0) {
    process.stdout.write('Nothing stored yet.\n');
    return;
  }

  for (const memory of memories) process.stdout.write(formatMemory(memory));
}

/**
 * @param {import('./store.js').Store} store
 * @param {string[]} args
 */
function runLog(store, args) {
  refuseExtra('log', args);

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
  const [rawId, ...extra] = args;
  if (rawId === undefined) fail('Which one? nosyparker restore <id>');
  refuseExtra('restore', extra);

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
  // Only active memories reach here. What was replaced or forgotten is not
  // something this tool shows; the decision log is where that is read.
  return `${memory.id}. ${memory.text}\n`;
}

/**
 * Refuse what a command was not asked for.
 *
 * `list`, `log` and `restore` take a fixed number of arguments, and until now
 * they read the ones they wanted and dropped the rest on the floor. So
 * `list --all` printed the active memories and exited 0, and the person
 * reading it had every reason to believe they had been shown the forgotten
 * and replaced ones too. `--all` was taken out deliberately; accepting it
 * without a word is worse than refusing it.
 *
 * `add`, `search` and `forget` are not in this list on purpose. Everything
 * after their first argument is the text or the reason, so there is nothing
 * left over for them to ignore.
 *
 * @param {string} command
 * @param {string[]} extra
 */
function refuseExtra(command, extra) {
  if (extra.length > 0) fail(`"${command}" does not take ${extra[0]}.`);
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
