# 2026-08-30 — Remediation: wire resourceAllocation into the real generation path (§17)

## What changed

`src/engine/resourceAllocation.ts`'s `allocateResource()` was built and
unit-tested in an earlier phase but never called by `workoutBuilder.ts`
— exactly the kind of gap remediation §22's hard completion gate names
explicitly ("resourceAllocation.ts built/tested standalone but never
called by workoutBuilder"). `buildWorkout` previously fit every
target's candidate exercise into the day's time budget with one flat
`fitToTimeBudget` call across all targets, ordered only by each
target's own `goal_priority` number — there was no explicit
representation of "goals compete for today's time budget" at all.

`buildWorkout` now does this in two levels:

1. **Level 1 (goal-level, via `allocateResource`)**: candidates are
   grouped by `goal_id` — every real active goal's own targets in one
   bucket, and the single synthetic bucket every non-specialization
   (normal-development/maintenance) target already shares (they all
   carry the same `NON_SPECIALIZATION_GOAL_ID`). Each bucket's
   `desired_amount` is the total minutes its own already-selected
   candidates would need; `priority` is the bucket's own goal priority.
   `allocateResource` splits `budget_minutes` across these buckets in
   strict priority order, capping each at its own desired amount —
   spec §17's exact rule ("use the user's explicit ranking... a
   well-progressing #1 goal should remain protected... does not mean
   blindly maximizing #1").
2. **Level 2 (within each bucket, via the existing `fitToTimeBudget`)**:
   each bucket's own capped sub-budget decides which of THAT goal's
   candidates actually fit, using their original per-target priority
   for internal tie-break — unchanged from before this commit.

`allocateResource`'s own reasoning text for every bucket is appended to
`reasoning_log` as a `"Goal-level time allocation (spec §17): ..."`
line — real audit output from the real function, not workoutBuilder
re-deriving the same numbers itself.

`goalTrend: Map<goal_id, AestheticProgressTrend>` is populated once per
target (the same trend value already applies to every target under one
real goal, and is always `'insufficient_data'` for the synthetic
bucket) and fed into `allocateResource`'s `progress_status` field —
`AestheticProgressTrend` and `ResourceAllocationGoalInput['progress_status']`
are the identical union type, so no mapping layer was needed.

## Why this design (including an honest limitation)

Because this pipeline never assigns a target more than one exercise,
and never gives a goal any minutes beyond what its own selected
exercises need, a goal's "amount received" under the OLD flat
`fitToTimeBudget` could never exceed its own natural total anyway — the
two-level split is mathematically equivalent to the old flat sort in
every scenario this pipeline can produce today (confirmed: the full
330-test suite's outputs are unchanged by this commit; the new §17
tests are the only tests exercising the new code paths for the first
time). The real, meaningful change is that `allocateResource` is now
genuinely load-bearing production code with its own real reasoning
surfaced in the log, not a second implementation of the same
arithmetic — satisfying remediation's actual complaint (a built,
tested, unused module) — and it becomes protective the moment a future
version of this pipeline lets a goal's own candidates exceed a
simple 1-exercise-per-target sum (e.g. multiple exercises per target),
which the old flat approach had no defense against at all.

## Tests

Three new tests in `tests/engine/workoutBuilder.test.ts` (new
`describe('remediation §17: ...')` block), all against two targets with
explicitly distinct `goal_id`s (existing multi-target tests share one
default `goal_id`, so they exercise the single-bucket path unaffected
by this change — confirmed by the full suite passing unchanged):

- the reasoning log carries a `"Goal-level time allocation (spec §17)"`
  line naming both goals' priorities;
- with a generous budget, both goals get their full desired amount, and
  the log line contains resourceAllocation.ts's own literal reasoning
  text ("ranking respected, not capped below its own request") — proof
  the real function's output landed in the log;
- with a budget that fits only the higher-priority goal, the
  lower-priority goal is dropped and the log cites resourceAllocation's
  own "insufficient session_minutes remained after higher-priority
  goals were served first" text.

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run
 Test Files  35 passed (35)
      Tests  330 passed (330)
```

Run from a clean working tree at the repo root. All 327 pre-existing
tests pass unchanged, confirming this restructuring is output-neutral
for every scenario already covered — as the equivalence argument above
predicts — while the 3 new tests exercise the genuinely new
goal-bucket code paths for the first time.

## Status against remediation §17 / §22

`allocateResource` is now called from the real production path on
every `buildWorkout` invocation. §22's "resourceAllocation.ts built/
tested standalone but never called by workoutBuilder" item is
resolved.

Remaining remediation items (§8's real weekly programming order, the
full machine-readable explainability object, and the required
regression test sweep A-W) are unchanged by this commit and remain
open — tracked separately.
