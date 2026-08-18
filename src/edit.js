/**
 * Putting one entry into somebody else's config file, and taking it out again.
 *
 * This is the first code in the project that writes to a file the project does
 * not own, and the rule that has protected the memory store now protects other
 * people's editors: never remove anything we did not add. That rules out the
 * obvious implementation. `JSON.parse` then `JSON.stringify` reads a file,
 * throws away everything that is not data, and writes back something that
 * merely means the same thing — which for Zed's settings, whose own shipped
 * defaults are wall-to-wall `//` comments, means deleting every comment the
 * user wrote, and for VS Code means breaking `${input:...}` references by
 * reformatting the file around them.
 *
 * So every edit here is a splice: the text before our entry, our entry, the
 * text after it. Nothing else in the file is read as data or written back. The
 * caller can and does check that afterwards by comparing the file it wrote
 * against the text it computed, which is the same guarantee stated the other
 * way round.
 *
 * Four formats, because the clients do not agree on one:
 *
 *   json       an object map, parsed as a check after the splice
 *   jsonc      the same with comments, which is why the scanner exists
 *   yaml-map   Goose, where a block of lines goes under `extensions:`
 *   yaml-list  Continue, where the same thing is a list item and the name is a
 *              field rather than a key
 *
 * The JSON result is parsed before it is handed back. That is not belt and
 * braces: Claude Desktop's config loader falls back to `{}` on a failed read
 * and then writes that empty object over the file, so a malformed write of ours
 * would not fail — it would destroy the user's file at their next launch. A
 * write that cannot be parsed does not leave this module.
 *
 * YAML has no such check here, because there is no parser in this project and
 * adding one to write six lines is not a trade worth making. What it has
 * instead is that the edit inserts whole lines and changes no existing one, and
 * that Goose can be asked afterwards whether it still sees its own extensions.
 */

/**
 * @typedef {object} EditRequest
 * @property {string} format
 * @property {string} rootKey
 * @property {string} name
 * @property {any} entry
 */

/**
 * Put our entry in. The text comes back with one splice in it and nothing else
 * touched.
 *
 * @param {string} text the file as it is now, or '' if there is no file
 * @param {EditRequest} request
 * @returns {string}
 */
export function insertEntry(text, request) {
  switch (request.format) {
    case 'json':
    case 'jsonc':
      return insertJson(text, request);
    case 'yaml-map':
      return insertYamlMap(text, request);
    case 'yaml-list':
      return insertYamlList(text, request);
    default:
      throw new Error(`There is no way to write a "${request.format}" file here.`);
  }
}

/**
 * Can this project edit a file of this format at all.
 *
 * TOML is the one it cannot, and deliberately: Codex writes its own file
 * through its own command, so there has never been anything for us to insert.
 * That is fine until the fallback path is reached — an uninstall on a machine
 * where the client has since been deleted edits the file itself — and then the
 * honest answer is that we cannot, said as a sentence rather than as an
 * internal error about formats.
 *
 * @param {string} format
 * @returns {boolean}
 */
export function canEdit(format) {
  return ['json', 'jsonc', 'yaml-map', 'yaml-list'].includes(format);
}

/**
 * Take our entry out, leaving everything else exactly as it is.
 *
 * If the entry is not there the text comes back unchanged. That is the ordinary
 * case for an uninstall run twice, and for a config the user has already
 * cleaned up by hand.
 *
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
export function removeEntry(text, request) {
  switch (request.format) {
    case 'json':
    case 'jsonc':
      return removeJson(text, request);
    case 'yaml-map':
      return removeYamlBlock(text, request, 'map');
    case 'yaml-list':
      return removeYamlBlock(text, request, 'list');
    default:
      throw new Error(`There is no way to edit a "${request.format}" file here.`);
  }
}

/**
 * Is our entry in this text.
 *
 * TOML appears here and nowhere else in this file. Codex's config is written by
 * Codex's own CLI, so there is nothing to splice — but there is still something
 * to check, because a CLI reporting success and writing nothing is a thing that
 * happens in this ecosystem and is the reason this function is called after
 * every write, not only after ours.
 *
 * @param {string} text
 * @param {EditRequest} request
 * @returns {boolean}
 */
