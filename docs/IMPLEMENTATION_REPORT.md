# Next Phase Implementation Specification — Implementation Report

Per spec §26.10. Covers commits `fb9c2fb`..`985daae` (13 commits) on
top of the last verified Phase 2 milestone (`3260647`). Full narrative
detail for each commit lives in `docs/logs/2026-08-30-13-*.md` through
`2026-08-30-25-*.md` — this report is the concise summary those
entries add up to.

## 1. Files changed

65 files, +5815/−574 lines. By area:

**New engine modules** (`src/engine/`): `goalCreation.ts`,
`resourceAllocation.ts`; **rewritten from `NotApprovedError` stubs to
real implementations**: `volumeEngine.ts`, `frequencyEngine.ts`,
`recoveryEngine.ts`, `exerciseSelector.ts`, `progressionEngine.ts`,
`workoutBuilder.ts`; **extended**: `exposureEngine.ts`, `config.ts`,
`constraintEngine.ts` (new `isBodyFocusAllowedOnDay`,
`fitToTimeBudget`), `explanationEngine.ts` (`explainExerciseSelection`
no longer a stub). New impure boundary: `exerciseUniverse.ts`.

**New Blueprint-layer module**: `src/blueprint/developmentPackages.ts`
(lookup over Blueprint's own per-muscle-group exercise/sets/reps/RIR
prescriptions). Extended: `src/blueprint/types.ts`/`adapter.ts` — three
previously-`unknown`-typed real Blueprint fields exposed:
`common_user_phrasings`, `globalPrinciples`, `developmentPackages`.

**New repositories**: `goalEventsRepo.ts`, `aestheticAssessmentsRepo.ts`,
`measurementsRepo.ts`, `outsideBlueprintExercisesRepo.ts`,
`badmintonSessionDetailsRepo.ts`. Extended: `goalsRepo.ts` (cap
enforcement, event recording, deactivate/reactivate/setPriority),
`workoutSessionsRepo.ts` and `programsRepo.ts` (route exercise-id
resolution through `exerciseUniverse.ts`).

**New/extended routes**: `outsideBlueprintExercises.ts` (new);
`goals.ts` (`POST /match`, natural-language confirmation fields);
`workouts.ts` (badminton-details endpoints); `programs.ts`
(validation-error handling update).

**Contracts**: `src/contracts/types.ts` — `CONTRACT_VERSION` 1.2.0 →
1.4.0 across two additive bumps (`Goal` fields + `goal_events` etc.;
`TrainingExposure.primary_sets`/`secondary_sets`).

**Tests**: 16 new test files, 2 extended (`constraintEngine.test.ts`,
`goals.test.ts`), 1 deleted (`unapprovedStubs.test.ts` — its entire
premise, proving modules still throw `NotApprovedError`, stopped being
true).

**Docs**: 2 new focused design docs (`VOLUME_ENGINE.md`,
`GOAL_MATCHING.md`), 13 new dated change-log entries, `README.md` and
`TRAINING_ENGINE_DESIGN.md` corrected to no longer describe six
modules as blocked, `open-decisions.md` rewritten.

## 2. Schema changes

`src/db/schema.sql`, +95/−1 lines, all additive (no destructive
migration; `CONTRACT_VERSION` bumped twice, see above):

- `goals`: added `review_cadence_days`, `source`, `source_text`.
- New tables: `goal_events` (append-only history), `aesthetic_assessments`,
  `measurements`, `badminton_session_details`, `outside_blueprint_exercises`.
- New indexes: `idx_goal_events_goal`, `idx_aesthetic_assessments_goal`,
  `idx_measurements_goal`, `idx_measurements_date`.

## 3. Rules implemented (by spec section)

