# 2026-08-30 — Remediation §4-5: wire real exercise history and last-trained dates

## Why

`assembleAndBuildWorkout` — the one function that actually reads the
database and builds the production input to `buildWorkout` — hardcoded
`recent_exercise_ids: []`, `current_exercise_id: null`, and
`days_since_target_last_trained: null` for every target, unconditionally.
The engines consuming those fields (`exerciseSelector`'s Gates 4-5,
`recoveryEngine`'s same-day-avoid rule) were real and tested in
isolation, but the production path never actually fed them real data —
exactly the gap the remediation spec's §4-5 calls out.

## What changed

`src/engine/workoutBuilder.ts` — new `gatherTargetTouches()`: one pass
over every recent session's real logged performances, reusing
`exposureEngine.calculateExerciseExposure` (the same primary/secondary
resolution the exposure numbers themselves use, so "meaningfully
trained" — spec §5.1 — means the identical thing here it does
everywhere else in this app) to build a `target -> chronological list
of {date, exercise_id}` map. Only completed sets ever produce a touch
(exposure rule D falls out of reusing the existing function, not a
new check). `assembleAndBuildWorkout` now derives, per target, from
real data:

- `current_exercise_id` — the exercise used in the most recent touch.
- `recent_exercise_ids` — every distinct exercise id touched within
  the loaded history window.
- `days_since_target_last_trained` — `daysBetween(mostRecentTouch.date,
  date)`, or `null` only when there's genuinely no touch in the loaded
  window (an honest answer, not a placeholder).

Also wired `exerciseSelector`'s new `exercises_already_planned_today`
input (Gate 3, from the previous commit) into `buildWorkout`'s
per-target loop — it now tracks which exercises have actually been
committed to the plan so far and passes that forward, rather than
leaving the parameter unused.

## Tests

3 new tests in `tests/engine/assembleAndBuildWorkout.test.ts`: a real
prior session on `flat-barbell-bench-press` flips the winning exercise
away from what alphabetical Gate 6 would otherwise pick (`cable-fly`)
via Gate 5 continuity — proof `current_exercise_id` is real, not a
hardcoded `null`; a target trained earlier the same day is skipped via
recovery `avoid` — proof `days_since_target_last_trained` is real, not
always `null`; a target whose only feasible candidate is also its only
history doesn't get excluded by its own recency — proof
`recent_exercise_ids` is populated and Gate 4 doesn't self-defeat.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 309 passed (309)
```

(306 tests before this batch; 309 after — no regressions.)

## Still open (remediation spec)

`progressionEngine` is still not called by `workoutBuilder` (it now
*has* the real per-exercise history this commit wires up, but nothing
invokes `computeProgression` with it yet). The normal-development/
maintenance layer, outside-Blueprint fallback wiring, badminton's
actual programming effect, and `resourceAllocation` wiring remain,
each tracked separately.
