# Decisions

Reasoning that is too long to live in the code, kept where it can be read
rather than scrolled past. Each section is pointed at from the place it
explains, and a check enforces that rather than this sentence asking you to
believe it.

Some sections are marked **[record]** instead. Those are retrospectives, or
policy for something not built — they explain no particular line, so nothing
points at them. A section that is neither pointed at nor marked is one of the two
things having quietly become the other, which is what happened to the first of
them before it was marked. This paragraph twice said a number that had stopped
being true, which is the same defect one level up; it no longer counts.

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

Two things this did not cover when it was written. Time was unbounded: the
per-memory cost is multiplied by how many memories match and nothing caps how
many there are, and a thousand memories at the worst allowed shape took 92
seconds for one search. That is bounded now, by a clock rather than a fourth
prediction — see *Why a search could not be interrupted, and how it is stopped
now*. And the two write-side limits were enforced at the two entry points
rather than in the gate, so `submit` called directly as a library function was
bounded by neither; they have since moved into the gate.

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

## Why a search could not be interrupted, and how it is stopped now

*Pointed at from `searchMemories` and `SEARCH_TIME_LIMIT_MS` in `src/store.js`.*

`node:sqlite` exposes no interrupt and no progress handler. Its whole surface is
`open`, `close`, `prepare`, `exec`, `function`, `location`, `aggregate`, the
session calls and the extension calls. The SQLite underneath is 3.51.3 and has
both in C. The binding is synchronous, so nothing else in the process runs while
a search finishes.

**What was true until 24 September 2026.** `iterate()` was the only in-process
lever and `ORDER BY rank` defeated it: the first row arrived at 979 ms of a
993 ms query, so stopping after five rows still cost 988 ms. Doing the ranking
ourselves gave byte-identical ordering and moved the first row to 436 ms —
better, and still not abandonable, because nothing in the process could act
between rows. Ordinary stores answered fast: 112 ms and 175 ms for 2,000
memories at 36 MB. Memory was bounded by the three limits above, at around
91 MB for the worst single memory they allow. Time was not: a thousand
memories at that shape took 92 seconds for one search, and it could not be
stopped once it started. There was no bound on time because nothing predicted
it — a query with 43 million total occurrences answered in 7 ms while another
with 105 million took 1094 ms — and a limit built on a prediction would refuse
ordinary searches on large stores while still allowing slow ones.

**The lever that was there.** `function` is on the list above, and a function
SQLite calls per row can throw. Measured before it was relied on: a throw from
a user function ends the statement it was called from, the connection stays
usable, and inside an explicit transaction the transaction is still open and
commits afterwards. So a per-row function that reads a clock and throws past a
deadline stops a search *between* documents. What it cannot do is stop one
inside a document, and that is fine: the write-side limits bound what one
document costs, at 40 to 80 ms for the worst shape they allow.

**Why that did not work under `ORDER BY rank`, and what does.** Measured on
twenty worst-shape memories with a 999-character query: with `ORDER BY rank`
the per-row function was first called at 1,627 ms of a 1,628 ms search — after
every document had been matched — and the whole search cost about twice what
the same query cost unordered (874 ms). Selecting `rank` as a column with no
`ORDER BY` streams: first call at 68 ms, and the total is below the ordered
form. So the store selects `rank` as a column and sorts in JavaScript by rank
and then by id, which is the order the rows arrive in and the order SQLite's
stable sorter kept. Checked on seven queries over three thousand memories with
thousands of ties: identical to `ORDER BY rank` on every one.

**The limit itself is a clock, not a prediction.** `SEARCH_TIME_LIMIT_MS` is
ten seconds. It refuses the searches that actually took too long and no others,
so the three failed predictions in *Bounding what a search can cost* are not
tried a fourth time. Ordinary searches are two orders of magnitude under it.
A stopped search is a refusal in a sentence — nothing was returned, add a word
that narrows it — never a shorter answer, which is the rule search has always
had. The overrun past the limit is one document's cost.

**Where the clock comes from, and why it is not in `store.js`.** The oldest
rule here is that no code on the memory path reads a clock, and a test refuses
`Date`, `performance.now`, `process.hrtime` and `Temporal` in every module that
can reach the store. The search clock does not bend that rule; it is handed in
at the door. `openStore` now takes `elapsed` beside `now`: a function from
`config.js` returning milliseconds from a clock that only goes forward, which
is a count from nowhere in particular and cannot be compared with a memory's
date by any arithmetic. Both are required, so a caller cannot open a store
whose searches never stop by forgetting — the shape of defect this project has
had three times with a bound at an entrance. Tests hand in a clock they
control, which is what makes the deadline testable without timing.

Three things are still true. A search inside one document cannot be stopped.
The binding still has no interrupt, so a process-level abort is still the only
way to stop a document, and nothing here does that. And the MCP server still
cannot stop a search for a client that has gone; what it can now count on is
that the search stops itself.

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

## Saying it louder, and not acting on it

A review can put away every memory in a store. It should be able to: somebody
may well ask for exactly that, and a program that refused would be forming a
judgement about a review, which is the thing Phase 4 exists not to do.

A reviewer ran that case — one pass, forty memories out of forty, plausible
reasons — and `doctor` afterwards said "the memory store opens, and no review is
open". Nothing wrong. Everything gone from `list`, the only trace in `why`,
which a person has to think to go and read. Reversible, and only if you notice.

Three things follow, and the third is the one that was argued over.

**Say what happened, do not decide about it.** `closeReview` reports two exact
counts — how many it changed, how many are on show — and no share and no
threshold. `doctor` compares those two numbers and adds a sentence when a review
moved most of a store. Where a number becomes worth saying out loud is a
decision about telling, not about memories, which is why it lives in the
reporting command and not in the gate. Nothing anywhere refuses, caps or warns
programmatically on the ratio.

**Counts are not dates.** That comparison is two integers and no clock, and
choosing to *mention* something because of a proportion is neither a comparison
of moments nor a decision about a memory. It does not touch the rule above.

**An unusual review does not turn the exit code red, and this is settled.** It
was argued both ways and the second argument won:

- For red: unattended means nobody is reading, so the status is the only signal
  that travels.
- Against, and decisive: the review stays in the log, so `doctor` would be red
  from that day on. A permanently red command is one people stop running, and
  the failure mode of a check nobody reads is worse than the failure mode of a
  sentence somebody might skim. Time-scoping it — "reviews from the last week" —
  would need exactly the comparison the section above forbids.

What actually closes the unattended gap is neither of those, because both act on
somebody who is already looking. `doctor` is pulled. The agent that just ran the
review is the only party that can reach the person who is not looking, in the
conversation where they asked for it, and `review_end`'s description is the
whole of the influence available over whether it does. That is where the fix
went.

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

Phase 4 added a sixth and a seventh, and they are the reason this section now
carries two rules rather than one.

The sixth: the guard on the one line that must hold — that nothing decides
anything from a date — passed its own suite while accepting the exact rule it
was written to forbid. It matched the phrasing (`Date.now`, `new Date`) and the
rule needs no clock, because timestamps here are ISO 8601 strings and ISO 8601
sorts as text. Rewritten to match the comparison, it caught four of twelve
mutations; the eight it missed were ordinary refactoring, beginning with
extracting a variable. A lexical check on what sits next to what survives
exactly one assignment. It is now a check on whether the value can get out at
all, which does not decay the same way.

The seventh is about how that was found. The reviewer ran twelve mutations and
**checked which test failed for each** — and two of its own attempts looked
caught and were not, because breaking behaviour turns other tests red without
the guard firing at all. A harness that asks "did the suite go red" scores a
guard that never fired. One of ours does the same thing: a mutation to the SQL
turns ten other tests red as well as the guard.

So, two rules.

**A new check is not finished until it has been made to fail on purpose.** Break
the thing it guards, watch it complain, put it back. If it cannot be made to
fail, it is not a check — it is a sentence that happens to run. Do it in the
same commit that adds the check, not afterwards: every guard in this project
that was wrong was wrong on the day it was written.

**Assert on the name of the test that fires, not on the suite going red.** A
mutation that breaks behaviour turns other tests red, and a harness reading only
the exit code will report a guard as working when it never ran. Name the test
you expect, check it is among the failures, and keep at least one control
mutation that must *not* fire it — the controls in this project's own harness
caught a false positive in the guard's allowlist.

The mutation tests in `test/documentation.test.js`, the three mutations behind
`test/entrances.test.js`, and the twenty-three behind the date guard exist
because of this, and are the pattern to copy rather than the exception.

## Time as evidence, never as a rule

The owner's previous memory project deleted things. Not by accident and not
through a bug: it had a rule that anything older than a number of days went
away. No reading, no content, age alone as sufficient cause. It worked exactly
as designed and it destroyed the thing it existed to hold.

So Phase 4 had a problem. Some memories really do stop being true — "next week
I am presenting at the all-hands" is worth keeping the day it is said and is
noise a year later — and nothing was able to notice. The obvious fix is a
timer, and the obvious fix is the thing that already failed.

The distinction that resolves it is between a statement whose *content* names a
moment and a row that is merely *old*.

- "Next month I am going to Berlin", stored in January, names a moment. Whether
  that moment has gone by is a question about the sentence, and the date it was
  stored on is what lets somebody answer it.
- "I live in Tehran" names no moment. It is exactly as true after ten years as
  the day it was written. Nothing about its age can ever be a reason to touch
  it, and no amount of time passing makes it stale.

Reading the sentence is what tells the two apart, and reading is not something
this program does. So the design is:

**The timestamp is data shown to the agent. No code here reads it and concludes
anything.**

Every memory has carried `created_at` since Phase 1. `review_start` shows it on
every line, which is the only reason that tool exists rather than `list`. The
agent reads the sentence, looks at the date, and decides. The store records
what it decided and why, and can put it all back.

The line is worth stating as an absolute because a softened version of it is
worthless. Not "we only use dates carefully". Not "the threshold is
configurable". **No comparison of a stored timestamp against the current time,
anywhere, for any purpose, ever.** The moment such a line exists, the sentence
at the top of the README — nothing in it expires — stops being true, and every
argument for widening it slightly will sound as reasonable as the first one did.

Held by a test rather than by this paragraph, and the first version of that test
was wrong in the most instructive way available. It forbade *naming a clock* —
`Date.now`, `new Date`, `Date.parse`, `getTime` — and a reviewer walked straight
past it with the rule this section is about:

```js
if (memory.created_at < '2024-01-01T00:00:00.000Z') { actions.leaveBehind(…) }
```

No clock anywhere. Timestamps here are ISO 8601 strings, ISO 8601 sorts as text,
and that is a deliberate property of the format and part of why it was chosen —
so the comparison a clock would have been needed for is a language operator
available to anything holding two rows. **The guard forbade the phrasing of the
mistake and the design made the phrasing unnecessary.**

What replaced it matched the comparison instead — and was walked past a second
time, by this:

```js
const c = memory.created_at;
if (c < at) { … }
```

Which is not evasion either. It is what happens when somebody extracts a
variable. A check on what sits next to what survives exactly one assignment, and
eight of twelve mutations got past it: a rendered pair compared, an
`Intl.Collator`, a `localeCompare` inside a sort, a `slice` of the year, a
`String()` on both sides, a property name built by concatenation, a two-element
sort read at `[0]`. Every one of them ordinary refactoring rather than an
attempt to hide.

