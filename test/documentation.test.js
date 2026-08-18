/**
 * The documents, checked against the program rather than against somebody's
 * memory of it.
 *
 * This file exists because of a specific failure, and the failure is the one
 * this whole phase is about. A commit message said every checkable claim in the
 * four documents had been compared against the program "by a script". The
 * comparison was real and it did run; the script was a line of shell that was
 * never saved. So the record asserted a mechanism that did not exist — which is
 * `gemini mcp add` reporting that it added a server, and `kimi doctor`
 * reporting that a file it never opened is valid, committed by us about us.
 *
 * The documents were true. That is not the point: something reported that it
 * checked, and nothing checked.
 *
 * Two rules follow from how the throwaway version got things wrong, three times
 * in one sitting. It flagged Claude Code, Codex and the README's section count,
 * and all three times the document was right and the check was wrong — because
 * it was matching the shape of prose rather than a fact. So: derive every
 * expectation from the table or the code, never restate it here; and match on
 * things that are true or false — a client's name, the command it runs, a
 * version string — rather than on how a sentence happens to be phrased.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadClients } from '../src/clients.js';
import { OLDEST_SUPPORTED } from '../src/node-version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} name
 * @returns {string}
 */
function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

const CLIENTS_MD = read('CLIENTS.md');
const README = read('README.md');
const CONNECTING = read('CONNECTING.md');
const DECISIONS = read('DECISIONS.md');

/** How CLIENTS.md writes a client's name, which drops Devin's parenthetical. */
const shortName = (/** @type {any} */ client) => client.name.replace(' (formerly Windsurf)', '');

/**
 * The paragraph of CLIENTS.md that introduces this client.
 *
 * Five clients share one paragraph, which is why this finds the block rather
 * than assuming one block per client.
 *
 * @param {any} client
 * @returns {string}
 */
function paragraphFor(client) {
  const marker = `**${shortName(client)}`;
  const block = CLIENTS_MD.split('\n\n').find((candidate) => candidate.includes(marker));
  assert.ok(block, `CLIENTS.md does not introduce ${client.id}`);
  return block;
}

/**
 * The command a row actually runs to write, as it would be written down.
 *
 * @param {any} client
 * @returns {string}
 */
function writeToken(client) {
  return client.write.argv.includes('--add-mcp') ? '--add-mcp' : client.write.argv.slice(0, 3).join(' ');
}

test('CLIENTS.md introduces every client in the table, and no others by accident', () => {
  for (const client of loadClients().clients) {
    assert.ok(CLIENTS_MD.includes(shortName(client)), `CLIENTS.md never names ${client.id}`);
  }
});

test('CLIENTS.md puts each client in the group its own verification reaches', () => {
  // The document tells the reader the first group needs no checking by them.
  // That is a promise made on the strength of the row's tier, so the two have
  // to agree or the promise is being made about a client that cannot keep it.
  const sections = CLIENTS_MD.split(/^## /mu);
  const confirmed = sections.find((s) => s.startsWith('Confirmed')) ?? '';
  const unconfirmed = sections.find((s) => s.startsWith('Written, but unconfirmed')) ?? '';

  assert.ok(confirmed.length > 0 && unconfirmed.length > 0, 'the two groups are still there');

  for (const client of loadClients().clients) {
    const answers = ['A', 'B+'].includes(client.verify.tier);
    const where = answers ? confirmed : unconfirmed;
    const other = answers ? unconfirmed : confirmed;

    assert.ok(where.includes(shortName(client)),
      `${client.id} is tier ${client.verify.tier} and CLIENTS.md has it in the wrong group`);
    assert.equal(other.includes(shortName(client)), false, `${client.id} is in both groups`);
  }
});

test('CLIENTS.md names the mechanism that actually touches the reader\'s files', () => {
  // The failure this replaces was exactly here, twice: the document said Cursor
  // was wired through a command that writes nothing, and later said Devin and
  // Kiro used "its own tool" without naming it. A person deciding whether to
  // let this near their configuration is owed the real mechanism.
  for (const client of loadClients().clients) {
    const paragraph = paragraphFor(client);

    if (client.write.method === 'cli') {
      assert.ok(paragraph.includes(writeToken(client)),
        `${client.id} is written by \`${writeToken(client)}\` and CLIENTS.md does not say so`);
    } else {
      assert.doesNotMatch(paragraph, /Wired through/u,
        `${client.id} is written by file and CLIENTS.md says it is wired through a command`);
    }
  }
});

test('the README says how many clients there are, and is right', () => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three'];
  const count = loadClients().clients.length;

  assert.ok(README.includes(`${words[count]} clients`), `the README does not say ${words[count]}`);

  // And no other count is left lying about from a previous total.
  for (const [n, word] of words.entries()) {
    if (n === count) continue;
    assert.equal(README.includes(`${word} clients`), false, `the README still says ${word} clients`);
  }
});

