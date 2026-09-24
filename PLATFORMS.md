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

## The two sessions, prepared

Both sessions use one script, `scripts/platform-check.mjs`, which reads and
prints and never writes: what the table claims about the machine it is on,
whether the machine agrees, and after `setup` whether each entry landed. It
is not in the package. The paid or evening hours go on running things and
reading output; nothing has to be worked out live.

The sequence is the same on both platforms. It is written for somebody at a
keyboard late in the day: type each line, read what it prints, write down what
it says, move on. Nothing in it asks for a judgement until step 8, and that
one is yes or no.

**Before you start:** have the accounts and keys for the applications you will
sign in to ready in a password manager, and have the applications you want
tested installed and opened once. Quit Claude Desktop and Devin if they are
running. Use PowerShell on Windows and Terminal on macOS; `~` below means your
home folder.

1. Get the code and run its tests. Let the tests run to the end even if they
   fail — a failure is the first finding, not a reason to stop:
   ```
   git clone https://github.com/amirj4m/nosyparker.git
   cd nosyparker
   npm ci
   npm test
   ```
   **Record:** the last five lines (`# tests`, `# pass`, `# fail`…), and every
   `not ok` line, pasted verbatim.

2. Make the results table and see what the table thinks of this machine:
   ```
   node scripts/platform-check.mjs --template > results.md
   node scripts/platform-check.mjs
   ```
   **Record:** nothing yet. Read it. Every row says *not installed*, *file
   exists*, *file absent*, or *installed, path unknown*; the last kind is a
   row you can add by finding where that application keeps its MCP settings.

3. Install the published copy — not the checkout — and see what it would write:
   ```
   npm install -g nosyparker
   nosyparker --version
   nosyparker setup --print-config
   ```
   **Record:** for each installed row, does the path `--print-config` prints
   match where the application actually keeps its MCP settings? Open the
   application's own settings or its documentation for the platform you are
   on. Fill the *table path right?* column: `yes`, or `no` plus the real path
   in the next column. This is the column the whole exercise is for.

4. Wire everything:
   ```
   nosyparker setup
   node scripts/platform-check.mjs --after-setup
   ```
   **Record:** from `setup`, which group each row landed in (answered /
   written but unconfirmed / not done, with its reason); from the script, `ok`
   or `FAIL` per row into *setup wrote*.

5. Store the test phrase — the store is empty on a fresh machine and the agents
   need something to find:
   ```
   nosyparker add "the test phrase is purple giraffe"
   nosyparker list
   ```

6. Open each application in turn, start a new session, and ask it: *what is the
   test phrase?* The `--after-setup` output says, per row, how to restart it.
   For the ones a command can ask, the command is in that output too and
   `setup` already ran it. **Record:** *agent answered* as `yes` (it said purple
   giraffe), `no` (it did not, or said it has no such tool), or `no account`
   (you could not sign in). A `no` is a finding; write what it said instead.

7. Ask the program what it thinks now, then take everything out again:
   ```
   nosyparker doctor
   nosyparker uninstall
   node scripts/platform-check.mjs --after-uninstall
   ```
   **Record:** *uninstall clean* per row from the script, and whether `doctor`
   said anything you disagree with.

8. Look at `results.md`. Every row you touched has every column filled with a
   word, not a dash. Save it, and the `npm test` output from step 1, and send
   both back. The only judgement in the whole sheet is step 3's yes/no, and
   the real path if no.

Put nothing real in the store: "the test phrase is purple giraffe" is the only
sentence to store, and the test store is removed afterwards with
`nosyparker uninstall` and by deleting `~/.nosyparker`. Use a throwaway user
account on Windows if the machine is shared.

### macOS: a rented machine, once

**Providers that bill for a day rather than a month**, at the time of writing
— confirm prices before paying, they move:

- **Scaleway Apple silicon** (Mac mini M2 or M4): hourly rate with a
  24-hour minimum per instance, in the region of €3–6 for the mandatory
  day. SSH and VNC out of the box, a current macOS image, no account
  commitment beyond the day. The cheapest realistic option and the one to
  try first.
- **AWS EC2 Mac** (`mac2`, `mac2-m2`): a dedicated host with a 24-hour
  minimum allocation, roughly $16–21 for that day at on-demand rates, plus
  the usual AWS account setup and a VNC session to configure. Fine if he
  already lives in AWS; otherwise more setup than Scaleway for more money.
- **MacinCloud** pay-as-you-go: about a dollar an hour but sold as a prepaid
  block (around $30 for 30 hours), with a web or RDP desktop. Reasonable if
  a GUI with no setup matters more than the price.
- **MacStadium** and the like: monthly. Not for this.
- **A GitHub Actions macOS runner** is free for a public repository and is
  already running the suite. It cannot do this session: it has no signed-in
  applications and no screen, and every row below needs one or both. It is
  the right tool for claim 2 automation later, not for this.