export function hasEntry(text, request) {
  if (text === '') return false;

  switch (request.format) {
    case 'json':
    case 'jsonc': {
      const root = rootObject(text);
      if (root === null) return false;
      const section = memberOf(text, root, request.rootKey);
      if (section === null) return false;
      const start = skipTrivia(text, section.valueStart);
      if (text[start] !== '{') return false;
      return memberOf(text, start, request.name) !== null;
    }
    case 'yaml-map': {
      const block = yamlBlock(text, request.rootKey);
      if (block === null) return false;
      return block.lines.some((line) => new RegExp(`^\\s+${escapeRegExp(request.name)}:`, 'u').test(line));
    }
    case 'yaml-list': {
      const block = yamlBlock(text, request.rootKey);
      if (block === null) return false;
      return block.lines.some((line) =>
        new RegExp(`^\\s*-?\\s*name:\\s*["']?${escapeRegExp(request.name)}["']?\\s*$`, 'u').test(line));
    }
    case 'toml':
      return new RegExp(`^\\s*\\[${escapeRegExp(request.rootKey)}\\.${escapeRegExp(request.name)}\\]`, 'mu')
        .test(text);
    default:
      throw new Error(`There is no way to read a "${request.format}" file here.`);
  }
}

// ---------------------------------------------------------------- JSON / JSONC

/**
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
function insertJson(text, request) {
  const member = `${JSON.stringify(request.name)}: ${JSON.stringify(request.entry, null, 2)}`;

  if (text.trim() === '') {
    const created = `{\n  ${JSON.stringify(request.rootKey)}: {\n    ${indentBy(member, '    ')}\n  }\n}\n`;
    return checkedJson(created, request);
  }

  const root = rootObject(text);
  if (root === null) {
    throw new Error('This file does not hold a JSON object, so there is nowhere to put the entry.');
  }
  parseCheck(text, 'The file as it stands is not valid JSON, so it was left alone.');

  const section = memberOf(text, root, request.rootKey);

  if (section === null) {
    const wrapped = `${JSON.stringify(request.rootKey)}: {\n  ${indentBy(member, '  ')}\n}`;
    return checkedJson(spliceIntoObject(text, root, wrapped), request);
  }

  const objectStart = skipTrivia(text, section.valueStart);
  if (text[objectStart] !== '{') {
    throw new Error(`"${request.rootKey}" in this file is not an object, so it was left alone.`);
  }

  const existing = memberOf(text, objectStart, request.name);
  if (existing !== null) {
    // An entry that already says what ours says is left exactly as it is, in
    // whatever shape the file has it. Two reasons, and the second is the one
    // that was actually wrong.
    //
    // Rewriting an entry that already means the right thing is reformatting
    // somebody's file for nothing, which is what every other line of this
    // module exists to avoid. And without this the function is not idempotent:
    // where the container is on one line, the first insert matches that layout
    // and a second produces the multi-line form, so `insertEntry(text) !== text`
    // — which `doctor` uses to ask "is this still what setup would write" —
    // said no about a file setup had just written. Every JSON client was
    // reported broken immediately after a successful install.
    if (sameEntry(text.slice(existing.valueStart, existing.valueEnd), request.entry)) return text;

    const replaced = text.slice(0, existing.valueStart)
      + indentBy(JSON.stringify(request.entry, null, 2), indentAt(text, existing.keyStart))
      + text.slice(existing.valueEnd);
    return checkedJson(replaced, request);
  }

  return checkedJson(spliceIntoObject(text, objectStart, member), request);
}

/**
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
function removeJson(text, request) {
  if (!hasEntry(text, request)) return text;

  const root = /** @type {number} */ (rootObject(text));
  const section = /** @type {{valueStart: number}} */ (memberOf(text, root, request.rootKey));
  const objectStart = skipTrivia(text, section.valueStart);

  return removeMemberFrom(text, objectStart, request.name,
    'The entry could not be removed without leaving the file unreadable.');
}

/**
 * Did this file already have the key our entry goes under.
 *
 * Asked before the first write and written into the manifest, because after the
 * write the answer is always yes and there is no way back to it.
 *
 * @param {string} text
 * @param {EditRequest} request
 * @returns {boolean}
 */
export function hadRootKey(text, request) {
  if (request.format !== 'json' && request.format !== 'jsonc') return true;
  if (text.trim() === '') return false;

  const root = rootObject(text);
  return root !== null && memberOf(text, root, request.rootKey) !== null;
}

