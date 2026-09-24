# Windows and macOS: what has to be established before anyone is told this works there

**Status, 24 September 2026.** Nothing in `src/clients.json` has been watched
working on Windows or macOS. Every macOS path (14 rows) and every Windows path
(12 rows) is the standard location for that platform, taken from the
vendor's documentation, and marked as inference. Linux is the only platform
any of it has been watched on. This is the one thing standing between the
project and a public audience, and this file is the plan for closing it. It
replaces the earlier `WINDOWS.md` brief, of which nothing had been done.

It is not in the package (`package.json`'s `files` list), and a test holds
that: it is a working document, not something a person who installed a memory
store should find on their disk.

## What the question is, per row

A row makes three claims about a platform, and they are separate:

1. **The path is where the client reads.** Wrong path: nothing is written,
   nothing is removed, the client is reported as not installed. It cannot
   damage a file it never opens — but it also does nothing, and says nothing
   about it beyond "not on this machine".
2. **The write lands and reads back** through the client's own command where
   the row says `cli`, or through our own splice where it says `file`.
3. **The client loads it.** Only the 7 rows with a command to ask —
   `claude-code`, `gemini-cli`, `codex-cli`, `goose`, `opencode`, `hermes`, `openclaw` — can be checked by a program.
   For the rest the only test is opening the application and asking the agent
   something it could only know from the shared memory.

Claim 1 is the one nobody has measured anywhere but Linux. Claims 2 and 3
follow from it and cannot be tested until it holds.

## What a CI runner can establish, and does

`test.yml` runs the whole suite on `windows-latest` and `macos-latest` on
every push, non-blocking until it is green there. The first runs, on
24 September 2026:

- **macOS: green.** 556 pass, 1 skipped (`/dev/full` is a Linux device). The
  suite exercises the writer, the splice, the backup and manifest, the
  symlink handling, the store, the gate and the MCP server on a real macOS
  filesystem, and all of it holds. What that does *not* say: whether the
  14 macOS paths are where those applications read. Nothing on a runner can.
- **Windows: 62 of 259 failed before the job was stopped, and the first run
  before that passed by running zero tests** — PowerShell handed the
  single-quoted glob to Node as a literal, which is fixed. Of the 62, three
  are real:
  - **Line endings.** A checkout with `autocrlf` turned CLIENTS.md and
    DECISIONS.md into CRLF, so every check that splits them on blank lines
    misread them, and `vendor/clients.json` no longer matched its recorded
    hash. Fixed with `.gitattributes` (`eol=lf`), which is what any Windows
    contributor needs as well.
  - **File modes.** The action log and the backup copies are written with
    mode `0600`, and the test that holds the log's mode fails on Windows
    because there is no such mode there: Node reports `0666`-shaped bits and
    the real protection is the user profile's ACL. The README's wording now
    says so. Nothing to fix in code; a claim to state correctly.
  - **Argument length.** One test passes a 120 KB query as a single argument,
    which Windows refuses at 32 KB (`ENAMETOOLONG`). The program's bound is
    on the query, not the argument, so this is a test to rewrite, not a limit
    to change — and a Windows user cannot type a 120 KB argument either.

  The other 59 are the test harness assuming POSIX: fixtures built on
  `/home/p` compared against `path.join` output (backslashes), `/bin/sh` in
  the pipe tests, `ps -o` in the memory watcher, temporary stores deleted
  while a child process still holds them (`EBUSY`), regular expressions built
  from Windows paths, and `import.meta.url.pathname` (`D:\D:\…`). None of
  them is a product defect; all of them stop the column from being a signal.

**So the cheapest path to a launch-ready answer is not what it looked like.**
CI can prove the program's own behaviour on both platforms — and after one
day it already has on macOS — but it cannot prove the 26 paths, and the
paths are the claim. A runner has none of these applications installed and
no way to ask them. The runners are worth keeping green because they catch the
next line-ending or path-separator mistake for free; they do not replace the
run sheet below.

## Work the runners need before they can gate

In order, each small:

1. Make the harness platform-neutral: build fixtures with `path.join(home, …)`
   rather than `/home/p` literals; compare paths after `path.normalize`; use
   `process.execPath` with `-e` where `/bin/sh -c` is used; skip the memory
   watcher where `ps -o` is not available; close and wait for child processes
   before removing their store; escape paths that go into regular expressions;
   use `fileURLToPath` rather than `.pathname`.
2. Move the 120 KB argument test to pass the query through stdin or a file.
3. Turn `continue-on-error` off, one platform at a time, once each is green.

None of that changes what ships. It is a day of test work.

## The run sheet: what needs a person and a real machine

One person, one machine per platform, the applications installed. Use a
throwaway user account or a `NOSYPARKER_STORE` of its own; put nothing real in
the store. For each row present on that machine:

1. `nosyparker setup --print-config <id>` — read the path it *would* write.
   Compare with where the application's own settings or documentation says it
   reads. That answers claim 1 without writing anything.
2. `nosyparker setup` — read which group the row lands in and what it says.
3. Open the application, start a fresh session, and ask the agent something
   only the shared memory knows. That answers claim 3, for every row, including
   the 12 that no command can answer.
4. `nosyparker doctor`, then `nosyparker uninstall <id>`, then the application
   again to confirm the entry is gone and nothing else in its settings moved.
5. Record the outcome in the row: move the platform into `lastVerified`, and
   for a second surface flip `inferred` to `false` and add the platform to
   `measuredOn`. The documentation checks and the table loader hold the rest
   of the document to that change.

A row whose path is wrong is corrected in the table with what was measured,
and the divergence from the community table, if any, is recorded in
`vendor/clients.meta.json` with the reason.

## The rows, and where each stands

Every path below is inferred until the row says otherwise. A `—` is a row the
research could not establish a path for on that platform: the program reports
the client as one it has no path for rather than guessing.

| id | client | macOS path | Windows path | write | verify |
|---|---|---|---|---|---|
| `claude-code` | Claude Code | `~/.claude.json` | `~/.claude.json` | cli | cli-lines |
| `gemini-cli` | Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/settings.json` | file | cli-lines |
| `codex-cli` | Codex CLI | `~/.codex/config.toml` | `~/.codex/config.toml` | cli | cli-json |
| `goose` | Goose | `~/.config/goose/config.yaml` | `%APPDATA%\Block\goose\config\config.yaml` | file | cli-lines |
| `copilot-cli` | GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `~/.copilot/mcp-config.json` | file | file-reread |
| `opencode` | opencode | `~/.config/opencode/opencode.jsonc` | — | file | cli-lines |
| `kiro` | Kiro | — | — | file | file-reread |
| `lmstudio` | LM Studio | — | — | file | file-reread |
| `roo-code` | Roo Code | — | — | file | file-reread |
| `amazon-q` | Amazon Q Developer CLI | `~/.aws/amazonq/mcp.json` | — | file | file-reread |
| `vscode` | VS Code | `~/Library/Application Support/Code/User/mcp.json` | `%APPDATA%\Code\User\mcp.json` | cli | file-reread |
| `cursor` | Cursor | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` | file | file-reread |
| `devin-desktop` | Devin Desktop (formerly Windsurf) | — | — | cli | file-reread |
| `claude-desktop` | Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | file | file-reread |
| `zed` | Zed | — | — | file | file-reread |
| `kimi-code` | Kimi Code | `~/.kimi-code/mcp.json` | `~/.kimi-code/mcp.json` | file | file-reread |
| `cline` | Cline | — | — | file | file-reread |
| `continue` | Continue | `~/.continue/config.yaml` | `~/.continue/config.yaml` | file | file-reread |
| `warp` | Warp | `~/.warp/.mcp.json` | `~/.warp/.mcp.json` | file | file-reread |
| `junie` | JetBrains Junie | `~/.junie/mcp/mcp.json` | `~/.junie/mcp/mcp.json` | file | file-reread |
| `hermes` | Hermes | — | — | file | cli-lines |
| `openclaw` | OpenClaw | — | — | cli | cli-lines |

Second surfaces: Cursor's `settings.json` is inferred on both platforms; Kiro's
inherited file has no path on either.

## Things known to differ on Windows, from reading the code rather than running it

- `%APPDATA%` is read from the environment and falls back to
  `~\AppData\Roaming`; both are exercised by unit tests with a fake machine.
- Whether an application is running is asked with `ps`, which does not exist
  on Windows; the program already answers "unknown" there and writes anyway,
  saying it could not check. Claude Desktop and Devin rewrite their files from
  memory while running, so on Windows that protection is absent until
  `tasklist` is used instead. Worth doing before Windows is called supported.
- Read-only files: Node maps the read-only attribute to a missing write bit,
  so the refusal should work; unverified.
- The `nosyparker.cmd` shim: `invocation()` handles it by name; whether npm's
  shim on the machine is what a person types is one of the things to watch.
- Symlinked configs need a privilege Windows does not grant by default; a
  config that is a symlink is unusual there and the code follows links where
  it can.

## What "supported" will mean when it is said

A platform is called supported in the README when: the runner column is green
and gating; every row with a path on that platform has been through the run
sheet at least once, with the date in `lastVerified`; and the rows that could
not be measured say `null` rather than a guess. Until then the README says
what it says today — Linux is the only platform this has been watched on.
