/**
 * The format-preserving editor.
 *
 * The assertion that matters in almost every test here is the same one, and it
 * is about what did *not* change. A file with somebody else's servers in it,
 * somebody else's comments, somebody else's formatting, comes back with our
 * entry added and every other byte where it was. That is the promise this phase
 * makes about other people's configuration, and the round trip — insert, then
 * remove, then compare to the original text — is the strongest way to state it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { hasEntry, insertEntry, removeEntry, stripComments, withoutTrailingCommas } from '../src/edit.js';

const ENTRY = { command: '/usr/bin/node', args: ['/srv/mcp-server.js'] };

/** @type {import('../src/edit.js').EditRequest} */
const JSON_REQUEST = {
  format: 'json',
  rootKey: 'mcpServers',
  name: 'nosyparker',
  entry: ENTRY,
};

test('an empty file becomes a file with one entry in it', () => {
  const written = insertEntry('', JSON_REQUEST);

  assert.deepEqual(JSON.parse(written), { mcpServers: { nosyparker: ENTRY } });
  assert.ok(written.endsWith('\n'), 'files end with a newline');
});

test('a config with other servers in it keeps them, byte for byte', () => {
  const before = [
    '{',
    '  "mcpServers": {',
    '    "filesystem": {',
    '      "command": "npx",',
    '      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/p"]',
    '    }',
    '  },',
    '  "otherThing": [1, 2, 3]',
    '}',
    '',
  ].join('\n');

  const after = insertEntry(before, JSON_REQUEST);

  assert.equal(hasEntry(after, JSON_REQUEST), true);
  assert.deepEqual(JSON.parse(after).mcpServers.filesystem, {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/p'],
  });

  // The other server's own line, with its own spacing inside the array, is
  // still exactly the line the user wrote. A parse and reserialise would have
  // spread that array over five lines and called it the same file.
  assert.ok(
    after.includes('      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/p"]'),
    'the other server\'s formatting survived',
  );

  assert.equal(removeEntry(after, JSON_REQUEST), before, 'and it all comes back');
});

test('comments survive, which is the whole reason this is not a parse and rewrite', () => {
  // Zed's own shipped settings are wall-to-wall comments and its users copy
  // that style. JSON.parse would read this file perfectly and JSON.stringify
  // would hand back a file with every one of these lines gone.
  const before = [
    '// Zed settings. See https://zed.dev/docs',
    '{',
    '  "theme": "One Dark", // the good one',
    '  /* servers I have added by hand */',
    '  "context_servers": {',
    '    "mine": { "command": "my-server" }',
    '  }',
    '}',
    '',
  ].join('\n');

  /** @type {import('../src/edit.js').EditRequest} */
  const zed = { format: 'jsonc', rootKey: 'context_servers', name: 'nosyparker', entry: ENTRY };
  const after = insertEntry(before, zed);

  for (const comment of ['// Zed settings. See https://zed.dev/docs', '// the good one',
    '/* servers I have added by hand */']) {
    assert.ok(after.includes(comment), `${comment} survived`);
  }

  assert.equal(hasEntry(after, zed), true);
  assert.equal(removeEntry(after, zed), before);
});

test('a trailing comma is JSONC, not a broken file', () => {
  // Zed wrote this settings.json for itself on the research machine, and the
  // default it ships has a trailing comma after the last key of every block.
  // The installer refused to touch it and reported that the file was not valid
  // JSON — which was wrong about a file the client had just produced, and would
  // have meant no Zed user with default settings could ever be installed to.
  const zed = [
    '// Zed settings',
    '//',
    '// For information on how to configure Zed, see the Zed',
    '// documentation: https://zed.dev/docs/configuring-zed',
    '{',
    '  "vim_mode": true,',
    '  "ui_font_size": 16,',
    '  "theme": {',
    '    "mode": "system",',
    '    "light": "One Light",',
    '    "dark": "One Dark",',
    '  },',
    '}',
    '',
  ].join('\n');

  /** @type {import('../src/edit.js').EditRequest} */
  const request = { format: 'jsonc', rootKey: 'context_servers', name: 'nosyparker', entry: ENTRY };
  const after = insertEntry(zed, request);

  assert.equal(hasEntry(after, request), true);
  assert.ok(after.includes('"dark": "One Dark",\n  },'), 'their trailing commas are still theirs');
  assert.ok(after.includes('// documentation: https://zed.dev/docs/configuring-zed'));
  assert.deepEqual(
    JSON.parse(withoutTrailingCommas(stripComments(after))).context_servers.nosyparker,
    ENTRY,
  );

  // And the check that was doing the refusing still refuses a genuinely broken
  // file, so this did not buy leniency by turning the check off.
  assert.throws(
    () => insertEntry('{\n  "vim_mode": true,,\n}', request),
    /not valid JSON/u,
  );
});

