# Decisions

Reasoning that is too long to live in the code, kept where it can be read
rather than scrolled past. Each section is pointed at from the place it
explains, and a check enforces that rather than this sentence asking you to
believe it.

One section is marked **[record]** instead. That is a retrospective — what a
phase learned, written for the next one — and it explains no particular line, so
nothing points at it. A section that is neither pointed at nor marked is one of
the two things having quietly become the other, which is what happened to that
one before it was marked.

Nothing here is instructions. If this file and the code disagree, the code is
what runs and this file is out of date.

## Which SQLite driver

`node:sqlite`, and the question has been asked and answered with measurements.

A U+0000 inside a text value is written faithfully and read back cut off at the
NUL. One file, both drivers writing and both reading, 42 characters offered:

| | result |
| --- | --- |
| on disk, either writer | 42 bytes, and `hex()` shows all of them |
| read by `node:sqlite` | 20 characters |
| read by `better-sqlite3` | 42 characters |

So the storage is faithful and the truncation is in the binding, which takes
the length of the C string rather than asking SQLite how many bytes there are.
SQLite is not blameless — its own `length()` on a TEXT value stops at the NUL
too — but `hex()` and `length(CAST(text AS BLOB))` both report the whole value.
Nothing is lost; it is hidden on the way out.

We stay on `node:sqlite` for two reasons, neither of them inertia.

Nothing can put a NUL in a memory any more. The gate refuses one, with a
decision row, before it reaches the store, so the difference between the two
drivers is not reachable through this program.

And if such a row ever had to be read anyway, this binding can already do it:
`SELECT CAST(text AS BLOB)` decoded in JavaScript returns all 42 characters,
faithfully, for a row written by either driver. The fix exists at our own layer
and needs no dependency.

What swapping would cost: 27 MB and a native module against nothing at all, on
a project whose distribution story is that a stranger runs one command. It does
ship prebuilt binaries for every platform this needs, Windows included, which
is a stronger position than expected — but it falls back to compiling with
`node-gyp` when none matches, a class of install failure this project does not
have today.

What swapping would not buy: anything for the memory defect below. The same
degenerate corpus and query costs 868 MB under `node:sqlite` and 875 MB under
`better-sqlite3`. Same SQLite, same FTS5, same position lists.

## Bounding what a search can cost

*Pointed at from `SEARCH_QUERY_LIMIT` in `src/store.js`.*

**This is unsolved.** Three attempts, all recorded here because all three
looked right and none was, and because the next attempt should start from what
they measured rather than from intuition.

A search costs the number of trigrams in the query multiplied by how dense
those trigrams are in a single stored memory. FTS5 builds its position lists one
document at a time, so a single memory sets the cost of every search matching
it — but *which* property of that memory decides the cost is exactly what none
of the three got right.

**Bounding the query alone.** A thousand-character limit, on the theory that
the query was the multiplier. It is one of two, and the other has no ceiling.
Measured, with a query one character inside the bound, against one memory of a
repeated character:

| stored | peak |
| --- | --- |
| 0.1 MB | 273 MB |
| 0.4 MB | 874 MB |
| 0.8 MB | killed at 1225 MB |
| 1.6 MB | killed at 1210 MB |

Bounding the length of a single term does not help either: the same 999
characters cut into 199 four-character terms cost more, not less.

**Pricing the search before running it.** Asking `fts5vocab` how often each
query trigram occurs, and refusing when the total looked too large. This was
defeated by ordinary use, not by adversarial input. `cnt/doc` is the **mean**
occurrences per memory and the cost is driven by the **maximum**: a hundred
ordinary memories each containing a trigram once dragged the mean down far
enough to let an 878 MB search through. One repetitive pasted document plus
fifty normal memories was enough. The store got safer the emptier it was, which
is backwards.

**Refusing the document at write time.** Measuring the densest trigram of the
offered text exactly, once, and refusing above a limit. Shipped, then removed,
because the metric does not separate the two populations. Measured over a real
corpus:

| text | chars | densest trigram |
| --- | --- | --- |
| English prose, 10,000 | 10,000 | 233 |
| English prose, 1,000,000 | 1,000,000 | 23,413 |
| this project's README | 2,641 | 30 |
| a source file (store.js) | 33,348 | 1,002 |
| source indented 24 spaces, 2,000 lines | 129,779 | **44,000** |
| source indented 24 spaces, 6,000 lines | 393,779 | **132,000** |
| CSV, 20,000 rows | 948,917 | 20,715 |
| a 5,000-line bullet list | 314,999 | 7,583 |
| a log line repeated 5,000 times | 365,000 | **5,000** |
| base64, 400 KB | 400,000 | **4,762** |
| "the the the…", 400 KB | 400,000 | 100,000 |
| 400 KB of one character | 400,000 | 399,998 |