/**
 * Take the root key out, if we are the ones who put it there and it is empty.
 *
 * The other half of a guarantee that was only half kept. A file that already
 * existed is never deleted — right — but if it had no `mcpServers` key and now
 * has an empty one, that key is a change of ours that uninstall was leaving
 * behind. Three real files were observed carrying one: opencode's, LM Studio's
 * and Zed's.
 *
 * The same evidence discipline as everywhere else. Whether the key was there
 * before is recorded at the moment before the first write, because it cannot be
 * established afterwards, and the caller passes that record in. An empty
 * container that was already in the file stays exactly where it is.
 *
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
export function removeEmptyRootKey(text, request) {
  if (request.format !== 'json' && request.format !== 'jsonc') return text;

  const root = rootObject(text);
  if (root === null) return text;

  const section = memberOf(text, root, request.rootKey);
  if (section === null) return text;

  const objectStart = skipTrivia(text, section.valueStart);
  if (text[objectStart] !== '{') return text;
  if (firstMember(text, objectStart) !== null) return text;

  return removeMemberFrom(text, root, request.rootKey,
    'The empty key could not be removed without leaving the file unreadable.');
}

/**
 * @param {string} text
 * @param {number} objectStart
 * @param {string} key
 * @param {string} complaint
 * @returns {string}
 */
function removeMemberFrom(text, objectStart, key, complaint) {
  const ours = /** @type {{keyStart: number, valueEnd: number}} */
    (memberOf(text, objectStart, key));

  // The comma is the awkward part. A member that is not last owns the comma
  // after it; a member that is last is separated by the comma before it, which
  // belongs to somebody else's line and has to go with us or the file stops
  // parsing. Which of those we are decides where the cut starts.
  const ownLine = text.slice(lineStart(text, ours.keyStart), ours.keyStart).trim() === '';
  const afterValue = skipTrivia(text, ours.valueEnd);

  let from = ownLine ? lineStart(text, ours.keyStart) : ours.keyStart;
  let to = ours.valueEnd;

  if (text[afterValue] === ',') {
    to = afterValue + 1;
    while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to += 1;
    if (ownLine && text[to] === '\n') to += 1;
  } else {
    const before = previousComma(text, objectStart, ours.keyStart);
    if (before !== null) from = before;
    else if (ownLine && text[to] === '\n') to += 1;
  }

  const removed = text.slice(0, from) + text.slice(to);
  parseCheck(removed, complaint);
  return removed;
}

/**
 * Put a member at the front of an object, matching how the object is laid out.
 *
 * The front rather than the back because the last member is the one whose comma
 * is missing, and inserting before the first one means never having to add a
 * comma to a line somebody else wrote.
 *
 * @param {string} text
 * @param {number} objectStart index of the `{`
 * @param {string} member
 * @returns {string}
 */
function spliceIntoObject(text, objectStart, member) {
  const first = firstMember(text, objectStart);

  if (first !== null) {
    // A file written on one line stays on one line. Somebody who wrote
    // `{"mcpServers":{}}` by hand did not ask for their file to be reformatted,
    // and the whole point of splicing rather than reserialising is that we do
    // not have an opinion about their layout.
    if (lineStart(text, first) !== first && indentAt(text, first) === '') {
      return `${text.slice(0, first)}${oneLine(member)}, ${text.slice(first)}`;
    }
    const indent = indentAt(text, first);
    return `${text.slice(0, first)}${indentBy(member, indent)},\n${indent}${text.slice(first)}`;
  }

  const base = lineIndent(text, objectStart);
  const indent = `${base}  `;
  const at = objectStart + 1;

  // Whatever whitespace is already sitting between the braces is replaced
  // rather than inserted in front of, so that `{}` and `{\n  }` both become the
  // same thing. Inserting in front of it looks identical the first time and
  // accumulates a blank line on every install-and-uninstall cycle after that,
  // which is how it was found.
  //
  // Only whitespace. A comment between the braces is somebody's and stays where
  // it is, even at the cost of the blank line.
  const close = skipTrivia(text, at);
  const between = text.slice(at, close);
  const resume = text[close] === '}' && between.trim() === '' ? close : at;

  return `${text.slice(0, at)}\n${indent}${indentBy(member, indent)}\n${base}${text.slice(resume)}`;
}

/**
 * @param {string} member
 * @returns {string}
 */
