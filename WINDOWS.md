# Testing nosyparker on Windows

**Status: nothing in this file has been done yet.** It is a brief for a session
that will run on Windows, written on Linux by a session that has never seen this
program run anywhere else. Everything it says about Windows is either a quotation
of our own source or an admission that we do not know.

Written 2026-08-20, against `nosyparker@0.0.2`, commit `18e0844`.

This document is deliberately **not** in `package.json`'s `files` list. It is a
working note between the people building this, not something a person who
installed a memory store should find on their disk. There is a test that fails if
it ever ends up in the tarball.

---

## 1. What nosyparker is

It is a memory store for AI agents: one SQLite file on one person's computer,
holding sentences worth remembering about them, which any agent on that machine
can read and write through MCP. Its second job — the whole of this document — is
`nosyparker setup`, which finds the AI tools installed on a machine and adds
itself to each one's configuration file, and `nosyparker uninstall`, which takes
itself back out. The promise those two commands make is narrow and absolute: it
only ever adds or removes its own entry, and never changes anything else in a
file it did not create.

That promise is why this document exists. Every path, key name and write method
in `src/clients.json` is a claim about somebody else's config file, and a wrong
claim on Windows is not a failed install — it is us editing a stranger's editor
settings in the wrong place.

---

## 2. What we established on Linux, and how

Twenty clients are in `src/clients.json`. For the Linux column, nearly every row
was established the same way, and **the method matters more than the results**:

1. Install the application for real.
2. Take a snapshot of a clean `HOME` — every file, with its modification time.
3. Run the vendor's own command (`claude mcp add`, `cursor --add-mcp`,
   `gemini mcp add`, `codex mcp add`, …) or start the application and add a
   server through its UI.
4. Diff the whole of `HOME` afterwards. Not the file the documentation names —
   **every file that changed**.
5. Record what was actually written: the path, the root key, the exact shape of
   the entry, and whether the vendor command worked at all.
6. Where the client offers any way to ask whether it loaded the server, ask it,
   and record what kind of answer that is.

Reading the documentation was never accepted as evidence. `CLIENTS.md` says so in
its own words, and `PHASE3-RESEARCH.md` — 1,206 lines, frozen on 2026-08-18 —
carries a confidence marker on every single claim, with `[MACHINE]` and
`[BINARY]` ranked above `[DOCS]` on purpose.

Three findings show why. `gemini mcp add` **reports success and writes nothing**.
`cursor --add-mcp` **exits 0 and creates no file at the path Cursor's own docs
name** — it writes `~/.config/Cursor/User/settings.json` instead, under
`mcp` → `servers`, which we did not discover for three days and only then because
somebody diffed a machine. VS Code reads *other* clients' MCP config files, so
writing one client's file silently registers the server in another. None of the
three is in anybody's documentation. All three came out of step 4.

**The Windows session should repeat this method rather than trust our table.**
The table is a Linux measurement with a Windows column filled in by inference,
and the two must not be confused.

---

## 3. Every Windows value in the table is unverified

`measuredOn` in `src/clients.json` currently says `["linux"]` and nothing else.
Treat the entire `win32` column as inference until measured. Here it is in full,
so that nothing gets missed.

### 3.1 Rows with a Windows path (12)

Each of these must be checked in both directions: **does the file live there,
and is that the file the application actually reads?**

| client | `configPaths.win32` | format | root key | written by |
|---|---|---|---|---|
| `claude-code` | `~/.claude.json` | json | `mcpServers` | its own CLI |
| `gemini-cli` | `~/.gemini/settings.json` | json | `mcpServers` | us, by file |
| `codex-cli` | `~/.codex/config.toml` | toml | `mcp_servers` | its own CLI |
| `goose` | `%APPDATA%\Block\goose\config\config.yaml` | yaml (map) | `extensions` | us, by file |
| `copilot-cli` | `~/.copilot/mcp-config.json` | json | `mcpServers` | us, by file |
| `vscode` | `%APPDATA%\Code\User\mcp.json` | jsonc | `servers` | its own CLI |
| `cursor` | `~/.cursor/mcp.json` | json | `mcpServers` | us, by file |
| `claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json` | json | `mcpServers` | us, by file |
| `kimi-code` | `~/.kimi-code/mcp.json` | json | `mcpServers` | us, by file |
| `continue` | `~/.continue/config.yaml` | yaml (list) | `mcpServers` | us, by file |
| `warp` | `~/.warp/.mcp.json` | json | `mcpServers` | us, by file |
| `junie` | `~/.junie/mcp/mcp.json` | json | `mcpServers` | us, by file |

Note the `~/…` rows. On Windows those expand to `%USERPROFILE%\…` via
`expandPath` (`src/clients.js:106`). Several of them are *probably* right because
the vendor uses the same relative path on every platform — but "probably" is the
word this project does not accept, and a handful of these tools may not exist on
Windows at all, which is also a finding worth writing down.

