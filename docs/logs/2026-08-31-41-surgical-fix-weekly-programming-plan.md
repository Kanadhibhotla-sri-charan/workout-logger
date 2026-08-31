# 2026-08-31 — Final Surgical Fix Pass: real weekly programming plan

## What changed

Implemented the "FINAL SURGICAL FIX PASS — WORKOUT PROGRAMMER"
specification's central requirement: a genuine, first-class, in-memory
`WeeklyProgrammingPlan` object, built once per generation run
(`buildWeeklyProgrammingPlan` in `src/engine/workoutBuilder.ts`), with
today's workout extracted as a real slice of it — never independently
re-derived. This replaces the prior architecture, where `buildWorkout`
computed a target's per-day allocation via `desiredWeekly /
sessionsRemainingThisWeek` on every call; that division was durable
(same result any day of the week, per the prior "Strict Bug-Fix" pass)
but was still the actual decision-making mechanism, not a first-class
weekly plan.

**New types**: `WeeklyPlanInput`, `PlannedWorkItem`, `WeeklyPlanSession`,
`WeeklyPlanTargetAllocation`, `WeeklyProgrammingPlan` — matching §4's
required shapes (adapted to this repo's existing naming conventions,
reusing `PlannedExercise`'s own field shapes rather than duplicating
them).

**Day-by-day distribution, not division**: for each target, every
eligible day this week except its LAST one now gets exactly one
exercise, capped at that exercise's own Blueprint-authored per-session
`sets` figure (from the same development-package data the prior pass's
Fix C already reads) — never an even split. The target's LAST eligible
day absorbs whatever genuinely remains, using the existing 0/1/multiple
exercise constructor. A single-eligible-day target (the common case:
most PPL-restricted targets have only one compatible day) has that one
day be both first and last, so it receives the *exact same* treatment
as before this pass — verified by the full existing 392-test suite
passing unchanged.

**§7 — real cross-target exposure propagation**: `plannedExposureByTarget`
accumulates every placed exercise's real primary/secondary contribution
(`calculateExerciseExposure` — the same exposure engine every other
number in this app already uses) as targets are processed in their
fixed priority order. A target processed later (lower priority) now
reads baseline exposure *plus* whatever earlier targets already placed
this same week when computing its own live classification and need —
not a static pre-plan snapshot. This is a genuinely new mechanism (the
prior passes' `weekly_exposure_units` was always the real-logged-history
value only); it directly implements §8's "do not add redundant direct
work merely because direct sets = 0" as an explicit gate, separate from
`volumeEngine.decideVolume` (untouched, still the retained
primary/direct-sets methodology).

**Per-session time/equipment fitting**: `allocateResource` +
`fitToTimeBudget` now run once per real session (date), each using that
date's own real available minutes — today's explicit override, or the
user's real `TrainingProfile.default_session_duration_minutes` for
every other day (never today's number applied to the whole week, and
never an invented default).

**`buildWorkout` and `assembleAndBuildWorkout`** keep their exact
pre-existing public shapes and behavior for every current caller —
`buildWorkout` is now a thin wrapper that builds a one-week
`WeeklyPlanInput` from its own single-day input, calls
`buildWeeklyProgrammingPlan`, and extracts `input.date`'s own session.
A new `assembleWeeklyProgrammingPlan(db, date, budgetMinutes)` exposes
the complete real weekly plan through the production path, sharing the
identical DB-reading step (`assembleWeeklyPlanInput`) with
`assembleAndBuildWorkout` so the two can never gather real state
differently.

## A design correction made mid-implementation

The first version of the day-by-day distribution applied a
progression-driven "reduce" (one fewer set for a declining exercise)
by shrinking the shared `remainingWeeklySets` pool before computing any
exercise's own capped sets — this correctly kept the WEEKLY total
genuinely reduced, but silently masked the reduction on the specific
(non-last) day it was meant to apply to, whenever that day's own
Blueprint per-exercise cap was already below the un-reduced remaining
pool (e.g. remaining=12, capped at 3 either way). A real test
(`remediation §6: a "reduce" progression decision...`) caught this: the
declining exercise's own visible set count stopped differing from the
undeclined baseline. Fixed by splitting "what's charged against the
week's remaining need" (the exercise's own full natural cap — so a
later day can never silently backfill the trim) from "what's actually
delivered on this exercise" (natural cap minus one, when this is the
reduce-triggering first exercise) — the exercise's own visible
prescription now genuinely shows the reduction, while the weekly total
delivered across all its sessions still drops by exactly one set, with
no backfill either within one day (already fixed the prior pass) or
across days (this pass's own addition).

## New tests

`tests/engine/surgicalFixWeeklyPlanTests.test.ts` (8 tests) — the
required §16 full-week test that inspects the real
`WeeklyProgrammingPlan` object itself (not four independently generated
workouts): every real session present with its real PPL+Upper purpose
from one call; `targetAllocations` summarizing a target's whole-week
outcome (allocated dates spanning both its real eligible days);
determinism on the weekly plan object; §7/§15's real cross-target
exposure propagation (a lower-priority target's own allocation
genuinely reflects a higher-priority target's already-placed compound
work); and §17/§18/§19's priority/Monday/badminton regressions
re-verified through the weekly-plan entry point specifically.

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run

 Test Files  41 passed (41)
      Tests  400 passed (400)
```

Also verified from a genuinely clean checkout (working tree copied to
a scratch directory excluding node_modules/dist/.git, then `npm
install` followed by `npm run verify` from there):

```
$ npm install
added 172 packages, and audited 173 packages in 4s
(no errors)

$ npm run verify
 Test Files  41 passed (41)
      Tests  400 passed (400)
```

Node v22.22.2, npm 10.9.7. Unit: 264 passed. Integration (real DB/
production path): 136 passed. 264 + 136 = 400, verified by direct
arithmetic against a per-file `openDb` classification, not estimated.

## Status against §26 (completion gate)

Every item is addressed: a first-class in-memory weekly plan exists and
is built before today's workout is derived from it;
`desiredWeekly/sessionsRemaining` no longer decides any single day's
allocation (day-by-day distribution does); `spreadDays()` still plays
no role; Goal 1 → Goal 2 → normal development → maintenance priority is
unchanged and verified; primary/secondary exposure coefficients
unchanged (1.00/0.33); compound exposure now genuinely affects later
target allocation within one weekly plan (§7, new this pass); PPL+Upper
and the Monday rule are unchanged and re-verified through the weekly
plan directly; time/equipment remain hard, per-session constraints;
canonical priority still survives time fitting (unchanged from the
prior pass, re-verified); targets still support 0/1/multiple exercises
with deterministic Blueprint-grounded set distribution; Blueprint-first
and outside-Blueprint fallback are unchanged; real history/progression
still reach the final prescription (and now correctly reach it as a
per-exercise visible reduction, not silently absorbed by a later day);
explainability matches actual output; the `supporting_targets` crash
fix remains in place; the full test suite was actually executed from
both the working tree and a genuinely clean checkout, with exact
results reported above.