The third version asks a different question — not *is the mistake spelled this
way* but **can the value get out at all**. Outside `store.js`, a timestamp
column may appear in exactly two places: inside a `${…}` being rendered into a
sentence for a person, and in a comparison against null. Not assigned to
anything, not passed to anything, no method called on it. Once it is in a
variable nothing lexical can follow it, and every one of those eight mutations
begins by getting it out. Fourteen mentions satisfy that today, across four
files.

`store.js` is exempt and keeps the comparison rules: its SQL names these columns
in every statement it has, and a rule forbidding that would forbid the file.
Comments are stripped and string literals are kept, because `WHERE created_at <
?` is the same rule one layer down where JavaScript cannot see it.

Twenty mutations that must fire and three that must not, and the harness asserts
on the *name* of the failing test — the SQL one turns ten other tests red as
well, and a harness reading only the exit code would have scored a guard that
never ran. What it does not catch, said rather than left to be found: reaching
the column with no `_at` token anywhere, `Object.values(memory)[4] < at`. That is
hiding rather than refactoring, and a lexical check cannot follow it.

Writing a timestamp down is fine and this project does it constantly — every
memory, every decision, every line of the action log — so the check is scoped to
the modules where reading one would be a decision about a memory rather than
banned outright.

The list of modules is derived from the import graph rather than written down.
The hand-written version missed `doctor.js` when that module joined the
entrances, inside the commit whose own test says a module joining one list joins
the other in the same commit for the same reason. Two lists kept by hand had
already drifted apart in the change that promised they would not.

The state a review can reach is `overtaken`, and its name is part of this. Not
`expired`, which describes a timer. Not `forgotten`, which is the person saying
they do not want something shown. Overtaken by events: the world moved and this
did not, which says nothing whatever about how old the row is.

## There is a command, and what the reasoning cost  [record]

0.0.1 shipped with no `bin`, so a global install put nothing on PATH and the
README told people to run `node "$(npm root -g)/nosyparker/src/cli.js" setup`.
That broke the promise this project opened with — one command that wires every
agent up — and it was justified here by a claim that had never been measured:

> a package run that way lives under `~/.npm/_npx/<hash>/`, which npm clears.

**npm does not clear it.** Measured on npm 10.9.8: `npm cache clean --force`
empties `_cacache` and leaves `_npx` exactly as it was, and `npm cache verify`
does not touch it either. The sentence was written in the confident register
this document uses for measured things, and it was a guess.

The hazard is real and it is a different one. `_npx/<hash>` is keyed on the
exact spec, so `npx nosyparker` and `npx nosyparker@0.0.3` unpack to different
directories and **both persist**. A config written by the first goes on pointing
at a copy that still works and is silently a version behind, for ever. That is
worse than a path that breaks, because nothing ever tells you.

So 0.0.2 does both halves of what this section previously said would be needed.
There is a `bin`, named `nosyparker`, so the promise holds and `npx nosyparker`
resolves instead of failing with "could not determine executable to run". And
`install` refuses outright when the path it is about to write is inside an
`_npx` directory, with the two commands to run instead — a refusal rather than a
warning, because it is a cache, npm promises nothing about it, and twenty
configs pointing into one is not a thing to do quietly.

`invocation()` now returns `nosyparker` when it was started through the shim and
the script path otherwise. It matches the basename under both POSIX and Windows
rules, so the `.cmd` name a Windows shim carries is recognised rather than
missed by a separator.

**What Windows actually does here has not been measured, and this paragraph
used to imply it had.** It said npm writes a `.cmd` wrapper that runs the script
directly, so that platform gets the path form — stated in the same settled
register as everything else in this section, six lines above a lesson about
exactly that. Nobody has run a global install on Windows and printed
`process.argv[1]`. It is the first thing on the list for the Windows round, and
until then the honest word is unknown.

**What this cost, and the lesson worth keeping.** The claim sat in this document
for a day, was read back by the person who wrote it as though it were evidence,
and shaped a released package. A measurement takes minutes; this one took a
user asking why he had to type two commands. **If a paragraph here states a fact
about another program's behaviour, it has to name what was run and what came
back — and if it cannot, it is a guess wearing the clothes of a finding.**

## Removing an entry we did not write  [record]

The README said, from Phase 3 until 0.0.2, that setup "never removes anything it
did not add". That was the whole of the promise it made about other people's
files, and `cleanSecondSurfaces` broke it: `cursor --add-mcp` writes the entry
into Cursor's user settings file — on Linux
`~/.config/Cursor/User/settings.json` — and uninstall takes it out.

The promise is now narrower and the behaviour stays, which is the right way
round for one reason. **The purpose of `uninstall` is that nothing of ours is
left running.** An entry in that file starts our server exactly as an entry in
`~/.cursor/mcp.json` does. Leaving it because a different program's hand typed
it would mean the command did not do the one thing it exists for, and the person
would be told it had.

We caused it to exist. It was written during research, by us, running that
command to find out what it did. Somebody who ran it themselves has the same
entry for the same reason — because this project told them to, or because they
were wiring us up.

What keeps this from becoming a licence:

- **Our entry only.** Keyed on the server name, spliced out, every other byte
  left alone. `editor.fontSize` beside it is untouched, and there is a test that
  fails on the file's mtime as well as its contents.
- **A copy first**, through `recordFirstTouch`, like every other file this
  program edits. It went a day without one and that was the worst finding of the
  first review.
- **Said out loud.** The removal report names the file and where the copy is, and
  the README says which file and why before anybody runs it.
- **Only where we know.** The path is per-OS and carries `measuredOn`; on a
  platform nobody has watched it work, an inferred path that is wrong misses
  rather than damages, because cleaning only ever acts on a file that exists and
  holds our entry under that key.
- **The table decides, not the code.** Adding a second surface is a row in
  `clients.json` that `validateTable` refuses if it is incomplete.

The rule that replaces the old sentence: *we add and remove our own entry, and
nothing else, wherever that entry ended up.* If a future row wants to remove
something we did not cause, that is a different decision and it needs its own
argument here.

## The schema, frozen on 19 August 2026

Three tables, one virtual table, three triggers, one index. Schema version 2.

    memories        id · owner · text · text_normalised · created_at
                    state {active, superseded, forgotten, overtaken}
                    state_reason · state_at · supersedes · superseded_by
    review_passes   id · owner · reviewer · began_at · closed_at · undone_at
    decisions       id · owner · decided_at · verdict · rule · explanation
                    memory_id · related_memory_id · input_excerpt
                    pass_id · reasoning · derived_from
    memories_fts    external content, trigram, kept in step by three triggers
    index           decisions(pass_id)

Changing this was free until today and costs somebody's memories after it. So
it was looked at once, deliberately, and this is what we live with.

**What the look changed.** One index, and only because measurement asked for it.
At 20,000 memories and 24,400 decisions, `reviewSummaries` took 357 ms because
it reads the decisions of every pass — cost is passes multiplied by decisions,
both grow with use, and `doctor` calls it on every run. With `decisions(pass_id)`
it is 35 ms. Two other indexes were tried and made things worse: one over
`(owner, text_normalised)` for the duplicate check turned 7.4 ms into 10.0 ms,
inside the write lock every other agent waits on, and one over `(owner, state)`
turned `listMemories` from 21.4 ms into 25.5 ms, which is what happens when you
index a query that wants every row anyway. They are not here.

The index is created on open rather than only for new stores, because the
schema statements run once for a fresh file and would reach nobody who already
had one. It is not a column, so it does not move the schema version.

**What is missing, and is staying missing.**

*Nothing records which agent stored a memory.* A review says who ran it and a
memory does not say who wrote it, which is the one asymmetry a year of use would
notice: "which of them told you that" is a fair question and there is no answer
in the file. It is not here because filling it honestly means every door
supplying it — the MCP server has the client's name, the terminal has no agent
at all — and inventing a value for the door that has none is worse than the gap.
This is the most likely reason for a schema version 3.

*There is no way to repair the search index.* `memories_fts` takes its content
from `memories` and three triggers keep it in step. If they are ever bypassed,
searching lies quietly. FTS5's own `integrity-check` was tried and does not
detect that case — it verifies the index against itself, and a row removed
behind the trigger came back clean — so nothing was built on the strength of a
check that does not check. A `rebuild` costs 25 ms per 2,000 rows if it is ever
needed.

*`derived_from` holds ids as text, so a purge can leave one pointing at nothing.*
Purge clears the two foreign keys and runs `foreign_key_check`; it does not
touch this, because it is a record of what an agent read and the agent did read
it. Rewriting it would make the record claim the review read fewer memories than
it did, which is a worse thing for a log to say than a number that no longer
resolves. A join table would have avoided the question and is the one part of
the shape I would think longer about if it were being designed again.

*No unique constraint over active text.* The duplicate rule is the gate's, and
making it the file's would also make `restore` fail with an SQLite error when
somebody brings back a memory whose words happen to be stored again — worse than
the two identical memories it would prevent.

*No `decisions(memory_id)` index.* No query here asks that question. An index
for a question nobody asks is a guess about the future written into everybody's
file.

## How a migration is done, if one is ever needed  [record]

There is no migration in this code and deliberately nowhere to put one: a store
written under an older schema is turned away at the door with a sentence naming
the file. That is right for a project with no released version. It stops being
right the first time somebody has memories in a file and an upgrade needs a
column, and this is the policy for that day, written now rather than under
pressure.

**Never in place.** The original file is not touched. Copy it, migrate the copy,
verify the copy, and only then swap. The original stays where it is as the
backup, and the person deletes it when they are satisfied — not us, not the
migration, not a tidy-up.

The worst case that policy allows is a failed migration leaving somebody exactly
where they started. Any policy that edits the live file has a worst case of
somebody losing everything, and no amount of care inside the migration changes
which of those two you are choosing.

**Copy it with `VACUUM INTO`, not with `cp`.** This is the step to get wrong and
it fails silently. The store runs in WAL mode, so recent writes live in a
`-wal` sidecar until a checkpoint folds them in. Measured on a store of 200
memories with an open connection:

    original                    200 memories, 200 in the search index
    cp memory.sqlite copy       135 memories, 135 in the search index
    VACUUM INTO 'copy'          200 memories, 200 in the search index

The plain copy lost a third of the store, reported no error, passed
`foreign_key_check`, and had a search index that agreed with the truncated
table — so every check you would think to run says it is fine. `VACUUM INTO`
produces one consistent standalone file. It is one statement:

```sql
VACUUM INTO '/path/to/memory.migrating.sqlite'
```

**Then, in order.**

1. `VACUUM INTO` a new file beside the original.
2. Migrate that copy. `ALTER TABLE … ADD COLUMN` for a new column; for anything
   structural, create the new table, copy the rows, and swap inside one
   transaction. Set `PRAGMA user_version` to the new number last, so a copy that
   failed halfway is still recognisably the old shape.
3. Verify the copy, and verify it against the original rather than against
   hope: the same number of rows in `memories`, `decisions` and `review_passes`;
   `PRAGMA foreign_key_check` empty; `PRAGMA integrity_check` clean; the search
   index returning the same count for a term that matches most of the store; and
   `openStore` opening it under the new code.
4. Anything wrong: delete the copy, say what failed, and stop. Nothing has
   happened to the original.
5. Only then rename the original to `memory.sqlite.before-v<n>` and the copy
   into place. Say where the backup is, in that sentence, in the output.

**Never delete the backup**, on any schedule, for any reason, including disk
space. That is the same rule as everywhere else here: nothing in this project
removes what somebody might want, and a migration is the moment it matters most.

`nosyparker export` is the other half of this. It is the copy that does not
depend on the schema being readable at all, and the sentence to put in front of
somebody before a migration runs is to take one.

