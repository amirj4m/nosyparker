/**
 * What this program does when a write does not land.
 *
 * There are two of those and they are not the same thing.
 *
 * **The reader has gone away.** `nosyparker search 2026 | head -1` prints the
 * line `head` asked for, and `head` then closes the pipe. The next write fails
 * with `EPIPE`, and Node turns an unhandled `error` event on stdout into a
 * crash: a stack trace with our own source paths in it, and exit 1. Nothing has
 * gone wrong. Somebody asked for one line and got one line. A Unix tool in that
 * position stops writing and goes quietly, and this is the only case that is
 * silent.
 *
 * **The write genuinely failed.** A full disk, a read-only target, a device
 * that will not take it. That is worth saying, and it is said the way every
 * other refusal in this project is said — one sentence, no frames — because a
 * handler that swallowed every write error would swallow a full disk with it,
 * and somebody would find out by discovering their export was empty.
 *
 * **On the exit code.** Measured rather than chosen: `seq`, `yes` and `cat`
 * piped into `head -1` are killed by SIGPIPE and report 141; `ls` reports 0
 * because its output fits in the pipe buffer and it never writes again. Node
 * ignores SIGPIPE, so nothing here is killed by anything and reporting 141
 * would be claiming a death that did not happen. It exits 0: the program wrote
 * what it was able to write and stopped, which is true, and it is what a
 * pipeline that does not set `pipefail` sees anyway. What it must not do is
 * exit 1, which is what it did, and which tells a script the search failed.
 */

/** Write errors that mean the reader has gone, rather than that the write failed. */
const READER_HAS_GONE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function readerHasGone(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code;
  return typeof code === 'string' && READER_HAS_GONE.has(code);
}

/**
 * Make every command behave the same way when its output cannot land.
 *
 * Installed once, before any command runs, so it cannot be present on `search`
 * and missing from `export`. That split is exactly what happened with the
 * migration's stack traces: the guard was written for one script and the defect
 * was living in the other.
 *
 * @param {object} [io]
 * @param {NodeJS.WriteStream} [io.stdout]
 * @param {NodeJS.WriteStream} [io.stderr]
 * @param {(code: number) => void} [io.exit]
 * @returns {void}
 */
export function quietWhenTheReaderGoes(io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((/** @type {number} */ code) => process.exit(code));

  stdout.on('error', (error) => {
    if (readerHasGone(error)) {
      // Nothing to say and nobody to say it to.
      exit(0);
      return;
    }

    // A real failure. Said on stderr, which may itself be gone — in which case
    // there is nowhere left to report anything and the code is all that is
    // left to carry it.
    try {
      stderr.write(`${sentenceFor(error)}\n`);
    } catch {
      // Deliberately empty: reporting failed, the exit code below is the report.
    }
    exit(1);
  });

  stderr.on('error', (error) => {
    // Whatever this is, it cannot be described on the stream that just failed.
    exit(readerHasGone(error) ? 0 : 1);
  });
}

/**
 * One line about a write that did not land, with no trace attached.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function sentenceFor(error) {
  const said = error instanceof Error ? error.message : String(error);
  const first = said.split('\n')[0].trim();

  return `nosyparker could not write its output: ${first}\n\n`
    + 'Nothing was read or changed that this failure affects — the output is what could '
    + 'not be delivered. Check that there is room on the disk and that you can write to '
    + 'wherever this was pointed.';
}
