/**
 * The ten tools.
 *
 * Each one reads its arguments, calls one function in the gate or the store,
 * and turns what comes back into something a person can read. Nothing here
 * decides whether a memory may be stored, nothing here writes to the database,
 * and nothing here contains a line of SQL: every decision goes through the
 * gate exactly as the command line tool's does, and gets the same transaction
 * and the same row in the log.
 *
 * This used to claim there was no rule in the file at all, and that was not
 * true: a blank reason and a blank query were both refused here, outside the
 * gate, with nothing written down. The blank reason has moved to the gate,
 * where it is the `empty` rule and leaves its row, because refusing to put a
 * memory away is a decision about a memory.
 *
 * What is left here is worth being exact about, because it is more than
 * nothing. This file checks that arguments are the shape the schema says —
 * text where text is wanted, an id that could be an id, nothing extra. It
 * refuses a blank query, which is an answer to a caller rather than a
 * judgement about the store: nothing is stored, changed or even read, so there
 * is no row for the log to hold.
 *
 * Nothing else. The length limit was enforced here and moved to the gate, as
 * the credential screen on `recall` did before it, and both for the same
 * reason: a judgement about what a memory may be belongs where every caller
 * passes, not at whichever doors happen to exist today.
 *
 * The explanations are the gate's own wherever the gate has one, credentials
 * included. A refusal shown to a person through an agent says word for word
 * what the same refusal says at the terminal, because there is one set of
 * sentences and this file does not own them.
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
 *
 * The four review tools are the same shape as the other six and are worth one
 * more sentence, because their descriptions are carrying more than usual. They
 * are the only place an agent is told what a review may and may not conclude,
 * and the only place it is told that being unsure is an answer rather than a
 * failure. An agent that reads `review_finding` and comes away thinking it has
 * to pick a side has been told the wrong thing by this file.
 */