### 3.2 Rows that say nothing about Windows (8)

`opencode`, `kiro`, `lmstudio`, `roo-code`, `amazon-q`, `devin-desktop`, `zed`,
`cline`.

Their `configPaths.win32` is `null`, which the code reads as **"not on this
platform"** and skips silently. That is the honest value for a path nobody has
measured, and it is also indistinguishable from "this application does not run on
Windows". For each of the eight, the question is which of those two it is. If any
of them is installed on that Windows machine, `nosyparker setup` will currently
walk straight past it and report it as not present — correct behaviour for an
unknown path, wrong answer for the person.

### 3.3 Second surfaces and extra paths

- **Cursor's second surface** — `alsoRemoveFrom[0].path.win32` is
  `%APPDATA%/Cursor/User/settings.json`, root key `mcp.servers`, `measuredOn:
  ["linux"]`. Inferred from where the Linux build keeps user settings. Unverified.
- **`kiro.extraConfigPaths`** — `~/.kiro/settings/mcp.json`. A single string with
  no per-OS map at all, so it resolves under `%USERPROFILE%` on Windows whether
  that is right or not.
- **`devin-desktop.extraConfigPaths`** — `~/.codeium/windsurf/mcp_config.json`.
  Same shape, same caveat. We do not write this one; we name it.

---

## 4. Things we know are unresolved on Windows

These are not guesses about how Windows behaves. They are places where our own
code makes a decision that has only ever been exercised on Linux, quoted so the
Windows session can go and look.

### 4.1 `nosyparker.cmd` and the `invocation()` branch

`src/clients.js:242`. Every sentence this program prints back to a person — "run
`nosyparker setup`" versus "run `node C:\…\cli.js setup`" — comes from here. It
takes the basename of `process.argv[1]` under **both** POSIX and Windows rules and
matches it against `nosyparker` and `nosyparker.cmd`.

The comment above it records a belief that on Windows npm writes a `.cmd` wrapper
which runs the script directly, so `argv[1]` is the JS file and the function falls
through to the path form. **That belief has never been tested.** Print
`process.argv[1]` from a global install and find out what is actually there. If
the `.cmd` branch is unreachable, the branch is wrong; if `argv[1]` is something
neither branch expects, every printed instruction on Windows is wrong.

### 4.2 The `_npx` guard and backslashes

