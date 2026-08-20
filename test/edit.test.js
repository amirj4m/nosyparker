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

import {
  hadRootKey,
  hasEntry,
  insertEntry,
  removeEmptyRootKey,
  removeEntry,
  stripComments,
  withoutBom,
  withoutTrailingCommas,
} from '../src/edit.js';

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

test('the container we added comes out too, and one that was there does not', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const request = { format: 'jsonc', rootKey: 'mcp', name: 'nosyparker', entry: ENTRY };

  // opencode's real file: a schema line and nothing else. Uninstalling left it
  // holding an empty `"mcp": {}` that had never been there — a change we made
  // and did not reverse.
  const theirs = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  assert.equal(hadRootKey(theirs, request), false);

  const after = insertEntry(theirs, request);
  const emptied = removeEntry(after, request);
  assert.match(emptied, /"mcp": \{/u, 'removing the entry alone leaves the container');

  assert.equal(removeEmptyRootKey(emptied, request), theirs);

  // This function only knows how to take an empty container out. Whether it
  // *should* is the caller's decision and is made from the manifest, because
  // this text cannot say whether the key was here an hour ago — `hadRootKey` is
  // what answers that, and it has to be asked before the first write.
  const mine = '{\n  "mcp": {},\n  "theme": "dark"\n}\n';
  assert.equal(hadRootKey(mine, request), true);
  assert.equal(hadRootKey(theirs, request), false);
});

test('installing and uninstalling repeatedly cannot grow the file', () => {
  // Found on a real machine: opencode's and LM Studio's files each gained a
  // blank line inside the container on every cycle, because the empty-object
  // insert went in front of the whitespace already between the braces instead
  // of replacing it. One cycle looked perfect; the fourth did not.
  /** @type {import('../src/edit.js').EditRequest} */
  const request = { format: 'json', rootKey: 'mcpServers', name: 'nosyparker', entry: ENTRY };

  let text = '{\n  "mcpServers": {}\n}\n';
  const afterOne = removeEntry(insertEntry(text, request), request);

  for (let cycle = 0; cycle < 5; cycle += 1) {
    text = removeEntry(insertEntry(text, request), request);
  }

  assert.equal(text, afterOne, 'the fifth cycle leaves exactly what the first did');
  assert.deepEqual(JSON.parse(text), { mcpServers: {} });
});

test('a comment between the braces is not whitespace and is not replaced', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const request = { format: 'jsonc', rootKey: 'mcpServers', name: 'nosyparker', entry: ENTRY };
  const before = '{\n  "mcpServers": {\n    // I removed mine on purpose\n  }\n}\n';

  const after = insertEntry(before, request);

  assert.ok(after.includes('// I removed mine on purpose'));
  assert.equal(hasEntry(after, request), true);
});

