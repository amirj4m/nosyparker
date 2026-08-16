# Connecting an agent by hand

This is the whole of the wiring for now. You do it once, yourself, by editing
one file. Nothing here detects anything, installs anything, or edits a config
on your behalf — that is a later phase, and it is not built.

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
