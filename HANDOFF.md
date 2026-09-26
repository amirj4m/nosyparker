# Handoff, 26 September 2026

Where things stand for whoever picks this up next. It is a working note, like
`PLATFORMS.md`, and it is not in the package. The measurements behind it are in
`PLATFORMS.md` under "Windows — first real-machine run, 2026-09-25/26", and
the reasoning is in `DECISIONS.md`. Delete this file, or rewrite it, once it is
out of date. A stale handoff is worse than none.

## Done

- **Windows client writes work.** PR #1, merged to `main` as `19c1f89`, fixed
  two things at once: every client written through its own command failing on
  Windows, and the test suite stalling there. Detection now uses PATHEXT, and
  a `.cmd` or `.bat` is run through `cmd.exe /d /s /c` with every argument
  escaped. The table has Claude Desktop's bundled `claude.exe` as a fallback
  for Claude Code. `test/windows-spawn.test.js` passes 11 of 11 and is the only
  file that runs real `.cmd` shims. See DECISIONS.md, "Starting a client's
  command on Windows" and "Claude Code is written through its own command or
  not at all".
- **Six Windows paths measured** on a real machine: `claude-code`, `codex-cli`,
  `vscode`, `copilot-cli`, `gemini-cli` and `cursor`. Each file holds our entry
  after `setup`. Claude Code is confirmed loading: its own command reports the
  server connected. Codex is confirmed parsed and enabled, which is not the
  same thing, because Codex never starts the command to check. VS Code,
  Cursor, Copilot and Kimi are written but unconfirmed. Gemini is written and
  disabled by its own untrusted-folder policy.
- **The Windows suite finishes.** `npm test` takes about a minute: 573 tests,
  500 pass, 72 fail, 1 skipped. Before, it never finished.
- **Nothing was published.** npm `latest` is still 0.0.8. `publish.yml` runs
  only on a published GitHub Release, and none has been made since `v0.0.8`.

## Left to do, in rough order

1. **Claim 3 per client on Windows: does the agent load the memory?** This
   needs the owner at the keyboard, signed in:
   - Cursor and Kimi Code: already written. Open them, sign in, ask for the
     test phrase.
   - Warp, Continue (the VS Code extension) and Claude Desktop: open each once
     so it creates its settings, then run `nosyparker setup` again.
   - Gemini CLI: run `/permissions trust` in the folder you start it in, then
     ask.

   Then make the row edits: `lastVerified` for each measured row. The run sheet
   in `PLATFORMS.md` says what to record.
2. **Claude Desktop is never detected on Windows.** Its row's `detect.paths`
   has no Windows entry. Before adding one, measure which config the MSIX
   build reads, `%APPDATA%\Claude\…` or its
   `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\…` copy. Both
   exist on the test machine.
3. **Two Windows defects `doctor` shows, not yet examined:**
   - It cannot read the interpreter out of any JSON entry, so the check that
     the entry still points at a real Node never runs.
   - The sentences the program prints name `node <checkout>\src\cli.js`
     instead of `nosyparker`, which fails the documentation check "the program
     and the README name the same command to run next".

   Both are in `PLATFORMS.md`.
4. **The Windows test harness.** 72 failures are left, all harness assumptions
   and listed in `PLATFORMS.md` under "Work the runners need before they can
   gate". Nine files still delete a temporary store before closing what holds
   it open, and fail with EPERM: `cli`, `concurrency`, `doctor`, `migrate`,
   `purge`, `review-damage`, `search`, `store-guarantees` and `write`. The fix
   is the one already applied to `mcp.test.js` and `review-is-overdue.test.js`:
   close first, then `rmSync` with `maxRetries`. Once the column is green, turn
   off `continue-on-error` for Windows in `test.yml`.
5. **macOS is entirely unverified.** All fourteen macOS paths are still
   inferred. The rented-Mac session in `PLATFORMS.md` is written and ready to
   run.
6. **Goose and Junie on Windows.** Neither could be installed unattended.
   Goose needs Block's own installer; Junie needs a full JetBrains IDE. Both
   need a person.
7. **A release, when the above is far enough along.** Bump the version, then
   publish a GitHub Release, which is what triggers `publish.yml`. Until then,
   nobody installing from npm has the Windows fix.

## The Windows machine, as it was left

- The repository is cloned at `~\nosyparker`, on `main`.
- `nosyparker` is installed globally as a junction to that checkout, not from
  the registry. It runs whatever is checked out and calls itself 0.0.8.
  Switching branches in the checkout changes what every wired client starts.
- It is wired into seven clients: Claude Code, Codex CLI, VS Code, Cursor,
  GitHub Copilot CLI, Kimi Code and Gemini CLI. Gemini's entry is disabled by
  folder trust.
- Installed and waiting for the owner to open or sign in: Cursor, Warp, Kimi
  Code CLI, Claude Desktop, Gemini CLI, Codex CLI, and the Continue extension
  for VS Code.
- `test-out.txt` in the checkout is an old, untracked test log. Leave it
  uncommitted.