function oneLine(member) {
  return member.replaceAll(/\n\s*/gu, ' ').replaceAll('[ ', '[').replaceAll(' ]', ']');
}

/**
 * Does what is in the file already say what our entry says.
 *
 * On content rather than on text, because the question is whether the entry
 * works, not whether it is spelled the way this version spells it. A file with
 * the same fields in a different order, or on one line instead of five, is not
 * a file that needs rewriting.
 *
 * @param {string} valueText the entry exactly as it appears in the file
 * @param {unknown} entry what we would write
 * @returns {boolean}
 */
function sameEntry(valueText, entry) {
  try {
    return canonical(JSON.parse(withoutBom(withoutTrailingCommas(stripComments(valueText)))))
      === canonical(entry);
  } catch {
    return false;
  }
}

/**
 * A value written so that two of them compare equal when they mean the same.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
function checkedJson(text, request) {
  parseCheck(text, 'The entry could not be written without leaving the file unreadable.');

  if (!hasEntry(text, request)) {
    throw new Error('The entry was written and then could not be found again in the same text.');
  }
  return text;
}

/**
 * @param {string} text
 * @param {string} complaint
 */
function parseCheck(text, complaint) {
  try {
    JSON.parse(withoutBom(withoutTrailingCommas(stripComments(text))));
  } catch {
    throw new Error(complaint);
  }
}

/**
 * A byte order mark at the start, replaced by a space.
 *
 * For the parse check only, like the two passes above it, and for the same
 * reason: `JSON.parse` refuses a file that begins with U+FEFF, and a config
 * saved by Notepad or by an older VS Code begins with one. Four of the twenty
 * clients are supported on Windows, which is where those files come from.
 *
 * Without this we refused to install and said "the file as it stands is not
 * valid JSON", which is a sentence about the file being broken when the file is
 * fine — the reader's own editor wrote it, and every other program they own
 * reads it. Telling somebody their working file is corrupt is a worse failure
 * than the one it was guarding against.
 *
 * Nothing removes it from the file. The splice keeps every byte of the original
 * including this one, so a file that arrived with a BOM leaves with it, and the
 * editor that expects one is not surprised. The scanner needed no change at
 * all: JavaScript's `\s` already counts U+FEFF as whitespace, so it was only
 * ever the parse that objected.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutBom(text) {
  return text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text;
}

/**
 * A comma before a closing brace, replaced by a space.
 *
 * For the parse check only. The file is never written from this — it exists so
 * that a valid JSONC file is not mistaken for a broken one, which is not a
 * hypothetical: Zed wrote its own `settings.json` on this machine and the
 * default it ships has a trailing comma after the last key of every block. On
 * that file the installer refused to write and said the file was not valid
 * JSON, which was wrong about a file the client itself had just produced.
 *
 * Offsets are preserved, like `stripComments`, so the two compose and neither
 * moves anything the scanner has already found.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutTrailingCommas(text) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }

    if (text[i] === ',') {
      let ahead = i + 1;
      while (ahead < text.length && /\s/u.test(text[ahead])) ahead += 1;
      if (text[ahead] === '}' || text[ahead] === ']') {
        out += ' ';
        i += 1;
        continue;
      }
    }

    out += text[i];
    i += 1;
  }

  return out;
}

/**
 * Comments replaced by spaces, so the offsets of everything else stay put.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out += text.slice(i, end).replaceAll(/[^\n]/gu, ' ');
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }

  return out;
}

/**
 * @param {string} text
 * @returns {number|null}
 */
function rootObject(text) {
  const i = skipTrivia(text, 0);
  return text[i] === '{' ? i : null;
}

/**
 * @param {string} text
 * @param {number} objectStart
 * @param {string} key
 * @returns {{keyStart: number, valueStart: number, valueEnd: number}|null}
 */
function memberOf(text, objectStart, key) {
  let i = skipTrivia(text, objectStart + 1);

  while (i < text.length && text[i] !== '}') {
    if (text[i] !== '"') return null;

    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const found = JSON.parse(text.slice(keyStart, keyEnd));

    i = skipTrivia(text, keyEnd);
    if (text[i] !== ':') return null;

    const valueStart = skipTrivia(text, i + 1);
    const valueEnd = valueEndAt(text, valueStart);

    if (found === key) return { keyStart, valueStart, valueEnd };

    i = skipTrivia(text, valueEnd);
    if (text[i] === ',') i = skipTrivia(text, i + 1);
  }

  return null;
}

