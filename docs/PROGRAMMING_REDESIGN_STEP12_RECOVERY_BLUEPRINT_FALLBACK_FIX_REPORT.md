# Workout Programmer — Step 12 Recovery Evidence + Blueprint Fallback Guard Report

Scope: two surgical fixes per
`docs/PROGRAMMING_REDESIGN_STEP12_RECOVERY_BLUEPRINT_FALLBACK_FIX_SPEC.md`.
Per that spec's framing, Step 12's architecture is accepted — nothing
here introduces a second exposure/recovery/volume engine, no new
physiological thresholds, and no Blueprint package/coefficient changes.

## A. Changed files

```text
src/engine/goalPhaseEngine.ts
src/engine/volumeEngine.ts
tests/engine/goalPhaseEngine.test.ts
tests/engine/goalReviewGraduationMethodology.test.ts
tests/engine/goalReviewRollingExposureEvidence.test.ts (new)
tests/engine/volumeEngineBlueprintFallbackGuard.test.ts (new)
```

## B. Recovery fix

1. **Where the bug was.** `gatherReviewEvidence` in
   `src/engine/goalPhaseEngine.ts` built the `applyRecoveryConstraint()`
   input as:
   ```ts
   weekly_exposure_units: actual_weekly_exposure,
   rolling_exposure_units: actual_weekly_exposure,
   rolling_window_days: 14,
   ```
   `actual_weekly_exposure` is the PHASE-WIDE average (total primary sets
   across the whole elapsed phase, divided by elapsed weeks — potentially
   spanning many weeks). Passing that same number for both the "current
   week" and "14-day rolling" recovery inputs told the recovery engine
   the phase average WAS the current week and WAS the last 14 days,
   which is never true except by coincidence.

2. **How actual rolling exposure is now calculated.** Both
   `weekly_exposure_units` and `rolling_exposure_units` are now computed
   from a fresh, unscoped-by-phase fetch of real completed sessions
   (`date <= asOfDate`, `status === 'completed'`), fed through the
   existing `aggregateWeeklyExposure`/`aggregateRollingExposure`
   functions (`src/engine/exposureEngine.ts`, unmodified) — the exact
   same canonical functions `workoutBuilder.ts`'s own real
   weekly-programming recovery calls already use. The rolling window
   stays 14 days, using `aggregateRollingExposure`'s existing
   `rollingRangeEnding` date math (`asOfDate - 13` through `asOfDate`,
   inclusive) — no new date utility was written. `rolling_exposure_units`
   is also exposed on `GoalReviewEvidence` itself so the distinction is
   visible/inspectable, not just an internal variable.

3. **Existing infrastructure reused.** `aggregateWeeklyExposure`,
   `aggregateRollingExposure`, `calculateExerciseExposure` (all
   pre-existing, unmodified, in `exposureEngine.ts`) — no new exposure
   calculation was written. The current-week window uses the same
   `profile?.week_start_day ?? 'monday'` fallback `trainingState.ts`
   already establishes.

4. **Target isolation.** Both aggregations are filtered to
   `target_type`/`target_id` via the same `.find((e) => e.target_type
   === target.target_type && e.target_id === target.target_id)` pattern
   the pre-existing phase-wide exposure computation already uses — no
   new target-matching logic.

5. **Actual vs. planned.** The session fetch is `status === 'completed'`
   only (same filter the rest of this file already applies) — a planned,
   skipped, or partially-completed session contributes nothing, exactly
   as before.

6. **Future-date exclusion.** The session fetch pre-filters
   `date <= asOfDate`, and `aggregateExposure`'s own internal
   `isDateInRange` check (unmodified) independently enforces the same
   bound — belt-and-suspenders, no session dated after `asOfDate` can
   reach either aggregation.

`applyRecoveryConstraint()` itself (`src/engine/recoveryEngine.ts`) was
NOT modified — inspection confirmed it already has the correct
semantics (it already expects a real current-week figure and a real
rolling figure as two distinct parameters); the bug was purely in what
was passed into it, not in the function itself.

## C. Blueprint fallback fix

1. **Where the fallback existed.** `referenceRangeFor` in
   `src/engine/volumeEngine.ts` falls back to
   `BlueprintAdapter.getGlobalPrinciples().weekly_volume`'s
   `starting_point_sets`/`practical_range_sets`/`higher_recovery_dependent_sets`
   bands whenever `developmentReference?.weekly_direct_set_reference` is
   `null` — which happens both for a functional_goal (no package by
   design) AND for a physique_target Blueprint simply hasn't grouped
   into a muscle_group yet (a real, already-documented possible state in
   `developmentReferenceEngine.ts`/`developmentPackages.ts`). Both cases
   were previously indistinguishable — the returned `label` was one of
   `'starting_point'`/`'practical_range'`/`'higher_recovery_dependent'`
   either way.

