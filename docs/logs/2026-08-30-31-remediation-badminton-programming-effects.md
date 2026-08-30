# 2026-08-30 — Remediation: badminton actually changes programming (§9)

## What changed

Remediation §9 ("badminton must actually change programming (exercise
selection, lower-body workload, session distribution, redundant
fatigue, day-moving) — not just explanation text... do NOT
automatically reduce gym volume merely because badminton occurred")
was still open. Before this change, `recoveryEngine.applyRecoveryConstraint`
already consumed real logged badminton data, but its only downstream
effect was `recovery_ok: false` fed into `volumeEngine.decideVolume` —
which only ever *withholds* a volume increase, never a visible,
targeted change to a specific day's session. Nothing distinguished a
badminton-caused 'reduce' from a pure rolling-exposure-spike 'reduce',
and nothing about badminton touched exercise selection or day
placement at all.

Four real, bounded, independently-testable effects were added, each
reusing an existing primitive rather than inventing a new one:

1. **`src/engine/recoveryEngine.ts`**: `RecoveryConstraintResult` gained
   `badminton_triggered: boolean` — true only when recent logged
   badminton data (not a rolling-exposure spike) is one of the reasons
   behind a 'reduce'. Callers can now tell *why* a 'reduce' fired, which
   is what makes a badminton-specific effect possible at all without
   also firing on an unrelated exposure spike.

2. **`src/engine/constraintEngine.ts`**: new `isLowerBodyPhysiqueTarget()`
   — the same `LOWER_BODY_PHYSIQUE_REGIONS`/`parent_region` resolution
   the Monday hard rule already uses, exported so workoutBuilder and
   frequencyEngine share one "what counts as lower body" definition.

3. **`src/engine/workoutBuilder.ts`**: a new `badmintonLowerBodyReduce`
   condition (physique_target + recovery 'reduce' + `badminton_triggered`
   + lower-body) drives two effects, scoped deliberately narrow because
   badminton itself is a lower-body-dominant activity — this is where
   real physiological overlap exists, not an arbitrary trigger:
   - Today's session set count is trimmed by exactly one (floored at
     1), stacking independently of (never replacing) the existing
     progression-driven trim. The *weekly* volume decision
     (`desiredWeekly`) is never touched — satisfying the spec's explicit
     "do NOT automatically reduce gym volume merely because badminton
     occurred."
   - `selectExercise` is called with `prefer_lower_fatigue_cost: true`.

4. **`src/engine/exerciseSelector.ts`**: `ExerciseSelectionInput` gained
   optional `prefer_lower_fatigue_cost`. Implemented as a new narrowing
   step inside Gate 6 (stable tie-break) — reusing the exact same
   `narrow()` category primitive every other gate uses, applied to
   Blueprint's own `fatigue_cost` DemandLevel instead of role/recency/
   continuity. This is explicitly NOT a new gate or a score: it only
   ever runs when Gates 2-5 already left more than one tied candidate,
   and falls through to the existing alphabetical fallback for any
   further tie or when the flag is unset.

5. **`src/engine/frequencyEngine.ts`**: `allocateFrequency` gained
   optional `recurring_badminton_days` — the user's own TrainingProfile
   `other_activity_schedule` (documented since Phase 2 as "reduced
   training/recovery capacity, not just ignore," but never actually
   read by anything until now). A lower-body physique_target gets a
   *soft* preference away from a day marked as recurring badminton,
   using the identical swap-if-a-feasible-alternative-exists pattern as
   the existing hard Monday rule — except never forced: if no
   alternative day exists, the original day is kept and the reasoning
   says so explicitly, rather than ever dropping a day's coverage.
   `src/engine/workoutBuilder.ts`'s `assembleAndBuildWorkout` derives
   this list from the real TrainingProfile and threads it through.

## Why this design

- Every effect reuses an existing mechanism (Gate 6's `narrow()`, the
  Monday-swap pattern, the progression-reduce set-trim pattern) instead
  of inventing a new one — consistent with the remediation spec's
  repeated "do not invent replacement rules / arbitrary scoring"
  instruction.
