# Change log: Phase 2 — training state, constraints, engine module boundaries

- **Date:** 2026-08-30
- **Commit:** `bbf9fde`

## What changed

Established the full `src/engine/` module boundary from the spec's §30
list. Hard rule applied throughout: only modules whose logic is a pure
fact-check or query over already-decided rules got a real implementation;
everything requiring an unapproved judgment call throws a specific
`NotApprovedError` (`src/engine/errors.ts`) instead of an invented
placeholder formula.

**Implemented:**
- `src/engine/trainingState.ts` — `buildTrainingState(db, date)` assembles
  training profile, current active program, active goals resolved to
  PriorityMaps, recent sessions, and weekly/rolling exposure, entirely
  from persisted data via the repositories. This is the app's one
  intentional impure boundary layer — everything above it stays pure.
  Throws (does not silently drop) if an active goal's `blueprint_ref` no
  longer resolves.
- `src/engine/constraintEngine.ts` — equipment feasibility (matching
  Blueprint's own exact-match-all-required rule) and generic time-budget
  arithmetic (`remainingBudgetMinutes`/`fitsWithinBudget`) — deliberately
  not an estimate of how long an exercise takes, since neither Blueprint
  nor this app has that data yet.
- `src/engine/explanationEngine.ts` — real explanations for the two
  decisions that actually exist (`explainExposureContribution`,
  `explainEquipmentFeasibility`), generated from the same data the
  decision used. `explainExerciseSelection` throws — nothing real to
  explain until exercise selection itself is decided.
- `WorkoutSessionsRepo.listSessionsInRange(start, end)` — the date-range
  fetch `trainingState.ts` needed.

**Stubbed, interfaces only, throwing `NotApprovedError`:**
`volumeEngine.allocateVolume`, `frequencyEngine.allocateFrequency`,
`recoveryEngine.applyRecoveryConstraint`, `exerciseSelector.selectExercise`,
`workoutBuilder.buildWorkout`, `progressionEngine.computeProgression` —
each names the exact open decision blocking it.

## Why

This is the direct executable form of the spec's repeated instruction not
to implement the full automatic optimizer until design decisions are
approved (§36's last acceptance criterion) — six of twelve modules are
real, six are not, and the boundary between them is enforced by a thrown
error a test can assert on, not just a comment.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 109/109 passing. 27 new tests, including
  `tests/engine/unapprovedStubs.test.ts`, which asserts every stubbed
  module throws `NotApprovedError` with the correct `decision` key —
  proving the implemented/blocked line is exactly where the design says
  it should be, not further along.