## What the first real migration got wrong  [record]

0.0.4's migration ran on the owner's store and worked: 152 of 208 rows rekeyed,
all seven checks green, `search 10` and `search ۱۰` returning the same 29
results. It also failed on his first attempt, and the three things it got wrong
are all the same mistake wearing different clothes — **the program found out too
late, and then explained itself badly.**

**The check asked the wrong question.** Before doing anything it asked whether
the store was free by running `BEGIN IMMEDIATE` and rolling back. In WAL mode a
write transaction may start alongside any number of readers, so a client sitting
with the store open passes that. The step that actually needs the file to itself
is `PRAGMA journal_mode = DELETE`, at step 6 of 7. So it copied his store,
rewrote 154 rows, ran every verification, and met `database is locked` at the
swap. Measured, with a second connection open:

    BEGIN IMMEDIATE                     succeeds
    wal_checkpoint(TRUNCATE)            succeeds
    journal_mode = DELETE               database is locked
    locking_mode = EXCLUSIVE + a write  database is locked

The rule: **a precondition has to ask the question the last step will ask.** If
it asks an easier one it is not a check, it is a delay. The check is now the
exclusive-lock write, which fails in exactly the circumstances the swap will.

**And it reported the wrong thing when it was not a lock.** The first version of
the replacement treated every failure as "somebody has your store open", which
sent a person to close editors that were already closed when the real problem
was a folder they could not write. A check that collapses distinct failures into
one sentence is worse than no sentence, because it is confidently wrong.

**The failure arrived as a stack trace.** Every other refusal in this project is
prose. This one — the one a person is most likely to hit, because having an
editor open is the normal state of a working machine — printed a file path and a
line number. The launcher now turns anything unforeseen into a sentence that
keeps the error's own first line and throws the frames away.

**And it left him stuck.** Refusing to run because a `.migrating` file is there
is right; it may be the only thing that finished. But that was not his
situation: his run had failed at the swap and his store was untouched, and he was
given the dangerous-case sentence and had to work out for himself that moving
the file aside was safe. The two are now told apart from the store itself — **if
the live store still holds rows keyed under the old rule, the swap never
happened** — rather than from a marker file, because a marker file is one more
thing a stopped run can leave behind, and the situation being explained is
somebody already holding a file they did not expect.

The general form, and the reason this is a record rather than a bug fix: the
migration was tested hard on whether it would *corrupt* anything, and not at all
on what it does to a person when it stops. Six of its seven checks were watched
failing against deliberately damaged copies before it shipped. None of that
asked what somebody reads at the terminal, and that is where all three of these
lived.

## Two indexes, and why this one is not a migration  [record]

0.0.4 folded digits into `text_normalised` so that `۱۰` and `10` are one
memory. It did not fix search, and the reason it looked as though it had is
worth keeping.

Search has two paths. Under three characters it looks through `text_normalised`
directly, because a trigram index has nothing to match on; three or more goes to
the FTS index, which is built on `text` — the column the fold deliberately never
touches. So `search ۱۰` and `search 10` agreed, and `search ۲۰۲۶` and
`search 2026` did not. On the owner's store: 4 results against 70, for the same
number. **The half of the feature that was tested was the half that already
worked**, because the migration's own query check compares through the substring
path, which is the path that was never broken.

**Union or folded-only, settled by measuring.** The obvious safe choice is to
search both indexes and union the results, on the grounds that finding more is
the direction we already permit. It was measured instead: 3130 distinctive terms
from his own store in three digit scripts and at every length, plus 30 built to
break it — fullwidth forms, ligatures, roman numerals, ℃, ㍿, soft hyphens,
sharp s, runs of whitespace. The raw index found a memory the folded one misses
**zero** times; the folded index found 643 the raw one missed.

It cannot be otherwise, and the argument is short enough to keep: the same
many-to-one folding is applied to the stored text and to the search term, so it
can only merge matches. The one case where it could cost a match is a term that
folds below three characters — and such a term never reaches the index, because
the length test is applied to the folded term and sends it to the substring path
instead. Folded-only, and the promise is exact rather than approximate: the two
scripts return the same memories, not overlapping ones.

**And it is an index, so it is not a schema change.** The rule was already
written down here for the b-tree indexes: *an index is not a column; it is not a
reason to turn a file away and it does not move the schema version.* A second
FTS table is an index. It is created and filled on the first open by code that
knows about it — 13 ms for 213 memories, 43 ms for ten thousand, 688 ms for a
hundred thousand, once — and `PRAGMA user_version` stays at 2.

That last part is not a technicality. **A backup is only a way back if the
version you would go back to can still open it.** Bumping the schema version
would have meant that after upgrading, the backup the migration tells somebody
to keep could no longer be opened by the release they kept it for. Verified
rather than assumed: 0.0.4's own code, from its own commit, opens a store this
version has written, reads it, writes to it, and searches it with 0.0.4's
behaviour — `2026` finding the ASCII memory and `۲۰۲۶` the Persian one, exactly
as it always did.

The raw index is therefore kept and kept correct even though nothing here reads
it any more, and there is a test that says so — because an index nothing reads
is an index nothing would notice rotting, and it is the thing an older release
depends on.

## The guard was one file away from the defect  [record]

0.0.5 shipped, the search fix worked on his own store — 70 matches from either
script — and the command he was given to check it crashed:

    $ nosyparker search 2026 | head -1
    70 matches:
    node:events:497
          throw er; // Unhandled 'error' event
    Error: write EPIPE
        at ... /nosyparker/src/cli-main.js:258:46

`head` closes the pipe after the line it asked for. The next write fails with
EPIPE. Node turns an unhandled `error` event on stdout into a crash, and a
person who asked for one line got a stack trace with our source paths in it.

**It is not a regression.** 0.0.4 does the same thing, byte for byte, thirteen
frames deep — run from its own commit against the same store to be sure. It has
been there since there was a CLI, and `latest` has it today.

**What makes it a record rather than a bug.** Item 1 of this same release was
spent removing exactly this — a stack trace where a sentence belongs — from the
migration, and a test was written that asserts no refusal from `migrate.mjs`
reaches a person as frames. That test passes. It has always passed. It is about
`scripts/migrate-main.mjs`, and the defect was in `src/cli-main.js`, which is
the file somebody actually types at.

*The guard was written against the neighbour of the thing it needed to protect.*
Sixth time in this project that a check has been satisfied by something adjacent
to its subject: a regex matching prose near the claim rather than the claim, a
fixture that already contained the string being asserted, a mutation that
renamed a trigger instead of removing it. The pattern is always the same — the
check is true, and true of the wrong thing.

The fix is one handler installed in `src/cli.js` before any command runs, so it
cannot be present on `search` and missing from `export`. Five commands were
affected — `search`, `list`, `log`, `export` and `setup --print-config` — and
the ones that were not are simply the ones that write little enough to fit in
the pipe buffer, which is not a property worth relying on.

**Two things it must not get wrong.** Only "the reader has gone" is silent: a
write that fails for any other reason still gets a sentence, held by a test that
writes to `/dev/full` and gets a real ENOSPC from the kernel. And the exit code
was measured rather than picked — `seq`, `yes` and `cat` into `head -1` report
141 because SIGPIPE kills them, `ls` reports 0 because it never writes twice.
Node ignores SIGPIPE, so nothing here is killed and 141 would be claiming a
death that did not happen. It exits 0. What it must not do is exit 1, which is
what it did, and which tells a script the search failed.

The test runs the real binary through a real pipe in a real shell. An earlier
version of it read `PIPESTATUS`, which does not exist in `/bin/sh` here, so it
was reading `head`'s exit code — 0, always — and asserting nothing.

## The damage a test does can stop being allowed  [record]

Reported from a stale checkout on a server: the suite fails on Node 26. It does
— exactly one test of 503, and the diagnosis was right.

`test/migrate.test.js` proves the migration notices a damaged search index by
damaging one, and it did that with `DELETE FROM memories_fts_data` — writing
straight into the shadow table that holds the index. SQLite stopped allowing
that. On Node 26.7.0, carrying SQLite 3.53.4, the statement is refused with
`table memories_fts_data may not be modified`, so the test ended in an error
rather than an assertion. Node 22.23.2, which this project supports, still
allows it. Measured on both.

**The temptation is to weaken the assertion, and it has to be refused.** That
test exists because a checker nobody has watched fail may be looking at nothing;
if the corruption can no longer be performed, the check it guards becomes
unproven on that Node, which is the same thing as not having it. Four routes
were measured on both versions:

    delete a row from the shadow table   refused on 26, works on 22
    the documented 'delete' command      works on both — one memory unfindable
    drop the index and recreate it       works on both — all unfindable
    'delete-all'                         works on both — all unfindable
    write over a page of the index file  works on both — index corrupt, table fine

The last one is what it now does. `dbstat` says which pages belong to the
index's storage, the file is closed, one of those pages is written over, and the
file is opened again. It is the same corruption in a stronger form: not a
statement SQLite happened to permit, but bytes that are no longer a b-tree page.
The `memories` table still reads every row and the *other* search index is
untouched, so the damage is where it is aimed.

It is also better held than what it replaced. The index check has three ways of
reporting — the index failing its own `integrity-check`, a memory not being
findable, and the MATCH itself throwing — and this corruption trips all three
independently. Blanking any one of them leaves the test green; blanking all
three turns it red, on both Node versions. The old damage was caught by fewer.

**And the product was fine the whole time.** On Node 26.7.0: `search`, `list`,
`log`, `export`, `doctor` and `setup --print-config` all work, piping into
`head` stays quiet, and the migration runs a real store of 219 memories end to
end — 163 rekeyed, all seven checks green, 789 queries still finding what they
found. `engines` says `>=22.5.0` and that is still true; nothing about it needed
changing. The suite failing and the program failing are different problems, and
this was only ever the first.

## The review had no trigger, and what it cost  [record]

The review mechanism worked from the day it was written. `review_start`,
`review_finding` and `review_end` all did what they said. It ran **once** — 22
August, eight minutes, four findings — and never again.

Seventy-nine memories were written after it with no review over any of them. By
the time anybody counted, roughly **19 of 161 active memories were stale or in
direct contradiction**, including one saying a bill was still owed sitting live
beside another recording that it had been paid.

Nothing was broken. The design was that the person's own agent would go and
review periodically, on its own initiative, and **that part was never built**.
It only ever ran because a human asked for it, and humans do not remember to ask
for maintenance of something that is working.

So the store now says the fact out loud, in every tool response, until a review
is done: how many memories have arrived since the last one and when that was.
Overdue at twenty memories or seven days, whichever comes first — both from his
measured rate of about 2.3 memories a day, so they land at roughly weekly for
him and move with him if the rate changes. They are in one place,
`REVIEW_IS_DUE_AFTER`, for somebody who wants a different cadence.

**The line this must not cross, and it is the oldest rule here.** No code in
this project concludes anything from a *memory's* date. Counting our own process
— how long since we reviewed, how much has arrived since — is bookkeeping.
Deciding that a particular memory is stale, expired, or due to go is the
judgement `valid_until` was rejected for, and the reason has not changed: only
somebody reading the sentence can tell a fact that has gone out of date from one
that has simply been true for a long time.

That separation is built rather than promised. The calculation reads
`decisions` and `review_passes` and **never touches a memory row** — it cannot
rank, select or mark a memory, because it never sees one. The nudge says there
is unreviewed material and how much. Which memories are wrong is for the agent
that reads them.

