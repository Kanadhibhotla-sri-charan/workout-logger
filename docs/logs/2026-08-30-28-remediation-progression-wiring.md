# 2026-08-30 — Remediation §6: wire progressionEngine into generated prescriptions

## Why

`progressionEngine.computeProgression` was real and thoroughly tested
in isolation, but nothing in `workoutBuilder`'s production path ever
called it — the remediation spec calls this out directly: "A
progression engine that is not consumed by the workout builder is
incomplete." The generated workout must use historical performance to
produce today's actual prescription, distinguishing planned target,
previous result, and progression decision.

## What changed

- `TargetBuildContext` gained `exercise_history`: a real
  `exercise_id -> most-recent-session-first actual sets` map, built in
  `assembleAndBuildWorkout` from the same per-target touch data the
  previous commit introduced (grouped by exercise id instead of
  flattened away — nothing new is read from the database, this reuses
  what `gatherTargetTouches` already collects).
- `buildWorkout`'s per-target loop now looks up
  `target.exercise_history[selection.exercise_id]` **after** exercise
  selection (progression is per-exercise, and the exercise isn't known
  until Gates 2-6 pick one). When history exists, it calls
  `computeProgression` with Blueprint's own prescribed rep range and
  gets a real recommendation; when it doesn't, `progression_decision`
  stays `null` — an honest "nothing to progress from yet," not a gap.
- `PlannedExercise` gained `previous_performance` (the most recent
  actual completed set: date/weight/reps) and `progression_decision`
  (the full `ProgressionResult`) — the spec's required "planned
  target; previous result; progression decision" distinction, now
  literally three separate fields rather than folded into one number.
- The one recommendation with a real, bounded effect here:
  `'reduce'` trims the session's set count by 1 (floored at 1) —
  deliberately scoped to *this session's* set count, never touching
  the weekly volume decision (`volumeEngine` keeps that job entirely;
  this is a narrower, session-level adjustment for one specific
  exercise's own recent decline).

## Tests

`tests/engine/workoutBuilder.test.ts` (+2 tests, +2 assertions on an
existing test): a first-time prescription (no history) leaves both new
fields `null`; supplied `exercise_history` for the current exercise
produces a real `progression_decision` and `previous_performance`;
three consecutive genuinely-declining sessions produce a `'reduce'`
recommendation that measurably lowers `target_sets` versus an
otherwise-identical target with no decline history.

`tests/engine/assembleAndBuildWorkout.test.ts` (extended the Gate-5
continuity test): the same real prior session (8 reps, within
`flat-barbell-bench-press`'s 6-12 Blueprint range but not at the top)
that already proved history-driven exercise selection now also proves
a real `increase_reps` progression decision and a real
`previous_performance` summary flow all the way through the database-
backed path, not just the pure function.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 311 passed (311)
```

(309 tests before this batch; 311 after — no regressions.)

## Still open (remediation spec)

The normal-development/maintenance layer, outside-Blueprint fallback
wiring, badminton's actual programming effect, and `resourceAllocation`
wiring remain, each tracked separately.
