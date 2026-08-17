# Which agents nosyparker can wire itself into

`nosyparker setup` finds the AI tools already installed on your machine and adds
itself to each one's configuration. This is the list of what it knows how to do
that for, and — just as important — how sure it is afterwards.

Most of these applications offer no way to ask whether they actually loaded a
server. There is no command to run, no log to read, nothing to check. That is a
limitation of theirs rather than a sign something went wrong, and it is the only
reason the second group below exists. Where a tool *can* answer, setup asks it
and tells you what it said. Where it cannot, setup says so plainly instead of
showing you a tick it has not earned.

Every entry here was established by installing the application on a real machine
and reading what it does, not from its documentation, except where the entry says
otherwise.

---

## Confirmed — these answered us

After setup runs, something on your machine has confirmed the entry. You do not
need to check these yourself.

**Claude Code.** Anthropic's terminal agent. Wired automatically through its own
`claude mcp add`. It then starts nosyparker and reports the connection, so a tick
here means the server really ran. The strongest confirmation of anything on this
list. New sessions pick it up; a session already open needs `/mcp` to reconnect.

**Gemini CLI.** Google's terminal agent. Setup writes its settings file directly —
deliberately, because `gemini mcp add` reports success and writes nothing, which
we found by watching it do exactly that. Afterwards `gemini mcp list` starts the
server and says `Connected`, which is real confirmation. One thing to know: Gemini
suppresses servers in folders it does not trust, **including ones configured for
your whole account**. If it says nothing is configured, trust the folder and look
again.

**opencode.** An open-source terminal agent. Its `opencode mcp list` genuinely
connects and reports success or failure with the reason, so confirmation here is
solid. Its configuration file allows comments, and setup preserves them.

**Codex CLI.** OpenAI's terminal agent. Wired through `codex mcp add`, and
`codex mcp list` reads the entry back. Worth being precise: that confirms the
entry is present, well-formed and switched on — it does not prove the server ran.
Codex will happily report a command that does not exist as enabled. Better than
nothing, short of proof.

**Goose.** Block's terminal agent, now maintained by the Agentic AI Foundation.
Setup writes its configuration file and then reads it back through `goose info`,
which shows the parsed entry. Same caveat as Codex: the entry is confirmed
present and enabled, not confirmed running. Note that a malformed file makes
Goose fall back to defaults silently and lose *all* your extensions, not just
this one — which is why setup backs the file up first.

---

## Written, but unconfirmed — worth ten seconds of your time

Setup wrote the entry and checked the file afterwards. Nothing in these
applications will tell us whether they read it.

The check is quick: open the tool, and ask the agent something it could only know
from your shared memory. If it knows, it is working.

**Nearly all of these need restarting** before they pick up a new server. If you
had the application open while setup ran, close it and open it again.

**VS Code.** Wired through `code --add-mcp`, which writes to your user profile.
If you work in a custom VS Code profile, that profile has its own separate file
and setup writes the default one. Several settings can quietly stop a server
loading — an administrator policy can too, and that is invisible from outside.

**Cursor.** Wired through `cursor --add-mcp`. Cursor has a per-server on/off
switch in its own interface; if the entry is there but nothing happens, check it
has not been switched off.

**Devin Desktop**, formerly Windsurf. Renamed, but the old configuration folder
name survives. It keeps **two** separate MCP configuration files, and setup
writes the one its own command-line tool writes. Its other, older surface belongs
to Cascade, which is switched off by default in current versions. Close it before
running setup: it rewrites its configuration from memory and will overwrite
changes made while it is open.

**Kiro.** Amazon's agentic editor. Like Devin, built on VS Code and carrying two
configuration files; setup writes the one its own tool writes.

**Claude Desktop.** Anthropic's desktop app. Officially macOS and Windows; the
Linux build is a community one and uses the same layout. Close it before running
setup — it rewrites its configuration from memory, and a damaged file can cost
you the whole thing, so setup takes a backup first. Restart it fully afterwards,
not just the window.

**Zed.** The editor. Its settings file allows comments and setup keeps them. Zed
starts servers only when its agent panel needs them, which is why nothing can be
confirmed at install time.

**LM Studio.** For running models locally. Its configuration file is created the
first time you open the app, and setup adds to it without disturbing anything
else. It only starts a server when a model actually uses one, so there is nothing
to observe until you load a model.

**Kimi Code.** Moonshot's terminal agent. Setup can write the entry, but nothing
in Kimi will confirm it without signing in to a Moonshot account. Its `kimi doctor`
command looks like the right thing to run and is not — it reports success without
ever reading the MCP file, including when that file is broken.

**Amazon Q Developer CLI.** Every one of its MCP commands refuses to run until you
sign in to an AWS account, so setup writes the configuration file from Amazon's
documentation and cannot check it. Treat this entry as the least certain on the
list.

**Roo Code.** A VS Code extension. Setup writes the file the extension itself
looks for. The extension only starts up when you first open its panel, so there
is nothing to check before then.

**Cline**, **Continue**, **Warp**, **JetBrains Junie**, and **GitHub Copilot CLI**
are all written from their published documentation rather than from a running
installation. They follow shapes we have verified elsewhere and there is no
reason to think they are wrong, but nobody has watched them work. Continue in
particular does not always notice a changed file — reload it if nothing happens.

---

## Not applicable — nothing to install into

These support MCP, but only through a web interface where you paste in a server
address. They have no configuration file on your computer, and nosyparker runs
*on* your computer. There is nothing for setup to write, and this will not change
by us trying harder:

- **Claude on the web**
- **ChatGPT**
- **GitHub Copilot coding agent**

If you use one of these, nosyparker is not the right shape for it today. It would
have to be a hosted server with a public address rather than a program on your
own machine.

---

## One thing that trips everything up

If nosyparker was installed through a version manager — `nvm`, `fnm`, `asdf` —
the program that runs it may not be on the search path of the application trying
to start it. We hit this in testing: one tool failed to connect for exactly this
reason and gave no useful explanation.

Setup writes the full path to the interpreter for this reason, so it works
regardless. It is worth knowing about if you ever edit one of these files by
hand: use the full path, not just `node`.