import {
  beginReview,
  closeReview,
  forget,
  restore,
  review,
  screenQuery,
  submit,
  undoReview,
} from './gate.js';
import { listDecisions, listMemories, searchMemories } from './store.js';
import { enumValue, isBlank } from './text.js';

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
      'held is left alone.',
      '',
      'Store facts, never files. Text longer than ten thousand characters is',
      'refused, and so is text that repeats itself the way a log, an export or a',
      'dump does, however short. If the person pastes a log and says something',
      'about it, the thing to store is the sentence — what the pattern is, when it',
      'happens, what to do about it — which you are the one who can work out. Read',
      'the file, keep the fact, and offer them that. Sending the file again will',
      'get the same answer. Ordinary writing of any reasonable length is fine:',
      'notes, a table, a list, source code all store without trouble.',
      '',
      'Every call either way is recorded, and `why` reads that record back.',
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
      'returns every match with its id — never a page of them. Words are looked for',
      'together rather than as a phrase, so "coffee morning" finds "coffee in the',
      'morning". Nothing that has been forgotten or replaced is returned; `why` has',
      'the record of those.',
      '',
      'Search for words, not for documents. A query is limited to',
      'a thousand characters.',
      '',
      'Never put a credential in a query. Text recognised as one is refused here',
      'exactly as it is by `remember`, the refusal is recorded, and searching for a',
      'secret will not find it because a secret was never stored.',
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

      // No limit passed. The store bounds the query, on the function that
      // would do the allocating, and says so in a sentence that comes back
      // through the same catch as everything else. One definition, one place
      // it is enforced, and every caller covered rather than this one.
      const query = readText(args, 'query', 'what to look for');
      if (isBlank(query)) {
        return 'There was nothing to look for. Say what to search for.';
      }

      // Screened by the gate, which also writes the row. `recall` answering
      // "Nothing matched" to a key was true, useless, and taught an agent
      // nothing — so the next thing it did was offer the same key to
      // `remember`. That refusal used to live here and left no trace, which
      // meant `why` showed a secret offered to one tool and not to another.
      const refused = screenQuery(store, { owner, query });
      if (refused) return refused.explanation;

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

  {
    name: 'review_start',
    description: [
      'Begin a review of what is stored, and get everything back with the date each',
      'memory was stored on.',
      '',
      'Use it when the person asks you to tidy up what is remembered about them, or',
      'when you notice while working that two memories disagree. It is not something',
      'to run on a schedule and nothing here will ask you to.',
      '',
      'The dates are why this tool exists rather than `list`. Some statements name a',
      'moment — "next month", "on Tuesday", "before the deadline", "until the end of',
      'the year" — and the date it was stored on is what lets you work out whether',
      'that moment has gone by. Nothing in this server does that for you and nothing',
      'in it ever will: no code here compares a date to today or concludes anything',
      'from one. It is your reading of the sentence, and the date is evidence you are',
      'handed.',
      '',
      'A statement that names no moment does not go stale. "They live in Tehran" is',
      'exactly as true after two years as the day it was stored, and age alone is',
      'never a reason to touch anything.',
      '',
      'Every finding names the review this returns. Close it with `review_end` when',
      'you have finished, and `review_undo` puts the whole thing back at once.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        reviewer: {
          type: 'string',
          description: 'Which agent you are, in a few words. It is kept with the review.',
        },
      },
      required: ['reviewer'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['reviewer']);

      const started = beginReview(store, {
        owner,
        reviewer: readText(args, 'reviewer', 'which agent you are'),
      });

      if (started.verdict === 'refused') return started.explanation;

      const memories = listMemories(store, owner);
      if (memories.length === 0) {
        return `${started.explanation} (review ${started.pass_id})\n\nNothing is stored yet, so there is nothing to review.`;
      }

      return [
        `${started.explanation} (review ${started.pass_id})`,
        '',
        `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}, oldest first, `
          + 'each with the date it was stored:',
        '',
        ...memories.map(asDatedLine),
      ].join('\n');
    },
  },

  {
    name: 'review_finding',
    description: [
      'Record what you concluded about one memory, and why.',
      '',
      'Three outcomes and no fourth:',
      '',
      '`overtaken` — it is no longer current and there is nothing to put in its place.',
      'A plan whose date has gone by, an arrangement that has ended. It stops being',
      'shown, keeps your reasoning, and can be brought back.',
      '',
      '`superseded` — another memory that is already stored says the same thing more',
      'recently. Give its id as `replaced_by`. The two are linked and the older one',
      'stops being shown.',
      '',
      '`could_not_tell` — you read it and you are not sure. Nothing changes and your',
      'reasoning is written down. This is a real answer, not a failure, and it is the',
      'right one whenever you are guessing. Two memories that contradict each other',
      'with nothing to say which came first is exactly this case. Do not pick one.',
      '',
      'What a review cannot do: it cannot forget anything and it cannot delete',
      'anything. Forgetting is the person saying they do not want something shown,',
      'and it is not a conclusion you may reach on their behalf. If you think',
      'something should go, say `could_not_tell` and tell them.',
      '',
      '`reasoning` is required and is the point. Somebody reads it later to judge',
      'whether you thought correctly, so write the actual argument — what the',
      'statement says, what the date tells you, what you compared it against — not a',
      'label like "stale". Never put age on its own in it: a memory being old is not',
      'a reason for anything.',
      '',
      '`derived_from` is required and is checked. List the ids of every memory you',
      'read to reach this, including the one being judged. A conclusion nothing was',
      'read to reach is refused.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        review: {
          type: 'integer',
          description: 'The review this finding belongs to, from `review_start`.',
        },
        id: {
          type: 'integer',
          description: 'The memory you are judging.',
        },
        outcome: {
          type: 'string',
          enum: ['overtaken', 'superseded', 'could_not_tell'],
          description: 'What you concluded.',
        },
        reasoning: {
          type: 'string',
          description: 'Why, in your own words, in enough detail to be judged later.',
        },
        derived_from: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Ids of every memory you read to reach this, the judged one included.',
        },
        replaced_by: {
          type: 'integer',
          description: 'For `superseded`: the id of the memory that replaces this one.',
        },
      },
      required: ['review', 'id', 'outcome', 'reasoning', 'derived_from'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['review', 'id', 'outcome', 'reasoning', 'derived_from', 'replaced_by']);

      // `could_not_tell` at the door and `could-not-tell` inside. The schema
      // reads better with underscores and the gate's vocabulary is hyphenated
      // throughout; translating here is one line, and making either give way to
      // the other would be a cosmetic change to something a test closes.
      const concluded = readText(args, 'outcome', 'what you concluded');
      if (concluded !== 'overtaken' && concluded !== 'superseded' && concluded !== 'could_not_tell') {
        throw new Error(
          '"outcome" has to be "overtaken", "superseded" or "could_not_tell", and this call '
            + `gave ${enumValue(concluded) ?? describe(concluded)}. Nothing was done.`,
        );
      }

      return outcome(
        review(store, {
          owner,
          pass: readId(args, 'review'),
          id: readId(args, 'id'),
          outcome: concluded === 'could_not_tell' ? 'could-not-tell' : concluded,
          reasoning: readText(args, 'reasoning', 'why you concluded it'),
          derivedFrom: readIds(args, 'derived_from'),
          replacedBy: args.replaced_by === undefined ? null : readId(args, 'replaced_by'),
        }),
      );
    },
  },

  {
    name: 'review_end',
    description: [
      'Close a review. It takes no more findings afterwards.',
      '',
      'Call it when you have finished walking the store, whether or not you changed',
      'anything. A review left open can be added to by anything holding its number,',
      'and the doctor command will keep telling the person it is there.',
      '',
      'It can still be undone after it is closed, which is usually when somebody',
      'reads what it did and decides otherwise.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        review: {
          type: 'integer',
          description: 'The review to close, from `review_start`.',
        },
      },
      required: ['review'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['review']);
      return closeReview(store, { owner, pass: readId(args, 'review') }).explanation;
    },
  },

  {
    name: 'review_undo',
    description: [
      'Put back everything one review changed, all at once.',
      '',
      'Reach for it the moment the person says a review got something wrong. They',
      'should not have to undo an agent\'s work one memory at a time, and they should',
      'not have to open a terminal to undo it at all.',
      '',
      'It puts back every memory the review moved, in one go. Anything that has',
      'changed since — because the person did something to it themselves, or a later',
      'review did — is left exactly alone and named in the answer, because undoing',
      'this review must not undo somebody else\'s decision.',
      '',
      'A review can be undone once. `why` has the number of every review and',
      'everything each one concluded, with the reasoning.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        review: {
          type: 'integer',
          description: 'The review to undo. `why` names it against every finding.',
        },
      },
      required: ['review'],
      additionalProperties: false,
    },
    run(store, owner, args) {
      only(args, ['review']);
      return undoReview(store, { owner, pass: readId(args, 'review') }).explanation;
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
 * The same line with the date it was stored on in front of the text.
 *
 * Only the review sees this. `list` and `recall` answer "what is known about
 * this person", and a date on every line there is noise in front of the answer;
 * the review is the one caller for which the date is half the evidence.
 *
 * The whole timestamp, not just the day. A reviewer working out whether "this
 * afternoon" has passed needs the hour, and rounding it away here to make the
 * lines shorter would be this file deciding how much of the evidence the agent
 * is allowed.
 *
 * @param {Memory} memory
 * @returns {string}
 */
function asDatedLine(memory) {
  return `${memory.id}. [stored ${memory.created_at}] ${memory.text}`;
}

/**
 * One entry of the log, laid out so a person can read down it.
 *
 * @param {Decision} decision
 * @returns {string}
 */
function asEntry(decision) {
  const lines = [`${decision.decided_at}  ${decision.verdict} (${decision.rule})`];

  if (decision.pass_id !== null) lines.push(`  review: ${decision.pass_id}`);
  if (decision.memory_id !== null) lines.push(`  memory: ${decision.memory_id}`);
  if (decision.related_memory_id !== null) {
    lines.push(`  other memory: ${decision.related_memory_id}`);
  }
  if (decision.input_excerpt !== '') lines.push(`  text: ${decision.input_excerpt}`);

  // The reviewer's own account, shown as its own line rather than folded into
  // the explanation. They are two different sentences by two different authors
  // and running them together would leave a person unable to tell which of them
  // was the agent's thinking and which was this program's.
  if (decision.derived_from !== null) lines.push(`  read: ${decision.derived_from}`);
  if (decision.reasoning !== null) lines.push(`  reviewer said: ${decision.reasoning}`);

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

  // isSafeInteger, not isInteger. 1e308 is an integer as far as isInteger is
  // concerned — it has nothing after the decimal point — so it was accepted,
  // reached the store, was bound as a REAL because that is what node:sqlite
  // does with a number, matched nothing, and came back as "memory 1e+308 is
  // not one of your active memories". That sentence was then written into the
  // decision log, where it will sit for good, and it names something that is
  // not an id and never could have been one.
  //
  // Anything past 2^53 is not an id either: it cannot be told apart from its
  // neighbours once it is a double, so there is no honest answer to give
  // about it.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `"${name}" has to be the id of a memory, which is a whole number above zero, ` +
        `and this call gave ${describe(value)}. Nothing was done. The ids are the ` +
        'numbers shown against each memory by list, recall and why.',
    );
  }
  return value;
}

/**
 * A list of ids, read as strictly as one id is.
 *
 * Every element goes through the same check a single id does, and one bad
 * element refuses the whole list rather than being dropped. A derivation record
 * with an entry quietly removed from it is worse than no record: it would say
 * the review read four memories when it named five, and nothing downstream
 * could tell.
 *
 * @param {Record<string, unknown>} args
 * @param {string} name
 * @returns {number[]}
 */
function readIds(args, name) {
  const value = args[name];
  if (!Array.isArray(value)) {
    throw new Error(
      `"${name}" has to be a list of memory ids, and this call gave ${describe(value)}. ` +
        'Nothing was done.',
    );
  }

  return value.map((_, index) => readId({ [name]: value[index] }, name));
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
