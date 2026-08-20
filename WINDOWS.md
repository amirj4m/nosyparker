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

## 2. Before you start

You need Node **22.5.0 or newer** — `node:sqlite` arrived in 22.5.0 and this
program is built on it. Check with `node --version` before anything else; an
older Node fails on an import with a message that does not name this program.

```
git clone https://github.com/amirj4m/nosyparker.git
cd nosyparker
npm ci
```

Then, **before touching a single configuration file**, establish a baseline:

```
npm test
npm run typecheck
```

On Linux that is 455 tests passing and a silent typecheck. **Whatever it does on
Windows is your first finding, and it is worth writing down before you do
anything else** — including if it is a clean pass. A suite that fails here tells
you which of the sections below to read first; a suite that passes tells you the
failures you find later are real rather than environmental. If something fails,
record the test name and the message verbatim and keep going. A failing suite is
not a reason to stop; it is data.

Run one file at a time with `node --test test/setup.test.js`.

### The commands this program has

`setup`, `uninstall`, `doctor`, and then the store itself: `add`, `search`,
`list`, `log`, `forget`, `restore`, `undo-review`, `export`. There is no
`--help`; an unknown command says so and exits non-zero.

**The one to start with is `nosyparker setup --print-config`.** It prints the
entry that *would* be written for each detected client and **writes nothing to
any file**. Give it a client id to narrow it: `nosyparker setup --print-config
cursor`. It is the only way to see what this program thinks about a machine
without letting it act, and every question in section 5 can be partly answered
with it before anything is written. Use it first, every time.

To get the `nosyparker` command itself, install the clone globally:

```
npm install -g .
```

Whether that puts a working command on `PATH` is itself one of the things being
measured — see 7.1.

---

## 3. A scratch profile, and the owner's store

**Do not make the owner's real Windows profile the first thing this touches.**
Use a throwaway Windows user account, or redirect what the program reads:

- The store: `NOSYPARKER_STORE` is read by `defaultStorePath`
  (`src/config.js:35`) and overrides the store location outright. Set it.
- Home: everything else is derived from `os.homedir()`, and `%APPDATA%` from
  `process.env.APPDATA` (`src/clients.js:106`). Whether setting `USERPROFILE`
  or `APPDATA` actually moves them on Windows is a thing to **check, not
  assume** — print `node -p "require('os').homedir()"` with your variables set
  and confirm it moved before you rely on it. If it does not move, use a
  separate Windows account instead. Do not proceed on the assumption.

Two rules about the store while you work:

1. **Use a store you create for this.** Not the owner's.
2. **Put nothing real about him in it.** Test sentences should be obviously
   invented. The store is shared between every agent on a machine and this one
   is being thrown away afterwards.

---

## 4. What we established on Linux, and how

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

---

## 5. The run sheet

The order matters. Each step is safe to stop after, and each one makes the next
one interpretable. Do not skip ahead to `setup` — by the time it has run, the
machine is no longer clean and the most valuable measurement of the day is gone.

**Step 1 — snapshot a clean profile.** Before any AI tool has been asked to add
anything. You need, for every file under the profile: its path, size,
modification time, and a hash of its contents. Size and mtime alone miss a
rewrite that happens to preserve both, which is a thing this project has already
been bitten by.

Pick your own tool. This one has never been run by us, so **try it on a
directory you control and confirm the output is what you expect before pointing
it at a profile you care about**:

```
Get-ChildItem -Path $env:USERPROFILE -Recurse -File -Force -ErrorAction SilentlyContinue |
  Get-FileHash -Algorithm SHA256 |
  Export-Csv -NoTypeInformation before.csv
```

**Step 2 — what is installed.** `nosyparker setup --print-config`, which writes
nothing. Record which clients it detects and which it does not. Then check by
hand which of the twenty are *actually* installed, because a client that is
present and undetected is a finding (see 7.6 on how commands are looked for) and
a client that is absent is a finding too (see 6.2).

**Step 3 — the vendor commands, one at a time.** For each client that has one:
run its own MCP-add command by hand, snapshot again, and diff against step 1.
**Every file that changed, not the one the documentation names.** This is the
step that found the Cursor bug and it is the reason the day is worth doing.
Undo each one before the next, so you always know which command caused what.

**Step 4 — `nosyparker setup`.** Now let this program do it. Snapshot, diff,
and compare what it wrote against what step 3 showed the vendor writing. Where
they disagree, the vendor is right and our table is wrong.

