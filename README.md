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
- **review_start** — begin reading back through everything stored, with the
  date each thing was stored on.
- **review_finding** — record what it concluded about one memory, and why.
- **review_end** — finish, after which that review takes nothing more.
- **review_undo** — put back everything one review changed, all at once.

### Reviewing

The last four are for tidying up. Things you said a year ago can stop being
true — "next week I am presenting at the all-hands" was worth remembering the
day you said it and means nothing now — and an agent can read back through what
is stored and say so.

The important part is what it cannot do.

**Nothing here ever decides anything from a date.** No code in this project
looks at when something was stored and concludes it should go. That is not an
oversight and it is not something a later version will add: it is the point.
Every memory carries the date it was stored, an agent doing a review is shown
that date, and the agent works out — by reading the sentence — whether the
moment the sentence named has gone by. "Next month" means something different
depending on when it was written. "I live in Tehran" names no moment at all,
and is exactly as true after ten years as it was the day you said it. Age alone
is never a reason for anything.

**A review cannot forget anything, and it cannot delete anything.** Forgetting
is you saying you do not want something shown. An agent may not reach that
conclusion for you. All it can do is mark something overtaken — no longer
current, with nothing to put in its place — or link it to a newer memory that
replaced it. Both are reversible.

**"I could not tell" is a real answer.** If two memories disagree and nothing
says which came first, the agent is meant to say so and change nothing. Its
reasoning is written down either way, so you can read afterwards what it thought
and decide whether it thought well. `why` shows you that, alongside which
memories it read to reach each conclusion.

If a review got something wrong, `node src/cli.js undo-review <number>` puts
the whole thing back. The number is in `why` and in `node src/cli.js log`.
Anything you have changed yourself since is left exactly alone.

There is also `node src/cli.js doctor`, which checks that what `setup` wrote is
still there and still points at something that exists, tells you what it cannot
check, and says whether your memory store opens, whether a review was left open,
and what the recent reviews actually did — how many memories each put away, how
many are left on show, and the command to put any of them back. A review that
moved most of your store gets a sentence saying so. That is a report and not a
complaint: nothing here refuses a review, caps one, or treats a large one as a
fault. It changes nothing.

And it keeps a log — `~/.nosyparker/actions.log` — of every file it has touched
on your machine: which config, when, what was written, backed up or removed.
Never the contents of anything, so no key of yours is ever in it. It is
append-only and it does not rotate: nothing trims it by age or size, on purpose,
because the entry you want a month from now is the one a tidy-up would have
taken. It is a few hundred bytes per run.

Offers can be refused. Anything shaped like a password, a key or a card number
is not stored, and is not written into the record either; so is empty text, and
so is something you have already said word for word. Files are refused too: if
an agent pastes a log or an export, it is told to keep the fact and leave the
file — this is a memory, not a filing cabinet.

There is also a command line tool, so you can read and change your memories
without an agent in the way.

You can take everything out at any time:

```
node src/cli.js export memories.json
```

That is every memory in every state, every review, and the whole record of what
was decided and why — not just what is currently shown. Plain JSON, which any
program opens and you can read. It will not write over a file that is already
there.

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
copy of this folder, with Node 22.5 or newer and nothing else, one command wires
up every agent on your machine:

```
node src/cli.js setup
```

It looks for twenty clients, writes its entry into the ones it finds, and then
sorts them into three groups: the ones that answered us, the ones you should
check yourself, and the ones that did not work, with the reason.

That middle group is most of them, and it is worth knowing why. Three of these
applications can be asked whether they started the server and will say so —
Claude Code, Gemini CLI and opencode. Two more, Codex and Goose, will show you
their own parsed configuration with our entry in it, which is worth having and
is not the same thing. The rest offer no way to be asked at all: a limitation of
those applications rather than of this one, and nothing here can work around it.

So for those, one check is left and only you can do it. Open the client and ask
the agent something it could only know from your shared memory. If it knows, it
is working. Ten seconds, once per client.

[CLIENTS.md](CLIENTS.md) lists all twenty and says which group each is in.

It never removes anything it did not add. Where it edits a config file itself,
it puts a copy of that file in `~/.nosyparker/backups/` first, and that copy is
never replaced, because the version worth keeping is the one from before this
existed. Where a client has its own command for adding a server, that command
does the writing and no copy is taken, because there is nothing of ours to undo.

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

If something is not working, this will tell you what:

```
node src/cli.js doctor
```

It says which clients have an entry, which of them are working, which cannot be
asked at all, and — for anything broken — what is wrong and what to do about it.
The commonest answer is that you changed your Node version, in which case it
says so and running `setup` again fixes it. It changes nothing itself.

If that does not resolve it, the
[issues page](https://github.com/amirj4m/nosyparker/issues) is the place to say
so.

## Removing it

```
node src/cli.js uninstall
```

Takes its entry out of every client that has one and touches nothing else in
those files. It works even if a config has changed since you installed, and
running it twice is not an error.

That removes the wiring, not the memories. Everything nosyparker keeps is in
one folder:

```
~/.nosyparker/memory.sqlite   your memories
~/.nosyparker/actions.log     what it did to which file, and when
~/.nosyparker/backups/        a copy of each config as it was before it was edited
```

Delete the folder and all of it is gone. Delete `memory.sqlite` alone and the
memories are gone. If you set `NOSYPARKER_STORE`, the memories live wherever you
pointed it instead and the other two stay here.
