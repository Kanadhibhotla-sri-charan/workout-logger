# 2026-08-30 — Real time-fitting algorithm (§6.2)

## Why

`constraintEngine.ts` previously only had budget-check primitives
(`fitsWithinBudget`, `remainingBudgetMinutes`) — useful for checking
one item at a time, but nothing that actually decided, across a full
candidate list, what to keep and what to drop when the ideal workout
doesn't fit the available time. Spec §6.2: preserve higher-priority
goal work, remove/reduce lower-priority or redundant work, never
exceed the limit, never truncate arbitrarily.

## What changed

`src/engine/constraintEngine.ts` — new `fitToTimeBudget(items,
budgetMinutes)`: sorts candidates by priority (lower number = higher
priority, matching the convention already used by
`resourceAllocation.ts` and `goalResolver.ts`), then by a caller-set
`redundant` flag (redundant items ordered after non-redundant ones at
the same priority — §6.2 rule 2's "or redundant"), then by `id` for
full determinism. Greedily keeps items in that order while the running
total stays within budget; everything past that point is `dropped`.
Never exceeds the budget by construction. Critically, drops are always
priority/redundancy-driven, never a cut by original array position — a
test specifically constructs a case where the lowest-priority item is
*first* in the input array to prove a naive "truncate the tail" bug
isn't happening.

Like every other function in this file, `estimated_minutes` is a
caller-supplied input, never computed here — Blueprint has no per-set
duration data, and this app still has no approved methodology for
estimating one (unchanged from this file's original scope note).
Finding a shorter substitute for a dropped item (§6.2 rule 3) is
explicitly out of scope too — that's `exerciseSelector`'s job if a
caller chooses to re-invoke it.

## Tests

`tests/engine/constraintEngine.test.ts` (+7 tests): everything fits →
nothing dropped; **required test 4** — a lower-priority item is
dropped and a higher-priority one kept when both can't fit; the total
never exceeds budget across three same-priority items; a
caller-flagged redundant item is dropped before a non-redundant one at
the same priority; drops are priority-driven, not array-position-driven
(the "first in array ≠ dropped" proof above); deterministic
alphabetical tie-break; `reasoning` names the exact dropped item(s).

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  33 passed (33)
      Tests  264 passed (264)
```

(257 tests before this batch; 264 after adding 7 to
`tests/engine/constraintEngine.test.ts` — no regressions.)

## Still open

Every engine module the spec names now has a real implementation
except `workoutBuilder` itself (the §19 22-step pipeline) — its two
former blockers (resourceAllocation, real time-fitting) are both done
as of this commit and the previous one. `workoutBuilder` is next: it
assembles exposure → volume → frequency → exercise selection →
recovery → resource allocation → time-fitting → progression into an
actual generated workout for a given day.