**Step 5 — does anything actually work.** Open a client and ask its agent
something only the shared memory could answer. Store a sentence first with
`nosyparker add "the test sentence"`. Then `nosyparker doctor` and record every
line of it. An entry that is written and does not load is the failure mode this
whole program exists to catch, and it looks identical to success from the file.

**Step 6 — `nosyparker uninstall`.** Snapshot, diff. The promise is that every
file it touched is back to what step 1 recorded, apart from our entry being
gone. Check that literally, file by file, against the hashes. A file that came
back *different* is the most serious thing you could find.

**Step 7 — the six areas in section 7.** With a machine you now understand.

Anything unexpected at any step: write it down and keep going. Do not stop to
fix the program unless it is doing damage — measuring is today's job, and a
long list of honest observations is worth more than one fix and no measurements.

## 6. Every Windows value in the table is unverified

`measuredOn` in `src/clients.json` currently says `["linux"]` and nothing else.
Treat the entire `win32` column as inference until measured. Here it is in full,
so that nothing gets missed.

### 6.1 Rows with a Windows path (12)

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

### 6.2 Rows that say nothing about Windows (8)

`opencode`, `kiro`, `lmstudio`, `roo-code`, `amazon-q`, `devin-desktop`, `zed`,
`cline`.

Their `configPaths.win32` is `null`, which the code reads as **"not on this
platform"** and skips silently. That is the honest value for a path nobody has
measured, and it is also indistinguishable from "this application does not run on
Windows". For each of the eight, the question is which of those two it is. If any
of them is installed on that Windows machine, `nosyparker setup` will currently
walk straight past it and report it as not present — correct behaviour for an
unknown path, wrong answer for the person.

### 6.3 Second surfaces and extra paths

- **Cursor's second surface** — `alsoRemoveFrom[0].path.win32` is
  `%APPDATA%/Cursor/User/settings.json`, root key `mcp.servers`, `measuredOn:
  ["linux"]`. Inferred from where the Linux build keeps user settings. Unverified.
- **`kiro.extraConfigPaths`** — `~/.kiro/settings/mcp.json`. A single string with
  no per-OS map at all, so it resolves under `%USERPROFILE%` on Windows whether
  that is right or not.
- **`devin-desktop.extraConfigPaths`** — `~/.codeium/windsurf/mcp_config.json`.
  Same shape, same caveat. We do not write this one; we name it.

---

## 7. Things we know are unresolved on Windows

These are not guesses about how Windows behaves. They are places where our own
code makes a decision that has only ever been exercised on Linux, quoted so the
Windows session can go and look.

### 7.1 `nosyparker.cmd` and the `invocation()` branch

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

### 7.2 The `_npx` guard and backslashes

