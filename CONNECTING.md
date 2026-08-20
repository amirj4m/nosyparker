# Connecting an agent by hand

There is now a command that does this for you — `nosyparker setup`, which
the [README](README.md) describes. This page is the by-hand version: what to do
for a client the command does not know about, and what it is doing on your
behalf for the ones it does.

`nosyparker setup --print-config` prints the snippet below filled in with
your own paths, and naming a client prints that client's own shape.

## Running the server

```
node /absolute/path/to/nosyparker/src/mcp-server.js
```

Node 22.5 or newer; on anything older it stops immediately and says so. It
speaks MCP over stdin and stdout, so run on its own it sits there saying
nothing — that is what working looks like. An agent starts it for you; the
command is here because it is what goes in the config below.

It reads and writes `~/.nosyparker/memory.sqlite`, the same file the command
line tool uses. Set `NOSYPARKER_STORE` to point both somewhere else.

## Pointing Claude Code at it

Add this to `~/.claude.json`, with the path to your copy. The file is already
there; the `mcpServers` key may not be, in which case add it at the top level
alongside the keys that are.

```json
{
  "mcpServers": {
    "nosyparker": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/nosyparker/src/mcp-server.js"]
    }
  }
}
```

If the file you are editing is a symlink into a dotfiles repository, edit the
file it points at rather than replacing the link. `setup` does this for you;
doing it by hand is the one place it is easy to get wrong, and replacing the
link disconnects your repository from your live config without saying so.

**Both paths have to be absolute, including the one to Node.** Run
`node -e 'console.log(process.execPath)'` to get it. An application started from
a desktop icon does not inherit your shell's `PATH`, so a bare `node` is a
command it may not find — opencode fails with `Connection closed` and nothing
else for exactly this reason. The cost is that a version manager moves that path
when you switch versions and the entry then fails silently, so run `setup` again
after changing Node. `setup` does all of this and prints the path it wrote.

Restart Claude Code. `/mcp` lists the connected servers; nosyparker should be
there with ten tools.

## Trying it

Ask for each of these in turn, in ordinary words:

- *"Remember that I prefer to be written to in short sentences."* → `remember`
- *"What do you know about me?"* → `list`
- *"How do I like to be written to?"* → `recall`
- *"Forget that, I have changed my mind."* → `forget`, with a reason
- *"Why is that not remembered any more?"* → `why`
- *"Actually, put that back."* → `restore`
- *"Have a look through what you know about me and see if any of it has gone
  out of date."* → `review_start`, then `review_finding` for anything it
  concludes, then `review_end`

The last one is worth trying properly. Tell an agent *"next week I am giving a
talk"*, come back a fortnight later, and ask it to review. It should work out
from the sentence and the date that the week has gone. Ask it about something
with no date in it and it should leave that alone however old it is, or say it
could not tell. Nothing in nosyparker decides any of that; you are watching the
agent read.

Then start a second agent — another Claude Code window, or the command line
tool in a terminal — and ask it what it knows about you. It reads the same
file. That is the point of the thing.

## More than one agent

Every agent you point at this runs its own copy of the server against the one
file, and they are meant to. Writes take the lock in turn and wait for each
other; nothing is lost and nothing is overwritten.