/**
 * @param {string} text
 * @param {number} objectStart
 * @returns {number|null}
 */
function firstMember(text, objectStart) {
  const i = skipTrivia(text, objectStart + 1);
  return text[i] === '}' || i >= text.length ? null : i;
}

/**
 * The comma that separates the member before this one from it.
 *
 * @param {string} text
 * @param {number} objectStart
 * @param {number} keyStart
 * @returns {number|null}
 */
function previousComma(text, objectStart, keyStart) {
  let last = null;
  for (let i = objectStart + 1; i < keyStart; i += 1) {
    if (text[i] === '"') {
      i = stringEnd(text, i) - 1;
      continue;
    }
    if (text[i] === ',') last = i;
  }
  return last;
}

/**
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function skipTrivia(text, i) {
  for (;;) {
    while (i < text.length && /\s/u.test(text[i])) i += 1;

    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    return i;
  }
}

/**
 * @param {string} text
 * @param {number} start index of the opening quote
 * @returns {number} index just past the closing quote
 */
function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  throw new Error('This file has a string in it that is never closed.');
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function valueEndAt(text, start) {
  const first = text[start];

  if (first === '"') return stringEnd(text, start);

  if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    let i = start;
    while (i < text.length) {
      if (text[i] === '"') {
        i = stringEnd(text, i);
        continue;
      }
      const skipped = skipTrivia(text, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      if (text[i] === first) depth += 1;
      else if (text[i] === close) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new Error('This file has a bracket in it that is never closed.');
  }

  let i = start;
  while (i < text.length && !',}]\n \t\r'.includes(text[i])) i += 1;
  return i;
}

// ------------------------------------------------------------------ YAML

/**
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
function insertYamlMap(text, request) {
  const entry = yamlLines(request.entry, '    ');
  const block = [`  ${request.name}:`, ...entry];
  return spliceYaml(text, request, block, '  ');
}

/**
 * @param {string} text
 * @param {EditRequest} request
 * @returns {string}
 */
function insertYamlList(text, request) {
  const [first, ...rest] = yamlLines(request.entry, '    ');
  const block = [`  - ${first.trimStart()}`, ...rest];
  return spliceYaml(text, request, block, '  ');
}

/**
 * @param {string} text
 * @param {EditRequest} request
 * @param {string[]} block
 * @param {string} indent
 * @returns {string}
 */
function spliceYaml(text, request, block, indent) {
  if (hasEntry(text, request)) {
    return spliceYaml(removeEntry(text, request), request, block, indent);
  }

  const body = `${block.join('\n')}\n`;

  if (text.trim() === '') return `${request.rootKey}:\n${body}`;

  const found = yamlBlock(text, request.rootKey);

  if (found === null) {
    const separator = text.endsWith('\n') ? '' : '\n';
    return `${text}${separator}${request.rootKey}:\n${body}`;
  }

  if (found.inline !== '') {
    throw new Error(
      `"${request.rootKey}" in this file is written on one line, and the entry cannot be added to it safely.`,
    );
  }

  const lines = text.split('\n');
  lines.splice(found.headerIndex + 1, 0, ...block);
  return lines.join('\n');
}

/**
 * @param {string} text
 * @param {EditRequest} request
 * @param {'map'|'list'} kind
 * @returns {string}
 */
function removeYamlBlock(text, request, kind) {
  const found = yamlBlock(text, request.rootKey);
  if (found === null) return text;

  const lines = text.split('\n');
  const start = found.headerIndex + 1;
  const end = start + found.lines.length;

  const opener = kind === 'map'
    ? new RegExp(`^(\\s+)${escapeRegExp(request.name)}:`, 'u')
    : new RegExp(`^(\\s*)-\\s`, 'u');

  for (let i = start; i < end; i += 1) {
    const match = opener.exec(lines[i]);
    if (match === null) continue;

    if (kind === 'list') {
      const item = itemLines(lines, i, end, match[1].length);
      const named = new RegExp(`\\bname:\\s*["']?${escapeRegExp(request.name)}["']?\\s*$`, 'mu');
      if (!named.test(item.join('\n'))) continue;
      lines.splice(i, item.length);
      return withoutEmptyHeader(lines, found.headerIndex);
    }

    const item = itemLines(lines, i, end, match[1].length);
    lines.splice(i, item.length);
    return withoutEmptyHeader(lines, found.headerIndex);
  }

  return text;
}

/**
 * A YAML key with nothing under it is not an empty map, it is a null, and a
 * client that expects a map there may make less of it than of no key at all. So
 * when taking our entry out leaves the block with no lines in it, the header
 * goes too. JSON does not need this: `{}` is an empty map and says so.
 *
 * @param {string[]} lines
 * @param {number} headerIndex
 * @returns {string}
 */
function withoutEmptyHeader(lines, headerIndex) {
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (leadingSpaces(lines[i]) === 0) break;
    return lines.join('\n');
  }

  lines.splice(headerIndex, 1);
  return lines.join('\n');
}