| §  | Rule | Where |
|---|---|---|
| §1.2 | Max 2 active aesthetic goals, enforced | `goalsRepo.ts` |
| §2.1 | Hybrid goal creation, mandatory confirmation | `goalCreation.ts`, `routes/goals.ts` |
| §3 | Dated 1-5 assessments, measurements, review cadence | `aestheticAssessmentsRepo.ts`, `measurementsRepo.ts`, `volumeEngine.classifyAestheticTrend` |
| §4.2 | Outside-Blueprint exercises require explicit approval | `outsideBlueprintExercisesRepo.ts`, `exerciseUniverse.ts` |
| §5 | Goal-oriented exercise selection/replacement | `exerciseSelector.ts` |
| §6.2 | Time is a hard constraint, preserves priority | `constraintEngine.fitToTimeBudget` |
| §7 | Compound exposure, primary 1.00 / secondary 0.33 | `exposureEngine.ts`, `secondaryTargetMapping.ts` |
| §8-9 | Blueprint volume is reference; starting volume builds up | `volumeEngine.decideVolume` |
| §10-11 | Maintain is default; stagnation introspects before increase | `volumeEngine.decideVolume` |
| §12 | Decline/poor recovery never auto-reduces | `recoveryEngine.ts`, `volumeEngine.ts` |
| §13 | Aesthetic outcome is the top-level signal | `volumeEngine.decideVolume` |
| §14 | Functional goals accommodated, aesthetics wins conflicts | uniform engine treatment across target types |
| §15 | Badminton is first-class, feeds recovery, never faked into sets | `badmintonSessionDetailsRepo.ts`, `recoveryEngine.ts` |
| §16 | Default schedule; Monday never lower-body | `config.ts`, `constraintEngine.isBodyFocusAllowedOnDay`, `frequencyEngine.ts` |
| §17 | Resource allocation respects ranking, doesn't hoard | `resourceAllocation.ts` |
| §18 | Goal history, returning goal loads it | `goalEventsRepo.ts` |
| §19 | The 22-step daily generation pipeline | `workoutBuilder.ts` |
| §20-21 | Explainability, determinism, no LLM | every module's own `reasoning` field |
| §22 | Centralized configuration, `[SPEC]`/`[DEFAULT]` tagged | `config.ts` |

## 4. Tests run

```
$ npm run verify
> tsc --noEmit
(no output — clean)
> vitest run
Test Files  35 passed (35)
     Tests  297 passed (297)
```

Command run for real (not assumed) as the last step of every commit in
this batch; the exact count grew commit-by-commit — see individual
`docs/logs/` entries for the running total after each one. All 15 of
spec §23's required test scenarios have explicit, individually
identifiable coverage — see `docs/logs/2026-08-30-24-*.md` for the
full audit (which also found and fixed one real bug: a prescription
fallback that would have silently applied one exercise's Blueprint
reps/RIR to a different selected exercise).

## 5. Tests passed / failed

297 passed, 0 failed, 0 skipped.

## 6. Genuinely blocked dependencies

None block the pipeline from running. Two narrower items remain
explicitly provisional or deferred, both documented at the point they
occur, not hidden:

- **Time-per-exercise estimation** (`TIME_ESTIMATION` in `config.ts`)
  is this app's own `[DEFAULT]` operational estimate — Blueprint has no
  per-set duration data to calibrate against. Revisit if real
  session-duration data ever becomes available.
- **`progressionEngine`'s per-set load prescription is not yet wired
  into `workoutBuilder`** — `progressionEngine.computeProgression` is
  real and tested, but it answers a logging-time question (how should
  load/reps change based on last actual performance) that
  `workoutBuilder`'s pre-workout generation doesn't currently consume.
  Not a missing methodology decision, a deferred integration.

Everything else the spec asked for is real, wired, and tested — see
`docs/open-decisions.md` for the full, itemized before/after status of
every decision Phase 2 had left open.

## 7. What was explicitly NOT done, per spec §26's own instruction

UI additions (goal creation/confirmation screen, assessment/
measurement entry, badminton logging, generated-workout view) were not
built. The spec is explicit: *"Do not mark complete merely because the
UI renders. The deterministic engine and tests are the primary
deliverables."* Every capability above is reachable today via its
route/repository API; a UI layer is a separate, follow-on piece of
work.
