/**
 * Keeping one of Node's warnings off the terminal.
 *
 * The first time `node:sqlite` is loaded, Node prints:
 *
 *   (node:1234) ExperimentalWarning: SQLite is an experimental feature and
 *   might change at any time
 *   (Use `node --trace-warnings ...` to show where the warning was created)
 *
 * It is true, and it is addressed to whoever wrote this program rather than to
 * the person storing a sentence about how they take their coffee. That person
 * reads two lines of red after a command that worked and concludes the tool is
 * broken.
 *
 * Only that one warning is dropped. Node's own printer is taken off the
 * `warning` event and put straight back behind a filter, so everything else
 * still reaches the terminal by exactly the route it always did, formatted the
 * way it always was. Silencing the lot, here or with `--no-warnings`, would
 * hide the next real one too, and the next real one is worth reading.
 */

/**
 * Stop the SQLite experimental warning reaching the terminal, and nothing else.
 *
 * This has to be in place before `node:sqlite` is loaded, which is why both
 * entry points are launchers that call this and only then import the code that
 * does the work.
 */
export function silenceSqliteExperimentalWarning() {
  // Node prints warnings through an ordinary listener on this event, so the
  // printer can be borrowed rather than reimplemented. Anything else that was
  // already listening is kept as well.
  const printers = process.listeners('warning');
  process.removeAllListeners('warning');

  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
    for (const printer of printers) printer(warning);
  });
}
