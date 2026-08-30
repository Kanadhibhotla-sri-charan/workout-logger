# 2026-08-30 — Exercise selector: real ranking among feasible candidates

## Why

`exerciseSelector.ts` previously threw `NotApprovedError`. Spec §5
names the factors selection should weigh — active goal, Blueprint
muscle-role data, exposure, recent history/redundancy, progression
evidence, fatigue/recovery, equipment, time, schedule, other goals,
badminton workload — but most of those already have their own engine
now (exposure/volume/recovery/frequency), or belong to
resourceAllocation (not yet built) or the pipeline that will feed
everything together (workoutBuilder, not yet built). What was left,
genuinely in this module's own scope, is: given an already
feasibility-filtered candidate list for one target, which one is
actually best, using Blueprint's own muscle-role data and recent-use
history — and the one explicit rule from §5: *"If the current exercise
is best feasible option, keep it. If another available exercise is
demonstrably better... replace it."*

## What changed

- `src/engine/exerciseSelector.ts` (rewritten, real implementation) —
  `selectExercise()` scores each candidate: +2 if it's the target's
  Blueprint primary role, +1 if secondary (via
  `secondaryTargetMapping.ts`, same resolution logic exposureEngine
  uses for logged sets), −1 if it appears in `recent_exercise_ids`
  (redundancy — a mild preference for variety, not exclusion; the spec
  doesn't forbid ever repeating an exercise), +0.5 if it's the
  currently-prescribed exercise (a tie-break only — implements "keep it
  if still best" without ever letting a genuinely better option lose).
  Ties break alphabetically by exercise_id for full determinism. New
  `NoFeasibleExerciseError` when given zero candidates. `reasoning`
  names every factor that applied.
- `src/engine/explanationEngine.ts` — `explainExerciseSelection()` is
  no longer a stub; it's a thin accessor onto
  `ExerciseSelectionResult.reasoning` (that reasoning is already built
  from the same decision inputs the selection itself used — no second,
  separately-derived explanation to keep in sync).
- `src/engine/workoutBuilder.ts` — updated its `NotApprovedError`
  message: it no longer blames volumeEngine/frequencyEngine/
  recoveryEngine/exerciseSelector (all real now); its actual remaining
  dependencies are `resourceAllocation` (§17, not built) and a real
  time-fitting algorithm (§6.2 — `constraintEngine` currently only has
  budget-check primitives, not the fit-to-budget algorithm itself).
- `tests/engine/unapprovedStubs.test.ts` — dropped the `exerciseSelector`
  and `explainExerciseSelection` now-false cases; updated the
  `workoutBuilder` case to the new decision key.

## Tests

`tests/engine/exerciseSelector.test.ts` (8 tests): a primary-role
candidate beats a secondary-only one for the same target; a single
recent candidate is still selected (redundancy is a penalty, not
exclusion); a non-recent primary candidate beats a recent one of equal
role; the current exercise is kept when tied for best; the current
exercise is replaced when a demonstrably better one exists;
identical inputs always produce identical output; zero candidates
throws `NoFeasibleExerciseError`; `explainExerciseSelection` returns
exactly the selection's own `reasoning`.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  32 passed (32)
      Tests  249 passed (249)
```

(243 tests before this batch; 249 after adding
`tests/engine/exerciseSelector.test.ts`'s 8 tests, minus 2 removed
from `unapprovedStubs.test.ts` — no regressions.)

## Still open

Two stubs remain: `workoutBuilder` (the full §19 pipeline) and its
last real dependency, resource allocation across competing goals
(§17) — not built yet, and the real §6.2 time-fitting algorithm
(currently just budget-check primitives in `constraintEngine.ts`).
Resource allocation is next.
