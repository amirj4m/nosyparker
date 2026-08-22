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
import { stripInvisible } from './text.js';

/**
 * @typedef {object} CredentialMatch
 * @property {string} label how to describe it to a person, as in "recognised as ..."
 */

/**
 * The words that announce a secret, in the languages this store meets.
 *
 * English only until a card written in Persian digits went into a plaintext
 * store and made the point that this project's guards had all been written by
 * English speakers testing in English. See the labelled-secret rule below for
 * why a list is the weakest instrument here and what carries the real weight.
 */
const SECRET_WORDS = [
  // English
  '\\bpassword', '\\bpasswd', '\\bpwd', '\\bsecret', '\\bapi[\\s_-]?key',
  '\\baccess[\\s_-]?key', '\\bsecret[\\s_-]?key', '\\bprivate[\\s_-]?key',
  '\\bauth[\\s_-]?token', '\\btoken', '\\bcredentials?',
  // Persian, Arabic, Urdu — no \b, because it is defined on ASCII word
  // characters and does not fire between an Arabic letter and a space.
  'رمز عبور', 'رمز', 'گذرواژه', 'كلمة المرور', 'كلمة السر', 'پاس ورڈ',
  // Hindi
  'पासवर्ड', 'कुंजी',
  // Chinese, Japanese, Korean
  '密码', '密碼', 'パスワード', '秘密鍵', '비밀번호',
  // Greek. Not a general widening of the list — this owner lives in Athens,
  // writes his correspondence in Greek, and his bank, hospital and tax records
  // are Greek, so its absence was not the list's known incompleteness but a
  // gap in the one language he uses every day.
  'κωδικός', 'κωδικό', 'συνθηματικό', 'μυστικό', 'κλειδί',
  // Spanish, French, German, Portuguese, Italian, Russian, Turkish
  'contraseña', 'clave', 'mot de passe', 'passwort', 'geheimnis',
  'senha', 'password di', 'пароль', 'ключ', 'şifre', 'parola',
];

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
  //
  // The words are a list, and a list is the weakest kind of rule here: it is
  // only ever as wide as the languages somebody thought of. It was English
  // only, in a store whose owner writes Persian, so `رمز عبور: hunter2` was
  // stored in plain text — the same defect as the card, wearing the other half
  // of its clothes. The languages below are the ones this store actually sees
  // and the largest few beyond them.
  //
  // What it cannot be is complete. Every language not listed is a hole, and no
  // amount of adding closes the last one. That is why the rules that matter
  // most here — the card checksum, the vendor key shapes, the entropy rule —
  // are about the shape of the secret rather than about the word next to it.
  // This rule catches the careless case; it is not a boundary.
  shape(
    'a labelled secret',
    new RegExp(
      `(?:${SECRET_WORDS.join('|')})["']?\\s*[:=]\\s*["']?\\S{6,}`,
      'iu',
    ),
  ),
  { label: 'a payment card number', find: containsPaymentCard },
  // 32 characters or more of mixed case with at least one digit, in one
  // unbroken run. Ordinary prose does not contain a word like that.
  //
  // Deliberately still ASCII, and measured rather than assumed. Widening it to
  // `\p{Nd}` meant dropping the `\b` anchors, and that anchor is what stops the
  // match being attempted at every position: on the one megabyte query that
  // once took this machine down, the widened form did not finish at all, while
  // this one returns immediately. A token of this shape is base64 or hex by
  // construction and does not carry Persian digits, so the reach gained was
  // theoretical and the cost was the guard that `test/mcp.test.js` exists to
  // hold. The card check is where non-ASCII digits actually turn up, and it is
  // a scan rather than a backtracking match.
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
  // Twice: as it was written, and with the invisible characters taken out.
  //
  // Every shape in this file could be walked past with one character — a
  // `U+200B` inside an AWS key, a `U+200F` between a card's groups, which is
  // what a bidi-aware paste carries. `AKIA` and sixteen characters is an access
  // key; `AKIA`, one zero-width space, and sixteen characters is not, to a
  // regular expression.
  //
  // The stripped view is looked at rather than the text being refused or
  // rewritten, because `U+200C` is ordinary Persian orthography and this
  // store's owner writes Persian. Refusing it would turn away his sentences to
  // catch a rare one. See `stripInvisible`.
  const views = [text];
  const bare = stripInvisible(text);
  if (bare !== text) views.push(bare);

  for (const view of views) {
    for (const { label, find } of SHAPES) {
      if (find(view)) return { label };
    }
  }

  return null;
}

/** Any Unicode decimal digit, rather than the ASCII ten. */
const DIGIT = /\p{Nd}/u;

/**
 * A run of digits, separated the way people and clipboards separate them.
 *
 * The separators are a single space, a hyphen, and the space characters that
 * look like a space and are not one: no-break, narrow no-break, and figure
 * space. Those arrive by paste rather than by typing and are common in anything
 * copied out of a statement.
 */
const RUN_OF_DIGITS = /\p{Nd}(?:[ \u00A0\u202F\u2007-]?\p{Nd})*/gu;

/**
 * What a digit is worth, whatever script it is written in.
 *
 * Every Unicode decimal block is ten consecutive code points beginning at its
 * own zero, so the value is the distance back to that zero. The walk is bounded
 * at nine steps, so a block sitting immediately after another in code space
 * cannot be walked into.
 *
 * @param {string} character
 * @returns {string} the same digit, in ASCII
 */
function digitValue(character) {
  const point = /** @type {number} */ (character.codePointAt(0));

  let zero = point;
  while (zero > point - 9 && DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;

  return String(point - zero);
}

/**
 * Is there a 13 to 19 digit sequence anywhere that passes the Luhn check?
 *
 * Digits may be separated by single spaces or hyphens, the way people write
 * card numbers down — and by the spaces a paste carries rather than types, the
 * non-breaking ones, which are what a bank statement or a web page puts on the
 * clipboard. A card whose only oddity was a `\u00A0` between its groups was
 * stored in plain text.
 *
 * Digits are any Unicode decimal digit, not `[0-9]`. `\d` in JavaScript is
 * ASCII even under the `u` flag, so a card written ۵۱۶۷ ۳۲۰۴ ۴۳۷۸ ۰۷۳۹ — which
 * is how a Persian, Arabic, Urdu or Hindi speaker writes one — was not made of
 * digits as far as this function was concerned, and there was nothing for the
 * checksum to look at. It answered "no card here" and the number went into the
 * store in plain text. This is the worst defect this project has had, and it
 * lived in one character class.
 *
 * NFKC is not the fix, which is worth writing down because it is the obvious
 * guess: it folds full-width digits to ASCII and leaves Persian, Arabic-Indic,
 * Devanagari and Bengali exactly as they are.
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
  const runs = text.match(RUN_OF_DIGITS);
  if (!runs) return false;

  for (const run of runs) {
    const digits = [...run].filter((c) => DIGIT.test(c)).map(digitValue).join('');

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
