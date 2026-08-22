# nosyparker

One memory for every AI agent on your machine: tell one, and the rest know.

A gate, not a store — it decides what gets in, and writes down why.

Nothing in it expires, and nothing is ever removed behind your back.

**The file is yours, wherever it is.** No account, nothing to sign up for,
nothing hosted. We never run a server and we never hold anyone's data.

## What it can do

Every agent on your machine reads and writes the same file. Ten things an agent
can do:

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

### What it turns away

Refusing is half of it, and a refusal is an answer rather than an error.
Anything shaped like a password, a key or a card number is not stored, and is
not written into the record either — offering one leaves the fact and never the
text. Digits count as digits in any script: a card written ۴۱۱۱ ۱۱۱۱ ۱۱۱۱ ۱۱۱۱
is the same card as one written 4111 1111 1111 1111, and both are refused. Empty text is refused, so is something you have already said word for
word, and so is a file: paste an agent a log and it is told to keep the fact and
leave the file. Every one is written down with the rule that decided it.

### Where a secret goes instead

This keeps facts, and a file that every agent on your machine can read is the
wrong place for a password. So the refusal is not a gap to work around: keep the
secret in a password manager, and keep here the sentence that says where it is.

That sentence is the part people do not think to write down, so here is one:

> The code for the clinic's results portal is in my password manager, saved
> under "Meridian Health", and the login is the email ending 4412.

An agent that reads that knows where to look and what to ask for, which is
everything it needs and none of the secret. Any password manager with a command
line will do; nosyparker does not integrate with one and does not need to.

One limit, which is real and which nothing changes: at the moment an agent
fetches a secret and reads it out to you, that secret is in the conversation.
Keeping it in a vault decides where it rests, not what happens when it is used.

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

A review can put away a large part of a store in one pass, and nothing will
mention it unless the agent does or you run `doctor`. `nosyparker undo-review <number>`
puts a whole review back; the number is in `why`, and anything you changed
yourself since is left alone.

### Your copy of everything

```
nosyparker export memories.json
```

Every memory in every state, every review, and the whole record of what was
decided and why — not only what is currently shown. Plain JSON, which any
program opens and you can read. It will not write over a file already there.

Nothing here deletes a memory. If you want one gone for good, that is a command
you run yourself, and it cannot be undone:

```
node "$(npm root -g)/nosyparker/scripts/purge.mjs" --id 4 --yes
```

## Installing it

Node 22.5 or newer, and nothing else:

```
npm install -g nosyparker
nosyparker setup
```

Install it globally rather than through `npx`. Setup writes the path it is
running from into every config it touches, and npx keeps a separate copy per
version in a cache — those entries would keep pointing at a copy you had moved
on from. Setup refuses to run from there and says so, rather than writing twenty
paths that quietly rot.

It looks for twenty clients, writes its entry into the ones it finds, and sorts
them into three groups: the ones that answered us, the ones you should check
yourself, and the ones that did not work, with the reason.

The middle group is most of them, because most of these applications offer no
way to be asked. Three can be — Claude Code, Gemini CLI and opencode — and two
more, Codex and Goose, will show you their own parsed configuration with our
entry in it, which is not the same thing. For the rest, open the client and ask
the agent something it could only know from your shared memory. Ten seconds,
once per client.

[CLIENTS.md](CLIENTS.md) lists all twenty and says which group each is in.

It only ever adds or removes its own entry, and where it edits a config file it
keeps a copy in `~/.nosyparker/backups/` first, never replaced.

One thing it does that is worth knowing: Cursor's own `--add-mcp` writes its
server into Cursor's user settings file — on Linux `~/.config/Cursor/User/
settings.json` — which is where Cursor also keeps your editor settings. If that
entry is there, `uninstall` takes it out, after copying the file. It is our
entry wherever it ended up, and leaving it behind would mean `uninstall` did not
do what this page says it does. Nothing else in that file is touched.

Linux is the only platform any of this has been watched on. The macOS and
Windows locations are the standard ones those builds use and have not been
seen working here, so on those two `uninstall` looks for a file it has never
been shown, finds nothing, and says nothing either way.

The last thing it prints is which applications to close and reopen. None of them
re-read their config while running.

If it does not know your client, `nosyparker setup --print-config` prints the exact thing
to paste, and naming one it does know (`nosyparker setup --print-config zed`) prints that
client's shape, path and pitfalls. [CONNECTING.md](CONNECTING.md) has the
by-hand version.

If something is not working:

```
nosyparker doctor
```

It says which clients are working, which cannot be asked, and for anything
broken what is wrong and what to do — plus whether your store opens, whether a
review was left open, and what the recent reviews did. The commonest answer is a
changed Node version, and running `nosyparker setup` again fixes it. It changes
nothing.

If that does not resolve it, the
[issues page](https://github.com/amirj4m/nosyparker/issues) is the place to say
so.

## Removing it

```
nosyparker uninstall
```

Takes its entry out of every client that has one, including the one Cursor's own
command writes, and changes nothing else in those files. Running it twice is not
an error.

One thing it does delete, and it belongs here rather than in the engineering
notes: a configuration file that existed **only** because setup created it, and
that is empty once our entry is gone, is removed — along with any directories
that had to be made to hold it. A file that was already on the machine is never
deleted, and neither is one with anything else left in it. The test is on the
contents, not on our say-so.

That removes the wiring, not the memories. Everything nosyparker keeps is in one
folder:

```
~/.nosyparker/memory.sqlite   your memories
~/.nosyparker/actions.log     what it did to which file and when, never contents
~/.nosyparker/backups/        a copy of each config as it was before it was edited
```

Delete the folder and all of it is gone. `NOSYPARKER_STORE` moves the memories
elsewhere; the other two stay here.

**What creates `memory.sqlite`, if you are wondering where it came from.** Two
things, and only two. Storing something — `nosyparker add`, or an agent calling
`remember` — makes it, which is what you asked for. And an agent's client
connecting to the server makes it at connection time, before any tool is called:
wiring a client to a memory server is a statement of intent, and the file being
there is what lets several agents share it.

Nothing else does. `list`, `log`, `search` and `export` answer from an empty
store held in memory when there is no file, so asking what is stored never
creates the thing that stores it. Neither does a command it does not have —
`nosyparker --help` will tell you there is no such command and leave nothing
behind.
