# 2026-08-30 — Remediation: outside-Blueprint exercises are real candidates now (§10)

## What changed

Remediation §10 ("CRITICAL FIX #7 [sic — outside-Blueprint fallback]:
the actual generation path must support the Blueprint-inadequate ->
approved-outside-Blueprint fallback flow, not just an unused approval
API") was still open after the previous four remediation commits. Before
this change, `outside_blueprint_exercises` was purely an approval
record — `propose()`/`approve()`/`list()` — with nothing that let an
approved exercise ever be selected by `workoutBuilder`'s real generation
path. `exerciseUniverse.ts` already let an approved outside exercise be
*logged*, but `workoutBuilder` never offered one as a candidate in the
first place.

1. **Schema + contract** (`src/db/schema.sql`, `src/contracts/types.ts`,
   `CONTRACT_VERSION` 1.4.0 -> 1.5.0): `outside_blueprint_exercises`
   gained `target_type`, `target_id`, `role`, `equipment`, `reps_range`,
   `rir_range` — a proposal is now a full programming candidate, not
   just an approval record with nothing to prescribe once approved.

2. **`src/repositories/outsideBlueprintExercisesRepo.ts`** (rewritten):
   `propose()` requires and validates the new fields (equipment
   non-empty; `reps_range`/`rir_range` parsed with the same
   `parseRange` Blueprint's own package data uses, wrapped into a new
   `InvalidOutsideBlueprintExerciseError`). New
   `listApprovedForTarget(targetType, targetId)` — the read path
   `workoutBuilder` now uses.

3. **`src/server/routes/outsideBlueprintExercises.ts`**: POST `/`
   validates and passes through the new fields; catches
   `InvalidOutsideBlueprintExerciseError` as 400.

4. **`src/engine/exerciseSelector.ts`**: `ExerciseSelectionInput` gained
   an optional `outside_blueprint_candidates` map (id -> role/name). A
   new internal `resolveRole()` checks this map before falling back to
   Blueprint's own `roleFor` — every one of Gate 2/3/6's role checks
   (and the final reasoning text) now sees an approved outside
   candidate's own human-declared role, since it has no Blueprint
   muscle-role data at all. This does NOT touch the gate hierarchy
   itself — an outside candidate is filtered/ranked by the exact same
   Gates 2-6 as any Blueprint exercise, just with its role sourced
   differently.

5. **`src/engine/workoutBuilder.ts`**: new `OutsideBlueprintCandidate`
   type and `TargetBuildContext.outside_blueprint_exercises` field,
   populated by `makeTargetContext` via
   `outsideRepo.listApprovedForTarget(targetType, targetId)` (so both
   the goal-linked and normal-development/maintenance loops in
   `assembleAndBuildWorkout` get it automatically — no separate wiring
   needed, matching the existing `makeTargetContext` sharing pattern).
   In the per-target build loop: approved outside candidates are
   equipment-filtered with the same `filterEquipmentFeasible` Blueprint
   candidates use (their `equipment: string[]` field satisfies the same
   `Pick<BlueprintExercise, 'equipment'>` shape) and merged into
   `candidateExerciseIds` before `selectExercise` runs. The final
   prescription step now checks whether the winner is an outside
   candidate first — if so, its own `reps_range`/`rir_range` is used
   (never Blueprint's `lookupExercisePrescription`, and never a second,
   parallel prescription lookup by mistake). For a `functional_goal`
   target specifically — which has no Blueprint development-package
   prescription source at all (see the existing "skips a functional_goal
   target..." test) — candidates are narrowed to only outside-Blueprint
   ones when any exist, since a Blueprint-only candidate there has
   nothing to ever prescribe and reaching selection just to be skipped
   afterward would produce a less specific `skipped_targets` reason.

## Why this design

- **No second selection algorithm.** An approved outside-Blueprint
  exercise goes through the identical Gate 1-6 hierarchy (remediation
  §3) as every Blueprint exercise — the only change is where Gate
  2/3/6's *role* data comes from. This directly satisfies remediation's
  repeated "do not invent a second methodology" instruction.
- **No second prescription format.** `reps_range`/`rir_range` reuse
  Blueprint's own `parseRange` "8-12" format — one parser, one shape,
  whether the range came from Blueprint's package data or a human
  proposal.
- **Equipment feasibility reuses `filterEquipmentFeasible` unchanged**
  rather than a parallel equipment check for outside candidates, by
  keeping `OutsideBlueprintCandidate.equipment` as a plain `string[]`
  (matching `BlueprintExercise.equipment`'s exact shape) instead of a
  `readonly` array that would fail the function's generic constraint.

## Tests

- `tests/outsideBlueprintExercises.test.ts`: all 7 existing tests
  updated for the new required `propose()` fields (real target ids/
  equipment/ranges instead of the old name+justification-only shape);
  still exercise the approval gate itself, now against the fuller
  shape.
- `tests/engine/workoutBuilder.test.ts` (pure `buildWorkout`, 2 new
  tests): an approved outside-Blueprint candidate fills a
  `functional_goal` target Blueprint itself cannot prescribe (asserts
  the exact selected exercise id and `target_reps_min/max`/
  `target_rir_min/max` come from the outside candidate's own range);
  and the same candidate is never selectable when it requires
  equipment that isn't available.
- `tests/engine/assembleAndBuildWorkout.test.ts` (impure end-to-end
  path, 1 new test — remediation §18's required O/P coverage): creates
  a real functional goal, proposes a real outside-Blueprint exercise
  via `OutsideBlueprintExercisesRepo`, confirms it is absent from a
  generated workout while only proposed, then confirms it appears with
  its own reps/RIR immediately after a real `approve()` call — proving
  the full production path (repo -> workoutBuilder -> selection ->
  prescription), not just an isolated unit.

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run
 Test Files  35 passed (35)
      Tests  315 passed (315)
```

Run from a clean working tree at the repo root, Node/npm versions
unchanged from prior log entries.

## Status against remediation §10 / §22

Outside-Blueprint exercises are now reachable from the real production
generation path: `propose()` alone still yields nothing selectable
(verified by the new integration test), and `approve()` is the one
event that makes a real, equipment/role/range-complete candidate
available to `selectExercise`. §22's "the outside-Blueprint fallback is
built but not reachable from the actual generation path" item is
resolved.

Remaining remediation items (§7's badminton-actually-changes-programming,
§8's real weekly programming order, resourceAllocation wiring, the
full machine-readable explainability object, and the required
regression test sweep A-W) are unchanged by this commit and remain
open — tracked separately.
