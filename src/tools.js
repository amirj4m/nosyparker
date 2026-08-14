/**
 * The six tools.
 *
 * Each one reads its arguments, calls one function in the gate or the store,
 * and turns what comes back into something a person can read. There is no rule
 * in this file. Nothing here decides whether a memory may be stored, nothing
 * here writes to the database, and nothing here contains a line of SQL: every
 * decision goes through the gate exactly as the command line tool's does, and
 * gets the same transaction and the same row in the log.
 *
 * The explanations are the gate's own. A refusal shown to a person through an
 * agent says word for word what the same refusal says at the terminal, because
 * there is one set of sentences and this file does not own it.
 *
 * A tool is a name, a description, a schema and a function. Adding one is
 * adding one entry to the list below; nothing else knows how many there are,
 * which is how `restore` arrived without anything but this file changing.
 *
 * On the descriptions. MCP is pull-only: nothing here can make an agent look
 * something up before it answers, or write something down after it learns it.
 * The description is the whole of the influence available, so it is written to
 * be acted on — when to reach for this rather than that, and what a refusal
 * means, so that an agent told no does not try the same thing in a different
 * shape.
 */

import { forget, restore, submit } from './gate.js';
import { listDecisions, listMemories, searchMemories } from './store.js';
import { isBlank } from './text.js';

/**
 * @typedef {import('./store.js').Store} Store
 * @typedef {import('./store.js').Memory} Memory
 * @typedef {import('./store.js').Decision} Decision
 */

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} description written for the agent that has to decide whether to call it
 * @property {object} inputSchema JSON Schema, handed to the client as it is
 * @property {(store: Store, owner: string, args: Record<string, unknown>) => string} run
 */

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'remember',
    description: [
      'Store one fact about the person, in a file every agent on this machine reads.',
      '',
      'Call it as soon as you learn something about them that will still be true next',
      'week: how they want to be written to, what they use and why, a decision they',
      'have made, something they are working towards. One fact per call, in their own',
      'words where you have them, written so that an agent starting cold understands',
      'it. Do not store what is only true inside this conversation.',
      '',
      'Set `replaces` to the id of a memory this one supersedes, from `list` or',
      '`recall`. The old memory is retired rather than removed and can be brought',
      'back.',
      '',
      'An offer can be refused, and a refusal is the answer rather than an error to',
      'work around. Text recognised as a credential is not stored and is not written',
      'down anywhere, not even in the log, so do not offer it again reworded, encoded',
      'or split across calls — put it in a password manager instead. Empty text is',
      'refused. A fact already stored word for word is refused and the memory already',
      'held is left alone. Every call either way is recorded, and `why` reads that',
      'record back.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The fact to store, as one plain sentence.',
        },
        replaces: {
          type: 'integer',
          description: 'Id of the memory this one supersedes, if it supersedes one.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['text', 'replaces']);

      // Blank text is not checked here. The gate refuses it, and refusing it
      // here instead would be a decision taken with nothing written down.
      const text = readText(args, 'text', 'the fact to store');
      const replaces = args.replaces === undefined ? null : readId(args, 'replaces');

      return outcome(submit(store, { owner, text, replaces }));
    },
  },

  {
    name: 'recall',
    description: [
      'Search what is already known about the person.',
      '',
      'Call it before answering anything that turns on who they are — their',
      'preferences, their setup, their history, how they like something done — and',
      'before asking them something they may already have told an agent. They expect',
      'not to have to say it twice.',
      '',
      'It searches the full text of every memory being shown, in any language, and',
      'returns each match with its id. Words are looked for together rather than as',
      'a phrase, so "coffee morning" finds "coffee in the morning". Nothing that has',
      'been forgotten or replaced is returned; `why` has the record of those.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to look for. All of them have to appear.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['query']);

      const query = readText(args, 'query', 'what to look for');
      if (isBlank(query)) {
        return 'There was nothing to look for. Say what to search for.';
      }

      const found = searchMemories(store, owner, query);
      if (found.length === 0) return 'Nothing matched.';

      const heading = `${found.length} match${found.length === 1 ? '' : 'es'}:`;
      return [heading, '', ...found.map(asLine)].join('\n');
    },
  },

  {
    name: 'forget',
    description: [
      'Stop a memory being shown, and say why.',
      '',
      'This is not deletion. The memory stays in the file, leaves `list` and',
      '`recall`, keeps the reason given here, and can be brought back with `restore`.',
      'Nothing in this server removes anything: the only way a memory leaves the file',
      'is the person deleting it themselves.',
      '',
      'Use it when the person says something is wrong or no longer true and there is',
      'nothing to put in its place. When there is something to put in its place, use',
      '`remember` with `replaces` instead, so the old and the new are linked.',
      '',
      'The reason is kept and is shown to the person later, so write the sentence',
      'they would recognise rather than a word like "obsolete".',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          description: 'Id of the memory, from `list` or `recall`.',
        },
        reason: {
          type: 'string',
          description: "Why it should stop being shown, in the person's terms.",
        },
      },
      required: ['id', 'reason'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['id', 'reason']);

      const id = readId(args, 'id');
      const reason = readText(args, 'reason', 'why it should stop being shown');

      // A memory put away for no stated reason is a memory nobody can judge
      // later. The gate has nothing to say about a blank reason, so this is
      // refused before it becomes a decision, exactly as at the terminal.
      if (isBlank(reason)) {
        return 'No reason was given, so nothing was changed. Say why this should stop being shown.';
      }

      return outcome(forget(store, { owner, id, reason }));
    },
  },

  {
    name: 'restore',
    description: [
      'Show a memory again that was forgotten or replaced.',
      '',
      'The undo for `forget`. Reach for it the moment the person says the last thing',
      'was a mistake, or asks for something back that an agent put away. Nothing was',
      'lost when it was forgotten, and they should not have to leave the conversation',
      'and open a terminal to reverse something an agent did to their memory.',
      '',
      'The id comes from `why`, which names the memories that were forgotten and',
      'replaced. `list` and `recall` show only what is currently being shown, so the',
      'memory you are looking for will not be in either.',
      '',
      'If a newer memory had replaced this one, that newer memory stops claiming to',
      'have replaced it and both are shown from now on. Restoring something already',
      'being shown says so and changes nothing.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          description: 'Id of the memory to show again, from `why`.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['id']);

      return outcome(restore(store, { owner, id: readId(args, 'id') }));
    },
  },

  {
    name: 'list',
    description: [
      'Everything currently known about the person, oldest first, each with its id.',
      '',
      'Use it when you want the whole picture at once: before a task that turns on',
      'who they are, or when they ask what is known about them. For one specific',
      'question `recall` is the shorter road.',
      '',
      'What has been forgotten or replaced is not here. `why` has the record of it.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(store, owner, args) {
      only(args, []);

      const memories = listMemories(store, owner);
      if (memories.length === 0) return 'Nothing stored yet.';

      return memories.map(asLine).join('\n');
    },
  },

  {
    name: 'why',
    description: [
      'The record of every call ever made to this memory: what was offered, what',
      'became of it, and which rule decided. Oldest first, all of it, never',
      'shortened.',
      '',
      'Use it when the person asks why something is or is not remembered, or when an',
      'offer was refused and they want to know what happened.',
      '',
      'Text recognised as a credential appears here as the fact that it was',
      'recognised, never as the text. There is nothing to recover from this record;',
      'it says what was decided, not what was refused.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(store, owner, args) {
      only(args, []);

      const decisions = listDecisions(store, owner);
      if (decisions.length === 0) return 'Nothing has happened yet.';

      return decisions.map(asEntry).join('\n\n');
    },
  },
];

