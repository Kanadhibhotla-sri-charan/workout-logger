# 2026-08-30 — Workout builder: the full §19 pipeline, real end to end

## Why

This was the last remaining `NotApprovedError` stub. Every module it
depends on — exposure, volume, frequency, recovery, exercise
selection, resource allocation, time-fitting — became real over the
last several commits; `workoutBuilder` is what actually composes them
into a generated workout for a given day, per spec §19's 22 steps.

## The rep-range gap, resolved by real (previously-hidden) Blueprint data

Steps 14-20 need a target rep range and RIR to prescribe, and this app
had no approved source for one — inventing a default (e.g. "8-12" as a
universal number) would violate §25 ("do not invent... volume
targets") and Blueprint's own `wording_rules.avoid` explicitly warns
against implying "exactly N reps" as a hard rule.

Investigating `programming.json` found `developmentPackages`: real,
Blueprint-authored per-muscle-group packages, each listing specific
exercises with their own `sets`/`reps` (e.g. `"6-12"`)/`rir` (e.g.
`"1-3"`) prescriptions — exactly the missing piece, previously typed
`unknown` and unused by any code. Two levels exist per muscle group
("efficient" — fewest exercises avoiding redundancy — and "complete");
this app defaults to "efficient" (`[DEFAULT]`, documented, the more
conservative starting point).

## What changed

- `src/blueprint/types.ts`/`adapter.ts` — `BlueprintDevelopmentPackages`
  real type (was `unknown`), `BlueprintAdapter.getDevelopmentPackages()`.
- `src/blueprint/developmentPackages.ts` (new) — `parseRange()` (parses
  Blueprint's `"6-12"` range strings, throwing on an unrecognized
  format rather than guessing), `findMuscleGroupForTarget()`,
  `getPackageForTarget()`, `lookupExercisePrescription()` — returns
  `null` (never invented) when a target/exercise combination has no
  package data.
- `src/engine/config.ts` — new `TIME_ESTIMATION` (`[DEFAULT]`:
  secondsPerWorkingSet, restSecondsBetweenSets, setupMinutesPerExercise)
  — the one still-missing input `fitToTimeBudget` needs (Blueprint has
  no per-set duration data), centralized and clearly labeled rather
  than inline.
- `src/engine/exerciseSelector.ts` — exported `roleFor` (renamed type
  `ExerciseTargetRole`) and new `exercisesTrainingTarget()`, so
  `workoutBuilder` can gather a target's candidate pool without
  duplicating the primary/secondary resolution logic.
- `src/engine/workoutBuilder.ts` (rewritten, real implementation) —
  split like `trainingState.ts`'s pure/impure boundary:
  - `buildWorkout()` (pure): for each target (already
    priority-ordered), calls `recoveryEngine` (skip if `'avoid'`),
    `classifyAestheticTrend` + `volumeEngine.decideVolume` (always with
    `introspection_confirmed_no_other_explanation: false` — this
    per-target loop cannot itself verify the §11 checklist, so
    `maintain`/`introspect_needed` is correctly returned for a stagnant
    target rather than silently increasing), `frequencyEngine
    .allocateFrequency` (skip if today isn't an assigned day),
    `exerciseSelector.selectExercise` over the equipment-feasible (and,
    for a physique target, Monday-compliant) candidate pool, then
    `developmentPackages.lookupExercisePrescription` for reps/RIR
    (skip with an explicit reason if none exists — never invented),
    and finally `constraintEngine.fitToTimeBudget` across every
    target's candidate exercise. Every skip is recorded in
    `skipped_targets` with a real reason; every step's reasoning is
    appended to `reasoning_log`.
  - `assembleAndBuildWorkout(db, date, budgetMinutes)` (impure): the
    only function touching the database — reads `TrainingState`,
    `AestheticAssessmentsRepo`, `BadmintonSessionDetailsRepo`,
    deduplicates targets across active goals (first/highest-priority
    goal to touch a target wins), and calls the pure function above.

## Tests

`tests/engine/workoutBuilder.test.ts` (10 tests, pure): a zero-exposure
target produces a real Blueprint-sourced exercise with valid reps/RIR;
the time budget is never exceeded across multiple targets; a
higher-priority target is preserved when the budget forces a drop; no
equipment-feasible exercise → skipped with a real reason; a target
already trained today → skipped (avoid) via recoveryEngine; a stagnant
target never gets an automatic increase (maintains at its existing
volume, `reasoning_log` mentions introspection); a lower-body target is
never assigned to Monday even through the full pipeline; a
`functional_goal` target with no development-package data is skipped
with the gap named explicitly, never an invented rep range;
deterministic on identical input; every log line is real, non-empty
text.

`tests/engine/assembleAndBuildWorkout.test.ts` (3 tests, integration —
real SQLite DB): a real active aesthetic goal (`chest-front-width`,
`primary_targets: ['mid-pec']`) with a real `TrainingProfile` produces
a genuine end-to-end workout within budget; no active goals → nothing
generated; no `TrainingProfile` at all → nothing generated (empty
equipment/training days, not a crash).

`tests/blueprint/developmentPackages.test.ts` (13 tests): range parsing
(including every real range string in the actual snapshot); muscle-group/
package/exercise lookups; every real package `exercise_id` is a real
Blueprint exercise id (a completeness check against data drift).

`tests/engine/unapprovedStubs.test.ts` — **deleted**. With
`workoutBuilder` real, no engine module in this codebase throws
`NotApprovedError` anymore; the file's entire premise (proving the
module boundary) no longer has anything to prove.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 289 passed (289)
```

(264 tests before this batch; 289 after — the new
`developmentPackages.test.ts` (13), `workoutBuilder.test.ts` (10), and
`assembleAndBuildWorkout.test.ts` (3) tests, minus the 1 deleted from
`unapprovedStubs.test.ts` — no regressions.)

## Still open

Every engine module named in the spec is now real. What's left is
integration/polish, not methodology: progressionEngine isn't yet wired
into `workoutBuilder`'s per-set load prescription (it decides
load/rep adjustment from performance history — a logging-time
decision, not a pre-workout generation one, and was left out of this
pass rather than force a premature integration); explainability
coverage for every decision type (`docs/TRAINING_ENGINE_DESIGN.md`'s
own tracking); the remaining required tests from spec §23 not yet
explicitly named as their own test (several are already covered
incidentally — a full audit against all 15 is the next task); doc
updates reflecting how many "open decisions" this phase actually
resolved; the implementation report; and UI (explicitly deprioritized
by the spec itself).
