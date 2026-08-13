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

Node 22.5 or newer. Nothing else. There are no dependencies to install for
running it.

## What it does

You give it a sentence. It decides one of a few things:

- if the sentence looks like a password or a key, it refuses and tells you why
- if the sentence is blank, it refuses
- if you already stored the same sentence, it refuses
- if you said the new sentence replaces an old one, it stores the new one and
  retires the old one
- otherwise it stores it

Every one of those decisions is written down, including the refusals, so you
can always read back what happened and why.

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
nosyparker list                      show everything currently active
nosyparker log                       show every decision ever made
nosyparker forget <id> "<reason>"    stop showing a memory, keep the record
nosyparker restore <id>              show it again
```

`add` takes an optional `--replaces <id>` if the new sentence replaces an old
one.

## Removing something permanently

```
node scripts/purge.mjs --id 4 --yes
```

Both flags are required. This is the only code in the project that deletes
anything, and nothing else can call it.

## Tests

```
node --test 'test/*.test.js'
```

There is nothing to install first. The tests use Node's own test runner and
write to a temporary folder, never to your real store.

## License

MIT. This is an open-source, non-commercial project.