**The guard had to learn a distinction it did not have.** `review.test.js` holds
the date rule mechanically, and it failed on the first version of this — a clock
in `review-due.js`, a `decided_at > ?` in `store.js`. It was right to: it could
not tell `created_at`, which is a memory's date, from `decided_at`, which is a
note about what we did. The temptation was to widen it until it went quiet,
which would have thrown away the thing it is for. Instead it now names the two
sets — `created_at`, `state_at` against `decided_at`, `began_at`, `closed_at`,
`undone_at` — and permits only the second, and only where the work is.

**The permission is held by its own assertion.** `review-due.js` is allowed the
one clock in this codebase on the condition that it never so much as names a
memory's date; the test asserts that before it grants the exemption. Write
`created_at` into that file and the exemption stops applying and the suite goes
red. An exemption that is not itself guarded is a hole with a comment over it,
and this project has spent seven defects on guards that were true of something
adjacent to the thing they protected.

**Two things settled by deciding.** A pass that was begun and abandoned is not
"the last review" — it reviewed nothing, and treating it as one would buy
silence for exactly as long as somebody left it open. Neither is a pass that was
undone. And the seven-day rule does not fire when nothing has arrived: a review
with nothing in front of it finds nothing, and a line that appears when there is
nothing to do is one an agent learns to skip past — which would cost us the one
time it matters.

## Which of seventeen clients does the review, and the rule we cannot write  [record]

Seventeen clients on the machine this was built on are wired to the same
store. When the store says a review is overdue, all seventeen see it.

**The answer is first come, and the rest stand down by themselves.** While a
review is open the line changes from "overdue" to saying one is already in
progress. No configuration, no election, no agent needing to know the others
exist. A simultaneous start is wasteful rather than dangerous — two open passes
cannot both retire the same memory, and there is a test that says so — and the
changed line is what makes it rare rather than what makes it safe.

**The failure that creates.** An agent begins a review and dies: terminal
closed, session ended, client quit. Nothing in this project tidies an open pass
away, deliberately — `doctor` reports one and declines to say whether anybody
will finish it, because that is a judgement about somebody else's intent. If an
open pass silenced the reminder for good, the store would look perfectly healthy
while nothing was ever reviewed again. **Silence that looks like health is worse
than never having had a reminder**, because there is nothing to notice.

So an open review holds the reminder down only while it is plausibly alive:
**thirty minutes with nothing happening in it**. Idle time rather than total
time, measured from the last finding recorded in the pass, so a review that
takes three hours is never called abandoned as long as it is working.

Thirty, because the only review anybody has ever run took eight minutes, and an
idle gap of nearly four times that with nothing written at all is far more
likely to be a closed terminal than a thinking agent. It errs short on purpose:
being wrong towards "abandoned" costs a duplicate review, which is safe; being
wrong towards "alive" costs the reminder, which is the thing being built. An
unreadable timestamp counts as idle forever, for the same reason — nothing
should buy silence on the strength of a value nothing can read.

**Nothing is decided about the pass itself.** It is not closed, marked, or
tidied. All that is decided is how long to stay quiet, which is a decision about
our own output rather than about somebody else's review, and that is why it does
not contradict `doctor` refusing to call an open review abandoned.

### The rule we cannot express, and why it is written here rather than skipped

The right rule is not first-come. **The user should name which client is allowed
to review.** These seventeen are not equivalent: a small local model judging a
hundred and sixty sensitive memories badly is worse than no review at all, and
"whichever got there first" gives that model the same standing as the most
capable agent on the machine.

**We cannot write that rule, because nothing records which client is calling.**
Every tool call arrives as `LOCAL_OWNER` and nothing else. `review_start` takes
a `reviewer` string, but it is free text the caller chooses for itself — it
identifies whoever wanted to be identified, which is not the same thing and
cannot be the basis of a permission.

This is the same missing field that made it impossible to say which agent wrote
the payment card into the store. That was the first thing it cost. **This is the
second, and it is recorded now so that whenever provenance is built, this is
waiting as a thing it unlocks** rather than being rediscovered from scratch:
with a trustworthy caller identity, the reminder can be addressed to one client
rather than announced to all of them, and everything above becomes the fallback
for stores that have not named one.

Until then, first come, and it is a compromise rather than a design.

## Where 0.0.7 stands, for whoever picks this up next  [record]

Written for a session starting cold on 4 September. **Superseded on
24 September 2026:** 0.0.7 was published through the workflow that day, with
the Phase 1 changes recorded in their own section below on top of the three
listed here. This section is kept as the record of where things stood between
the two dates; the registry, not this sentence, says what is current.

### In 0.0.7

- **The README's install block moved to the top.** `nosyparker setup` sat two
  thirds down the page behind about fifteen hundred words. The same seven lines
  were lifted to sit under the opening three, with one line on how to know it
  worked. Nothing was reworded. There is now a check on the opening block,
  because deleting `nosyparker setup` from it left every test green — the check
  that looks for that command looks at the whole page and found it further down.
- **The review reminder.** The store says how many memories have arrived since
  the last review and when that was, in every tool response, until one is done.
  Its own section is above.
- **A real payment card removed from `src/credentials.js`.** See the condition
  below, which is not finished business.

### Paused mid-flight: the `setup` output

Not started. The intent is staged progress while it runs — finding clients,
writing entries, asking each one, summarising — with a symbol and a short line
per client instead of several seconds of silence followed by a wall of prose.
Every piece of information there today stays; the long explanations move
underneath a short summary rather than in front of it.

**The constraint that must survive, in full.** A ✓ may appear **only** where a
client actually started the server and said so. Most of these clients cannot be
asked at all, and the three groups — answered, written but unconfirmed, did not
work — have to survive the redesign intact. There is a test named *"the
verification tiers are the ones the research earned, not one green tick"*, and
it exists because a tick beside everything is the single easiest way to turn
this table into a lie. Written-but-unconfirmed needs its own mark, not a
quieter tick.

**If the visual language cannot carry that distinction honestly, the existing
prose is better and the redesign should be abandoned rather than softened.**
Say so and stop; do not ship a prettier version that overstates what is known.

Colour must respect `NO_COLOR` and switch off when stdout is not a terminal —
the same surface as the pipe defect fixed in 0.0.6.

### Agreed, and deliberately untouched: the README cuts

About four hundred words were identified as cuttable against the four questions
the README exists to answer — who we are, what it can do, how to install, how to
remove. **His decision is that the whole README is the last step of the
project.** They are listed so the work is not redone, and **nobody should act on
them yet.**

1. **The Cursor `--add-mcp` paragraph** (~90 words). A correctness guarantee
   about one client of twenty-two, already in `CLIENTS.md` at more length. Cut
   entirely.
2. **"What creates `memory.sqlite`"** (~110 words). Answers a question almost
   nobody asks before installing. Move to `CLIENTS.md` or here, not delete — it
   is a real answer in the wrong place.
3. **The npx paragraph** (~70 words). Engineering justification. Cut to one
   line; the argument is already in this file.
4. **The Linux-only platform paragraph** in the install section (~50 words).
   Duplicates `CLIENTS.md` with less detail. Cut, keep the pointer.
5. **The "three groups" and "five can be asked" explanation** (~120 words).
   Names specific clients and has already been edited twice this week as the
   count changed. Compress to one line pointing at `CLIENTS.md`.

Not to be cut: the secrets section with its worked example. It is the clearest
statement of what the gate is for and the thing that distinguishes this from a
notes file.

### A known condition, not a task

**The payment card is still in the published npm tarballs and in this
repository's git history.** It was in `src/credentials.js` from 0.0.3 through
0.0.6 — verified by downloading and unpacking every published version — and it
is in three blob versions plus one commit message here. 0.0.1 and 0.0.2 are
clean. It is the card number alone: no expiry, no CVV, no cardholder name,
established by scanning every published version and every blob in history for
either.

**Taking it out of the working tree did not take it out of either place.**
Rewriting history would change every commit from `1a00c0b98` onward and would
not remove what the registry has already served.

**That is his decision and he has made it: he judged the risk low and is
handling the card himself.** This is recorded so that the next person does not
discover it and panic, and does not quietly rewrite history or deprecate a
published version without asking him first. Do neither.

## Phase 1, 24 September 2026: what a cold read found, and what was done  [record]

A session that started from nothing but the repository read it end to end and
listed what it found. This section records each item that was then acted on,
in the order it was done, one commit each. Where an item was investigated and
left alone, that is written here too, with the reason, so the next reader does
not redo the investigation.

### Nothing ran the tests on a commit

`.github/workflows/` held `drift.yml` and `publish.yml`. The suite ran on a
laptop, and inside the publish job on the way to the registry — and the publish
job has never fired: the repository has no tags and no releases, so every
version on npm went out by hand. Five hundred tests, and not one had ever been
run against a commit by anything other than a person choosing to.

`test.yml` now runs `npm ci`, the typecheck and the suite on every push and
every pull request, on Node 22 — the line `engines` names for `node:sqlite` and
the one the suite has been watched passing on. No matrix yet, deliberately: a
red column from a Node major this project has never been run on would be a
finding about that Node, not about the commit that triggered it, and it should
arrive as its own change once this one is green. A test in `package.test.js`
holds the workflow to its three properties — the two triggers, the two checks,
and a Node the program starts on — read from the file as text, the same way the
publish workflow's condition is held.

### Kiro was wired to a file Kiro does not read

The row wrote `~/.config/Kiro/User/mcp.json` — the Linux path; nothing about
Kiro is measured anywhere else — through `kiro --add-mcp`. On 2026-08-27 it
was measured — a server in each of Kiro's two files under
different names, Kiro opened — that the agent starts the one in
`~/.kiro/settings/mcp.json` within four seconds and never opens the inherited
VS Code file at all. The table recorded that, in `cannotProve`, in a trap, and
in an `extraConfigPaths` note ending "until the write target changes, this is
the file to add it to by hand". The write target did not change. For five weeks
setup wrote the dead file, reported Kiro under "written, but unconfirmed", and
told the person to open Kiro and check — asking them to verify what the row
already said would fail. `extraConfigPaths` reached the terminal only through
`--print-config`, which nobody runs after a setup that reported success.

**The row now writes the file Kiro reads**, by file, like Cursor and Kimi:
`~/.kiro/settings/mcp.json` on Linux, root key `mcpServers`, tier C. `--add-mcp` is not
used for anything. That is also what the community table said all along — it
named that file and that root key from the start, and the three Kiro
divergences accepted in `vendor/clients.meta.json` were the table defending a
row that was wrong. They are gone.

**The inherited file stays in the table as a second surface**, the way Cursor's
`settings.json` does, so `uninstall` takes out what the earlier setup wrote —
including on the machine this project was built on, which has exactly that
file. It carries a new flag, `loaded: false`, a boolean rather than a sentence
because `doctor` chooses its words from it: an entry found there is reported as
a file Kiro does not read, and if that is the only entry Kiro has, the client
is reported broken and the exit code says so. Before this, `doctor` said "It
works" about that file, because it had one sentence for every second surface
and nothing to choose with.

What this does not do, said so it is not mistaken for an oversight: `setup`
does not clean the dead file on install. It writes the live one and leaves the
other for `uninstall`, and `doctor` names it in the meantime. Cleaning on
install would be the first time `setup` removed anything from a file, and that
is a bigger rule to change than this fix needed.

macOS and Windows paths stay null. Upstream gives the same
`~/.kiro/settings/mcp.json` on macOS and Windows as on Linux, which is
plausible and unmeasured, and this table does not write to a plausible path.