**Expect: one day's rent, three to four hours of his time**, most of it
installing fourteen applications and signing in to them, not running our
commands. A cloud Mac is a bare machine; everything the table names has to be
put on it first. Prepare on his own machine beforehand: the list of accounts
and API keys he will sign in with, in a password manager, so that the paid
hour is not spent on password resets.

**Which of the fourteen macOS rows this can close.** All fourteen have a path
in the table, and all fourteen applications install on a fresh Mac with a
screen. Claim 1 (the path) and claim 2 (the write lands) close for every row
that is installed and opened once — no account is needed for an application
to create its settings directory. Claim 3 (the agent loads it) needs the
agent to run, which needs an account or a key:

| row | install with | needs, for claim 3 | claim 3 checkable by |
|---|---|---|---|
| `claude-code` | `npm i -g @anthropic-ai/claude-code` | Anthropic account or key | `claude mcp list` — the program asks |
| `gemini-cli` | `npm i -g @google/gemini-cli` | Google account or API key | `gemini mcp list` — the program asks; trust the folder first |
| `codex-cli` | `npm i -g @openai/codex` | OpenAI account or key | `codex mcp list` — the program asks |
| `goose` | `brew install block-goose-cli` | any LLM key | `goose mcp list` — the program asks |
| `opencode` | `brew install opencode` | any LLM key | `opencode mcp list` — the program asks |
| `copilot-cli` | `npm i -g @github/copilot` | GitHub Copilot subscription | ask the agent |
| `amazon-q` | `brew install --cask amazon-q` | AWS Builder ID | ask the agent |
| `vscode` | `brew install --cask visual-studio-code` | GitHub account for Copilot Chat | ask the agent; check the four `chat.mcp` settings |
| `cursor` | `brew install --cask cursor` | Cursor account | ask the agent; the second surface is inferred here too |
| `claude-desktop` | `brew install --cask claude` | Anthropic sign-in — it starts no server before | ask the agent; quit it before setup |
| `kimi-code` | its installer | Moonshot account | ask the agent |
| `continue` | VS Code extension | any LLM key | ask the agent |
| `warp` | `brew install --cask warp` | Warp account | ask the agent |
| `junie` | a JetBrains IDE + the Junie plugin | JetBrains account and AI licence | ask the agent |

So the honest count: **fourteen paths closable, and claim 3 for as many of
the fourteen as he has accounts for** — on Linux he has seventeen clients
wired, so most. Five of the fourteen answer the program directly, which is
worth doing first because they need no window. The eight rows with no macOS
path at all (`kiro`, `lmstudio`, `roo-code`, `devin-desktop`, `zed`, `cline`,
`hermes`, `openclaw`) can only gain a path if he installs them and notes
where each writes; Zed, LM Studio, Kiro, Windsurf, Cline and Roo all exist on
macOS, so a longer session could add up to six rows. That is a bonus, not
the goal.

Order on the day: `npm test` and the script first (ten minutes, and if the
suite fails on macOS that is finding one); then the five command-checkable
rows; then the GUI applications in the order above; `doctor`; `uninstall`;
the script's last mode; fill the table; cancel the machine.

### Windows: his own machine, tonight

Twelve rows carry a Windows path: `claude-code`, `gemini-cli`, `codex-cli`,
`goose`, `copilot-cli`, `vscode`, `cursor`, `claude-desktop`, `kimi-code`,
`continue`, `warp`, `junie`. The install commands are the npm ones above,
`winget install` for VS Code, Cursor, Warp and Claude, Goose's Windows
installer, and a JetBrains IDE for Junie. The same account list applies.

Three things are known to be different on Windows and are the findings to
watch for, beyond the paths themselves:

- **The suite.** Run `npm test` first. The runner's first real Windows run
  failed 62 tests, mostly harness assumptions, and three real things listed
  above. Whatever his machine does is recorded verbatim, pass or fail.
- **Is-it-running.** The program asks `ps`, which Windows lacks, and answers
  "unknown" — so Claude Desktop will be written to while it is open, and the
  application may overwrite the entry at its next settings write. Quit Claude
  Desktop before `setup`, and note whether the entry survives its restart.
- **The `nosyparker.cmd` shim.** Whether `nosyparker` on PATH is npm's `.cmd`
  wrapper, and whether the sentences the program prints name the command a
  person can actually type.

The eight rows with no Windows path — `opencode`, `kiro`, `lmstudio`,
`roo-code`, `amazon-q`, `devin-desktop`, `zed`, `cline` — are reported by
setup as clients it has no path for. Any of them he already has installed on
that machine is a row he can add tonight by noting where it keeps its MCP
configuration; the script says which ones it found.

**Expect: two to three hours, no money.** Most of the time is installing and
signing in to whichever of the twelve are not already on the machine.

### What comes back

The filled `results.md` table, pasted into this file under a dated heading;
the row edits (`lastVerified`, `configPaths`, `inferred`/`measuredOn`) as one
commit per platform; and the `npm test` output from each machine, verbatim,
whether or not it passed. The runner columns are turned into gates once each
platform's harness work is done and the sheet says the paths are right.

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