test('the README names every client that can confirm the server started', () => {
  for (const client of loadClients().clients.filter((c) => c.verify.tier === 'A')) {
    assert.ok(README.includes(client.name), `the README does not name ${client.id}`);
  }
});

test('the README is four sections, counting the one without a heading', () => {
  // The owner's rule. The opening counts, which is how a fourth heading was a
  // fifth section.
  assert.equal(README.split('\n## ').length - 1, 3);
});

test('every document agrees with the code about which Node is needed', () => {
  const version = `Node ${OLDEST_SUPPORTED.major}.${OLDEST_SUPPORTED.minor}`;

  assert.ok(README.includes(version), `the README does not say ${version}`);
  assert.ok(CONNECTING.includes(version), `CONNECTING.md does not say ${version}`);

  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.engines.node,
    `>=${OLDEST_SUPPORTED.major}.${OLDEST_SUPPORTED.minor}.0`);
});

test('an instruction a blocker gives is an instruction the document gives too', () => {
  // Gemini's folder trust is the one blocker that fires in ordinary use, and
  // both places a person might look have to say the same thing about getting
  // out of it.
  const gemini = loadClients().clients.find((client) => client.id === 'gemini-cli');
  const says = gemini.blockers.map((/** @type {any} */ blocker) => blocker.says).join(' ');

  assert.match(says, /\/permissions trust/u, 'the table lost the instruction');
  assert.ok(CLIENTS_MD.includes('/permissions trust'), 'CLIENTS.md lost the instruction');
});

test('no document claims a check the table does not make', () => {
  // Copilot's documented list command is deliberately unused, because nobody
  // has seen what it prints. A document implying we run it would be claiming
  // exactly the confirmation the row refuses to claim.
  const copilot = loadClients().clients.find((client) => client.id === 'copilot-cli');

  assert.equal(copilot.verify.method, 'file-reread');
  assert.equal(copilot.verify.argv, null);

  // Document-level rather than paragraph-level on purpose: Copilot shares its
  // paragraph with the other four documented-only clients, and the sentence
  // about its unused check is its own. What matters is that the document names
  // the command and says we do not use it, not which block that lands in.
  assert.ok(CLIENTS_MD.includes('copilot mcp list'), 'CLIENTS.md does not name the command');
  assert.ok(CLIENTS_MD.includes('we do not use it'),
    'CLIENTS.md does not say the documented check is unused');
});

test('what the installer refuses is written down where the code points', () => {
  const heading = 'What Phase 3 refuses to write';
  assert.ok(DECISIONS.includes(heading), 'DECISIONS.md has lost the section');

  // The pointer in the code is a comment and comments wrap, so the title is not
  // contiguous in the source. Collapsing whitespace is what makes this check
  // about the pointer rather than about where the line happened to break.
  const pointer = read('src/write.js').replaceAll(/\s*\n\s*\*\s*/gu, ' ');
  assert.ok(pointer.includes(heading), 'the code no longer points at it');
});
