# 2026-08-30 — Remediation: machine-readable decision explanation object (§16)

## What changed

Remediation §16 requires "every generated workout must include a
machine-readable reasoning object" covering: weekly exposure, secondary
exposure contributions, last-trained dates, recent exercise history,
progression input/output, badminton context, selected exercises,
rejected candidates, substitutions, volume decision + reason, active
goals/rankings, and equipment/time constraints. Before this change,
`WorkoutBuildResult` only carried `reasoning_log: string[]` (free
prose) — several of the values named above (rejected candidates,
decisive gate, the full volume/frequency/recovery decision objects)
were computed inside `buildWorkout` and then discarded once their
`.reasoning` string was logged.

- **`src/engine/workoutBuilder.ts`**: new exported `DecisionExplanation`
  interface, built entirely from values this pipeline already computes
  — nothing re-derived or invented for explainability's sake:
  - `weekly_exposure`: `{primary_sets, secondary_sets, exposure_units,
    rolling_exposure_units, rolling_window_days}` — `secondary_sets` is
    a new `TargetBuildContext.weekly_secondary_sets` field, sourced
    from the same `TrainingExposure.secondary_sets`
    `current_weekly_primary_sets` already comes from (exposureEngine
    always computed both; only `primary_sets` was threaded through
    before).
  - `last_trained`: `{date, days_since}` — `date` is a new
    `TargetBuildContext.last_trained_date` field, the raw calendar date
    `days_since_target_last_trained` was itself derived from (was
    computed and then discarded before this change).
  - `recent_exercise_ids`, `badminton_context`: already-real per-target
    data, just not previously surfaced structurally.
  - `recovery`, `volume_decision`, `frequency`: the FULL result objects
    from `applyRecoveryConstraint`/`decideVolume`/`allocateFrequency`
    (previously only `.reasoning` survived past each call).
  - `selection`: `{decisive_gate, rejected_candidates, substituted_from}`
    — `decisive_gate`/`rejected_candidates` come straight from
    `selectExercise`'s own result (previously discarded);
    `substituted_from` is newly computed as the target's own
    `current_exercise_id` when the winner differs from it (null for
    continuity or a first-time pick) — remediation §16's
    "substitutions."
  - `PlannedExercise.progression_decision`/`previous_performance` were
    already real fields, referenced (not duplicated) from the existing
    top-level `PlannedExercise` properties.
- `PlannedExercise` gained `decision: DecisionExplanation` (always
  fully populated for a generated exercise).
- `SkippedTarget` gained `decision`, a version of the same shape with
  `volume_decision`/`frequency`/`selection` allowed to be `null` —
  populated with whatever had actually been computed by the exact point
  a target was skipped (an 'avoid' recovery skip carries only
  `recovery`; a "not scheduled" skip carries `recovery` +
  `volume_decision` + `frequency`; etc.), never a fabricated value for
  a decision this pipeline never reached — the same "expose the gap,
  don't invent it" rule spec §25 already applies to prescriptions,
  applied here to explainability itself.
- `WorkoutBuildResult` gained three whole-workout fields (§16's "active
  goals, rankings" and "equipment/time constraints" are necessarily
  build-level, not per-exercise, concerns):
  - `active_goals: Array<{goal_id, priority, trend}>` — every distinct
    real (`is_specialization`) goal among the input targets, derived
    from the same `is_specialization` flag every classification
    decision already reads (no separate sentinel-id check needed); the
    synthetic normal-development/maintenance bucket is excluded.
  - `resource_allocation: ResourceAllocationEntry[]` — the exact
    `allocateResource()` output from the remediation §17 commit,
    exposed structurally instead of only as a log line.
  - `constraints: {available_equipment, budget_minutes}` — an echo of
    the exact inputs every equipment-feasibility check and the
    time-budget split were run against.

## Why this design

- Every field is sourced from a value the pipeline was already
  computing — this commit's job was exposing it, not building new
  tracking machinery. The one genuinely new engine-adjacent value
  (`weekly_secondary_sets`) already existed in `TrainingExposure`;
  `makeTargetContext` just needed one more field read from a record it
  already has open.
- `SkippedTarget.decision` intentionally allows partial data (nullable
  `volume_decision`/`frequency`/`selection`) rather than forcing every
  skip site to compute every downstream step just to fill a required
  field — that would mean doing wasted/meaningless work (e.g. running
  `allocateFrequency` for a target already skipped as 'avoid') purely
  to satisfy a type, which is exactly the kind of fabrication spec §25
  forbids.
- `reasoning: string` on `PlannedExercise` is unchanged and still the
  human-readable summary — `decision` is additive, not a replacement,
  so nothing consuming the existing string field breaks.

## Tests

6 new tests in `tests/engine/workoutBuilder.test.ts` (new
`describe('remediation §16: ...')` block):
- a generated exercise's `decision` object matches the target's real
  weekly exposure, last-trained date/days-since, recent exercise ids,
  recovery/volume/frequency/selection objects field-for-field;
- a substitution (`selection.substituted_from`) is recorded when
  selection genuinely replaces the target's current exercise (built on
  the same equipment-forced-substitution scenario an existing test
  already exercises), and is null when the winner IS the current
  exercise (continuity, not a substitution);
- a target skipped on an 'avoid' recovery signal carries `recovery` but
  null `volume_decision`/`frequency`/`selection` — proving no
  fabricated decision data ever appears for a step that never ran;
- `active_goals` lists a real specialization goal and excludes the
  synthetic normal-development bucket;
- `resource_allocation` and `constraints` echo the real allocation
  output and the real build inputs.

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run
 Test Files  35 passed (35)
      Tests  336 passed (336)
```

Run from a clean working tree at the repo root. All 330 pre-existing
tests pass unchanged — this commit is purely additive to the result
shape (new fields only; no existing field's meaning or value changed).

## Status against remediation §16 / §22

Every generated exercise and every skipped target now carries a
machine-readable `decision` object covering the fields §16 requires
that are per-target/per-exercise in nature; `WorkoutBuildResult` itself
carries the three fields that are necessarily whole-workout. §22's
"explainability restructured into a machine-readable decision object"
item is resolved.

Remaining remediation items (§8's real weekly programming order and the
required regression test sweep A-W) are unchanged by this commit and
remain open — tracked separately.
