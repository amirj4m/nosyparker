/**
 * The one rule for deciding whether two memories say the same thing.
 *
 * Normalise Unicode to NFKC, trim the ends, collapse runs of whitespace into
 * one space, lowercase. Nothing else. No punctuation stripping and no
 * stemming, because "Let's eat, grandma" and "Let's eat grandma" are different
 * statements and this tool has no business merging them.
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function normaliseForComparison(text) {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * True when the text is nothing but whitespace.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isBlank(text) {
  return text.trim() === '';
}

/**
 * The C0 control characters, less the three that belong in ordinary text.
 *
 * Tab, newline and carriage return are things people type and are left alone.
 * The rest are not text: they are invisible, nobody means to store one, and
 * two separate things go wrong when one arrives.
 *
 * U+0000 is the one that breaks the store's word. SQLite keeps the whole
 * string on disk, but reading it back through `node:sqlite` stops at the NUL,
 * so forty two characters were written and twenty came back. Everything that
 * rests on reading a memory then quietly disagrees with the file: the same
 * sentence stored twice with a NUL between the halves is two memories that
 * both read back identically, and the search index holds text the display
 * cannot show.
 *
 * The others do not truncate, but every one of them can be dropped into the
 * middle of a secret to break its shape — `AKIA` and sixteen characters is an
 * access key, and `AKIA`, one invisible character, and sixteen characters is
 * not, to a regular expression. So the check that looks for secrets can be
 * walked straight past by anything on this list, which is why the whole list
 * is refused rather than only the NUL that started it.
 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

/**
 * The first character in the text that is not text, if there is one.
 *
 * Handed back as a code point so it can be named in the refusal. It cannot be
 * quoted: printing it would put an invisible character into a sentence meant
 * to explain that there is an invisible character.
 *
 * @param {string} text
 * @returns {number|null} code point, or null when the text is clean
 */
export function controlCharacterIn(text) {
  const found = CONTROL_CHARACTER.exec(text);
  if (found === null) return null;
  return found[0].codePointAt(0) ?? null;
}

/**
 * How to name one in a sentence: U+0000, and never the character itself.
 *
 * @param {number} codePoint
 * @returns {string}
 */
export function namedCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Name a short enum-shaped value back to the caller, or say only its shape.
 *
 * `describe` in the tool adapter refuses to quote text at all, because text is
 * the caller's content and can be anything, a secret included. That is right
 * for a memory and wrong for an enum: told only that its `outcome` was "text",
 * a caller cannot see that it sent `forgotten` where `could_not_tell` was
 * wanted, which is a message that costs somebody a round trip to nowhere.
 *
 * So a value is named when it cannot plausibly be a secret: short, and letters
 * with the separators an enum uses. No digits, which is what every credential
 * shape this project knows about carries, and a length no key fits inside.
 *
 * @param {unknown} value
 * @returns {string|null} the value in quotes, or null if it must not be quoted
 */
export function enumValue(value) {
  if (typeof value !== 'string') return null;
  return /^[a-z][a-z_-]{0,19}$/iu.test(value) ? `"${value}"` : null;
}
