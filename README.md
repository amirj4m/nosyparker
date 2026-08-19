# nosyparker

A place to keep the things you tell an AI agent about yourself, so you do not
have to tell it again tomorrow.

What it accepts, it keeps. Nothing in it expires, and nothing is ever removed
behind your back. It does turn some things away, and it says so at the time.

## What it can do

Every agent on your machine reads and writes the same file, so what you tell
one, the others know. Ten things an agent can do:

- **remember** a fact about you, replacing an older one if you have changed
  your mind.
- **recall** what it already knows, before it asks you something twice.
- **list** everything currently known about you.
- **forget** something, with a reason. This puts it away rather than deleting
  it: it stops being shown and stays in the file.
- **restore** something that was forgotten or replaced, so it is shown again.
- **why** — the record of every offer ever made and what became of it,
  including the ones that were refused and why.
- **review_start** — begin reading back through what is stored, with the date
  each thing was stored on.
- **review_finding** — record what it concluded about one memory, and why.
- **review_end** — finish, after which that review takes nothing more.
- **review_undo** — put back everything one review changed, all at once.

Offers can be refused. Anything shaped like a password, a key or a card number
is not stored and is not written into the record either; so is empty text, and
so is something you have already said word for word. Files are refused too: if
an agent pastes a log, it is told to keep the fact and leave the file.

### Reviewing

The last four are for tidying up. "Next week I am presenting at the all-hands"
was worth remembering the day you said it and means nothing a year later, and an
agent can read back through what is stored and say so.

What it cannot do matters more:

- **Nothing here decides anything from a date.** No code in this project looks
  at when something was stored and concludes it should go. Every memory carries
  the date, the agent is shown it, and the agent works out — by reading the
  sentence — whether the moment it named has gone by. "I live in Tehran" names
  no moment, and is as true after ten years as the day you said it.
- **A review cannot forget and cannot delete.** Forgetting is you saying you do
  not want something shown. All a review can do is mark something no longer
  current, or link it to a newer memory that replaced it. Both are reversible.
- **"I could not tell" is a real answer.** If two memories disagree and nothing
  says which came first, the agent says so and changes nothing. Its reasoning is
  recorded either way, so you can judge afterwards whether it thought well.

`node src/cli.js undo-review <number>` puts a whole review back. The number is
in `why`. Anything you changed yourself since is left alone.

### Your copy of everything

```
node src/cli.js export memories.json
```

Every memory in every state, every review, and the whole record of what was
decided and why — not only what is currently shown. Plain JSON, which any
program opens and you can read. It will not write over a file already there.

Nothing here deletes a memory. If you want one gone for good, that is a command
you run yourself, and it cannot be undone:

```
node scripts/purge.mjs --id 4 --yes
```

There is also a command line tool for reading and changing your memories without
an agent in the way, and a log at `~/.nosyparker/actions.log` of every file this
has touched on your machine — which config, when, what changed. Never the
contents of anything, so no key of yours is in it.

## Installing it

nosyparker is not released yet — there is no package to fetch — but from a copy
of this folder, with Node 22.5 or newer and nothing else:

```
node src/cli.js setup
```

It looks for twenty clients, writes its entry into the ones it finds, and sorts
them into three groups: the ones that answered us, the ones you should check
yourself, and the ones that did not work, with the reason.

The middle group is most of them. Three applications can be asked whether they
started the server and will say so — Claude Code, Gemini CLI and opencode. Two
more, Codex and Goose, will show you their own parsed configuration with our
entry in it, which is not the same thing. The rest offer no way to be asked at
all. For those, open the client and ask the agent something it could only know
from your shared memory. Ten seconds, once per client.

[CLIENTS.md](CLIENTS.md) lists all twenty and says which group each is in.

It never removes anything it did not add. Where it edits a config file itself it
keeps a copy in `~/.nosyparker/backups/` first, and that copy is never replaced.
Where a client has its own command for adding a server, that command does the
writing and no copy is taken.

The last thing it prints is which applications to close and reopen. None of them
re-read their config while running.

If it does not know your client, `node src/cli.js setup --print-config` prints
the exact thing to paste, and naming a client it does know (`--print-config zed`)
prints that client's shape, path and pitfalls. [CONNECTING.md](CONNECTING.md) has
the by-hand version.

If something is not working:

```
node src/cli.js doctor
```

It says which clients are working, which cannot be asked, and for anything
broken what is wrong and what to do. It also says whether your memory store
opens, whether a review was left open, and what the recent reviews did. The
commonest answer is that you changed your Node version, and running `setup`
again fixes it. It changes nothing itself.

If that does not resolve it, the
[issues page](https://github.com/amirj4m/nosyparker/issues) is the place to say
so.

## Removing it

```
node src/cli.js uninstall
```

Takes its entry out of every client that has one and touches nothing else in
those files. Running it twice is not an error.

That removes the wiring, not the memories. Everything nosyparker keeps is in one
folder:

```
~/.nosyparker/memory.sqlite   your memories
~/.nosyparker/actions.log     what it did to which file, and when
~/.nosyparker/backups/        a copy of each config as it was before it was edited
```

Delete the folder and all of it is gone. If you set `NOSYPARKER_STORE`, the
memories live wherever you pointed it and the other two stay here.
