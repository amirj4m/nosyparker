# nosyparker

A place to keep the things you tell an AI agent about yourself, so you do not
have to tell it again tomorrow.

It keeps everything it is told and forgets nothing on its own. Nothing in it
expires, and nothing is ever removed behind your back.

## Installing it

There is nothing to install yet. nosyparker is not released: there is no
package to fetch and no command to set it up. This section will say how, once
there is something real to say.

## Removing it

There is nothing to uninstall yet, for the same reason.

What already exists is your memories, and they are all in one file:

```
~/.nosyparker/memory.sqlite
```

Delete that file and everything nosyparker knows about you is gone. If you set
`NOSYPARKER_STORE`, the file is wherever you pointed it instead.
