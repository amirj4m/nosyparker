# Which agents nosyparker can wire itself into

`node src/cli.js setup` finds the AI tools on your machine and adds itself to
each one's configuration. This is what it knows how to do that for, and how sure
it is afterwards.

Most of these applications offer no way to ask whether they loaded a server —
no command, no log, nothing to check. That is their limitation and it is the
only reason the second group exists. Where a tool can answer, setup asks it.
Where it cannot, setup says so rather than showing a tick it has not earned.

Every entry was established by installing the application on a real machine and
watching what it does, not from its documentation, except where it says
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
disables every MCP server in a folder it does not trust, **including ones
configured for your whole account**, and it does not announce this — it opens
normally and mentions it in passing. If setup reports Gemini as blocked, start
`gemini` in that folder and run `/permissions trust`. Writing the folder into
`~/.gemini/trustedFolders.json` by hand does the same thing; setup prints the
exact line.

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

**Cursor.** Setup writes its configuration file directly. Cursor does have a
`--add-mcp` flag, and it is one of the vendor commands we caught reporting
success and writing nothing at all — it exits cleanly and creates no file. Cursor
also has a per-server on/off switch in its own interface; if the entry is there
but nothing happens, check it has not been switched off.

**Devin Desktop**, formerly Windsurf. Renamed, but the old configuration folder
name survives. It keeps **two** separate MCP configuration files, and setup uses
its own `devin-desktop --add-mcp`, which writes `~/.config/Devin/User/mcp.json`.
The other one, `~/.codeium/windsurf/mcp_config.json`, is the file every published
document describes; it belongs to Cascade, which is switched off by default in
current versions. Close Devin before running setup: it rewrites its
configuration from memory and will overwrite changes made while it is open.

**Kiro.** Amazon's agentic editor, and the second VS Code fork here to carry two
MCP configuration files. Setup uses its own `kiro --add-mcp`, which writes the
file Kiro inherited from VS Code, `~/.config/Kiro/User/mcp.json`. Kiro's own
agent also reads `~/.kiro/settings/mcp.json`, and whether it reads the inherited
one was never established — so if the server does not appear in Kiro, that is
the file to add it to by hand. `node src/cli.js setup --print-config kiro` prints
both.

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

**Continue**, **Warp**, **JetBrains Junie** and **GitHub Copilot CLI** are
written from their published documentation rather than from a running
installation. They follow shapes we have verified elsewhere and there is no
reason to think they are wrong, but nobody has watched them work. Continue in
particular does not always notice a changed file — reload it if nothing happens.

**Cline** is one step weaker again, and it is the only entry on this page that
is. Its path comes from third-party write-ups rather than from Cline's own
documentation, so nobody has watched it work *and* the shape is not the
vendor's own word. If you use Cline and the server does not appear, that entry
is the first thing to doubt.

Copilot is worth one more sentence, because it is the one case where we
deliberately ignore a check a vendor documents. Its `copilot mcp list` is
described as reporting whether a server is running, and we do not use it: nobody
here has ever seen what it prints, and the pattern we wrote from guesswork
reported success against a configuration file containing nothing at all. It is
listed here as unconfirmed rather than confirmed by a check we cannot vouch
for.

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

## Checking later that it still works

```
node src/cli.js doctor
```

Nothing here needs running on a schedule, and this is not a repair tool — it
looks and tells you, and if something is wrong the answer is to run `setup`
again.

It is worth running after you change your Node version, which is the one way an
install breaks silently. Every entry names the full path to the interpreter that
wrote it, and a version manager moves that path when you switch versions; the
client then cannot start the server and mostly will not say so. `doctor` reads
the path out of each entry and tells you if it is no longer there.

It also checks that each entry is still exactly what `setup` would write, asks
the clients that can answer whether they are using the server, and says plainly
which clients cannot be asked at all. And if `setup` installed into a client
whose configuration has since been deleted, emptied, made unreadable or broken,
it says which and what to do — that is the likeliest reason to run it.

**Exit codes**, if you want it in a script or a shell prompt: `0` when it found
nothing wrong, `1` when it did. A client that cannot be asked is not counted as
wrong — most of them cannot, and exiting non-zero for that would make the code
mean "you have clients installed" rather than "something needs attention".

---

## If your configs are symlinks

Keeping dotfiles in a repository and linking them into place is a common
arrangement, and it is one setup understands. If `~/.cursor/mcp.json` is a link
into `~/dotfiles/`, setup follows the link and edits the file at the end of it.
Your link stays a link, and the change lands where your repository can see it.

A chain of links is followed to the end. A link pointing at a file that does not
exist yet gets that file created, so the link starts working. A link out of your
home directory is followed too — you made it deliberately, and setup records
where it actually wrote.

`uninstall` takes the entry back out of the same file and leaves the link alone.

---

## When setup declines to write

Three cases, and none of them is a failure of your setup:

- **The application is running.** Claude Desktop and Devin rewrite their
  configuration from whatever they are holding in memory, so an entry added
  while they are open is lost the next time they save. Setup writes nothing and
  names the application to quit.
- **The file is read-only.** An atomic write could replace it anyway without
  the permissions changing afterwards, which would leave you no way to tell.
  Setup treats read-only as you meaning it, and stops.
- **The file cannot be parsed.** A configuration file with a syntax error in it
  is left exactly alone. Editing around a broken file is how a whole
  configuration gets lost at the next launch.

A file that begins with a byte order mark — anything saved by Notepad, and some
things saved by older editors — is not in that list. It is read correctly, and
the mark is still there afterwards.

---

## One thing that trips everything up

An application started from a desktop icon does not inherit your shell's search
path, so a Node installed through a version manager — `nvm`, `fnm`, `asdf` — is
invisible to it. One tool failed to connect for exactly this reason and gave no
useful explanation. Setup writes the full path to the interpreter instead, and
prints it. If you edit one of these files by hand, do the same.

The cost: a version manager moves that path when you switch or remove a version,
and every entry then points at nothing. Nothing announces it. **After changing
your Node version, run `setup` again.**
