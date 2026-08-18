/**
 * The documents, checked against the program.
 *
 * These checks were written as a test, for a reason worth repeating: a commit
 * message once claimed the comparison was made "by a script" when the script
 * was a line of shell nobody saved. They live here now rather than in the test
 * because `doctor` runs them too, and a person running a command should see the
 * same answer the suite gets rather than a second implementation of it.
 *
 * Two rules, both learned from how the throwaway version got things wrong three
 * times in one sitting. Every expectation is derived from the table or the code
 * and none is restated here; and every check is about a fact — a name, a
 * command, a version string — rather than about how a sentence is phrased. All
 * three of its false alarms were prose-shape matches against documents that
 * were correct.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { invocation, loadClients } from './clients.js';
import { OLDEST_SUPPORTED } from './node-version.js';

/**
 * @typedef {object} Check
 * @property {string} what one line, in the present tense, saying what holds
 * @property {boolean} ok
 * @property {string[]} wrong every way it does not hold, empty when it does
 */

/** @returns {string} */
function repositoryRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

/**
 * @param {string} [root]
 * @returns {Check[]}
 */
export function checkDocumentation(root = repositoryRoot()) {
  /** @type {(name: string) => string} */
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

  const clients = loadClients().clients;
  const clientsMd = read('CLIENTS.md');
  const readme = read('README.md');
  const connecting = read('CONNECTING.md');
  const decisions = read('DECISIONS.md');

  const short = (/** @type {any} */ client) => client.name.replace(' (formerly Windsurf)', '');

  /**
   * @param {any} client
   * @returns {string}
   */
  const paragraphFor = (client) =>
    clientsMd.split('\n\n').find((block) => block.includes(`**${short(client)}`)) ?? '';

  /**
   * @param {any} client
   * @returns {string}
   */
  const writeToken = (client) => (client.write.argv.includes('--add-mcp')
    ? '--add-mcp'
    : client.write.argv.slice(0, 3).join(' '));

  const sections = clientsMd.split(/^## /mu);
  const confirmed = sections.find((section) => section.startsWith('Confirmed')) ?? '';
  const unconfirmed = sections.find((section) => section.startsWith('Written, but unconfirmed')) ?? '';

  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three'];
  const version = `Node ${OLDEST_SUPPORTED.major}.${OLDEST_SUPPORTED.minor}`;
  const heading = 'What Phase 3 refuses to write';

  return [
    check('CLIENTS.md introduces every client in the table', clients
      .filter((client) => !clientsMd.includes(short(client)))
      .map((client) => `${client.id} is never named`)),

    check('CLIENTS.md puts each client in the group its own verification reaches',
      clients.flatMap((client) => {
        const answers = ['A', 'B+'].includes(client.verify.tier);
        const where = answers ? confirmed : unconfirmed;
        const other = answers ? unconfirmed : confirmed;
        const wrong = [];
        if (!where.includes(short(client))) wrong.push(`${client.id} is tier ${client.verify.tier} and is in the wrong group`);
        if (other.includes(short(client))) wrong.push(`${client.id} is in both groups`);
        return wrong;
      })),

    check('CLIENTS.md names the mechanism that touches the reader\'s files',
      clients.flatMap((client) => {
        const paragraph = paragraphFor(client);
        if (client.write.method === 'cli') {
          return paragraph.includes(writeToken(client))
            ? [] : [`${client.id} is written by \`${writeToken(client)}\` and CLIENTS.md does not say so`];
        }
        return /Wired through/u.test(paragraph)
          ? [`${client.id} is written by file and CLIENTS.md says it is wired through a command`] : [];
      })),

    check('the README says how many clients there are, and is right',
      words.flatMap((word, n) => {
        if (n === clients.length) {
          return readme.includes(`${word} clients`) ? [] : [`the README does not say ${word}`];
        }
        return readme.includes(`${word} clients`) ? [`the README still says ${word} clients`] : [];
      })),

    check('the README names every client that can confirm the server started',
      clients.filter((client) => client.verify.tier === 'A' && !readme.includes(client.name))
        .map((client) => `the README does not name ${client.id}`)),

    check('the README is four sections, counting the one without a heading',
      readme.split('\n## ').length - 1 === 3
        ? [] : [`it has ${readme.split('\n## ').length - 1} headings and should have three`]),

    check(`every document agrees that ${version} is needed`, [
      ...(readme.includes(version) ? [] : ['the README does not say it']),
      ...(connecting.includes(version) ? [] : ['CONNECTING.md does not say it']),
      ...(JSON.parse(read('package.json')).engines.node
        === `>=${OLDEST_SUPPORTED.major}.${OLDEST_SUPPORTED.minor}.0`
        ? [] : ['package.json engines disagrees']),
    ]),

    check('an instruction a blocker gives is one the documents give too', (() => {
      const gemini = clients.find((client) => client.id === 'gemini-cli');
      const says = (gemini?.blockers ?? []).map((/** @type {any} */ b) => b.says).join(' ');
      return [
        ...(/\/permissions trust/u.test(says) ? [] : ['the table has lost the Gemini instruction']),
        ...(clientsMd.includes('/permissions trust') ? [] : ['CLIENTS.md has lost it']),
      ];
    })()),

    check('no document claims a check the table does not make', (() => {
      const copilot = clients.find((client) => client.id === 'copilot-cli');
      return [
        ...(copilot?.verify.method === 'file-reread' ? [] : ['copilot is asking a command again']),
        ...(copilot?.verify.argv === null ? [] : ['copilot has an argv again']),
        ...(clientsMd.includes('copilot mcp list') ? [] : ['CLIENTS.md does not name the command']),
        ...(clientsMd.includes('we do not use it') ? [] : ['CLIENTS.md does not say it is unused']),
      ];
    })()),

    check('the program and the README name the same command to run next', (() => {
      // Every message ending "run setup again" used to say `nosyparker setup`,
      // which is not a command anybody has: nothing is released and nothing is
      // on a PATH. The documents said `node src/cli.js setup` and were right.
      // A person stuck enough to be reading either one should not then be told
      // to run something that does not exist.
      const script = invocation().split(' ').slice(-1)[0];

      // Item 4 swept the messages that end "run setup again" and missed the
      // other half of the CLI: five usage strings still told somebody to run
      // `nosyparker add`, which is not a command anybody has. A sweep finds what
      // it looks for.
      //
      // And the check that replaced it only read `src`, so two of the seven
      // original instances — both in documents — were fixed by hand with
      // nothing holding them. It reads the documents and the scripts too now,
      // which is the whole of what this project can print or publish.
      const names = /nosyparker (add|search|list|log|forget|restore|setup|uninstall|doctor)\b/u;
      const sources = [
        ...fs.readdirSync(path.join(root, 'src')).filter((file) => file.endsWith('.js'))
          .map((file) => `src/${file}`),
        ...fs.readdirSync(path.join(root, 'scripts')).filter((file) => file.endsWith('.mjs'))
          .map((file) => `scripts/${file}`),
      ];
      const printing = [
        ...sources.filter((file) => names.test(withoutComments(read(file)))),
        // Documents have no comments to strip, and prose about the mistake is
        // the mistake here: a reader copies what a document shows them.
        ...['README.md', 'CLIENTS.md', 'CONNECTING.md', 'DECISIONS.md']
          .filter((file) => names.test(read(file))),
      ];

      return [
        ...printing.map((file) => `${file} names a command nobody has`),
        ...(script.endsWith('/src/cli.js') ? [] : [`the program points at ${script}`]),
        ...(readme.includes('node src/cli.js setup') ? [] : ['the README does not name setup']),
        ...(readme.includes('node src/cli.js doctor') ? [] : ['the README does not name doctor']),
        ...(/```\nnode src\/cli\.js doctor\n```/u.test(readme)
          ? [] : ['the README does not put doctor in a block somebody can copy']),
      ];
    })()),

    check('the README says where to go if doctor did not resolve it', [
      ...(readme.includes('/issues') ? [] : ['the README does not point anywhere']),
      // A personal address in a public repository gets scraped, and the owner
      // has decided against one.
      ...(/[\w.+-]+@[\w-]+\.[\w.]+/u.test(readme) ? ['the README carries an email address'] : []),
    ]),

    check('what the installer refuses is written down where the code points', [
      ...(decisions.includes(heading) ? [] : ['DECISIONS.md has lost the section']),
      // Comments wrap, so the title is not contiguous in the source; collapsing
      // whitespace makes this about the pointer rather than the line break.
      ...(read('src/write.js').replaceAll(/\s*\n\s*\*\s*/gu, ' ').includes(heading)
        ? [] : ['the code no longer points at it']),
    ]),
  ];
}

/**
 * Source with its comments taken out, so prose about a mistake is not read as
 * the mistake. Several modules explain in a comment why `nosyparker setup` was
 * wrong, and those sentences have to survive the check that made them true.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');
}

/**
 * @param {string} what
 * @param {string[]} wrong
 * @returns {Check}
 */
function check(what, wrong) {
  return { what, ok: wrong.length === 0, wrong };
}
