# One database for many sessions: measured, not adopted

Question: should the device keep one SQLite file per session (today), or fold every session into one file with group
commit, as the runtime upgrade plan (P7, E8) proposed?

Short answer: keep one file per session. The single-file shape is faster to open but nothing else it promises shows up in
a single-process device, and it would cost a migration and a global write lock to get there.

## Method

`apps/backend/.tmp-single-db-poc.mjs` (a throwaway script, not committed) built both shapes against a temporary data
directory with the faux model, and measured three things:

- **open** — time to have N conversations ready to talk to;
- **commit fan-in** — N conversations each committing W times at once (a `configure` call per write);
- **turn** — one model round trip per conversation, one conversation at a time (the faux provider's response queue
  serializes, so parallel turns would measure the queue, not the database).

Two sizes: 8 conversations × 20 writes, and 16 × 50.

## Results

8 × 20 (160 commits):

| shape | open | commits | 8 turns | faults |
| --- | --- | --- | --- | --- |
| one file per session | 59 ms | 29 ms | 479 ms | none |
| one file, many conversations | 12 ms | 22 ms | 427 ms | none |

16 × 50 (800 commits):

| shape | open | commits | 16 turns | faults |
| --- | --- | --- | --- | --- |
| one file per session | 110 ms | 112 ms | 951 ms | none |
| one file, many conversations | 17 ms | 94 ms | 918 ms | none |

No `storage_failed` report, no locked database, no retry, in either shape at either size.

## What the numbers mean

- **Opening is the real difference**, and it is linear in the number of files: ~7 ms per session file against ~1 ms per
  conversation in a shared file. This is the one honest win.
- **Commit throughput barely moves.** `node:sqlite` is synchronous and the device is one process, so the two shapes take
  turns on the same thread either way. A single file does not batch anything by itself.
- **Lock contention cannot be measured here.** Two processes never open the same session file (the device holds
  `<db>.lock`), so the cross-process contention a single-file design would introduce is a *cost* of this change that this
  PoC cannot even benchmark on a single-process device.
- **The memory and file-descriptor cost is real**: every open session holds a storage handle. A single file would cut
  that, but the device opens sessions on demand and closes them when idle already.

## Conclusion

Not adopting it this round.

1. The measured gain is opening cost on devices with many sessions open at once — a shape this product does not have
   (one or two sessions per device, a handful of conversations each).
2. The costs are certain: a migration of every existing session file into a shared schema, one write lock for every
   session, and a per-session failure that can now take down unrelated sessions.
3. Group commit only pays when several writers are blocked on the same file at the same moment, which a single-threaded
   writer never produces.

Revisit if any of these becomes true:

- a device routinely holds more than ~20 sessions open (opening dominates: ~140 ms per 20 sessions);
- the backend becomes multi-process, or several devices share one data directory;
- session files grow to the point where per-file page caches are the memory problem.

The PoC script is reproducible from this document: rebuild it with the two shapes described under "Method" and run it
with `POC_N` and `POC_WRITES` (defaults 8 and 20).