/**
 * The lines of one block, from its first line to the next line at or above its
 * own indentation.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @param {number} indent
 * @returns {string[]}
 */
function itemLines(lines, start, end, indent) {
  let last = start + 1;
  while (last < end) {
    const line = lines[last];
    if (line.trim() !== '' && leadingSpaces(line) <= indent) break;
    last += 1;
  }

  // Blank lines at the end belong to whatever comes next, or to the end of the
  // file. Taking them with us costs the file its final newline.
  while (last > start + 1 && lines[last - 1].trim() === '') last -= 1;

  return lines.slice(start, last);
}

/**
 * A top-level key and the lines beneath it.
 *
 * @param {string} text
 * @param {string} key
 * @returns {{headerIndex: number, inline: string, lines: string[]}|null}
 */
function yamlBlock(text, key) {
  const lines = text.split('\n');
  const header = new RegExp(`^${escapeRegExp(key)}:(.*)$`, 'u');

  for (let i = 0; i < lines.length; i += 1) {
    const match = header.exec(lines[i]);
    if (match === null) continue;

    let last = i + 1;
    while (last < lines.length) {
      const line = lines[last];
      if (line.trim() !== '' && leadingSpaces(line) === 0) break;
      last += 1;
    }

    return { headerIndex: i, inline: match[1].trim(), lines: lines.slice(i + 1, last) };
  }

  return null;
}

/**
 * Our entry, as YAML block lines.
 *
 * Only what the table's entries actually hold: strings, booleans and lists of
 * strings. A value is quoted unless it is plainly safe unquoted, which keeps a
 * path with a space in it from turning into two things.
 *
 * @param {any} value
 * @param {string} indent
 * @returns {string[]}
 */
function yamlLines(value, indent) {
  /** @type {string[]} */
  const out = [];

  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      out.push(`${indent}${key}:`);
      for (const element of item) out.push(`${indent}  - ${yamlScalar(element)}`);
      continue;
    }
    out.push(`${indent}${key}: ${yamlScalar(item)}`);
  }

  return out;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9_./-]+$/u.test(text) ? text : JSON.stringify(text);
}

// ------------------------------------------------------------------ shared

/**
 * @param {string} line
 * @returns {number}
 */
function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {number}
 */
function lineStart(text, at) {
  const nl = text.lastIndexOf('\n', at - 1);
  return nl === -1 ? 0 : nl + 1;
}

/**
 * The whitespace between the start of this line and this position, if that is
 * all there is between them.
 *
 * Spaces and tabs only. `trim` counts a byte order mark as whitespace, and a
 * file that begins with one and holds everything on a single line then reports
 * the mark itself as its indentation — which puts a U+FEFF into the middle of
 * the file and makes it unparseable. The write is refused rather than made, so
 * nothing was ever damaged, but a Notepad-saved one-line config could not be
 * installed into at all.
 *
 * @param {string} text
 * @param {number} at
 * @returns {string}
 */
function indentAt(text, at) {
  const start = lineStart(text, at);
  const before = text.slice(start, at);
  return /^[ \t]*$/u.test(before) ? before : '';
}

/**
 * The indentation of the line a position sits on, whatever else is on it.
 *
 * @param {string} text
 * @param {number} at
 * @returns {string}
 */
function lineIndent(text, at) {
  const start = lineStart(text, at);
  const line = text.slice(start, text.indexOf('\n', start) === -1 ? undefined : text.indexOf('\n', start));
  return (/^[ \t]*/u.exec(line) ?? [''])[0];
}

/**
 * @param {string} block
 * @param {string} indent
 * @returns {string}
 */
function indentBy(block, indent) {
  return block.replaceAll('\n', `\n${indent}`);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