A deeply indented source file scores 132,000 and a document of the word "the"
repeated a hundred thousand times scores 100,000. The canonical degenerate
cases — a repeated log line, a base64 blob — score lower per character than
ordinary English prose. There is no threshold that admits the first group and
refuses the second, and a relative ratio inverts the same way.

Measured cost confirms the metric is the wrong one. Each document searched with
a 999-character slice of itself:

| text | densest | peak | time |
| --- | --- | --- | --- |
| English prose, 1 MB | 23,413 | 92 MB | 55 ms |
| source indented 24, 2,000 lines | 44,000 | 91 MB | 48 ms |
| CSV, 20,000 rows | 40,000 | 119 MB | 60 ms |
| source indented 24, 6,000 lines | 132,000 | 165 MB | 133 ms |
| log line × 5,000 | 5,000 | 79 MB | 47 ms |
| base64, 400 KB | 4,762 | 80 MB | 44 ms |
| "the the the", 400 KB | 100,000 | 263 MB | 882 ms |
| 400 KB of one character | 399,998 | 834 MB | 3,828 ms |

132,000 costs less than 100,000. Any metric that cannot explain that inversion
is measuring the wrong thing: what makes a search expensive is not how dense
the commonest trigram is, but how much of the query is made of dense ones.

**What bounds it now.** Not one rule but three limits that only work together:
`SEARCH_QUERY_LIMIT` caps how many trigrams a query may have, `TEXT_LIMIT` caps
how long one memory may be, and `REPETITION_LIMIT` caps how much one memory may
repeat itself. Take away any one and the worst case returns — which is what
happened when `TEXT_LIMIT` was enforced in the MCP adapter but not at the
terminal, leaving a 856 MB search reachable through the `add` command.

The worst that now fits inside all three is about nine and a half thousand
dense characters in a single memory, which costs around 91 MB to search.

Two things this does not cover. Time is still unbounded: the per-memory cost is
multiplied by how many memories match, and a thousand memories at the worst
allowed shape take 92 seconds for one search. And the two write-side limits are
enforced at the two entry points rather than in the gate, so `submit` called
directly as a library function is bounded by neither. There is no such caller
today; Phase 4's review loop would be one.

## Walking past the repetition rule

A memory that mixes a long dense run with varied filler scores low on
`REPETITION_LIMIT` and is still expensive to search. A review reported one
costing 856 MB.

**The conclusion first, because it is the part that matters:** that shape
passes the repetition rule at *every* length. It is not that it needs to be
large to slip past — it slips past at any size, and gets expensive as it grows.
So `TEXT_LIMIT` is the only thing that stops it, always, and it is checked
first and in the gate. Same 90/10 ratio at each length:

| whole memory | dense run | filler | score |
| --- | --- | --- | --- |
| 10,000 | 9,050 | 950 | 10.6 |
| 40,000 | 36,200 | 3,800 | 11.0 |
| 210,000 | 190,050 | 19,950 | 13.1 |
| 440,000 | 398,200 | 41,800 | 16.0 |

Against a limit of 60, every one passes. The 210,000-character memory in the
report is not a threshold for getting past the rule; it is where the dense run
becomes big enough for the search to cost 856 MB.

### On unique fractions, and a correction

An earlier version of this section said the shape needed filler where about two
thirds of trigrams are unique, and gave figures for various text. Those figures
were not comparable: distinct trigrams saturate, so the same text measured on a
shorter sample looks more unique by arithmetic rather than by being unusual.
Measured properly, at three fixed lengths:

| text | at 10,000 | at 40,000 | at 200,000 |
| --- | --- | --- | --- |
| store.js | 21% | — | — |
| package-lock.json | 25% | 20% | — |
| mixed project files | 24% | 11% | — |
| a list of UUIDs | 43% | 14% | 3% |
| random hex | 37% | 10% | 2% |
| random base64 | 89% | 67% | 25% |
| random printable characters | 98% | 92% | 69% |

Every column falls as the sample grows, which is the point: the number is a
property of the text *and the length*, and quoting one without the other is how
the first table went wrong.

The review that caught this gave replacement figures at 40,000 characters —
base64 at 12%, random printable at 0%. Those did not reproduce here. At 40,000
characters this measures base64 at 67% and random printable at 92%, and the
counts were checked twice: FTS5's own vocabulary and a direct count in
JavaScript agree exactly, at 26,791 and 36,886 distinct trigrams. A fraction of
0% is not reachable for random text at any length, since 40,000 characters over
a 94-character alphabet cannot collide into near-nothing.

So the methodology correction is adopted and the numbers are this project's
own. The disagreement is recorded rather than resolved, because the conclusion
does not turn on it: at every length measured, by either party's figures, the
shape passes the repetition rule and only the length rule stops it.

