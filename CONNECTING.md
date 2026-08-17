# Connecting an agent by hand

There is now a command that does this for you — `node src/cli.js setup`, which
the [README](README.md) describes. This page is the by-hand version: what to do
for a client the command does not know about, and what it is doing on your
behalf for the ones it does.

`node src/cli.js setup --print-config` prints the snippet below filled in with
your own paths, and naming a client prints that client's own shape.

## Running the server

```
node /absolute/path/to/nosyparker/src/mcp-server.js
```

It speaks MCP over stdin and stdout, so run on its own it will sit there
saying nothing. That is what working looks like. An agent starts it for you;
the command is here because it is what you put in the config below.

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
      "command": "node",
      "args": ["/absolute/path/to/nosyparker/src/mcp-server.js"]
    }
  }
}
```

The path has to be absolute. Claude Code starts the server in a working
directory of its own choosing, and a relative one will not be found.

`setup` writes the absolute path of the Node it is running under rather than
the word `node`, for a reason worth knowing if you are doing this by hand: an
application started from a desktop icon does not inherit your shell's `PATH`,
so `node` may be a command it cannot find. The cost of the absolute path is
that upgrading Node moves it, and `setup` has to be run again.

Restart Claude Code. `/mcp` lists the connected servers; nosyparker should be
there with six tools.

## Trying it

Ask for each of these in turn, in ordinary words:

- *"Remember that I prefer to be written to in short sentences."* → `remember`
- *"What do you know about me?"* → `list`
- *"How do I like to be written to?"* → `recall`
- *"Forget that, I have changed my mind."* → `forget`, with a reason
- *"Why is that not remembered any more?"* → `why`
- *"Actually, put that back."* → `restore`

Then start a second agent — another Claude Code window, or the command line
tool in a terminal — and ask it what it knows about you. It reads the same
file. That is the point of the thing.

## More than one agent

Every agent you point at this runs its own copy of the server against the one
file, and they are meant to. Writes take the lock in turn and wait for each
other; nothing is lost and nothing is overwritten.