The installer's own write into the new file has not been watched with Kiro
open. What was watched on 2026-08-27 is that a hand-placed entry in that file
connects, and the write is the same code path every JSON client uses. The
`lastVerified` dates on the row say 2026-08-27 for that reason, and the next
person with Kiro open should run `setup` and read `~/.kiro/logs/<stamp>/mcp.log`
for the `Connected` line, which is what turns this from a row built on one
measurement into a row built on two.

### A document that hedges what the table has measured

CLIENTS.md said, of Kiro's inherited file, that "whether it reads the inherited
one was never established". The table had said since 2026-08-27 that it had
been established, in `cannotProve` and in a trap. Twenty-three documentation
checks ran on every commit and every `doctor`, and none moved, because every
one of them compares a name, a count, a tier or a command — facts with one
spelling — and this was a claim, in two prose forms that nothing could hold
side by side.

The fix is the one this project reached the third time it tried to check a
claim about provenance: **the claim becomes a boolean on the row, the sentence
a person reads is generated from the boolean, and the document has to carry
that sentence word for word.** `loaded: false` on a second surface is the
boolean; `whetherRead` in `clients.js` builds "Kiro does not read
~/.config/Kiro/User/mcp.json" from it — the Linux path, the only one the
surface has; a check requires CLIENTS.md to contain
exactly that, with code font stripped. Flip the flag and the required sentence
changes, so the document goes red until it agrees. Soften the document and the
sentence goes missing, so it goes red the same way. The mutation test puts the
old hedge back and confirms it is noticed.

A second check pairs with it: every second file the table carries for a client
— `alsoRemoveFrom`, `extraConfigPaths` — has to be named in that client's
paragraph. A file `uninstall` edits that the document never mentions is a file
nobody was told about, and a claim check cannot fire on a file the document
does not name.

Two things this deliberately does not do. It does not check that a document
never *mentions* a hedge — that is matching English against a pattern, which
has passed for the wrong reason three times here. And it does not require every
paragraph to name its client's primary path: eighteen of twenty-two paragraphs
do not, on purpose, because for most clients the path is the least interesting
thing about them and `--print-config` prints it.

### A constant nothing read, and the flag that would have said so

`AROSE` in `review-due.js` listed the two verdicts that mean a memory arrived,
beside a query in `store.js` that spells the same two out, and nothing read it.
It was found by a person reading the file. Removing it is one line; the
decision is the flag turned on with it. `noUnusedLocals` in `tsconfig.json`
makes the typecheck refuse a name that is declared and never read, and it
found four more the moment it was on — two imports in `doctor.js`, one in each
of two test files — which is the difference between a tidy-up and a mechanism.
`noUnusedParameters` was tried and left off: the names it objected to are
parameters kept to make a signature read correctly, and renaming them with an
underscore to satisfy a flag is a cost with nothing on the other side of it.

### One branch, fully merged, deleted

`clients-hermes-openclaw-and-three-untested` was nine commits behind `main`
with nothing on it that `main` did not have — `git log main..branch` was
empty, locally and on the remote. Deleted in both places on 24 September 2026.
Nothing was lost; the commits are all on `main`, and the branch name is in the
merge commit `a5fadac` for anybody looking for it.

### The interpreter goes away, and now something says so

Every entry names `process.execPath` in full, for a reason `clients.js` has
carried since the day it was chosen: a client started from a desktop icon has no
PATH. The cost was written beside it — switch or remove that Node and every
entry points at nothing, silently. `doctor` has detected that since Phase 4.
Nothing prompted anybody to run `doctor`, so the detection was a thing a person
had to already suspect.

**The least intrusive mechanism found, and what was rejected on the way.**
Reading the client files at the terminal, the way `doctor` does, was rejected:
twenty-two files belonging to other programs on every `list` is a cost this
project has refused before. Warning inside the MCP server was rejected as
impossible: a server whose interpreter is gone never starts. A third file in
`~/.nosyparker/` was rejected because the README says what is in that folder
and the README is not to be touched. Parsing `actions.log` for the last
`setup` run would work and was set aside for a record with a shape.

So `write.js` writes `wroteWith: {interpreter, serverPath}` onto the manifest
row when a write lands — including an unchanged one, since the entry is ours and
current — and both removal paths take it off again. `stale.js` reads that one
file of ours, compares each row against the Node that is running and the copy
of the server that is, and if a recorded path no longer exists, `cli-main.js`
says one line on stderr before opening the store. Stderr so that a piped search
is unchanged. Only for store commands, since `setup` fixes it and `doctor`
itemises it. And only when the recorded path is *gone*: a shell on Node 24
while the entries name a Node 22 that is still installed is a machine that
works, and a line there is a line people learn to skip.

Entries written by 0.0.6 and earlier have no record and get no line. Comparing
against a record that was never taken would be a guess about somebody's
machine, and this project does not print those. One `setup` writes the record.

### Search time, bounded by a clock rather than a fourth prediction

The brief was to investigate, report options, and change nothing unless
something small and safe existed. The whole argument is in *Why a search could
not be interrupted, and how it is stopped now*, which the code points at; this
is the record of what the options were.

Rejected: moving search into a child process that can be killed — a redesign
of the one hot path, for a problem that has never happened in real use.
Rejected: dropping relevance ordering to make `iterate()` abandonable — it
changes what search returns. Rejected: a fourth attempt at predicting cost —
three are recorded above and each admitted an 800 MB search while refusing
ordinary ones.

Taken, because it measured small and safe: rank as a column with the sort done
here, which is a pure speed-up with byte-identical results and is what lets
rows arrive one at a time; and a per-row clock function that stops a search
between documents after ten seconds, with the clock handed in at the door so
that `store.js` still names none. The MCP tests that measure abandoned
searches still hold, on a search that is now faster. Whether ten seconds is
the right number is the owner's to change and lives in one constant.

### The owner's first run after Phase 1, and what it turned out to be

He ran `nosyparker setup` and `nosyparker doctor` and pasted both. Three
things looked wrong and were checked against the code rather than assumed.

**It was 0.0.6.** The `nosyparker` on his PATH is the global install from
27 August: 22 documentation checks, no `stale.js`, Kiro's row still written
through `--add-mcp`. So nothing in that output came from Phase 1 — Kiro under
"written, but unconfirmed", doctor saying Kiro "writes this file with its own
command", and no line about a stale interpreter are all the previous version
doing what it did. Item 6 was silent because the code that says it did not
exist in that binary, and his manifest has no `wroteWith` on any of its
seventeen rows for the same reason. The Phase 1 row for Kiro is file-written at
`~/.kiro/settings/mcp.json` on Linux; it has not run on his machine yet.

**Setup and doctor disagreed about Claude Desktop, and setup was wrong.** His
file already held exactly the entry setup writes. Doctor read it and said
sound. Setup checked whether the application was running *before* it looked at
the file, refused, put a wired client under "Not done" and told him to quit
Claude Desktop and run it again — for a write that would have changed nothing.
That is the same code in HEAD, so it is fixed here: for a file-written client,
`writeToClient` reads the file first, and a file that already says what this
run would say is `unchanged` whatever the application is doing. Reading is
safe; the quit rule exists because a *write* is overwritten from memory. An
entry that is there and stale — a moved interpreter — still waits for the
quit, because that one is a write.

### The Gemini caveat, told to somebody whose folder Gemini already trusted

His `~/.gemini/trustedFolders.json` holds his home directory as
`TRUST_FOLDER` and, since 12:57 local time on 24 September, the project folder
as well. Both
`setup` and `doctor` that morning told him to trust the project folder, while
`gemini mcp list` had started the server and said connected. The file was
modified after both runs, so which of the two keys was there at 09:48 cannot
be established from here; the ancestor rule is a gap either way, and the
instruction printed is the likeliest reason the second key exists.

**Gemini's rules, read out of the installed 0.56.0 rather than assumed**, from
`packages/core/src/utils/trust.js` in its bundle. Folder trust is on unless
`security.folderTrust.enabled` is `false` in `settings.json`. A rule covers a
path if the path is the rule's path or inside it; `TRUST_PARENT` on a path
covers that path's parent. Of the covering rules, the longest path string
wins: `DO_NOT_TRUST` there means untrusted, either trust level means trusted,
and no covering rule means Gemini asks — which for a server configured for the
whole account means it is not started. Paths go through `realpath` where they
exist and are compared case-insensitively on Windows and macOS. So a trusted
home covers every folder under it, and the old check — is the folder itself a
key in the file — was wrong about exactly that. `gemini mcp list` does not
consult trust before connecting, which is why connected and the caveat could
be printed together and why connected is not used to suppress it.

