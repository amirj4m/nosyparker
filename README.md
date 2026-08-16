# nosyparker

A place to keep the things you tell an AI agent about yourself, so you do not
have to tell it again tomorrow.

What it accepts, it keeps. Nothing in it expires, and nothing is ever removed
behind your back. It does turn some things away, and it says so at the time.

## What it can do

Every agent on your machine reads and writes the same file, so what you tell
one, the others know. Six things an agent can do:

- **remember** a fact about you, replacing an older one if you have changed
  your mind.
- **recall** what it already knows, before it asks you something twice.
- **list** everything currently known about you.
- **forget** something, with a reason. This puts it away rather than deleting
  it: it stops being shown and stays in the file.
- **restore** something that was forgotten or replaced, so it is shown again.
- **why** — the record of every offer ever made and what became of it,
  including the ones that were refused and why.

Offers can be refused. Anything shaped like a password, a key or a card number
is not stored, and is not written into the record either; so is empty text, and
so is something you have already said word for word. Files are refused too: if
an agent pastes a log or an export, it is told to keep the fact and leave the
file — this is a memory, not a filing cabinet.

There is also a command line tool, so you can read and change your memories
without an agent in the way.

Nothing here deletes a memory. If you want one gone for good, that is a
command you run yourself:

```
node scripts/purge.mjs --id 4 --yes
```

That cannot be undone. The record of what happened to that memory stays,
including a short excerpt of the text, on purpose: if something ever goes
wrong, you should be able to see what was taken out.

## Installing it

There is nothing to install yet. nosyparker is not released: there is no
package to fetch and no command to set it up. This section will say how, once
there is something real to say.

Until then you point an agent at it by hand. It runs from a copy of this
folder, with Node 22 or newer and nothing else:

```
node /absolute/path/to/nosyparker/src/mcp-server.js
```

That is the command an agent runs for you, not one you leave running. You add
it to your agent's configuration once — for Claude Code, under `mcpServers` in
`~/.claude.json` — and it starts the server itself from then on.

[CONNECTING.md](CONNECTING.md) has the exact snippet to paste and what to say
to check it works.

## Removing it

There is nothing to uninstall yet, for the same reason.

What already exists is your memories, and they are all in one file:

```
~/.nosyparker/memory.sqlite
```

Delete that file and everything nosyparker knows about you is gone. If you set
`NOSYPARKER_STORE`, the file is wherever you pointed it instead.
