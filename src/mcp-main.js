/**
 * The MCP server.
 *
 * It opens the same store the command line tool opens, hands the client the
 * list of tools, and passes each call to the one function that runs it. That
 * is the whole of it. Every rule about what may be stored, and every guarantee
 * about how it is written down, is behind the gate and is not restated here.
 *
 * Started through `mcp-server.js`, which quietens one Node warning before
 * anything here loads `node:sqlite`.
 *
 * Two things about stdio are worth saying out loud, because getting either
 * wrong breaks the protocol rather than a feature. Nothing in this process may
 * write to stdout except the transport: a stray line of output is a parse
 * error at the other end and the client drops the connection. And nothing may
 * throw out of a tool call: the answer to a bad argument or an unknown id is a
 * sentence handed back to the agent, not a dead server.
 *
 * There is one store, opened once and held for the life of the process. That
 * is not a shortcut. Several agents run several of these at the same time
 * against the same file, which is the whole point of the product, and the
 * store is built for exactly that: WAL, a busy timeout, and every decision
 * taken inside the write lock that commits it.
 */

import fs from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { defaultStorePath, LOCAL_OWNER, systemClock } from './config.js';
import { openStore } from './store.js';
import { TOOLS } from './tools.js';

// Read rather than written down twice, so the version an agent is told about
// is the version in package.json and cannot drift from it.
const { version } = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * What the agent is told once, when it connects.
 *
 * This and the six tool descriptions are the only influence available. MCP is
 * pull-only: nothing here can make an agent look something up before it
 * answers or write something down after it learns it, and there is no hook
 * that fires on either. The difference between this and a description is
 * scope. A description is read when an agent is already considering that one
 * tool; this is read before it is considering anything, and it is the only
 * place to say what is true of all six at once.
 *
 * So it says the things no single tool can: that the memory is shared with
 * agents this one will never meet, that being uninformed is the normal state
 * here rather than a sign there is nothing to find, and that a refused
 * credential is the design working. What each tool does is left to each tool.
 *
 * It is short because a model reads it on every connection, and because a page
 * of instruction is read as boilerplate and skimmed. Everything in it has to
 * be true of what is built today; there is nothing here about later phases,
 * and if a claim in it ever stops being true it is a bug in the same way a
 * wrong sentence in a refusal is.
 *
 * Whether a client shows this to the model at all is the client's decision and
 * not ours. Some inject it, some ignore it. It is worth writing well anyway,
 * and it is not worth relying on.
 */
const INSTRUCTIONS = [
  'nosyparker is where the person using this machine keeps what they want agents',
  'to know about them. It is one file on their computer, and it is shared: other',
  'agents, in other sessions and other tools, read and write the same memories.',
  'What you store will be read by an agent you never meet, and what you read may',
  'have been written by one.',
  '',
  'Check it before answering anything about them — their situation, their',
  'preferences, their plans, what they have already decided. You are one of',
  'several agents here and not necessarily the one they told. When you learn',
  'something about them that will still be true next week, store it, and say',
  'briefly that you did; they cannot see this memory while they are talking to',
  'you.',
  '',
  'Credentials are refused by design. Anything shaped like a key, a password or a',
  'card number is not stored and is not written down anywhere, and that is the',
  'intended behaviour rather than a failure to work around.',
].join('\n');

const store = openStore({ file: defaultStorePath(), now: systemClock });

const server = new Server(
  { name: 'nosyparker', version },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args } = request.params;

  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return said(
      `There is no tool called "${name}", so nothing was done. This server has ` +
        `${TOOLS.map((one) => one.name).join(', ')}.`,
      true,
    );
  }

  try {
    return said(tool.run(store, LOCAL_OWNER, args ?? {}));
  } catch (error) {
    // Everything ends up here: a bad argument, an id that is not there, and a
    // fault nobody foresaw. The store has already rolled back whatever it was
    // doing and released the lock — that happens in the transaction, not here
    // — so all that is left is to say what went wrong and stay up.
    return said(explain(error), true);
  }
});

// The store holds a file handle and a write ahead log, and this process is one
// of several against the same file. Closing it when the client goes away is
// the difference between letting go tidily and being killed holding it.
server.onclose = () => {
  store.close();
};

await server.connect(new StdioServerTransport());

/**
 * The one shape a tool answer takes: text, meant to be read by a person,
 * because the agent will usually show it to them.
 *
 * @param {string} text
 * @param {boolean} [failed] whether the agent should treat this as a refusal to act
 * @returns {{content: {type: 'text', text: string}[], isError: boolean}}
 */
function said(text, failed = false) {
  return { content: [{ type: 'text', text }], isError: failed };
}

/**
 * What to say about something that was thrown.
 *
 * The messages this project throws are already sentences addressed to a
 * person, so they are passed through. Anything else — a fault in this code, or
 * in Node — has no such promise attached to it, and is wrapped in a sentence
 * that at least says where it came from.
 *
 * @param {unknown} error
 * @returns {string}
 */
function explain(error) {
  if (error instanceof Error && error.message !== '') return error.message;
  return `Something went wrong inside nosyparker and nothing was done: ${String(error)}`;
}