test('a comma inside a string is not a trailing comma', () => {
  const before = '{\n  "note": "ends with a comma,",\n  "mcpServers": {}\n}\n';

  const after = insertEntry(before, JSON_REQUEST);

  assert.equal(JSON.parse(after).note, 'ends with a comma,');
  assert.deepEqual(JSON.parse(after).mcpServers.nosyparker, ENTRY);
});

test('a file with no root key at all gains one and keeps everything else', () => {
  // Claude Desktop's config on the research machine, exactly: valid JSON, two
  // top-level keys, and no mcpServers anywhere in it.
  const before = '{\n  "coworkUserFilesPath": "/home/p/files",\n  "preferences": {"theme": "dark"}\n}\n';

  const after = insertEntry(before, JSON_REQUEST);
  const parsed = JSON.parse(after);

  assert.equal(parsed.coworkUserFilesPath, '/home/p/files');
  assert.deepEqual(parsed.preferences, { theme: 'dark' });
  assert.deepEqual(parsed.mcpServers.nosyparker, ENTRY);
  assert.ok(after.includes('"preferences": {"theme": "dark"}'), 'their line is their line');
});

test('a file written on one line stays on one line', () => {
  const before = '{"mcpServers":{"a":{"command":"a"}}}';
  const after = insertEntry(before, JSON_REQUEST);

  assert.equal(after.includes('\n'), false, 'we did not reformat their file');
  assert.deepEqual(JSON.parse(after).a, undefined);
  assert.deepEqual(JSON.parse(after).mcpServers.a, { command: 'a' });
  assert.equal(removeEntry(after, JSON_REQUEST), before);
});

test('writing twice changes nothing the second time', () => {
  const once = insertEntry('', JSON_REQUEST);
  assert.equal(insertEntry(once, JSON_REQUEST), once);
});

test('an entry that is already there with different arguments is replaced, not doubled', () => {
  const stale = insertEntry('', { ...JSON_REQUEST, entry: { command: 'node', args: ['/old.js'] } });
  const fresh = insertEntry(stale, JSON_REQUEST);

  assert.deepEqual(JSON.parse(fresh).mcpServers.nosyparker, ENTRY);
  assert.equal(Object.keys(JSON.parse(fresh).mcpServers).length, 1);
});

test('a file that is already broken is left alone rather than made worse', () => {
  // This one is not tidiness. Claude Desktop's loader falls back to {} on a
  // read it cannot parse and then writes that empty object over the file, so
  // editing around a syntax error is how somebody's whole config disappears at
  // their next launch.
  assert.throws(
    () => insertEntry('{ "mcpServers": { "a": }', JSON_REQUEST),
    /not valid JSON/u,
  );
});

test('a file that is not an object is refused', () => {
  assert.throws(() => insertEntry('[1, 2, 3]', JSON_REQUEST), /does not hold a JSON object/u);
});

test('a root key that is not an object is refused', () => {
  assert.throws(
    () => insertEntry('{"mcpServers": "elsewhere"}', JSON_REQUEST),
    /is not an object/u,
  );
});

test('removing something that is not there leaves the text alone', () => {
  const before = '{"mcpServers": {"other": {"command": "x"}}}';
  assert.equal(removeEntry(before, JSON_REQUEST), before);
});

test('removing our entry leaves the neighbours and their commas intact', () => {
  const before = '{\n  "mcpServers": {\n    "a": {"command": "a"},\n    "b": {"command": "b"}\n  }\n}\n';

  const after = insertEntry(before, JSON_REQUEST);
  assert.equal(Object.keys(JSON.parse(after).mcpServers).length, 3);

  assert.equal(removeEntry(after, JSON_REQUEST), before);
});

test('an entry that ends up last still comes out cleanly', () => {
  // Insertion always goes to the front, so the only way to be last is to be
  // put there by hand — which is what a user who edited the file does.
  const before = '{\n  "mcpServers": {\n    "a": {"command": "a"},\n    "nosyparker": {"command": "old"}\n  }\n}\n';

  const after = removeEntry(before, JSON_REQUEST);

  assert.deepEqual(JSON.parse(after), { mcpServers: { a: { command: 'a' } } });
  assert.ok(after.includes('"a": {"command": "a"}\n'), 'no trailing comma left behind');
});

test('Goose gets block YAML with its own field names, and nothing else moves', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const goose = {
    format: 'yaml-map',
    rootKey: 'extensions',
    name: 'nosyparker',
    entry: { type: 'stdio', name: 'nosyparker', enabled: true, cmd: '/usr/bin/node', args: ['/srv/mcp-server.js'] },
  };

  const before = [
    'GOOSE_PROVIDER: openai',
    'extensions:',
    '  developer:',
    '    type: builtin',
    '    enabled: true',
    'GOOSE_MODE: auto',
    '',
  ].join('\n');

  const after = insertEntry(before, goose);

  assert.ok(after.includes('  nosyparker:\n    type: stdio\n'), 'a block, at the block indent');
  assert.ok(after.includes('    cmd: /usr/bin/node'), 'cmd, not command');
  assert.ok(after.includes('    enabled: true'), 'and enabled, or it never loads');
  assert.ok(after.includes('  developer:\n    type: builtin\n    enabled: true'), 'theirs is untouched');
  assert.equal(hasEntry(after, goose), true);
  assert.equal(removeEntry(after, goose), before);
});

