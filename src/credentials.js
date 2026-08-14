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
 * @property {string} kind short machine name of the pattern that matched
 * @property {string} label how to describe it to a person, as in "recognised as ..."
 */

/**
 * Patterns in the order they are tried. The specific ones come before the
 * general ones so that the log says "an AWS access key" rather than "a long
 * opaque token".
 *
 * @type {{kind: string, label: string, pattern: RegExp}[]}
 */
const PATTERNS = [
  {
    kind: 'private-key-block',
    label: 'a private key block',
    pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/u,
  },
  {
    kind: 'aws-access-key',
    label: 'an AWS access key',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16}\b/u,
  },
  {
    kind: 'github-token',
    label: 'a GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/u,
  },
  {
    kind: 'slack-token',
    label: 'a Slack token',
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/u,
  },
  {
    kind: 'anthropic-key',
    label: 'an Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/u,
  },
  {
    kind: 'openai-key',
    label: 'an OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  },
  {
    kind: 'google-key',
    label: 'a Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u,
  },
  {
    kind: 'gitlab-token',
    label: 'a GitLab token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    kind: 'jwt',
    label: 'a JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  },
  {
    kind: 'connection-string',
    label: 'a connection string with a password in it',
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S+/u,
  },
  {
    kind: 'labelled-secret',
    label: 'a labelled secret',
    // A word that announces a secret, followed by something that looks like
    // the secret itself. "my deployment key is in 1Password" does not match,
    // because nothing follows a colon or an equals sign.
    pattern:
      /\b(?:password|passwd|pwd|secret|api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|auth[\s_-]?token|token|credentials?)\b["']?\s*[:=]\s*["']?\S{6,}/iu,
  },
  {
    kind: 'opaque-token',
    label: 'a long opaque token',
    // 32 characters or more of mixed case with at least one digit, in one
    // unbroken run. Ordinary prose does not contain a word like that.
    pattern:
      /\b(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}\b/u,
  },
];

/**
 * Does the text contain something shaped like a credential?
 *
 * Payment card numbers are checked between the named patterns and the general
 * opaque token rule, because they need arithmetic rather than a regular
 * expression.
 *
 * @param {string} text
 * @returns {CredentialMatch|null}
 */
export function detectCredential(text) {
  for (const { kind, label, pattern } of PATTERNS) {
    if (kind === 'opaque-token' && containsPaymentCard(text)) {
      return { kind: 'payment-card', label: 'a payment card number' };
    }
    if (pattern.test(text)) return { kind, label };
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
 * The point of this function is that it never receives anything derived from
 * the text apart from how long it was.
 *
 * @param {CredentialMatch} match
 * @param {string} text the offered text, used only to count characters
 * @returns {string}
 */
export function credentialPlaceholder(match, text) {
  const characters = [...text].length;
  return `[not recorded: recognised as ${match.label}, ${characters} characters]`;
}

/**
 * The refusal shown to the person, and written to the log.
 *
 * @param {CredentialMatch} match
 * @returns {string}
 */
export function credentialExplanation(match) {
  return [
    `That looks like ${match.label}, so it was not stored.`,
    'This is a memory, not a secret store. The file is read by every agent you connect to it,',
    'so anything in here is effectively shared with all of them.',
    'Keep the value in a password manager instead, and if it has already been shared, rotate it.',
    'A memory like "my deployment key is in 1Password" is fine to store here, and more useful,',
    'because it tells an agent where to send you without handing it the key.',
  ].join(' ');
}