/**
 * What to say about a decision the gate has just taken.
 *
 * The sentence is the gate's, unchanged. The id is added when there is a
 * memory to point at, because the next call the agent makes is likely to need
 * it.
 *
 * @param {import('./gate.js').GateResult} result
 * @returns {string}
 */
function outcome(result) {
  if (result.memory_id !== null && result.verdict !== 'refused') {
    return `${result.explanation} (memory ${result.memory_id})`;
  }
  return result.explanation;
}

/**
 * @param {Memory} memory
 * @returns {string}
 */
function asLine(memory) {
  return `${memory.id}. ${memory.text}`;
}

/**
 * One entry of the log, laid out so a person can read down it.
 *
 * @param {Decision} decision
 * @returns {string}
 */
function asEntry(decision) {
  const lines = [`${decision.decided_at}  ${decision.verdict} (${decision.rule})`];

  if (decision.memory_id !== null) lines.push(`  memory: ${decision.memory_id}`);
  if (decision.related_memory_id !== null) {
    lines.push(`  other memory: ${decision.related_memory_id}`);
  }
  if (decision.input_excerpt !== '') lines.push(`  text: ${decision.input_excerpt}`);
  lines.push(`  ${decision.explanation}`);

  return lines.join('\n');
}

/**
 * Refuse an argument the tool does not take.
 *
 * A client that sends `list` a `limit` is asking for something this tool does
 * not do, and answering it with the whole list would tell the caller it had
 * been honoured. The schema says `additionalProperties: false` as well; that
 * is a statement to the client, and this is what happens when a client sends
 * one anyway.
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} allowed
 */
function only(args, allowed) {
  for (const name of Object.keys(args)) {
    if (allowed.includes(name)) continue;
    throw new Error(
      `This tool does not take an argument called "${name}", so nothing was done. ` +
        (allowed.length === 0
          ? 'It takes no arguments at all.'
          : `It takes ${sentenceList(allowed)}.`),
    );
  }
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @param {string} whatItIsFor
 * @returns {string}
 */
function readText(args, name, whatItIsFor) {
  const value = args[name];
  if (typeof value !== 'string') {
    throw new Error(
      `"${name}" has to be text saying ${whatItIsFor}, and this call gave ` +
        `${describe(value)}. Nothing was done.`,
    );
  }
  return value;
}

/**
 * Ids are read strictly. A memory id arriving as "3" rather than 3 is a caller
 * that has not read the schema, and guessing what it meant is how the wrong
 * memory gets retired.
 *
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @returns {number}
 */
function readId(args, name) {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `"${name}" has to be the id of a memory, which is a whole number above zero, ` +
        `and this call gave ${describe(value)}. Nothing was done. The ids are the ` +
        'numbers shown by list and recall.',
    );
  }
  return value;
}

/**
 * Name what arrived, without repeating it.
 *
 * Numbers and booleans are quoted back because seeing `0` is what tells the
 * caller which of its variables was empty. Text is not, because the text is
 * the caller's content and may be anything at all, including the sort of thing
 * that must not be echoed into a log or a transcript.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return 'text';
  if (Array.isArray(value)) return 'a list';
  return 'an object';
}

/**
 * @param {string[]} names
 * @returns {string}
 */
function sentenceList(names) {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
