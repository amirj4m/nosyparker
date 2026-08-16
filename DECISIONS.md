# Decisions

Reasoning that is too long to live in the code, kept where it can be read
rather than scrolled past. Each section is pointed at from the place it
explains.

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

**So nothing currently bounds what a search costs.** One memory of 400 KB of a
repeated character takes 834 MB, and larger takes the machine down. That is an
open defect. `SEARCH_QUERY_LIMIT` caps one of the two multipliers and nothing
caps the other.

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
memories at 36 MB. But with no bound on what a single document may cost, a
search can run for minutes, or take the machine down, and it cannot be stopped
once it starts. These were measured while a write-time rule was in place and
are the optimistic numbers; without it the memory ceiling is gone too.

There is no bound on time because nothing predicts it. A query with 43 million
total occurrences answers in 7 ms while another with 105 million takes 1094 ms,
since an AND across selective terms stops early and a single dense term does
not. A limit built on that number would refuse ordinary searches on large
stores while still allowing slow ones.

Fixing the interruption means dropping relevance ordering, or moving search into
a process that can be killed. Both change what search is. If real use shows the
residual matters, that is the moment — and these numbers are the argument for
revisiting it.
