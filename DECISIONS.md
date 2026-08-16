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

*Pointed at from `SEARCH_QUERY_LIMIT` and `DENSEST_TRIGRAM_LIMIT` in
`src/store.js`.*

A search costs the number of trigrams in the query multiplied by how many times
the commonest of them occurs **inside a single stored memory**. FTS5 builds its
position lists one document at a time, so the densest single memory sets the
cost of every search that matches it.

This took three attempts, and the first two are worth recording because both
looked right.

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

**Refusing the document at write time.** What makes any search expensive is one
stored memory with a huge per-trigram count, and that is measurable exactly,
once, on one document, when it is offered. No estimate, no mean-versus-maximum
inference. It is also where the refusal is actionable: the person learns the
document is too repetitive while they still have it in their hand, rather than
through a search failing next week for reasons they cannot connect to anything.

Confirmed that this is the right quantity — decoy memories do not move the peak
at all (164 MB against 173 MB with two hundred of them), and the peak tracks
the densest single memory linearly:

| densest trigram | peak | time |
| --- | --- | --- |
| 9,998 | 103 MB | 149 ms |
| 49,998 | 175 MB | 582 ms |
| 99,998 | 268 MB | 1045 ms |
| 399,998 | 857 MB | 4284 ms |

And what ordinary text measures, which is what the limit has to clear:

| text | densest trigram |
| --- | --- |
| one fact about a person, 44 chars | 2 |
| a note, 2 KB | 59 |
| a pasted document, 10 KB | 304 |
| a pasted document, 100 KB | 3,042 |
| 10 KB of Chinese prose | 435 |
| 100 KB of base64 | 1,786 |
| 100 KB of log lines | 4,444 |
| **limit** | **20,000** |
| 400 KB of "the the the…" | 100,000 |
| 400 KB of one repeated character | 399,998 |

The most a caller can send through the MCP tools is ten thousand characters,
about 304. The most a shell passes in one argument is 128 KB, about 3,900. No
ordinary route comes within five times the limit, and ordinary English prose
would have to be about 650 KB in a single memory to reach it.

The ceiling it buys: no search can cost more than a thousand trigrams times the
limit, measured at 127 MB and 249 ms.

Two things that are not available, both checked rather than assumed. SQLite's
`hard_heap_limit` and `soft_heap_limit` are inert here — accepted, read back,
and 871 MB still allocated against a 128 MB limit — because Node's build sets
`DEFAULT_MEMSTATUS=0`. And the read-side estimate was removed rather than kept
as a second line of defence: it was wrong, an exact read-time check is not
available cheaply since `fts5vocab` reports no per-document maximum, and it
carried a virtual table and ninety lines of reasoning for a guarantee the
write-time rule now makes exactly.

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

What it costs today, on stores where every memory passed the write-time rule:

| store | one search |
| --- | --- |
| 2,000 ordinary memories, 36 MB | 112 ms and 175 ms |
| 400 memories of near-limit text | 70 s |
| 2,000 memories of near-limit text | 373 s |

Memory is bounded — no search exceeds about 127 MB. Time is that per-document
cost multiplied by how many documents match, and nothing caps the number of
documents. Six minutes needs a store deliberately filled with two thousand
blobs each just under the limit: not growth, and not somebody's memories, but
reachable one legal call at a time.

There is no bound on time because nothing predicts it. A query with 43 million
total occurrences answers in 7 ms while another with 105 million takes 1094 ms,
since an AND across selective terms stops early and a single dense term does
not. A limit built on that number would refuse ordinary searches on large
stores while still allowing slow ones.

Fixing the interruption means dropping relevance ordering, or moving search into
a process that can be killed. Both change what search is. If real use shows the
residual matters, that is the moment — and these numbers are the argument for
revisiting it.