`src/setup.js:167`, `NPX_CACHE = /(^|[/\\])_npx[/\\]/u`. It refuses to write
config entries pointing into an npx cache directory, because those rot silently
across versions. It was fixed this round to accept both separators — on the
reasoning that a Windows cache path uses `\` — but the fix was written and tested
on Linux. Run `npx nosyparker setup` on Windows, see where npx actually puts the
package, and confirm the refusal fires. Then confirm it does **not** fire on an
ordinary global install path.

### 7.3 Does `%APPDATA%` resolve where we think

`expandPath` (`src/clients.js:106`) reads `%APPDATA%` from the environment and
falls back to `path.join(home, 'AppData', 'Roaming')`. Four rows depend on it.
Check the fallback too, by running with `APPDATA` unset. Note also that the table
is internally inconsistent about separators — `%APPDATA%\Code\User\mcp.json` with
a backslash, `%APPDATA%/Cursor/User/settings.json` with a forward slash. The code
splits on both, so both should work; confirm that they do, because if they do not
then one of the two families is silently writing nothing.

### 7.4 Read-only files and unwritable directories

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

### 7.5 Does `process.execPath` produce a path the clients accept

`src/clients.js:216` writes `process.execPath` into every config entry as the
command to run — the full path to the running Node binary, deliberately, because
an application started from a desktop icon has no `PATH` to find `node` on.

On Windows that is something like `C:\Program Files\nodejs\node.exe`. Whether the
clients accept a command containing spaces, drive letters and backslashes — and
whether they need it quoted, escaped, or given as `node.exe` — is unknown. This is
the single highest-value thing to check, because every written entry contains it
and a wrong value means twenty configs that look right and start nothing.

### 7.6 Also unresolved, found while writing this

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

## 8. What a finished measurement looks like

"I looked at it" is not a measurement. For a **client row**, finished means all
six of these, or an explicit note saying which is missing and why:

1. Whether the application is installed on this machine — yes or no.
2. If it has an MCP-add command of its own: the command, its exit code, and
   every file under the profile that changed when it ran.
3. The absolute path of the file it actually reads, with `%APPDATA%` or
   `%USERPROFILE%` put back in place of the expanded value.
4. The root key and the exact entry shape, **copied out of the file**, not
   described from memory.
5. Whether the client can be asked if it loaded the server, and what it said
   when asked.
6. A confidence marker from the legend in `PHASE3-RESEARCH.md`.

For an **item in section 7**, finished means: the command you ran, the output
you got, and a plain statement of which of the two possible answers it is. If
the answer is "it depends" or "I could not tell", that is a finished measurement
too — write it as one. `[UNCONFIRMED]` is a real result and this project treats
it as one.

Nothing is finished on reasoning alone. If a claim cannot be traced to a command
that was run and an output that was read, it is not established, however obvious
it seems.

---

## 9. Undoing anything

Know this before you write to a real file, not after.

**Every file this program edits is copied first.** The copies and the record of
them are in `%USERPROFILE%\.nosyparker\backups`, with `manifest.json` listing,
for each file: where it was, where its copy is, whether it existed before we
touched it, and whether the container we wrote into was already there. That
manifest is how `uninstall` knows what it may put back — read it before trusting
it, and note that a file the program *chose* not to copy is recorded with the
reason rather than a bare null.

**`nosyparker uninstall`** removes our entry from every client it wired and
cleans the second surfaces it knows about. It does not touch the store.

**Every run writes a log** to `%USERPROFILE%\.nosyparker\actions.log`, and
`nosyparker log` prints it. If something went wrong and you cannot tell what happened, that
file is the record of it, including files skipped and why.

**The store** is a single SQLite file — delete it and it is gone. Individual
memories are removed by `scripts/purge.mjs`, which needs `--id` and `--yes`
together, is the only thing in this project that deletes anything, and refuses
to run unless a person started it.

**What is not automatic:** a file some *vendor command* wrote in step 3 of the
run sheet is not ours and has no backup here. Undo those yourself, one at a
time, which is why the run sheet says to do them one at a time.

---

## 10. The rules this work runs under

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

## 11. What to report back, and where to put it

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

Plus one answer for each of the six areas in section 7, and a plain list of
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

### Where to put it

**Nobody can be asked anything mid-run.** That session is on another operating
system, and this one will not see its questions. So the findings have to survive
on their own, in the repository:

1. Work on a branch. `git checkout -b windows-measurements`. Never commit to
   `main` — that rule holds on every platform.
2. Write the findings into a new file, `WINDOWS-FINDINGS.md`, in the shape
   section 8 asks for. Prose is fine; completeness is not optional.
3. Do **not** add it to `package.json`'s `files`. It is our working note, not
   something a person who installed a memory store should receive. `files` is a
   whitelist so it stays out by default, and a test in `test/package.test.js`
   fails if any markdown outside the four shipped documents reaches the
   tarball — you do not have to do anything, but do not undo it.
4. Commit and push as you go, not at the end. A day's measurements lost to a
   crashed session is a day.
5. Change `src/clients.json` only where something was actually measured, and
   only with the `lastVerified` discipline below. **Do not touch the Linux
   column.** If a Windows measurement contradicts a Linux row, say so in the
   findings; do not edit the Linux value on the strength of a Windows run.
6. Anything that changes behaviour needs a test that fails without it. That
   rule does not relax because the platform is new.

### What not to do

- **Do not publish anything.** Not `npm publish`, not a release, not a tag.
  0.0.2 is published by the owner himself with his security key, and the
  Windows results become a later version.
- **Do not delete another program's configuration file.** Ever, for any reason.
  Only our entry inside it.
- **Do not fix the table from documentation** when a measurement is
  inconvenient. An `[UNCONFIRMED]` is worth more than a plausible guess, and
  this whole document exists because three vendors' documentation was wrong
  about their own products.
- **Do not act on an ambiguity to resolve it.** Leave it and name it.
