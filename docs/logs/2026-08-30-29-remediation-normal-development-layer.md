# 2026-08-30 — Remediation §7/§14: train the whole physique, not just goal targets

## Why

`workoutBuilder` only ever processed the `PrioritizedTarget`s belonging
to active goals — with the spec's max-2-active-aesthetic-goals cap,
that meant generation genuinely reduced to "goal → target → one or two
exercises," exactly the bug the remediation spec calls out: *"The
two-goal limit controls specialization priority. It does NOT remove
chest, back, legs, shoulders, arms, other relevant musculature from
normal programming."* Nothing else in this app carried a
"normal development" or "maintenance" concept at all.

## What changed

`src/engine/workoutBuilder.ts`:

- New `TargetClassification = 'specialization' | 'normal_development' |
  'maintenance'`, and `TargetBuildContext.is_specialization: boolean`
  (true only for a target reached via an active goal's own
  `PriorityMap`).
- `buildWorkout` derives `classification` for every target **before**
  any other decision, from data already available — no new formula:
  `is_specialization` → `'specialization'`; otherwise
  `current_weekly_primary_sets === 0` → `'normal_development'`, else
  `'maintenance'`. This isn't a guess: for a non-specialization target
  this pipeline's only path to `volumeEngine.decideVolume` returning
  `'increase'` is its §9 starting-volume branch (`current === 0`), so
  reading `current_weekly_primary_sets` directly and reading
  `decideVolume`'s actual decision agree by construction.
  `classification` now travels on every `PlannedExercise` and
  `SkippedTarget` for explainability.
- `assembleAndBuildWorkout` refactored its target-context assembly
  into a shared `makeTargetContext()` helper (goal-linked targets and
  the new non-goal targets now gather weekly/rolling exposure and real
  history identically — no risk of the two paths drifting apart), then
  — after the existing goal loop — enumerates **every real Blueprint
  physique_target** (`BlueprintAdapter.getTargets()`, ~23 across all 11
  muscle groups) not already covered by an active goal, and adds each
  as a non-specialization `TargetBuildContext` at a synthetic priority
  of `1000 + index` — a number that always sorts after every real
  goal's priority in the exact same priority-ordering mechanism
  `buildWorkout`'s loop and `fitToTimeBudget` already use. No separate
  "protect specialization" rule was needed; it falls out of consistent
  priority numbers.

## Tests

`tests/engine/assembleAndBuildWorkout.test.ts`: rewrote the "no active
goals" test (its old assertion — zero exercises — was itself the bug
this commit fixes) to instead assert the physique still gets
programmed via `normal_development`/`maintenance`, never
`specialization`. New test: with one active goal and broad equipment,
a generous budget produces both `specialization` and
`normal_development`/`maintenance` exercises together (required test
L); a scarce budget still preserves the specialization goal's own
target — normal-development work never bumps it, exactly because of
the synthetic lower priority.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 312 passed (312)
```

(311 tests before this batch — one pre-existing test was rewritten in
place rather than added, plus one new test, net +1 — no regressions.)

## Still open (remediation spec)

Outside-Blueprint fallback wiring, badminton's actual programming
effect, and `resourceAllocation` wiring remain, each tracked
separately. One known, accepted characteristic of this layer worth
recording plainly: `frequencyEngine.allocateFrequency`'s day-spreading
is deterministic per `(sessions_per_week, available_days)` only — it
does not vary by target — so many non-specialization targets sharing
the same desired frequency will independently land on the same subset
of days rather than spreading across the whole week. `fitToTimeBudget`
absorbs the resulting overflow by priority (exactly its job), so no
day ever exceeds budget, but this is a real, simple mechanism, not a
smarter split-day scheduler — deliberately not invented here.