- Scoping every effect to `isLowerBodyPhysiqueTarget` (not "any target,
  any day badminton happened") is a direct, defensible reading of
  "badminton loads the lower body" — the spec names "lower-body
  workload" explicitly as one of the concrete effects it expects.
- The weekly volume decision is untouched by all of this — `recovery_ok`
  still only withholds an *increase*, exactly as before this change;
  nothing here ever pushes weekly volume down because of badminton,
  satisfying the spec's explicit prohibition.

## Tests

- `tests/engine/recoveryEngine.test.ts`: 3 new tests for
  `badminton_triggered` (true only when badminton itself is the cause;
  false for a pure exposure spike; false for none/avoid).
- `tests/engine/exerciseSelector.test.ts`: 1 new test proving
  `prefer_lower_fatigue_cost` flips Gate 6's winner away from what
  plain alphabetical order would have picked.
- `tests/engine/frequencyEngine.test.ts`: 3 new tests — a lower-body
  target moves off a recurring badminton day onto a feasible
  alternative; an upper-body target does not move; a lower-body target
  keeps the day when no alternative exists (coverage is never dropped).
- `tests/engine/workoutBuilder.test.ts` (pure `buildWorkout`, 4 new
  tests in a new `describe` block): the session-set trim; the
  fatigue-cost exercise-selection change (with an explicit "without
  badminton, alphabetical order picks the wrong one" baseline); the
  effect does NOT apply to an upper-body target; a stagnant, non-zero-
  volume target's weekly volume is provably held at its pre-existing
  value (only the one session-level trim moves it), never pushed up or
  down by badminton itself.
- `tests/engine/assembleAndBuildWorkout.test.ts` (impure end-to-end
  path, 1 new test): logs a REAL badminton session via
  `WorkoutSessionsRepo`/`BadmintonSessionDetailsRepo`, then confirms
  the next real `assembleAndBuildWorkout` call produces a different
  session-set count AND a different selected exercise for a lower-body
  target than an otherwise-identical run with no badminton logged —
  proving the effect through the full production path, not an isolated
  unit.

## A pre-existing, unrelated bug found (not fixed here)

While building the end-to-end test above, creating a Goal against
either of Blueprint's two `quads`-region aesthetic outcomes
(`quad-front-mass`, `quad-sweep-separation`) crashed
`goalResolver.buildPriorityMap` with `Cannot read properties of
undefined (reading 'map')` — confirmed that 22 of ~46 aesthetic
outcomes in `src/blueprint/snapshot/programming.json` have no
`supporting_targets` field at all, while `BlueprintAestheticOutcome`'s
type declares it required and `buildPriorityMap` calls `.map()` on it
unconditionally. This affects any user picking one of those 22 real,
displayed goal options — unrelated to badminton programming, so it was
NOT fixed as part of this change (the affected integration test was
rewritten to use the normal-development layer instead of a goal, so it
doesn't depend on the buggy path). Filed as a separate suggested task
(`task_273b2256`) rather than folded in here.

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run
 Test Files  35 passed (35)
      Tests  327 passed (327)
```

Run from a clean working tree at the repo root, Node/npm versions
unchanged from prior log entries.

## Status against remediation §9 / §22

Badminton now produces four real, targeted, reasoning-visible
programming effects (session-set trim, exercise-selection fatigue
preference, soft day-avoidance, and the pre-existing volume-increase
gate) through the real production path — proven end-to-end with a
genuinely logged badminton session, not just a unit-level check.
§22's "badminton only affects explanation text, not actual programming
decisions" item is resolved. The spec's explicit "do NOT automatically
reduce gym volume merely because badminton occurred" prohibition
remains honored: no code path here ever lowers `desiredWeekly`.

Remaining remediation items (§8's real weekly programming order,
resourceAllocation wiring, the full machine-readable explainability
object, and the required regression test sweep A-W) are unchanged by
this commit and remain open — tracked separately.