`src/setup.js:167`, `NPX_CACHE = /(^|[/\\])_npx[/\\]/u`. It refuses to write
config entries pointing into an npx cache directory, because those rot silently
across versions. It was fixed this round to accept both separators — on the
reasoning that a Windows cache path uses `\` — but the fix was written and tested
on Linux. Run `npx nosyparker setup` on Windows, see where npx actually puts the
package, and confirm the refusal fires. Then confirm it does **not** fire on an
ordinary global install path.

### 4.3 Does `%APPDATA%` resolve where we think

`expandPath` (`src/clients.js:106`) reads `%APPDATA%` from the environment and
falls back to `path.join(home, 'AppData', 'Roaming')`. Four rows depend on it.
Check the fallback too, by running with `APPDATA` unset. Note also that the table
is internally inconsistent about separators — `%APPDATA%\Code\User\mcp.json` with
a backslash, `%APPDATA%/Cursor/User/settings.json` with a forward slash. The code
splits on both, so both should work; confirm that they do, because if they do not
then one of the two families is silently writing nothing.

### 4.4 Read-only files and unwritable directories

`readOnlyRefusal` (`src/write.js:691`) checks `mode & 0o200` and refuses to touch
a file somebody has protected. `cleanSecondSurfaces` (`src/setup.js:296`) does the
same for second surfaces. Both were measured with `chmod` on Linux.

Windows permissions are ACLs; the mode bits Node reports are a translation of
them, and how a file marked read-only in Explorer or via `attrib +r` appears in
`fs.statSync().mode` is exactly the sort of thing this project does not assume.
Test all of it: a read-only file, a read-only directory, and a directory the user
cannot write. `writePreservingMode` (`src/write.js:527`) writes to a temporary
file in the same directory and renames over the target — check that the rename
succeeds when the target exists, which is where POSIX and Windows differ most.

### 4.5 Does `process.execPath` produce a path the clients accept

`src/clients.js:216` writes `process.execPath` into every config entry as the
command to run — the full path to the running Node binary, deliberately, because
an application started from a desktop icon has no `PATH` to find `node` on.

On Windows that is something like `C:\Program Files\nodejs\node.exe`. Whether the
clients accept a command containing spaces, drive letters and backslashes — and
whether they need it quoted, escaped, or given as `node.exe` — is unknown. This is
the single highest-value thing to check, because every written entry contains it
and a wrong value means twenty configs that look right and start nothing.

### 4.6 Also unresolved, found while writing this

Not on the original list, but visible in the source and on the same footing:

- **Finding a client's command.** `onPath` (`src/detect.js:209`) joins a directory
  with the bare command name and asks whether that file exists. Nothing appends
  `.cmd`, `.exe` or `.ps1`, and nothing consults `PATHEXT`. Whether that finds
  anything on Windows decides whether detection works at all.
- **The running-application check is switched off.** `src/detect.js:120` returns
  `null` for `win32` outright — the process list is never read. Claude Desktop and
  Devin rewrite their config wholesale from memory, so an entry written while they
  run is lost; on Linux setup refuses and says so. On Windows the answer is
  "unknown", so it writes anyway and says it could not check. That is the designed
  behaviour for an unanswerable question, but it means the Windows session must
  test the running case by hand and decide whether an answer is available there.
- **Running a vendor command.** `src/write.js:740` calls `spawnSync(command, …)`
  with a bare name and no `shell`. Five clients are written or verified through
  their own CLI. Whether that reaches a `.cmd` shim on Windows must be measured,
  not reasoned about.
- **Symlinks.** `resolveTarget` follows links so that a config in a dotfiles
  repository is written through rather than replaced. Windows has junctions and
  symlinks with different rules and different permissions. If the machine has none
  of these, say so — "not tested, no such arrangement present" is a real result.

---

## 5. The rules this work runs under

These are not style preferences. Every one of them was written after something
went wrong.

1. **Measure, do not assume.** If a claim cannot be traced to a command that was
   run and an output that was read, it is not established. Write `[UNCONFIRMED]`
   and move on — an honest gap costs an afternoon, a confident guess costs
   somebody's config file.
2. **A check is not finished until it has been made to fail on purpose.** Break
   the thing the check exists to catch and watch the check catch it. This round,
   six fixes out of sixteen turned out to be held by no test at all, and one test
   written specifically to hold a three-part condition passed by a different
   accident for each of its three cases. A green suite proves nothing on its own.
3. **Never delete another program's config file.** Only ever remove our own entry
   from inside it. If our entry cannot be found, the correct outcome is to say so
   and change nothing — not to tidy up, not to rewrite the file, not to remove a
   container we did not create.
4. **Back up before touching anything.** Every file this program edits goes
   through `recordFirstTouch` first, which copies it and writes a manifest row.
   That is the mechanism `uninstall` uses to put things back. Code that writes
   without it is a defect regardless of whether the write succeeded — that exact
   bug reached a release this month.
5. **Anything ambiguous gets left alone and named.** Never resolve an uncertainty
   by acting on it.
6. **Do a dry run in a scratch profile first.** A fresh Windows user account, or a
   `HOME`/`USERPROFILE` pointed somewhere disposable. Do not make the owner's real
   configuration the first thing this touches on a new platform.

---

## 6. What to report back

The results are going into `src/clients.json`, so report in the shape the table
needs. For each client:

- **Client id**, exactly as in the table.
- **Installed on this machine?** Yes / no. A "no" is a useful result and should be
  recorded as one.
- **What the vendor's own command did**, if it has one — the command run, its exit
  code, and *every file under the profile that changed as a result*. This is the
  step that found the Cursor bug; it is not optional.
- **The real path**, absolute, with `%APPDATA%` or `%USERPROFILE%` put back in.
- **The real root key and entry shape**, copied out of the file rather than
  described.
- **Whether the client can be asked if it loaded the server**, and what it said.
- **Confidence marker**: `[MACHINE]`, `[BINARY]`, `[DOCS]`, `[SECONDARY]` or
  `[UNCONFIRMED]`, matching the legend in `PHASE3-RESEARCH.md`.

Plus one answer for each of the six items in section 4, and a plain list of
anything that behaved in a way this document did not anticipate.

### The `lastVerified` discipline

A path is not "verified" because somebody looked at it. Folding results in means:

- `configPaths.win32` set to what was measured, or left `null` with a note saying
  the client is absent rather than unknown — those are different and the table has
  to keep them apart.
- `lastVerified.configPaths` (and `.write`, `.verify`, `.traps` as applicable) set
  to the date of the measurement, in `YYYY-MM-DD`.
- `alsoRemoveFrom[].measuredOn` extended to `["linux", "win32"]` **only for a
  surface actually watched on Windows**. `validateTable` refuses an empty
  `measuredOn`; it cannot refuse a dishonest one.
- `CLIENTS.md` updated in the same commit if the finding changes what a person is
  told — it is the living document, and `PHASE3-RESEARCH.md` is frozen.
- A test that fails without the change, as for everything else here.

Anything measured on Windows that contradicts the Linux row is a finding about the
Linux row too. Say so loudly rather than adding a special case.
