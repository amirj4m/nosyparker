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
