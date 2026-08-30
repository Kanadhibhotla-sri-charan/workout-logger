# 2026-08-30 — Remediation: realistic-week integration fixture + regression coverage audit

## What changed

Remediation §19 required "at least one fixture representing a
realistic week (Mon/Tue gym, Wed rest, Thu/Fri gym, Sat/Sun badminton/
rest) that includes compound pressing so secondary exposure is tested
end-to-end," alongside §18's required regression tests A-W. This
session's context carries only a summary of §18 ("23 specific
scenarios") rather than each lettered test's literal text, so rather
than guess at wording I did two things: built the exact fixture §19
specifies, and ran a systematic audit of every remediation CRITICAL FIX
item (§3-§17) against this repo's actual test suite to find genuine,
concretely-specifiable gaps — filling the ones I could verify, and
naming (not fabricating a fix for) the one I couldn't.

### New: `tests/fixtures/realisticWeek.test.ts`

Exercises the full real production path — `TrainingProfileRepo`,
`GoalsRepo`, `WorkoutSessionsRepo`, `BadmintonSessionDetailsRepo`,
`buildTrainingState`, `assembleAndBuildWorkout` — across an entire real
two-week span, not an isolated engine call:

- Week 1: real, completed gym sessions Monday/Tuesday/Thursday/Friday,
  every one performing `flat-barbell-bench-press` (a real compound
  movement — mid-pec primary; front-delt + triceps secondary, the
  same exercise `tests/fixtures/compoundMovement.test.ts` already
  validates in isolation) with 3 completed sets; real badminton logged
  Saturday and Sunday.
- **Test 1**: as of Friday of week 1, `buildTrainingState`'s real
  `weekly_exposure` shows triceps/front-delt secondary_sets = 12 (4
  sessions × 3 sets) with `exposure_units` matching
  `EXPOSURE_COEFFICIENTS.secondary` exactly, and mid-pec's own
  primary_sets/exposure_units matching the primary coefficient — proving
  secondary exposure accumulates correctly through the real pipeline,
  not just `calculateExerciseExposure`'s own unit test.
- **Test 2**: the real weekend badminton data reaches the following
  week's real `assembleAndBuildWorkout` call — every planned exercise's
  `decision.badminton_context` is checked, and at least one carries the
  real logged intensity.
- **Test 3**: a full six-day span (both weeks' scheduled gym days)
  generates a real workout with no errors, never exceeding budget, with
  every exercise carrying a fully populated §16 decision object.
- **Test 4**: the mid-pec specialization goal stays present and
  protected in week 2 alongside real normal-development coverage of the
  rest of the physique.

### New: a determinism test at the impure boundary

`tests/engine/assembleAndBuildWorkout.test.ts` gained one test proving
`assembleAndBuildWorkout` (not just the pure `buildWorkout`, which
already had its own determinism test) produces byte-identical output
across repeat calls against identical DB state — spec §17's
determinism requirement, previously only verified at the pure-function
level.

## Coverage audit against remediation §3-§17 (this session's context)

Every item below already has real, executed test coverage from this
session's prior commits (cross-referenced, not re-verified from
scratch in this entry):

- §3 (gate hierarchy): `tests/engine/exerciseSelector.test.ts` (18
  tests, including the badminton fatigue-preference addition).
- §4/§5 (real history/last-trained wiring): multiple
  `assembleAndBuildWorkout.test.ts` tests using real logged sessions.
- §6 (progression wired): covered in the same file's progression
  tests, plus `tests/engine/progressionEngine.test.ts`.
- §7 (complete daily workout, 4 layers): the normal-development/
  maintenance tests in `workoutBuilder.test.ts`/
  `assembleAndBuildWorkout.test.ts`; functional-goal handling covered
  separately (§15 below).
- §9 (badminton programming effects): the remediation §9 commit's own
  test suite (recoveryEngine/exerciseSelector/frequencyEngine/
  workoutBuilder/assembleAndBuildWorkout).
- §10 (outside-Blueprint fallback reachable): the remediation §10
  commit's own test suite.
- §12 (compound exposure 1.00/0.33 exact): `compoundMovement.test.ts`
  plus this commit's new fixture, which re-proves it end-to-end.
- §13 (volume decision rules): `tests/engine/volumeEngine.test.ts` (16
  tests).
- §14 (classification engine): the §7.1 classification tests already
  covered above.
- §15 (functional goal, no fabrication): "skips a functional_goal
  target with no Blueprint development-package data" and the §10
  outside-Blueprint functional-goal tests.
- §16 (explainability object): the remediation §16 commit's own test
  suite.
- §17 (determinism): the pure `buildWorkout` determinism test plus this
  commit's new impure-boundary determinism test.

## Known open item — not fabricated a fix for

§8's "real weekly programming in a specific 7-step allocation order"
remains open. This session's context only has a one-line paraphrase of
§8 (load full weekly context; allocate in a specific 7-step order —
the steps themselves are not in this context), and remediation's own
instructions are explicit that a developer must never "invent
replacement rules" or "reinterpret the methodology" when the actual
requirement isn't in hand. Implementing a fabricated 7-step order would
violate that instruction directly. This is named here rather than
silently dropped so it stays visible for whoever holds the literal spec
text.

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run
 Test Files  36 passed (36)
      Tests  341 passed (341)
```

Run from a clean working tree at the repo root.

## Status against remediation §18/§19/§22

§19's realistic-week integration fixture is built and passing. §18's
regression sweep is addressed by audit against this session's actual
critical-fix list (every item traced to real, passing tests) rather
than a literal A-W checklist this context does not hold verbatim; one
gap (the impure-boundary determinism test) was found and filled.

§8's weekly-programming allocation order remains open, named explicitly
rather than fabricated — tracked separately, along with the required
full-suite execution report and implementation report (§20-21).