## Why a search cannot be interrupted

*Pointed at from `searchMemories` in `src/store.js`.*

`node:sqlite` exposes no interrupt and no progress handler. Its whole surface is
`open`, `close`, `prepare`, `exec`, `function`, `location`, `aggregate`, the
session calls and the extension calls. The SQLite underneath is 3.51.3 and has
both in C. The binding is synchronous, so nothing else in the process runs while
a search finishes.

`iterate()` is the only in-process lever and `ORDER BY rank` defeats it: the
first row arrives at 979 ms of a 993 ms query, so stopping after five rows still
costs 988 ms. Doing the ranking ourselves gives byte-identical ordering and
moves the first row to 436 ms, because `bm25` wants its global statistics up
front — better, and still not abandonable.

What it costs today. Ordinary stores answer fast — 112 ms and 175 ms for 2,000
memories at 36 MB. Memory is bounded by the three limits above, at around
91 MB for the worst single memory they allow. Time is not: a thousand memories
at that shape take 92 seconds for one search, and it cannot be stopped once it
starts.

There is no bound on time because nothing predicts it. A query with 43 million
total occurrences answers in 7 ms while another with 105 million takes 1094 ms,
since an AND across selective terms stops early and a single dense term does
not. A limit built on that number would refuse ordinary searches on large
stores while still allowing slow ones.

Fixing the interruption means dropping relevance ordering, or moving search into
a process that can be killed. Both change what search is. If real use shows the
residual matters, that is the moment — and these numbers are the argument for
revisiting it.

## What Phase 2 learned about where a bound belongs  [record]

*Written before Phase 3, for Phase 3. Phase 3 has happened and everything below
was built — the inventory test exists and is verified by mutation, the gate
holds the bounds, and what the installer refuses is two sections down. This is
kept as the reasoning that produced them, not as work outstanding.*

The same defect was fixed three times, and each fix was placed at whichever
doors existed that week. Item 14 bounded the query in the MCP adapter, and
the `search` command was still open. Item 42 bounded the text at both doors, and
a library caller of `submit` was still open. It would be easy to read that as
carelessness three times over, and the sharper reading is the review's: it was
not that the bound was in the wrong place, it was that *"where the callers are"*
was treated as a stable fact, and it never was. Each fix was correct about the
doors that existed when it was written.

The gate is the one place every caller passes through. That is why the length
and repetition rules live there now.

Four things follow for Phase 3, which adds an installer and config detection —
that is, new entrances.

**1. Every new entrance reaches the store through the gate.** An installer or a
config writer does not obviously touch memories, but one that seeds a first
memory, or validates a store path, is a caller. There is no exception for "it
is only setup".

**2. Write the test that would have caught all three failures.** It does not
exist. It is an inventory test: enumerate every module that reaches `store.js`
or `gate.js`, assert the list, and a new entrance then fails a test rather than
waiting for a review to notice. The vocabulary closure test is exactly this
idea applied to rule names, and it works — it has been verified by mutation, a
thirteenth name fails, a removed name fails, a renamed name fails. Phase 3 gets
the same for callers.

**3. Config files are a new class of untrusted input and no existing rule
covers them.** The gate's rules are about text a person offers as a memory.
Nothing in them says what a malformed, hostile or merely surprising config file
should do. Write down what the installer refuses before writing what it
accepts.

**4. The installer writes to files this project does not own.** That is a
destructive surface this project has never had. Rule 2 of the whole project —
nothing is deleted, nothing expires — needs its analogue stated for it: nothing
overwrites a config the person did not ask us to change, and every write is
reversible or backed up first.

## What Phase 3 refuses to write, and why

*Pointed at from `writeToClient` in `src/write.js`.*

The section above asked Phase 3 to write down what the installer refuses before
writing what it accepts, on the grounds that config files are a class of
untrusted input no existing rule covered. This is that list, after the fact
rather than before it — every entry here was added because something was found,
and saying so is more useful than pretending it was foreseen.

**A file that does not parse.** Left exactly as it is. Not tidiness: Claude
Desktop's own loader falls back to an empty object on a read it cannot parse and
then writes that over the file, so editing around a syntax error is not a
cosmetic risk, it is how somebody's whole configuration disappears at their next
launch.

**A file that is not an object, or whose root key is not an object.** There is
nowhere to put an entry, and inventing somewhere is guessing.

**A file whose application is running,** for the two clients measured rewriting
their configuration from memory. An entry written then reads back correctly,
reports success, and is gone at the application's next save. That is a green
tick with a shelf life.

