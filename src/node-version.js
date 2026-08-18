/**
 * Refusing to start on a Node too old to run this, in a sentence.
 *
 * `node:sqlite` arrived in Node 22.5.0. On anything older, importing it throws
 * `ERR_UNKNOWN_BUILTIN_MODULE` from inside Node's module loader, and what the
 * person sees is nine lines of Node internals with a stack trace through
 * `ModuleLoader.builtinStrategy`. Nothing in it says which program failed, what
 * it needed, or what to do — and the one thing it does name, `node:sqlite`, is
 * not something they asked for.
 *
 * Phase 2 spent two items turning exactly this class of stack trace into a
 * sentence at the entry points that existed then. `setup` is a new entry point
 * and it arrived without the guard, which is worse than the ones before it: it
 * is the first command a stranger runs, on a machine we know nothing about, and
 * it does not need SQLite at all — it fails on an import it has no use for,
 * because the module that dispatches it also imports the store.
 *
 * This has to run before that import is evaluated, which is why it lives in the
 * launchers beside the warning filter rather than at the top of the module that
 * does the work. A static import is hoisted; a dynamic one is not.
 *
 * It checks rather than trusting `engines`, because `engines` is advice that
 * only npm reads, and nobody installs this with npm yet.
 *
 * The message is deliberately plain and deliberately short, and it is not an
 * invention: a person installing command line tools has met this before — the
 * owner had it from Hermes the same week — so the expected shape is the version
 * needed, the version found, and one thing to do. It does not explain that this
 * is about SQLite, because that is our reason and not their problem, and it
 * leads with "install a newer Node" rather than with a version manager, because
 * most people do not have one and the ones who do will recognise the clause at
 * the end without being taught the words.
 */

/** The first Node that has `node:sqlite`. */
export const OLDEST_SUPPORTED = { major: 22, minor: 5 };

/**
 * @param {string} [version] defaults to the Node running now
 * @returns {boolean}
 */
export function isSupported(version) {
  const [major, minor] = (version ?? process.versions.node).split('.').map(Number);

  if (major > OLDEST_SUPPORTED.major) return true;
  return major === OLDEST_SUPPORTED.major && minor >= OLDEST_SUPPORTED.minor;
}

/**
 * @param {string} [version]
 * @returns {string}
 */
export function tooOldMessage(version) {
  const running = version ?? process.versions.node;

  return [
    `nosyparker needs Node ${OLDEST_SUPPORTED.major}.${OLDEST_SUPPORTED.minor} or newer. This is Node ${running}.`,
    '',
    'Install a newer Node from nodejs.org and run this again. If you manage Node',
    'versions with a tool like nvm, switch to 22 there instead.',
  ].join('\n');
}

/**
 * Say so and stop, or return and let the caller carry on.
 *
 * @param {object} [io]
 * @param {(text: string) => void} [io.err]
 * @param {(code: number) => never} [io.exit]
 * @param {string} [io.version]
 */
export function requireSupportedNode(io = {}) {
  if (isSupported(io.version)) return;

  const err = io.err ?? ((text) => process.stderr.write(text));
  const exit = io.exit ?? ((code) => process.exit(code));

  err(`${tooOldMessage(io.version)}\n`);
  exit(1);
}
