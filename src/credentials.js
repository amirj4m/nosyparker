/**
 * Recognising things that should not be written down here.
 *
 * This is shape matching, not verification. It cannot tell a real key from a
 * string that looks like one, and it does not try. A false alarm costs the
 * user one sentence they have to rephrase. Storing a real key costs them the
 * key, because this file is read by every agent they connect to it.
 *
 * The label each pattern carries is the only thing that survives into the
 * decision log. The text itself never does.
 */

/**
 * @typedef {object} CredentialMatch
 * @property {string} label how to describe it to a person, as in "recognised as ..."
 */

/**
 * The shapes, in the order they are tried, each with a way of looking for it.
 *
 * The specific ones come before the general ones so that the refusal says "an
 * AWS access key" rather than "a long opaque token". Payment cards sit where
 * they do for the same reason, and they carry a function rather than a regular
 * expression because they need arithmetic.
 *
 * @type {{label: string, find: (text: string) => boolean}[]}
 */
const SHAPES = [
  shape('a private key block', /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/u),
  shape(
    'an AWS access key',
    /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16}\b/u,
  ),
  shape('a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/u),
  shape('a Slack token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/u),
  shape('an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/u),
  shape('an OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u),
  shape('a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/u),
  shape('a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/u),
  shape('a JSON Web Token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u),
  shape(
    'a connection string with a password in it',
    /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S+/u,
  ),
  // A word that announces a secret, followed by something that looks like the
  // secret itself. "my deployment key is in 1Password" does not match, because
  // nothing follows a colon or an equals sign.
  shape(
    'a labelled secret',
    /\b(?:password|passwd|pwd|secret|api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|auth[\s_-]?token|token|credentials?)\b["']?\s*[:=]\s*["']?\S{6,}/iu,
  ),
  { label: 'a payment card number', find: containsPaymentCard },
  // 32 characters or more of mixed case with at least one digit, in one
  // unbroken run. Ordinary prose does not contain a word like that.
  shape(
    'a long opaque token',
    /\b(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}\b/u,
  ),
];

/**
 * @param {string} label
 * @param {RegExp} pattern
 * @returns {{label: string, find: (text: string) => boolean}}
 */
function shape(label, pattern) {
  return { label, find: (text) => pattern.test(text) };
}

/**
 * Does the text contain something shaped like a credential?
 *
 * @param {string} text
 * @returns {CredentialMatch|null}
 */
export function detectCredential(text) {
  for (const { label, find } of SHAPES) {
    if (find(text)) return { label };
  }
  return null;
}

/**
 * Is there a 13 to 19 digit sequence anywhere that passes the Luhn check?
 *
 * Digits may be separated by single spaces or hyphens, the way people write
 * card numbers down.
 *
 * Every window is looked at, not just whole runs. A card with anything else
 * numeric beside it — an order number, a reference, a stray digit — reads as
 * one long run, and a long run does not pass Luhn even though the card inside
 * it does. Checking only whole runs meant "ref4 4111 1111 1111 1111" was
 * stored in plain text while "4111 1111 1111 1111" on its own was refused.
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsPaymentCard(text) {
  const runs = text.match(/\d(?:[ -]?\d)*/gu);
  if (!runs) return false;

  for (const run of runs) {
    const digits = run.replace(/[ -]/gu, '');

    for (let start = 0; start < digits.length; start += 1) {
      for (let length = 13; length <= 19; length += 1) {
        if (start + length > digits.length) break;
        if (passesLuhn(digits.slice(start, start + length))) return true;
      }
    }
  }

  return false;
}

/**
 * The Luhn checksum, the arithmetic every payment card number satisfies.
 *
 * @param {string} digits
 * @returns {boolean}
 */
function passesLuhn(digits) {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * What goes in the decision log instead of the text.
 *
 * Nothing derived from the text goes in it, not even how long it was.
 *
 * @param {CredentialMatch} match
 * @returns {string}
 */
export function credentialPlaceholder(match) {
  return `[not recorded: recognised as ${match.label}]`;
}

/**
 * The refusal shown to the person, and written to the log.
 *
 * @param {CredentialMatch} match
 * @returns {string}
 */
export function credentialExplanation(match) {
  return `That looks like ${match.label}, so it was not stored. This is a memory, not a secret store.`;
}