**A file somebody set read-only.** An atomic write does not need permission on
the file — it renames a new one over the top — and because the mode is carried
onto the replacement, the person who set it could not tell afterwards. Standard
behaviour, wrong answer: a change the owner of a file cannot see is the one this
phase must not make.

**A YAML block written on one line.** `extensions: {}` cannot be extended by
inserting lines, and a malformed Goose config silently loses every extension the
user has, not only ours.

Three things it deliberately does **not** refuse, each because refusing was
found to be wrong about a real file:

- **A trailing comma**, in the two clients whose format allows them. Zed's own
  shipped settings have one after the last key of every block, and refusing
  meant no Zed user with default settings could be installed to.
- **A byte order mark.** Notepad and older editors write one; `JSON.parse`
  refuses it and every other program the person owns does not. Telling somebody
  their working file is corrupt is worse than the failure it guards against.
- **Comments and formatting anywhere.** Every edit is a splice rather than a
  parse and reserialise, so nothing that is not our entry is read as data or
  written back.

The other three things that section asked for were answered where they belong
rather than here. Every new entrance reaches the store through the gate — the
installer reaches the store not at all, which is stronger and is asserted by the
inventory test it also asked for, verified by mutation three ways. And the rule
about writing to files this project does not own became: one copy of a file
before the first time we edit it, never replaced; a copy only where we do the
editing, because a client's own command writing its own file is not ours to
insure against; and an uninstall that removes what we added, including the
container and the directories, and nothing else.

One boundary on that last promise, because it is real. Every byte outside the
container our entry goes into survives an install-and-uninstall unchanged. The
container's own interior whitespace does not: a `{}` opens onto two lines when
an entry goes in and stays open when it comes out. Closing it again would mean
having recorded the whitespace inside it, and the cheap alternative — collapsing
any empty object we find — is guessing at somebody's formatting rather than
restoring it.

## A new entrance goes into `doctor` in the same commit

*Pointed at from `diagnose` in `src/doctor.js`.*

The entrances test already applies this rule to the static case: a module that
can reach `store.js` or `gate.js` is on a list, and a new one fails a test
rather than waiting for a review to notice. It was written because the same
defect was fixed three times, each time at whichever doors existed that week,
and *"where the callers are"* was treated as a stable fact when it never was.

`doctor` is the same idea against a running machine rather than against the
import graph, and it needs the same rule or it decays the same way. Phase 3
ended with sixteen defects found after the fact, sixteen of which the suite was
green for; the reason `doctor` exists is that the suite cannot compose the real
table with the real filesystem. That only stays true if it keeps up.

**So: whatever a later phase adds that touches something outside this process —
a file, a client, a scheduled job, a second store — is checked by `doctor` in
the commit that adds it.** Not the commit after, and not when somebody notices.

This matters immediately. Phase 4 adds a review loop that touches the store,
which is the first thing `doctor` will have to know about that is not a config
file: a store that cannot be opened, or that a running process is holding, is
exactly the class of failure this command exists to find, and it will not find
it by itself.

Two things that follow, so the rule cannot be met in the letter and missed in
the spirit:

- **A check that cannot be made is reported as not made.** `doctor` already
  distinguishes a client it asked from one that offers no way to be asked, and
  a new subject with no way to check it says so rather than being left out. A
  silent omission reads as a clean bill of health.
- **It still changes nothing.** Whatever is added, `doctor` diagnoses. The
  moment it repairs something, its output stops being evidence of what the
  machine was like and starts being evidence of what it was like after this
  command had a go at it.

## Before trusting a checker, make it fail  [record]

Five times now a check written to hold something has been wrong about the thing
rather than the other way round, and every time the check said everything was
fine. Listing them, because the shape only becomes obvious in a row:

- A coverage sweep asked "is this client named in any test file", which every
  client is, because the table tests enumerate all twenty. It reported total
  coverage of forks it had not looked at.
- A probe recording which clients each code path processes silently recorded
  nothing for `verifyClient`, because the module imports no `node:fs` and the
  injected `require` was never defined. An empty result read as an empty answer.
- A documentation checker compared prose shape rather than facts and reported
  three documents wrong that were right — Claude Code's "Wired automatically
  through", Codex's "Wired through", the README's section count.
- The same checker's mutation harness replaced the first occurrence of a string,
  so a claim appearing twice survived being "removed" and the mutation passed.
- The section check in this file compared titles with backticks stripped against
  source that still had them, and called a pointer that was right there missing.

The rule that follows is cheap and has caught every one of them: **a new check
is not finished until it has been made to fail on purpose.** Break the thing it
guards, watch it complain, put it back. If it cannot be made to fail, it is not
a check — it is a sentence that happens to run.

The mutation tests in `test/documentation.test.js` and the three mutations
behind `test/entrances.test.js` exist because of this, and are the pattern to
copy rather than the exception.
