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
 * @param {string[]} [workingNotes] documents of ours that are in the repository
 *   and deliberately not in the package. Empty for `doctor`, which is a shipped
 *   command and should not change its behaviour because of a note we keep for
 *   ourselves; the suite passes them, because the reason for checking them is
 *   real and belongs where the checking happens.
 * @returns {Check[]}
 */
export function checkDocumentation(root = repositoryRoot(), workingNotes = []) {
  /** @type {(name: string) => string} */
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

  const clients = loadClients().clients;
  const clientsMd = read('CLIENTS.md');
  const readme = read('README.md');

  // The same text with every run of whitespace flattened to one space, for the
  // checks that look for a phrase rather than for structure. These documents
  // are wrapped by hand, and "ten things an agent can do" wrapping after
  // "agent" is a claim moving across a line break, not a claim disappearing.
  // A check that goes red for correctly wrapped prose is one people learn to
  // work around, which is the whole value of it gone.
  const flatReadme = readme.replaceAll(/\s+/gu, ' ');
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
        const said = flatReadme.includes(`${word} clients`);
        if (n === clients.length) return said ? [] : [`the README does not say ${word}`];
        return said ? [`the README still says ${word} clients`] : [];
      })),

    check('the README lists every tool an agent has, and says how many there are', (() => {
      // The rule this closes is the owner's, written down after Phase 2: any
      // phase that adds or removes a capability updates the README in the same
      // phase. Phase 4 added four tools and the README said six, which is the
      // one sentence in it a person reads to find out what this thing does.
      //
      // `src/tools.js` is read as text rather than imported, because that file
      // reaches the store and this one may not — the entrances test says so.
      // The same technique as the gate's vocabulary check, for the same reason:
      // a name that exists but is unreachable is still a name.
      const tools = [...read('src/tools.js').matchAll(/^ {4}name: '([^']+)',$/gmu)]
        .map((match) => match[1]);

      return [
        ...(tools.length === 0 ? ['no tool names could be read out of src/tools.js'] : []),
        ...tools.filter((tool) => !flatReadme.includes(`**${tool}**`))
          .map((tool) => `the README does not list ${tool}`),
        // Lowercased, because the number opens a sentence and is capitalised
        // there. A check that missed for that reason would be a check nobody
        // could satisfy without rewriting the sentence around it.
        ...words.flatMap((word, n) => {
          const said = flatReadme.toLowerCase().includes(`${word} things an agent can do`);
          if (n === tools.length) {
            return said ? [] : [`the README does not say ${word} things an agent can do`];
          }
          return said ? [`the README still says ${word} things an agent can do`] : [];
        }),
        // CONNECTING.md tells somebody what they should see in their client's
        // own list once it is connected, which is the one number in that
        // document a person checks against their screen. It said six.
        ...words.flatMap((word, n) => {
          const said = connecting.includes(`${word} tools`);
          if (n === tools.length) {
            return said ? [] : [`CONNECTING.md does not say ${word} tools`];
          }
          return said ? [`CONNECTING.md still says ${word} tools`] : [];
        }),
      ];
    })()),

    check('the README does not call the package unreleased once it can be published', (() => {
      // The one document-versus-code gap left, and it would have arrived at the
      // most expensive moment available: `README.md` said "nosyparker is not
      // released yet — there is no package to fetch" and that paragraph ships
      // inside the tarball. The first thing a stranger reads after installing
      // would have been a sentence saying the thing they just installed does
      // not exist.
      //
      // It matters more here than the wording suggests. This project's whole
      // claim is that it tells you the truth about what it did — refusals
      // explain themselves, `doctor` says what it cannot check, CLIENTS.md says
      // which rows nobody has watched work. Being wrong about the most
      // checkable fact there is, in the first paragraph, spends that in ten
      // seconds.
      const manifest = JSON.parse(read('package.json'));
      const publishable = manifest.private !== true
        && /^\d+\.\d+\.\d+$/u.test(manifest.version ?? '');

      if (!publishable) return [];

      return [
        ...[/\bnot (?:yet )?released\b/iu, /\bunreleased\b/iu, /no package to fetch/iu,
          /\bnot on npm\b/iu, /\bcoming soon\b/iu]
          .filter((claim) => claim.test(flatReadme))
          .map((claim) => `the README says /${claim.source}/ and package.json is at ${manifest.version}`),
        // And the other half: it has to say how to get it, in the name the
        // manifest will publish under rather than the one somebody typed.
        ...(flatReadme.includes(`npm install -g ${manifest.name}`)
          ? [] : [`the README does not say \`npm install -g ${manifest.name}\``]),
      ];
    })()),

    check('no sentence the gate says out loud names one of its own functions', (() => {
      // Found by running it. A review offered to a closed pass answered "Start
      // one with beginReview", and `beginReview` is a function inside this
      // program. Nobody has it. The agent reading that sentence has
      // `review_start`; the person at the terminal has neither.
      //
      // This is the same defect as Phase 3's "run `nosyparker setup`", which
      // named a command nobody has, and it has the same shape: a sentence
      // written by somebody looking at the code, read by somebody who is not.
      // That one got a check and this is its other half.
      //
      // Some exports are also tool names — `forget`, `restore`, `submit` — and
      // naming those is right and is what the explanations do. The tell is the
      // capital letter: no tool and no terminal command has one.
      const gate = read('src/gate.js').replaceAll(/\/\*[\s\S]*?\*\//gu, '');
      const internal = [...gate.matchAll(/^export function ([a-z]+[A-Z]\w*)/gmu)]
        .map((match) => match[1]);

      // What the program says out loud is every string literal in it. Matching
      // the `explanation:` fields alone would miss the ones built by a helper,
      // and `restoreExplanation` and `undoExplanation` are both helpers.
      const spoken = [...gate.matchAll(/'([^'\\\n]*)'|`([^`\\]*)`/gu)]
        .map((match) => match[1] ?? match[2] ?? '')
        .join('\n');

      return [
        ...(internal.length === 0 ? ['no exported function names could be read out of the gate'] : []),
        ...internal.filter((name) => spoken.includes(name))
          .map((name) => `the gate says "${name}", which is a function and not something a caller has`),
      ];
    })()),

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
      // This rule has been true in both directions and the reason is the same
      // one each time: a person stuck enough to be reading a document must not
      // be told to run something that does not exist.
      //
      // Until 0.0.2 there was no `bin`, so `nosyparker setup` was a command
      // nobody had, and every message and document had to say
      // `node src/cli.js setup` instead. Seven places said otherwise and were
      // swept, twice, because the first sweep only read `src`.
      //
      // 0.0.2 adds the `bin`, so the command exists and the documents should
      // use it. What the check protects is the agreement, not the wording: it
      // reads the manifest to find out which commands are real, and it is the
      // manifest losing its `bin` that brings the old error back.
      const bin = Object.keys(JSON.parse(read('package.json')).bin ?? {});
      const hasCommand = bin.includes('nosyparker');

      const names = /nosyparker (add|search|list|log|forget|restore|setup|uninstall|doctor|export|undo-review)\b/u;
      const sources = [
        ...fs.readdirSync(path.join(root, 'src')).filter((file) => file.endsWith('.js'))
          .map((file) => `src/${file}`),
        ...fs.readdirSync(path.join(root, 'scripts')).filter((file) => file.endsWith('.mjs'))
          .map((file) => `scripts/${file}`),
      ];
      // The four that ship, plus whatever the caller says it also wants read.
      //
      // WINDOWS.md is a brief for a session on the other half of a dual-boot
      // machine — a stranger who will follow it literally, on a platform none of
      // us can watch — so a stale instruction in it is exactly the harm this
      // check exists to prevent, and the suite passes it in for that reason.
      //
      // It is not passed in by `doctor`. A third review called that creep and
      // was right: `doctor` is a shipped command, and making what it reports
      // depend on a note we keep for ourselves is a coupling with no upside for
      // the person running it. Filtered by existence as well, so a name that is
      // not there is skipped rather than read — which is the ENOENT that
      // `test/package.test.js` opens by describing.
      const documents = [
        'README.md', 'CLIENTS.md', 'CONNECTING.md', 'DECISIONS.md',
        ...workingNotes.filter((file) => fs.existsSync(path.join(root, file))),
      ];
      const printing = [
        ...sources.filter((file) => names.test(withoutComments(read(file)))),
        // Documents have no comments to strip, and prose about the mistake is
        // the mistake here: a reader copies what a document shows them.
        ...documents.filter((file) => names.test(read(file))),
      ];

      // What `invocation()` hands back has to be one of the two real shapes:
      // the command, when it was started through the shim, or the script path.
      const said = invocation();
      const shape = said === 'nosyparker' || said.endsWith('/src/cli.js');

      // The other direction, and the one that was missed. When the command
      // exists, a document still telling somebody to run `node src/cli.js
      // setup` is as wrong as naming a command nobody had — and the line above
      // discarded the whole list the moment `bin` appeared, in the release
      // whose headline was that the command now exists. Six occurrences shipped
      // in three documents that go in the tarball. The comment a few lines up
      // records this identical lesson from the last time.
      const oldForm = /node src\/cli\.js (add|search|list|log|forget|restore|setup|uninstall|doctor|export|undo-review)\b/u;
      const stale = [
        ...sources.filter((file) => oldForm.test(withoutComments(read(file)))),
        ...documents.filter((file) => oldForm.test(read(file))),
      ];

      return [
        ...(hasCommand ? [] : printing.map((file) => `${file} names a command nobody has`)),
        ...(hasCommand ? stale.map((file) => `${file} still tells people to run it by path`) : []),
        ...(shape ? [] : [`the program points at ${said}`]),
        ...(hasCommand && !flatReadme.includes('nosyparker setup')
          ? ['the README does not name setup'] : []),
        ...(hasCommand && !flatReadme.includes('nosyparker doctor')
          ? ['the README does not name doctor'] : []),
        ...(hasCommand && !/```\nnosyparker doctor\n```/u.test(readme)
          ? ['the README does not put doctor in a block somebody can copy'] : []),
      ];
    })()),

    check('every section of DECISIONS.md is pointed at from the code, or marked a record', (() => {
      // The file's own opening says this, and nothing was checking it — so a
      // retrospective written in the future tense to a phase that had finished
      // sat in it as though it were guidance, pointed at from nowhere.
      //
      // Comments wrap, so the titles are not contiguous in the source; the same
      // whitespace collapsing the pointer check two entries down uses.
      const code = [
        ...fs.readdirSync(path.join(root, 'src')).filter((file) => file.endsWith('.js'))
          .map((file) => `src/${file}`),
        ...fs.readdirSync(path.join(root, 'scripts')).filter((file) => file.endsWith('.mjs'))
          .map((file) => `scripts/${file}`),
      ].map((file) => read(file).replaceAll(/\s*\n\s*\*?\s*/gu, ' ').replaceAll('`', '')).join('\n');

      return decisions.split('\n').filter((line) => line.startsWith('## '))
        .map((line) => line.slice(3).trim())
        .filter((title) => !title.endsWith('[record]'))
        .filter((title) => !code.includes(title.replaceAll('`', '')))
        .map((title) => `"${title}" is pointed at from nowhere and is not marked a record`);
    })()),

    check('CLIENTS.md does not claim a firmer basis than a row has', (() => {
      // The document grouped Cline with the four clients written from vendor
      // documentation; its row says third-party write-ups, which is weaker.
      // A reader deciding whether to trust an entry was being told the wrong
      // thing about which one to doubt first.
      const documented = clients.filter((client) => client.evidence === 'DOCS').map(short);
      const weaker = clients.filter((client) => client.evidence === 'SECONDARY').map(short);
      const paragraph = clientsMd.split('\n\n')
        .find((block) => block.includes('written from their published documentation')) ?? '';

      return [
        ...weaker.filter((name) => paragraph.includes(name))
          .map((name) => `${name} is in the documented group and its row says SECONDARY`),
        ...documented.filter((name) => !clientsMd.includes(name))
          .map((name) => `${name} is documented-only and CLIENTS.md never says so`),
      ];
    })()),

    check('the README says what is in the folder it keeps things in', (() => {
      // Nothing held this: the log was a user-visible file in somebody's home
      // directory that no document mentioned at all, and "Removing it" said the
      // memories were "all in one file" when the folder had three things in it.
      const named = ['memory.sqlite', 'actions.log', 'backups/'];
      return named.filter((thing) => !readme.includes(thing))
        .map((thing) => `the README does not mention ${thing}`);
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