test('a Goose config with no extensions block gets one, and loses it again', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const goose = {
    format: 'yaml-map',
    rootKey: 'extensions',
    name: 'nosyparker',
    entry: { type: 'stdio', name: 'nosyparker', enabled: true, cmd: 'node', args: ['/p.js'] },
  };

  const before = 'GOOSE_PROVIDER: openai\n';
  const after = insertEntry(before, goose);

  assert.ok(after.startsWith('GOOSE_PROVIDER: openai\nextensions:\n'));

  // The header goes too, because a YAML key with nothing under it is a null
  // rather than an empty map, and a client that expects a map there may make
  // less of it than of no key at all.
  assert.equal(removeEntry(after, goose), before);
});

test('Continue gets a list item, because Continue is the one that is a list', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const request = {
    format: 'yaml-list',
    rootKey: 'mcpServers',
    name: 'nosyparker',
    entry: { name: 'nosyparker', type: 'stdio', command: '/usr/bin/node', args: ['/srv/mcp-server.js'] },
  };

  const before = [
    'name: My assistant',
    'mcpServers:',
    '  - name: filesystem',
    '    command: npx',
    '    args:',
    '      - -y',
    '      - fsserver',
    'models:',
    '  - name: gpt',
    '',
  ].join('\n');

  const after = insertEntry(before, request);

  assert.ok(after.includes('  - name: nosyparker\n    type: stdio\n'), 'a list item');
  assert.ok(after.includes('  - name: filesystem'), 'theirs is still there');
  assert.ok(after.includes('models:\n  - name: gpt'), 'and so is everything after it');
  assert.equal(hasEntry(after, request), true);
  assert.equal(removeEntry(after, request), before);
});

test('a YAML block written on one line is refused rather than guessed at', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const goose = {
    format: 'yaml-map',
    rootKey: 'extensions',
    name: 'nosyparker',
    entry: { type: 'stdio', name: 'nosyparker', enabled: true, cmd: 'node', args: ['/p.js'] },
  };

  assert.throws(() => insertEntry('extensions: {}\n', goose), /written on one line/u);
});

test('a path with a space in it is quoted, so it stays one path', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const goose = {
    format: 'yaml-map',
    rootKey: 'extensions',
    name: 'nosyparker',
    entry: { type: 'stdio', enabled: true, cmd: '/opt/my node/bin/node', args: ['/srv/a b.js'] },
  };

  const after = insertEntry('', goose);

  assert.ok(after.includes('cmd: "/opt/my node/bin/node"'));
  assert.ok(after.includes('- "/srv/a b.js"'));
});

test('a file with no trailing newline gains one, and that is the only difference', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const goose = {
    format: 'yaml-map',
    rootKey: 'extensions',
    name: 'nosyparker',
    entry: { type: 'stdio', enabled: true, cmd: 'node', args: ['/p.js'] },
  };

  const after = insertEntry('GOOSE_PROVIDER: openai', goose);
  assert.equal(removeEntry(after, goose), 'GOOSE_PROVIDER: openai\n');
});

test('Codex is read, never written, and reading it means finding its table header', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const codex = { format: 'toml', rootKey: 'mcp_servers', name: 'nosyparker', entry: null };

  assert.equal(hasEntry('[mcp_servers.nosyparker]\ncommand = "node"\n', codex), true);
  assert.equal(hasEntry('[mcp_servers.other]\ncommand = "node"\n', codex), false);
  assert.equal(hasEntry('', codex), false);
});

test('comments are removed for the parse check without moving anything else', () => {
  const text = '{ // hi\n  "a": 1 /* there */\n}';
  const stripped = stripComments(text);

  assert.equal(stripped.length, text.length, 'every offset is where it was');
  assert.deepEqual(JSON.parse(stripped), { a: 1 });
});

test('a comment containing a brace does not confuse the scanner', () => {
  const before = '{\n  // "mcpServers": { "fake": {} }\n  "mcpServers": {\n    "real": {"command": "r"}\n  }\n}\n';

  const after = insertEntry(before, JSON_REQUEST);

  assert.deepEqual(
    Object.keys(JSON.parse(stripComments(after)).mcpServers).sort(),
    ['nosyparker', 'real'],
  );
  assert.ok(after.includes('// "mcpServers": { "fake": {} }'));
  assert.equal(removeEntry(after, JSON_REQUEST), before);
});

test('a string containing a brace does not confuse it either', () => {
  const before = '{\n  "note": "{\\"mcpServers\\": {}}",\n  "mcpServers": {}\n}\n';

  const after = insertEntry(before, JSON_REQUEST);

  assert.equal(JSON.parse(after).note, '{"mcpServers": {}}');
  assert.deepEqual(JSON.parse(after).mcpServers.nosyparker, ENTRY);
});
