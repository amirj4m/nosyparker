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

nosyparker is still not released — there is no package to fetch — but from a
copy of this folder, with Node 22 or newer and nothing else, one command wires
up every agent on your machine:

```
node src/cli.js setup
```

It looks for fourteen clients, writes its entry into the ones it finds, and
then tells you, one by one, what it actually knows about each. That last part
is the point. Some clients can be asked whether the server started and will
say so; some can only confirm that they read their own config file; some offer
nothing at all, and for those it says it wrote a file and cannot tell you
whether anybody read it. You will not get one tick meaning six different
things.

It never removes anything it did not add. Before it touches a config file for
the first time it puts a copy in `~/.nosyparker/backups/`, and that copy is
never replaced, because the version worth keeping is the one from before this
existed.

The last thing it prints is which applications to close and reopen. None of
them re-read their config while running, so that is a required step and not a
footnote.

If it does not know your client:

```
node src/cli.js setup --print-config
```

prints the exact thing to paste, and naming a client it does know
(`--print-config zed`) prints that client's own shape, path and pitfalls.

[CONNECTING.md](CONNECTING.md) has the by-hand version and what to say to
check it works.

## Removing it

```
node src/cli.js uninstall
```

Takes its entry out of every client that has one and touches nothing else in
those files. It works even if a config has changed since you installed, and
running it twice is not an error.

That removes the wiring, not the memories. Those are all in one file:

```
~/.nosyparker/memory.sqlite
```

Delete that file and everything nosyparker knows about you is gone. If you set
`NOSYPARKER_STORE`, the file is wherever you pointed it instead.
