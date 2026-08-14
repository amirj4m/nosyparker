# nosyparker

A place to keep the things you tell an AI agent about yourself, so you do not
have to tell it again tomorrow.

This is Phase 1. It is the storage layer and the gate that guards it. There is
no MCP server yet and no installer yet.

Nothing here ever deletes a memory on its own, and nothing expires. A memory
you no longer want stops being shown, but it stays in the file and you can
bring it back. The only way to remove something permanently is to run one
script by hand from a terminal.

## Requirements

Node 22.5 or newer. Nothing else. There is nothing to install to run it.

## What it does

You give it a sentence. It decides one of a few things:

- if the sentence looks like a password or a key, it refuses and says so
- if the sentence is blank, it refuses
- if you already stored the same sentence, it refuses
- if you said the new sentence replaces an old one, it stores the new one and
  retires the old one
- otherwise it stores it

Every one of those decisions is written down, including the refusals, so you
can always read back what happened and why. The log is complete: it is never
shortened and nothing is dropped from it.

## Try it

```
git clone https://github.com/amirj4m/nosyparker.git
cd nosyparker
node src/cli.js add "I prefer to be written to in short sentences"
node src/cli.js list
node src/cli.js search "short sentences"
node src/cli.js log
```

The file lives at `~/.nosyparker/memory.sqlite`. Set `NOSYPARKER_STORE` to put
it somewhere else.

## Commands

```
nosyparker add "<text>"              store a sentence
nosyparker search "<query>"          find stored sentences
nosyparker list                      show what is currently stored
nosyparker log                       show every decision ever made
nosyparker forget <id> "<reason>"    stop showing a memory, keep the record
nosyparker restore <id>              show it again
```

`add` takes an optional `--replaces <id>` if the new sentence replaces an old
one.

`list` and `search` show what is currently stored. Memories you have forgotten,
and ones that were replaced, are not shown by either. They are still in the
file, and the log says what happened to them.

## Search

Search looks for all the words you type, in any order and anywhere in the
sentence, so `search "coffee morning"` finds "I drink coffee in the morning".
Case is ignored, in every alphabet that has case.

It works the same in any language. Words of one or two characters are findable
too, which matters in Chinese and Japanese where most words are that short.

## Removing something permanently

```
node scripts/purge.mjs --id 4 --yes
```

Both flags are required. This is the only code in the project that deletes
anything, and nothing else can call it. The memory is removed from the file for
good; the decision log still records that it existed and what it said, on
purpose, so that a store cannot change without leaving a trace.

If an agent is connected and using the store, the script will say so and change
nothing. Close the agent and run it again.

## Tests

```
node --test 'test/*.test.js'
```

The tests need nothing installed. They use Node's own test runner and write to
a temporary folder, never to your real store.

There is also a type check, which is the only thing here with dependencies:

```
npm install
npm run typecheck
```

TypeScript and the Node type definitions are used to check the JavaScript. They
are development tools only. Nothing this project runs has any dependencies.

## License

MIT. This is an open-source, non-commercial project.