test('a container with anything left in it is never removed', () => {
  /** @type {import('../src/edit.js').EditRequest} */
  const request = { format: 'json', rootKey: 'mcpServers', name: 'nosyparker', entry: ENTRY };
  const withTheirs = '{\n  "mcpServers": {\n    "theirs": {"command": "x"}\n  }\n}\n';

  assert.equal(removeEmptyRootKey(withTheirs, request), withTheirs);
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

test('a file that begins with a byte order mark is not a broken file', () => {
  // Notepad and older versions of VS Code write one, four of the twenty clients
  // are supported on Windows, and `JSON.parse` refuses a string that starts
  // with U+FEFF. Without this we declined to install and said the file was not
  // valid JSON — a sentence about their file being broken, when their own
  // editor wrote it and every other program they own reads it happily.
  const before = '﻿{\n  "mcpServers": {},\n  "theme": "dark"\n}\n';

  const after = insertEntry(before, JSON_REQUEST);

  assert.equal(hasEntry(after, JSON_REQUEST), true);

  // And it is still their file: the mark is where it was, because nothing here
  // rewrites the bytes it did not add. An editor expecting one still finds one.
  assert.equal(after.charCodeAt(0), 0xfeff);
  assert.equal(JSON.parse(withoutBom(after)).theme, 'dark');
});

test('the mark is only skipped at the start, and only for reading', () => {
  assert.equal(withoutBom('﻿{}'), ' {}', 'offsets do not move');
  assert.equal(withoutBom('{}'), '{}');

  // One in the middle of a string is somebody's data, not an encoding artefact.
  const inside = '{"note": "a﻿b"}';
  assert.equal(withoutBom(inside), inside);
});

test('a genuinely broken file with a mark on the front is still refused', () => {
  assert.throws(
    () => insertEntry('﻿{ "mcpServers": { "a": }', JSON_REQUEST),
    /not valid JSON/u,
  );
});

test('inserting the same entry twice changes nothing the second time, in any layout', () => {
  // Not idempotent for a container written on one line: the first insert
  // matched that layout, the second produced the multi-line form. `doctor` asks
  // "is this still what setup would write" by inserting and comparing, so it
  // said no about a file setup had just written — every JSON client reported
  // broken immediately after a successful install.
  //
  // The layouts are here because none of the fixtures had this one. They were
  // all `JSON.stringify(…, null, 2)` or an empty one-line container, and the
  // empty one happens to pass.
  const layouts = {
    'container on one line, with a member': '{\n  "mcpServers": {"a": {"command": "a"}}\n}\n',
    'whole file on one line': '{"mcpServers":{"a":1}}',
    'container on one line, empty': '{\n  "mcpServers": {}\n}\n',
    'pretty-printed with a member': '{\n  "mcpServers": {\n    "a": {"command": "a"}\n  }\n}\n',
    'no container at all': '{\n  "theme": "dark"\n}\n',
    'empty file': '',
    'tab indented': '{\n\t"mcpServers": {\n\t\t"a": 1\n\t}\n}\n',
    'with comments and a trailing comma': '// mine\n{\n  "mcpServers": {\n    "a": 1,\n  },\n}\n',
    'with a byte order mark, on one line': '﻿{"mcpServers":{"a":1}}',
  };

  for (const [label, before] of Object.entries(layouts)) {
    const once = insertEntry(before, JSON_REQUEST);
    assert.equal(insertEntry(once, JSON_REQUEST), once, label);
    assert.equal(hasEntry(once, JSON_REQUEST), true, label);
  }
});

test('an entry that says the same thing in a different order is left alone', () => {
  // The comparison is on content, not on text, because the question is whether
  // the entry works rather than whether it is spelled the way this version
  // spells it. Rewriting one that already means the right thing would be
  // reformatting somebody's file for nothing.
  const reordered = '{"mcpServers":{"nosyparker":{"args":["/srv/mcp-server.js"],"command":"/usr/bin/node"}}}';

  assert.equal(insertEntry(reordered, JSON_REQUEST), reordered);
});

test('an entry that says something different is still replaced', () => {
  const stale = insertEntry('', { ...JSON_REQUEST, entry: { command: '/old/node', args: ['/srv/mcp-server.js'] } });
  const fresh = insertEntry(stale, JSON_REQUEST);

  assert.notEqual(fresh, stale);
  assert.deepEqual(JSON.parse(fresh).mcpServers.nosyparker, ENTRY);
});

test('a file that begins with a byte order mark and holds one line can be written', () => {
  // `trim` counts U+FEFF as whitespace, so a one-line file starting with one
  // reported the mark itself as its indentation — which put a U+FEFF into the
  // middle of the file and made it unparseable. The write was refused rather
  // than made, so nothing was ever damaged; a Notepad-saved one-line config
  // simply could not be installed into.
  const before = '﻿{"mcpServers":{}}';

  const after = insertEntry(before, JSON_REQUEST);

  assert.equal(after.charCodeAt(0), 0xfeff, 'the mark is still where it was');
  assert.equal(after.slice(1).includes('﻿'), false, 'and there is not a second one');
  assert.equal(hasEntry(after, JSON_REQUEST), true);
});

test('a remover that cannot find what it was asked to remove says so, rather than nothing', () => {
  // The defect this closes, found on a real machine: `cursor --add-mcp` writes
  // its entry under `mcp` → `servers`, and our table pointed at a different
  // file with a top-level root key. Asked to remove it, `removeEntry` looked
  // for `servers` at the top level, did not find it, and returned the file
  // unchanged — reporting success. The entry stayed on the machine for three
  // days, invisible to `uninstall`, pointing at a path that a reinstall would
  // have made stale.
  //
  // "Not there" and "there, but not where I looked" have to be different
  // answers. The first is ordinary — uninstall runs twice and the second is a
  // no-op. The second is a bug in the table, and it must be loud.
  const nested = [
    '{',
    '\t"window.autoDetectColorScheme": true,',
    '\t"mcp": {',
    '\t\t"servers": {',
    '\t\t\t"nosyparker": {',
    '\t\t\t\t"command": "/usr/bin/node"',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}',
  ].join('\n');

  assert.throws(
    () => removeEntry(nested, { name: 'nosyparker', rootKey: 'servers', format: 'json', entry: {} }),
    /nosyparker/u,
    'a nested entry it cannot reach should be an error, not a silent no-op',
  );

  // And the ordinary case still has to be quiet: a file that genuinely does not
  // have our entry comes back unchanged, because uninstall is run twice.
  const absent = '{\n  "mcpServers": {\n    "somebody-else": {}\n  }\n}';
  assert.equal(
    removeEntry(absent, { name: 'nosyparker', rootKey: 'mcpServers', format: 'json', entry: {} }),
    absent,
  );

  // Including when the file has no root key at all.
  const empty = '{\n  "editor.fontSize": 12\n}';
  assert.equal(
    removeEntry(empty, { name: 'nosyparker', rootKey: 'mcpServers', format: 'json', entry: {} }),
    empty,
  );
});

test('hadRootKey understands a dotted key, like every other reader of one', () => {
  // `removeEntry` and `hasEntry` learned to walk `mcp.servers`; this one did
  // not, and it looks for a top-level key literally named "mcp.servers". It
  // answered false for a file that plainly has the container — which, recorded
  // in the manifest, means "we created it" and tells a later uninstall to
  // delete somebody else's `mcp` block. Found by reading the value it wrote
  // rather than by any test.
  const nested = '{\n\t"mcp": {\n\t\t"servers": {\n\t\t\t"nosyparker": {}\n\t\t}\n\t}\n}';

  assert.equal(hadRootKey(nested, { name: 'nosyparker', rootKey: 'mcp.servers', format: 'json', entry: {} }), true);
  assert.equal(hadRootKey('{\n\t"mcp": {}\n}', { name: 'nosyparker', rootKey: 'mcp.servers', format: 'json', entry: {} }), false);

  // And a plain key still answers the way it always did.
  assert.equal(hadRootKey('{"mcpServers":{}}', { name: 'n', rootKey: 'mcpServers', format: 'json', entry: {} }), true);
  assert.equal(hadRootKey('{"other":{}}', { name: 'n', rootKey: 'mcpServers', format: 'json', entry: {} }), false);
});