2. **What now prevents silent substitution.** `referenceRangeFor` checks
   `developmentReference?.target_type === 'physique_target'`. When a
   development reference resolved to a physique target but with no
   package, the SAME numeric band is still used (no redesign, no new
   number invented — this module has no other guidance to offer), but
   the returned label is the new, explicit `'missing_physique_package'`
   instead of one of the generic band names. `VolumeDecision.blueprint_reference_range.label`'s
   type was extended with this one new literal.

3. **What happens when a physique package is missing.** The caller
   (`workoutBuilder.ts`, unmodified) still receives a usable
   `{min, max}` pair so nothing crashes or changes behavior numerically,
   but the result is no longer silently indistinguishable from a real
   Blueprint-package-backed decision — any consumer (a route, a test, a
   future explainability surface) can tell this was a degraded fallback
   rather than verified target-specific guidance.

4. **Why functional-goal behavior remains intact.** The guard is keyed
   specifically on `target_type === 'physique_target'`. A
   `functional_goal` (no package by design) and the case where no
   `development_reference` is supplied at all both continue to receive
   the original, unlabeled-differently universal bands exactly as
   before — confirmed by Test C below and by the pre-existing
   `decideVolume` test at `tests/engine/volumeEngine.test.ts:41` (which
   passes no `development_reference` at all and still expects
   `'starting_point'`), which still passes unmodified.

## D. Tests

**New file `tests/engine/goalReviewRollingExposureEvidence.test.ts`**
(4 tests, Recovery fix):
- *Test A — recent rolling exposure differs from the phase-wide
  average*: constructs 3 older, modest sessions outside a 14-day rolling
  window plus one much larger session inside it; asserts
  `phase_total_primary_sets`/`actual_weekly_exposure` reflect the real
  phase-wide average (26 sets / 4 weeks) while `rolling_exposure_units`
  independently reflects only the in-window session (20) — and that the
  two are never equal. This is the test that specifically fails if
  `rolling_exposure_units: actual_weekly_exposure` is reintroduced.
- *Test B — no recent training gives a real zero*: real phase history
  exists (nonzero `actual_weekly_exposure`) but nothing within the last
  14 days — `rolling_exposure_units` is exactly `0`, never substituted
  with the phase average.
- *Test C — future data excluded*: a session dated after `asOfDate` is
  never counted, even though it would otherwise fall inside a 14-day
  window.
- *Test D — target isolation*: real recent quads exposure (via
  `back-squat`, which has zero real primary or secondary relationship to
  triceps) never contaminates a triceps goal's `rolling_exposure_units`.

**New file `tests/engine/volumeEngineBlueprintFallbackGuard.test.ts`**
(6 tests, Blueprint fallback fix):
- *Test A* (2 tests) — a physique target with a genuinely missing
  package is labeled `'missing_physique_package'`, never one of the
  generic global-guidance labels; a second test picks
  `current_weekly_primary_sets` to land exactly inside the
  `practical_range` band's own numbers and confirms the label is still
  never `'practical_range'` (the exact regression this fix closes).
- *Test B* — a real, resolved Blueprint package (triceps Efficient)
  still wins, labeled `'blueprint_package_reference'`, with `min`/`max`
  exactly equal to that real reference number.
- *Test C* (2 tests) — a `functional_goal` reference (no package by
  design) and no `development_reference` at all both continue to use
  the legitimate universal bands, never mislabeled as
  `'missing_physique_package'`.
- *Test D* — a real non-goal physique target's Efficient-package
  behavior (bootstrap "no existing volume" case) is unaffected by the
  guard.

**Updated `tests/engine/goalPhaseEngine.test.ts` and
`tests/engine/goalReviewGraduationMethodology.test.ts`** — each file's
hand-built `evidence()` test helper now includes the new
`rolling_exposure_units: 0` default field (required by
`GoalReviewEvidence`'s type); no existing assertion was weakened or
removed.

No existing test was weakened, and no assertion was replaced with a
snapshot.

## E. Command results (run individually, actual output)

- `npm run typecheck` — clean, no errors, exit code 0.
- `npm test` (`vitest run`) — **74 test files, 709 tests, all passed**,
  0 failed, 0 skipped.
- `npm run build` — clean, no errors, exit code 0.
- `npm run verify` (build + typecheck + test composed) — clean, all 709
  tests passed, exit code 0.

All numbers above are from actual command runs in this session.

## Deployment

No deployment was performed. No SSH, no production file changes, no
production database changes, no service restarts.