**The fix is the same algorithm in `verify.js`**, as a check kind of its own,
`gemini-folder-trust`, since it is not a key lookup and pretending it was one
is what went wrong. Nine tests hold it to Gemini's precedence, including the
owner's file. Two things it does not honour, said in the code: the
`GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, which lasts one shell
and is not a fact about the machine; and a trust file Gemini cannot parse,
which makes Gemini refuse to start and so keeps the caveat.

**Other caveats that could be checked the same way, listed rather than fixed.**
Every blocker in the table was read again for this. All eight are conditional
on something read from disk; none prints unconditionally. One is worth the
owner's decision: Claude Desktop's *"organisation-level extension allowlist
… whether it gates a hand-written mcpServers entry was never established"*
fires on his machine, because his `config.json` has the `dxt:allowlistEnabled`
key — and his `~/.config/Claude/logs/mcp-server-nosyparker.log` shows Claude
Desktop starting this server and listing its tools on 23 September. That is
the measurement the sentence says nobody has made. Establishing it properly
means one more launch with the log watched; then the hedge comes out of the
row, or the check reads that log. It is not done here because a log line from
one machine on one day is evidence for that machine, and the row's claim is
general. The Zed restart line ("writing settings.json while Zed was running
produced nothing") is unconditional prose in `restart` and cannot be checked
from a file; the interpreter paragraph in the setup report is unconditional
and is information rather than a caveat.

### A path is not a token

He offered a sentence with a quarantine folder's full path in it and was
refused with "this looks like a long opaque token". The same sentence without
the path stored. The cause is one character: `/` is in the base64 alphabet, so
it was in the opaque-token alphabet, so a path such as
`/srv/somebody/Documents/Quarantine/ReportFinal2026` was thirty-two characters
of mixed case with a digit in one unbroken run — the token shape exactly. Three
shapes of real path reproduced it, and a URL did too.

**The fix, and what it rests on.** Two facts about the encodings rather than a
guess about paths. Standard base64 uses `+` and `/`; base64url uses `-` and
`_`; neither uses `.` or `~`. So a run that mixes a slash with a dash, an
underscore, a dot or a tilde cannot be one encoded token, and the token rule
is not run on it. And a run that begins as a path begins — `/`, `~/`, `./`,
`../` — and reaches a second slash is read as a path. `=` splits a run before
the test, because an encoding only has `=` at its end, so `NAME=/path` is a
name and a path. The token pattern itself is unchanged, `\b`-anchored and
ASCII, and runs over each piece exactly as it ran over the whole; the wide
scan in front of it is one linear pass, so the one-megabyte guard in
`test/mcp.test.js` holds.

**The trade, made visible.** What now passes: a bare base64 secret that
happens to start with `/` and contain another slash, with no label and no
access key beside it — about one in three hundred AWS secret keys, pasted
naked. With its label, `secret key: …` catches it; beside its access key,
`AKIA…` catches it; both are tested. What is still refused wrongly: a path
segment run with no dot, dash, underscore or leading slash that is itself
thirty-two mixed-case characters with a digit — `cache/Quarantine/
ReportFinal2026xx` after a dotfolder has split the run. That residual is
narrower than before by every real path tried, and it is written here rather
than closed, because closing it means judging whether slashed text is
"wordlike", which is a heuristic, and the point of this fix is that it is not
one. Splitting on `/` outright was rejected: it lets a forty-character AWS
secret through as three short pieces, and a false negative here is the worse
direction.

### The publish trigger, read rather than rebuilt

Under a previous name this project published a version on every push until
the count ran away and the name was abandoned. `publish.yml` was read again
with that in mind. Its triggers are exactly two: a GitHub release with
`types: [published]`, and `workflow_dispatch`, whose only publish-capable step
carries `if: github.event_name == 'release'` and so never publishes from a
manual run. Before the publish step it runs the typecheck, the suite, a check
that the release tag and `package.json` agree, and a check that the version is
not already on the registry. That is already the right shape, and it had never
run: no tag or release has ever been cut, and every version on npm went out by
hand. So it is not rebuilt. Two things were added so it cannot regress: a
block at the top of the file saying in capitals what it must never start on,
and a test that reads the `on:` block and fails on any third trigger by name
and on a release type other than `published`. 0.0.7 is the first release to go
through it.

### 0.0.7: the first release through the workflow, and where it stopped

Cut on 24 September 2026 as a GitHub release, tag `v0.0.7`, on `58fc6a8`. It
is the first tag and the first release this repository has ever had; the six
versions before it went to npm by hand. The tarball was inspected before the
tag: thirty-eight files, no path naming a home directory, no digit run passing
the Luhn check other than the documented test card, and the only
credential-shaped text is the labelled examples in comments that the gate's
own tests need.

`publish.yml` ran twice as a dry run first. The first dry run failed inside
the suite: the job installs `npm@latest`, and npm 11 prints `npm pack --json`
as an object keyed by package name where npm 10 printed a list, so the six
tests that read the tarball listing read `.files` of `undefined`. That is now
read both ways and was the first thing the workflow found — which is what a
dry run is for. The second dry run passed end to end.

**The real run reached the publish step and stopped there with `ENEEDAUTH`.**
Everything before it passed: owner check, typecheck, suite, tag and manifest
agree on 0.0.7, 0.0.7 not on the registry, `npm pack --dry-run`. The publish
step has no credential to use. `NODE_AUTH_TOKEN` was empty, because no
`NPM_TOKEN` secret exists on the repository — deliberately, after two npm
tokens were found in plaintext on a laptop — and npm's trusted publishing,
which the workflow is written for, is not configured for this package on
npmjs.com. The workflow was right to refuse; the design says refusing beats
guessing, and nothing was hand-published around it.

**What has to be set up, once, by whoever owns the package on npmjs.com.**
On npmjs.com, open the `nosyparker` package, *Settings*, *Trusted Publisher*,
and add a GitHub Actions publisher with: owner `amirj4m`, repository
`nosyparker`, workflow filename `publish.yml`, environment left blank. No
token is created and nothing is stored anywhere; the job proves who it is with
a short-lived OIDC token, which is what `id-token: write` in the workflow is
for. The job already installs a new enough npm (12.1.0 on this run) and runs
on a new enough Node. Then re-run the failed run — `gh run rerun 35986782960`,
or *Re-run all jobs* on its page — and it publishes the tagged commit; the
release does not need cutting again. The alternative, a granular access token
with publish rights stored as the `NPM_TOKEN` secret, also works and is the
thing this project has already been burned by twice; npm is restricting tokens
that bypass two-factor for exactly this use.

The trigger is what the phase 0 read said and what the test now holds: a
published release, and nothing else, ever.

**Published.** The owner configured the trusted publisher — repository
`amirj4m/nosyparker`, workflow `publish.yml`, permissions `npm publish` and
`npm stage publish` — and re-ran the failed run. Attempt 2 of run 35986782960
succeeded; `nosyparker@0.0.7` reached the registry at 11:43:53 UTC on
24 September 2026 and `latest` points at it. The `beta` tag still says 0.0.6
and nothing here moves it.

**Why trusted publishing, so it is not revisited blindly.** npm is restricting
tokens that bypass two-factor authentication: for account changes from August
2026, for direct publishing from January 2027. A workflow publishing with a
long-lived token in a secret is on the wrong side of that date; OIDC trusted
publishing is on the right side, uses no stored secret, and is what this
repository was written for after two tokens were found on a laptop. There is
no `NPM_TOKEN` secret and there should not be one.

**How the owner installed it, and what that means.** He ran
`npm install -g` against the checkout, which npm satisfies with a symlink from
`node_modules/nosyparker` into the working tree. Node resolves that link, so
`serverCommand()` now names `…/Claude/nosyparker/src/mcp-server.js` and every
entry setup rewrote points into the git checkout. That works, and it means
`git pull` changes what sixteen clients run, and deleting or moving the
checkout breaks them all — which `stale.js` would now say at the next store
command, since it records that path. It also explains the next finding.

### Doctor said run setup; setup said quit the app; nobody said both

Claude Desktop's entry named the old `lib/node_modules` server path; setup now
writes the checkout path; so `doctor` said the entry is not what setup would
write, correctly, and sent him to `setup`. Setup found Claude Desktop running,
refused to write — also correctly, it rewrites that file from memory — and sent
him back to quit it. Twice. This is not a regression of the unchanged-entry
fix earlier today: that fix stands down when the file already says what setup
would say, and this file genuinely did not. It is the two sentences not
knowing about each other. `doctor` now builds its "run setup" from the row:
for a client with `writeRequiresQuit` — Claude Desktop and Devin, the two
caught rewriting their files — it says quit it first, why, and then setup, in
one sentence, and the closing instruction at the bottom names them again.

### `uninstall` was all of them, and doctor pointed at it for one file

`doctor` told him `nosyparker uninstall` takes the dead Kiro file out. It
would — along with sixteen other clients' entries. `uninstall <client>` now
takes one client's entries out, the file setup writes and any second surface,
and leaves every other client alone; an unknown name is refused with the
list. The doctor sentence names it and says what it costs: Kiro's live entry
goes with the dead one, and `setup` puts it back. The alternative, having
`setup` clean a surface marked `loaded: false` on its own, was set aside
again for the reason given under Kiro above; the narrow command is the
smaller change and is useful beyond this one file.

`uninstall <client>` is a capability, and the standing rule is that a
capability goes into the README in the same change. The README is not to be
touched this phase, so that line is owed and is recorded here as owed.

## Before anyone else looks: what was decided on 24 September 2026  [record]

A launch-readiness read of the repository, the history and every published
tarball, done before the project is shown to strangers. What it found, and
what the owner decided about each thing, so that none of it is re-litigated.

### The card in 0.0.3–0.0.6 and in the history stays where it is

A real payment card number, in Persian digits, was in a comment in
`src/credentials.js` from commit `1a00c0b` (22 August) until `4960a34`
(1 September), and so is in the tarballs of 0.0.3 through 0.0.6 and in that
commit's message. The first draft of the read called this the decisive
blocker and proposed unpublishing the four versions and rewriting history
while there were still no forks.

**The owner's answer, and it is the right one: the card is dead.** It was
cancelled long ago; it cannot be charged, and a payment on it would need a
code only he holds. So the number is an embarrassment in old source, not an
exposure. On that basis: **the four versions are not unpublished and the
history is not rewritten.** Four versions vanishing from the registry would
raise more questions than a stale comment in a comment does, and the thing
that remains in those artefacts after the card is discounted is the
author-profiling prose below, which is not worth erasing four public versions
over. Anyone who finds the number finds a cancelled card. Do not reopen this.

### The prose profiled its author, and now does not

Every published version since 0.0.3, and this file, carried sentences that
together told a reader where the author lives, what language his records are
in, which tax system he files under, and that a bill had once gone unpaid.
Each was an engineering anecdote; the sum was a biography, shipped to the
disk of everyone who installed a memory store. The five passages named in the
read, and the rest of the "his machine / the owner" specifics in this file and
in shipped comments, were rewritten on 24 September so that the fact being
illustrated survives and the person does not: a rule still says why it
exists, and no longer says where its author banks. The research note that
named the machine, its user and its installed applications
(`PHASE3-RESEARCH.md`) left the repository the same day; the client table's
rows carry what it established, and `clients.json` says the note is kept
outside. Older tarballs and history keep the earlier wording, for the reason
given above.

### The real blocker is the two platforms nobody has watched

The owner asked why 0.0.7 was published when the plan was to test on Windows
and macOS first, and the question was fair: `WINDOWS.md` opened with "nothing
in this file has been done yet", and twenty-two client rows carry paths for
those platforms that no one has seen used. That, and not the card, is what
stands between this project and a public audience. `PLATFORMS.md` — the
renamed and rewritten brief — is the plan: what a CI runner can establish on
each platform, what only a person with the application installed can, and
which rows are unverified where. The suite now runs on Windows and macOS
runners on every push, non-blocking until it is green there.

### `--help` and `--version`

Both exited 1 with "there is no command called", which was true and was the
first thing this program said to most people. Both answer now, before the
store is opened, and create nothing on the disk. The README paragraph that
described the old behaviour as a feature says the new one.

### The README, edited on the owner's approval

Two wrong claims — a digit-block clause nothing in the code supported, and
"none of them re-read their config" when Hermes does — and the four owed
capabilities from Phase 1: the review reminder, `uninstall <client>`, the
stale-wiring line and the ten-second search limit. And three facts a privacy
reader asks first: no network, no telemetry, no account; that
`~/.nosyparker/backups/` holds other programs' configuration files as they
were, at mode 0600, and some of those files may carry API keys; and that the
agent, not the person, decides what gets remembered. The five cuts agreed on
4 September are still pending and still the owner's.

### The surface a visitor judges by

The GitHub description said "a memory store"; the package says "a gate, not a
store", and now so does the repository. Topics were empty and are set.
`SECURITY.md` names GitHub's private vulnerability reporting, which is
enabled on the repository, as the route; there is no email in the repository
by design. `package.json` carries an `author` of the GitHub handle and its
URL, nothing more.

## What we are, and the one thing to leave room for  [record]

**We are not a place. We are a gate that decides.** The storage is a SQLite file
and anybody could have written it. What this project is is the judgement at the
door — what gets in, what is refused and why, what supersedes what, what has
merely been overtaken — and a record of every one of those decisions in
sentences a person can read. If a change ever makes the store more interesting
and the gate less, it is the wrong change.

**The file is yours, wherever it is.** That is the claim, and it is stronger than
"it stays on your laptop" because it stays true in every deployment. We never
run a server and we never hold anyone's data: there is no account, nothing
hosted, and no path by which somebody's memories reach us. If a person puts this
on a machine of their own, that is their machine and their file, and the claim
is unchanged. Do not weaken it to a privacy footnote and do not qualify it into
"local-first" — it is what the thing is.

**One future direction, so nobody designs against it.** The direction is one
person's several devices sharing one memory. Written here first as a direction; it has since
become a requirement, including the phone — see *Two requirements, settled*
below, which also carries the constraint that no file-based approach ever
reaches a phone.

What waits is the work, not the decision. A week of real use produces evidence
about *how* it should be built; it is not a period in which the owner might conclude
does not want it.

Nothing is built for it and nothing in the documents claims it — the product
today is one file on one machine, and any sentence that could be read as "this
works across your devices" is a defect. What makes it an addition rather than a
rewrite:

- The gate and the store are transport-agnostic. Neither knows what called it;
  `submit` takes an owner and text, and every entrance is an adapter above them.
- Phase 2 proved the adapter pattern by putting an MCP server beside the
  terminal tool with no change to either layer beneath. A second transport is
  the same shape.
- The `owner` column has been on every row since Phase 1 and is threaded through
  every read and every rule already.

So the shape to keep is the one that exists: decisions in one place, adapters
above it, and the owner carried rather than assumed. The thing that would make
this hard later is a rule that lives in an adapter — which is the defect this
project has already paid for four times.

## 22 August 2026: what was measured  [record]

A long day of measurement, written down because most of it existed only in a
conversation. Numbers where there are numbers; "unknown" where there are not.

**npx and `@latest`.** This project refused npx, and the reason recorded in
*There is a command, and what the reasoning cost* was measured against a pinned
spec rather than against `@latest`. `_npx` is keyed on the exact spec string, so
`@latest` never changes and resolves to **one** directory that is updated in
place; a pinned spec makes a second directory and both persist. So the refusal
was right about pinned specs and over-broad about the form the whole ecosystem
actually uses.

Measured against a local registry with two versions: an update arrives on the
next launch with the config untouched, costing 9.7–10.3 s once; steady state is
~495 ms against ~140 ms for a global install, so **npx costs ~355 ms per launch,
per client, per session**. `npm cache clean --force` empties `_cacache` and
leaves `_npx` alone; deleting `_npx` outright costs a 30.7 s refetch and then
works again.

The real cost is offline. With npm's defaults and the registry unreachable, a
warm-cache launch took **70.6 s, reproduced three times** — it succeeds from
cache only after exhausting the retry backoff. Claude Code gives an MCP server
**30 s**, so in practice the client gives up first and shows a broken server.
`--fetch-retries=0` gives 0.5 s offline *and* still takes updates;
`prefer-offline` and `--offline` are equally fast and stop updating altogether.
The flag can go in `args` — `npx -y --fetch-retries=0 <pkg>@latest` was verified
to update and to survive the registry being down.

And a prerequisite nobody expected: our `bin` is the CLI, so `npx
nosyparker@latest` would run the wrong program. The convention needs a bin that
*is* the server. Windows is unmeasured; `npx` there is a `.cmd` shim.

**Dist-tags.** Verified end to end against a local registry that accepts
publishes. `npm publish --tag beta` does not move `latest`; the beta is
invisible to an ordinary install and fetched by `@beta`. Promotion with `npm
dist-tag add` moves a pointer — one PUT, **no tarball upload**, shasum
unchanged. What was tested is byte-identically what a stranger later gets.

**npm credentials.** A fresh `npm login` buys a window in which `npm publish`
works with no second security-key ceremony. That window closes: a token written
at 12:29 on 21 August published a minute later and was refused with 401 about 26
hours on. Where between those points it lapsed is **not knowable from the
machine** — the token list on npmjs.com would say, and reading that needs a
login.

**Bitwarden, and why it was rejected.** `bw unlock` returns a session key that
lives in one shell's environment. Scanning every readable process on his
machine: **0 of 183 held `BW_SESSION`** — not the agents, not the shells, not
even the terminal, because environment is inherited at launch and never updated.
Without the key `bw` reports the vault locked and a read **prompts on stdin**,
which for a stdio MCP server means hanging the JSON-RPC channel or eating
protocol traffic as a password attempt. A clean error would have been
recoverable; a prompt is not.

One useful side finding: the unlock regression tracked as bitwarden/clients
#20703, confirmed for 2026.3.0 and 2026.4.1 with no public report either way for
2026.5 through 2026.8, is **not present in 2026.8.0** — established on his
machine, and it existed nowhere public.

**The OS keychain, and why it beat Bitwarden.** `gnome-keyring-daemon` runs and
owns `org.freedesktop.secrets`; the login keyring is unlocked. `secret-tool` is
**not installed**, but libsecret, the `Secret-1` typelib and PyGObject all are,
so the capability needs no install. A store, read-back and delete round-trip
works.

The decisive difference from Bitwarden is that there is no key to carry: the
keyring is unlocked once at desktop login and any process that can reach the
session bus can read. Agents under `cursor` and under the `claude` CLI can.
A **direct child of `claude-desktop` cannot** — that process carries neither
`DBUS_SESSION_BUS_ADDRESS` nor `XDG_RUNTIME_DIR`, and with both absent the
connection fails. Losing only the first is survivable, because D-Bus falls back
to `$XDG_RUNTIME_DIR/bus`. Critically it **fails with an error, not a prompt**.

Two limits. There is **no per-app isolation on Linux**: any process running as
him reads everything in the keyring, so an application tag is housekeeping and
not a boundary. And the **locked case is unmeasured** — the keyring was unlocked
and locking his login keyring while he was working would have taken out wifi and
application credentials. Whether a locked read errors or waits is the question,
and it is open.

**The duplicate-normalisation trap.** The digit fold itself works. But
`text_normalised` is a persisted, indexed column — the duplicate key and the
substring-search index — not a value computed per call. Changing the rule leaves
every existing row keyed under the old one. On the live store this was measured
on that is **105 of 151 memories**, because it holds Persian digits. Measured: a
row stored before the change stops being found by the Persian query that found
it yesterday, 1 hit becoming 0. That is loss of access to a person's own
memories, which is worse than the
gap being closed, and it is why the fold waits for 0.0.4 and its migration.

**Over-refusal in the card check.** Any unbroken digit run is tested against
Luhn at every offset and every length from 13 to 19, so long runs are refused
almost always. Measured over 20,000 random runs per length: **10% at 13 digits,
47% at 15, 79% at 17, 97% at 20, 99.9% at 25, 100% at 30 and above.** Greek,
German and other IBANs are all refused, as is any 17-digit reference number,
and the message names a payment card that it is not. National tax and
social-insurance numbers are safe as normally written, being under the 13-digit
floor. This is the refusing-too-much shape and it is the injury real use
actually produces.

## 22 August 2026: what was decided  [record]

**0.0.3 is the credential fix alone.** A written safety promise that is false is
different in kind from a rough edge, and a release that fixes one should not
carry three unrelated changes. The auto-update work, the Windows items, the
duplicate fold and the `DECISIONS.md` records were all kept out of it.

**Releases go out under `beta` first.** He runs one for a day or two, then the
tag is promoted rather than republished, so what he exercised is byte-identically
what a stranger gets. This is the standing pattern now, and the mechanism was
measured rather than assumed.

**A false claim is narrowed, not restated.** The README said digits count as
digits in any script. They do not in a handful of rare blocks, and the claim
collapsed entirely the moment an invisible character sat inside a number. It now
names the seven scripts that were verified and says outright that it is a screen
and not a guarantee. **A second sentence that is false in a subtler way is worse
than the first**, because a reader cannot reason about where it fails.

**The invisible-character fix reads the text twice rather than banning the
characters.** `U+200C` is ordinary Persian orthography — `کتاب‌ها` and `می‌روم`
both contain one — and Persian is one of the languages the store holds.
Refusing text that contains them would turn away ordinary sentences to catch a
rare secret. The
screen looks at the text as written and again with the invisibles stripped;
nothing is refused for containing them and nothing is rewritten. The wrong fix
is pinned by a test: adding `U+200C` to the refused set turns the Persian
control red.

**Auto-update: agreed in principle, scheduled after Windows.** npx on Windows is
unmeasured, and a stranger's first experience of this program should not rest on
our guess.

**`nosyparker status`: deliberately not decided.** This one really is open.
During his week he notes anything he wanted to know that `doctor` could not tell
him. If that list is empty the command is not needed, and a command nobody
needed is worse than an absent one.

It is worth naming the difference, because the two below are not like this. Here
the week decides *whether*. For multi-device and for storing sensitive values the
week decides only *how* — those are settled.

### Two requirements, settled

These are not options and not things a week of use might change his mind about.
They are written here as requirements so that when the same ideas are proposed
again the answer is "we considered that, here is what we concluded" rather than
a discussion starting from nothing.

**Multi-device, including the phone, is a requirement.** Stated plainly, and it
has already decided something: it is why the OS-keychain secrets design was put
on hold rather than built, because a keychain does not travel between machines.
Every design from here has to answer for it.

The constraint that goes with it, so nobody rediscovers it: **no file-based
approach ever reaches a phone.** No phone agent reads a local file. A synced
folder, a replicated SQLite file, a git repository — each is a perfectly good
answer for two laptops and none of them is an answer for the phone. Whatever is
built either has a route to the phone or says plainly that the phone is out of
scope for that route.

**Storing sensitive values is a goal.** The gate refusing them outright is a
limitation to be removed, not a principle to be defended. He hit the real cost of
it — out of the house, unable to retrieve the code for his own medical results,
from a memory store whose whole purpose is to hold what he needs to know. What is
open is *where such values go and how they are protected*. Whether to hold them
at all is not open.

**And the argument that makes it more than a preference — his, and the strongest
anyone made today.** If detection *routes* a secret instead of refusing it, the
cost of a false positive disappears. A wrongly-flagged IBAN still ends up
somewhere he can get it back from; nothing is lost, he is only mildly
inconvenienced. That means the screen can be made far more aggressive than it
dares to be today, because today an over-eager rule destroys a fact and tomorrow
it merely files it in a safer place.

This turns a trade-off this project has been stuck on since Phase 1 — catch more
and refuse honest text, or catch less and let secrets through — into a much
easier one. The over-refusal numbers above are the measure of the current cost;
routing removes it rather than tuning it.

### Sync: the leading candidate, and what has to be answered first

**Sync and secrets are one decision, not two.** Where a secret can live is
downstream of where the store lives, so sync is decided first and the secrets
answer follows from it.

**A server cannot be the only answer.** Many people will not have one and some
specifically want nothing leaving the machine. So the design treats "where
memories come from" as a list rather than a place: a local-only person points at
synced files, a server person points at a server, and there is one read path
behind both.

**The leading candidate is change-log replication**, proposed by a third party
and better than the Syncthing recommendation it replaced. Credited as theirs.
The shape:

- Replicate an **append-only log of changes**. Never sync the SQLite file.
- A **global uid** per memory alongside the integer id, so two devices cannot
  mint the same identity.
- A **Lamport clock** for ordering, so nothing depends on two machines' clocks
  agreeing.
- **Protocol first, then code.** This is the instruction most likely to be
  skipped by whoever picks it up, and it is the one that matters: the questions
  below are answerable on paper and expensive to discover in an implementation.

**The unresolved objection, which the protocol has to answer rather than the
implementation discover: it breaks `purge`.** Memory text would live in the
change log and would already have been sent to other devices. "The bytes are
gone" stops being true, the raw-file grep that proves a purge worked proves
nothing, and the gate would have to screen two paths rather than one. It also
breaks the schema freeze. None of that makes the design wrong; all of it has to
be settled before any code exists.

**One measurement gates the whole project:** how many of the sixteen clients can
reach a *remote* MCP server at all. An afternoon's work, and it decides whether
this is worth starting — because if the answer is "three", the phone requirement
and the sync design need a different shape entirely.

## 22 August 2026: how the defects got through  [record]

Four lessons, kept because each one is about the method rather than the code.

**Five reviews tested in English.** The credential screen read `\d`, which is
ASCII even under the `u` flag, so a payment card written in Persian digits was
not made of digits and went into a plaintext store. Five independent reviews had
been through this project and every one of them tested in English — in a
codebase that chose a trigram tokenizer *precisely because* `unicode61` returned
nothing for Chinese and Japanese. We knew at the schema level that this is not an
English-only tool and then wrote guards that were. The blind spot was the
tester's language, not the diff.

**The suite starts from an empty store, so it cannot ask what a change does to
data that already exists.** That is a structural gap, not an oversight: 471
passing tests said the digit fold was safe, and it would have taken 105 of 151
memories out of reach. The question "what does this do to a store that is
already full" has to be asked by hand, every time a stored or derived value
changes.

**A claim in three places gets fixed in one.** The Cursor settings path, and the
"the report says which platform it could speak for" promise, each existed in
`clients.json`, `CLIENTS.md` and the README. Each was corrected once and left
standing elsewhere — three times, in three separate rounds. The answer is not
more care: it is one source. Where a claim is checkable, the sentence people read
is now generated from the data and compared word for word, and a documentation
check refuses a document that quotes one platform's path without naming the
platform.

**A regex over prose cannot express "this sentence admits what it needs to
admit".** The `measuredOn` honesty check was satisfied by an accident three
times, twice inside a test written to close it — most recently by the phrase "on
a machine we have never looked at", which is about the output and not about the
paths. Patching the pattern would have produced a fourth. The instrument was
replaced instead: the admission is a boolean beside each path, refused at load
when it disagrees with `measuredOn`, and the prose is generated from it. The
general form of the lesson is that every one of those checks stood **at one
remove** from the thing it claimed to verify.

**And one that is not a lesson but a fact worth keeping.** `purge` deliberately
does not scrub `input_excerpt`, so that somebody can always see what was removed.
That is the owner's decision and it is right — but it rests on the gate never
having let a credential through. On 22 August the gate did, and after the memory
was purged the card was still in the decision log and had to be removed
separately. A design that is safe only while another part is perfect should say
so where it is written down.

## What 0.0.4 carries  [record]

Recorded so none of it is rediscovered as a finding.

- **`digitValue` walks into the neighbouring block.** Five blocks decode as all
  nines — Myanmar Extended-C Eastern Pwo Karen and four of the mathematical
  alphanumerics. Sixteen nines fails Luhn, so such a card is stored; and because
  `text_normalised` is NFKC and NFKC folds those forms, **it lands on disk as a
  plain ASCII card**. The nine-step bound in the comment does not prevent this,
  because Unicode has adjacent `Nd` blocks. A generated table of the 77 block
  zeros closes it.
- **The separator list is five characters** and misses tab and newline — a card
  pasted from a spreadsheet column — and `U+066B` and `U+066C`, the Arabic
  decimal and thousands separators, which is the same blind spot this release
  exists to remove.
- Digit-like characters outside `Nd` (circled, superscript, parenthesised), a
  lone low surrogate, and full-width vendor keys.
- **The duplicate fold and its migration**, under the policy already written
  here: never in place, `VACUUM INTO` a copy, migrate the copy, verify it, swap,
  and the original stays as the backup for him to delete.
- **A decision on the IBAN over-refusal** — not a patch. The numbers are above.
- The long-opaque-token rule stays ASCII on purpose: widening it to `\p{Nd}`
  required dropping its `\b` anchors, and on the one megabyte query that once
  took this machine down the widened form never finished. The reach gained was
  theoretical, the guard lost was real.
## 0.0.3, and the first release under a tag  [record]

Published 22 August 2026 at 23:49 UTC as `nosyparker@0.0.3` under the **`beta`**
tag. `latest` stayed at 0.0.2 throughout, so nobody installing normally received
it and the owner's own week continued on the version he started it with. That is
the pattern described above, used for real for the first time.

`gitHead` on the published package is `251c339`, matching `main` at the moment
of publish; 32 files, 559,810 bytes unpacked, shasum `07248ce9…`.

**Verified as a stranger would receive it**, which had never been done against a
published package before — only against a local tarball. Installed from the
registry into a sandbox with a fake home: 32 files on disk matching the
registry's own count, no path naming anybody's home directory, and none of the
working documents present. Every command exercised. The battery this release
exists for was run against that installed copy — a card in Persian,
Arabic-Indic, Devanagari and full-width digits, a card with a zero-width
non-joiner interleaved, and a labelled secret in Persian and in Greek, all
refused; an invented tax number, insurance number, mobile number, a date, and
ordinary Greek and Persian prose, all stored. A raw scan of the sandbox store and
its log found none of the refused values, with a control phrase proving the scan
could find something.

**Promotion is a separate decision and stays with the owner.** It is a pointer
move — `npm dist-tag add nosyparker@0.0.3 latest` — with no rebuild and no
second upload, so what he exercised for a day or two is byte-identically what a
stranger will get. Nothing about that step is automatic and nothing about it
should become automatic.

## The gate has never refused anything in real use  [record]

Observed on 22 August, after the first day of real use, and it is about the
method rather than the code.

Across roughly 160 writes drawn from real documents, **the gate has still never
refused a credential**. Not because none were present — one day's batch alone
carried several: a payment card with PAN, expiry and CVV2, IBANs, a tax-portal
login and a bank customer code. Every one was caught by the agent doing the
writing, upstream of the gate, and never reached it.

That sounds like good news and is worth reading carefully. **A system meant to be
safe by construction is in practice being kept safe by the diligence of whoever
writes to it.** The agent is careful, so the gate is never exercised; the gate
being never exercised is exactly why a defect in it can live for months. This is
how the Persian-digit hole survived five independent reviews — nothing in
ordinary use was ever going to reach the branch that was broken.

Two things follow.

**"No refusals in production" is not evidence the gate works.** It is evidence
that something upstream is working, which is a different claim about a different
component, and the two are easy to confuse precisely when the numbers look good.
The only evidence the gate works is a test that hands it the thing it is supposed
to refuse.

**The order is the wrong way round and should not be relied on.** An upstream
filter is a courtesy of whichever agent happens to be writing; it varies by
model, by prompt, by version, and it will not be there on the day it matters. The
gate is the part that is supposed to hold when nothing else does, so it has to be
exercised deliberately rather than incidentally — which means adversarial tests
and reviews that go looking, not usage statistics.

It also sharpens the argument for routing rather than refusing, recorded above:
if a secret that reaches the gate is filed somewhere retrievable instead of
turned away, then the upstream agent's caution stops being load-bearing at all.

## The gate fired, on a real card, over a user's insistence  [record]

23 August 2026, and it closes the note above rather than replacing it.

Cursor was restarted onto 0.0.3 and given a real, already-cancelled payment
card. Cursor runs Grok, so this was **a different vendor and a different model**
from anything this project had been tested with. It was given the card as an
image and told, in effect, store this, definitely, push it into memory. The
agent stored only the safe fact — whose card it is, which bank, and what it is
probably for.

Then the person overrode it: *who refused, you or the memory? I am telling you
to store it, I do not mind.* The agent sent the full number through. **The gate refused
it**, named the reason, and refused the IBAN alongside it. Nothing reached the
file.

Verified afterwards: one decision row, `refused/credential`, excerpt
`[not recorded: recognised as a payment card number]`, explanation *"That looks
like a payment card number, so it was not stored. This is a memory, not a secret
store."* A shape-based scan of the store, the write-ahead log, the shared-memory
file and the action log — for 13-to-19 digit runs in ASCII, Persian and
Arabic-Indic, for any run of twelve or more digits, and for an IBAN pattern —
found nothing, with each pattern proved able to fire against a control.

**The override case is the one that matters, and it is the only one worth
building for.** An agent's own caution is real and it worked first — but it is
discretion, and discretion evaporates the moment a user insists. On that path
the gate is the sole defence, and until this happened there was no evidence it
would hold there. Now there is: it held against a determined user, through an
agent that had already been talked out of its own judgement, on a model nobody
here had tested.

One limitation of the record, found while checking it. **The log shows one
refusal, not two offers.** The agent's first, self-censored pass left no trace in
this store, because nothing was sent — so a person reading the decision log later
can see that the gate refused a card, and cannot see that a human had insisted or
that an agent had already declined once. Everything upstream of the gate is
invisible to it by construction. That is worth knowing when reading the log as
evidence of anything, and it is the same blindness described in the section
above: what does not reach the gate is not recorded, and a system cannot count
what it never saw.

## An outside critique, and the three answers  [record]

A critique was commissioned from outside the project. Most of what it
proposed already exists here under other names. Three of its points are worth
keeping: two are gaps we had not stated, and one is the idea that destroyed the
data this project was built to replace.

Nothing below is built, and nothing below should be built because it is written
here. The two open questions are recorded so that the next person to look does
not rediscover them as findings, and does not quietly start building them
either. They are questions, deliberately unanswered.

### Open: there are no permissions

Any agent that can reach the store may write any memory and supersede any
other. There is no proposing and approving, no reader that is not also a
writer, and no way to say that this agent may add facts and that one may only
read them.

That was never decided. It is what falls out of the store being one file with
one owner and every client pointed at it, and it went unexamined for as long as
the number of clients was small enough not to make it obvious. Setup wires
fifteen on this machine. Any one of them can retire a fact any other put there,
and the record will say what was decided and why but not that the decision came
from somewhere unexpected.

What makes this a question rather than a defect is that the alternative is not
obviously better. A memory nobody may write without approval is a memory that
does not get written, and this project already knows what a gate that refuses
too much costs — people route around it. Whether the answer is roles, a
proposing state, or nothing at all is open.

### Open: provenance is not captured on write

`review_start` takes a `reviewer` and keeps it with the pass, so a review can be
attributed and undone as a unit. `remember` has no equivalent. The store records
that a fact was offered, what was decided about it, and which rule decided —
and not which agent offered it.

So the decision log answers "why is this here" and cannot answer "who said so".
On one machine with one person those are close to the same question. With
fifteen clients, several of them running models with different habits, they are
not: "an agent decided you had moved house" and "*this* agent decided you had
moved house" are different sentences, and only the weaker one can be said today.

It is the same shape as the gap above and probably has the same answer, which
is one reason both are written here rather than one.

### Refused: expiry, and why it will be proposed again

The critique proposed `valid_until` fields and expiry. **That is the rule that
destroyed twenty days of memories in this project's predecessor**, and it is
refused here for the reason set out in *Time as evidence, never as a rule*
above, which this section exists to point back at.

Restated, because it is the one that keeps coming back: **no code in this
project concludes anything from a date.** A timestamp is evidence shown to an
agent, which reads the sentence and judges whether the moment it names has gone
by. "Next week I am presenting" and "I live in Tehran" are different in content,
not in age, and only reading tells them apart. A field that says when a memory
stops being true is a field somebody has to fill in at the moment they know
least about it, and a program that acts on that field deletes things nobody
reconsidered.

It is written down as refused rather than left unmentioned because a rejected
idea with its reasoning is worth more in this file than an accepted one. This
is the idea that arrives again every time somebody looks at the project fresh,
sees memories accumulating, and reaches for the obvious fix. The obvious fix is
the thing that already failed.

### Not recorded as direction: numeric confidence

The critique also proposed numeric confidence scores. These are noted here as
having been proposed and **not** adopted as direction — but that is one
person's judgement on the project's behalf rather than a decision the owner has
made, and it is recorded as such.

The objection, for whoever settles it: a review can already answer "I could not
tell", which is honest about uncertainty rather than quantifying it. A number
invites arithmetic on something that was never measured — comparing two
memories' confidence, filtering below a threshold, watching a score decay — and
every one of those is a rule concluding something from a value nobody
calibrated. Whether a score survives contact with `could_not_tell` is the
question to answer before any of it is built.
