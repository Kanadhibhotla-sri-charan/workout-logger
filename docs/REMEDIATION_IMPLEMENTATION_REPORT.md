# Strict Remediation Specification — Implementation Report

Covers commits `e2237a3`..`9a07e8c` (9 commits) on top of `2777492`
("Add the required implementation report (spec §26.10)"), the last
commit of the prior Next Phase milestone (see
`docs/IMPLEMENTATION_REPORT.md`). Full narrative detail for each
commit lives in `docs/logs/2026-08-30-26-*.md` through
`2026-08-30-34-*.md` — this report is the concise summary those
entries add up to.

**A note on scope of this report.** This session's context carries the
strict remediation specification's own text for §3-§17's ten CRITICAL
FIX items plus supporting sections, but only a *summary* (not the
literal text) of §18's 23 lettered regression-test requirements and
§8's exact 7-step weekly-allocation order. Every claim below is
verifiable against real code and real, executed tests in this repo;
where the underlying literal spec text wasn't available, that is
stated explicitly rather than guessed at.

## 1. Files changed

26 files, +3130/−158 lines across 9 commits. By area:

**Engine modules rewritten/extended**: `exerciseSelector.ts`
(fully rewritten: arbitrary scoring removed, replaced with the strict
Gate 1-6 ordered hierarchy); `workoutBuilder.ts` (the largest single
change, +689/−? lines: real exercise history, real last-trained dates,
progression wiring, the normal-development/maintenance layer,
outside-Blueprint candidate merging, badminton programming effects,
goal-level time allocation, the full §16 decision-explanation object);
`frequencyEngine.ts` (soft recurring-badminton day avoidance);
`recoveryEngine.ts` (`badminton_triggered` signal); `constraintEngine.ts`
(`isLowerBodyPhysiqueTarget` extracted and shared).

**Repository/route extended**: `outsideBlueprintExercisesRepo.ts` (full
target/equipment/prescription metadata, `listApprovedForTarget`);
`server/routes/outsideBlueprintExercises.ts` (validates the new
fields).

**Contracts/schema**: `src/contracts/types.ts` (`CONTRACT_VERSION`
1.4.0 → 1.5.0, `OutsideBlueprintExercise` extended);
`src/db/schema.sql` (`outside_blueprint_exercises` table gains
`target_type`, `target_id`, `role`, `equipment`, `reps_range`,
`rir_range` — additive, no destructive migration).

**Tests**: 5 test files extended substantially
(`assembleAndBuildWorkout.test.ts` +244, `workoutBuilder.test.ts` +404,
`exerciseSelector.test.ts` +149, `frequencyEngine.test.ts` +35,
`recoveryEngine.test.ts` +20, `outsideBlueprintExercises.test.ts` +42);
1 new fixture (`tests/fixtures/realisticWeek.test.ts`, +170).

**Docs**: 9 new dated change-log entries
(`docs/logs/2026-08-30-26-*.md` through `-34-*.md`), this report.

## 2. CRITICAL FIX items — status

| § | Item | Status | Where |
|---|---|---|---|
| §3 | Remove arbitrary exercise-selection scoring; strict Gate 1-6 hierarchy | **Done** | `exerciseSelector.ts` full rewrite; `narrow()` primitive; `decisive_gate` in every result |
| §4 | Wire real exercise history (`recent_exercise_ids`, `current_exercise_id`) | **Done** | `workoutBuilder.gatherTargetTouches`/`makeTargetContext` |
| §5 | Wire real last-trained dates | **Done** | `TargetBuildContext.last_trained_date`/`days_since_target_last_trained`, both real |
| §6 | Wire progressionEngine into generation | **Done** | `workoutBuilder`'s per-target `computeProgression` call; `previous_performance`/`progression_decision` on every `PlannedExercise` |
| §7 | Complete daily workout (4 layers: specialization/normal/maintenance/functional) | **Done** | `TargetClassification`, the non-specialization enumeration loop in `assembleAndBuildWorkout`, functional-goal handling via §15 |
| §8 | Real weekly programming, specific 7-step allocation order | **Open** — see §6 below | — |
| §9 | Badminton actually changes programming (exercise selection, lower-body workload, day-moving, redundant fatigue) — never auto-reduces volume | **Done** | `recoveryEngine.badminton_triggered`, `workoutBuilder`'s session-set trim + fatigue preference, `frequencyEngine`'s soft day-avoidance |
| §10 | Outside-Blueprint fallback reachable from real generation path | **Done** | `listApprovedForTarget` merged into `workoutBuilder`'s candidate gathering; `exerciseSelector.outside_blueprint_candidates` |
| §11 | Time/equipment hard constraints, 5-tier cut priority | **Pre-existing, verified adequate** | `constraintEngine.fitToTimeBudget`/`filterEquipmentFeasible` (23 existing tests) |
| §12 | Compound exposure exactly 1.00/0.33 | **Pre-existing, re-verified end-to-end** | `EXPOSURE_COEFFICIENTS`; re-proven in `tests/fixtures/realisticWeek.test.ts` through the real production path |
| §13 | Volume decision rules (maintain default, small increments, stagnation checklist) | **Pre-existing, verified adequate** | `volumeEngine.decideVolume` (16 existing tests) |
| §14 | Explicit specialization/normal/maintenance classification, recalculated live | **Done** | `TargetClassification`, derived from `is_specialization` + `current_weekly_primary_sets` |
| §15 | Functional goal handling — no fabricated reps/sets when Blueprint data insufficient | **Done** | functional_goal targets skip with an explicit reason unless an approved outside-Blueprint exercise supplies its own range (§10) |
| §16 | Machine-readable explainability object | **Done** | `DecisionExplanation`, `PlannedExercise.decision`, `SkippedTarget.decision`, `WorkoutBuildResult.active_goals`/`resource_allocation`/`constraints` |
| §17 | Goals compete for time via explicit ranking (resourceAllocation) | **Done** | `allocateResource` wired into `buildWorkout`'s two-level time-fitting |
| — | Determinism (no randomness, no LLM) | **Done, both boundaries verified** | pure `buildWorkout` + impure `assembleAndBuildWorkout` each have an explicit repeat-call-equality test |

## 3. §18's regression-test sweep (A-W) and §19's integration fixture

This session's context does not hold §18's 23 lettered scenarios
verbatim — only a paraphrase ("23 specific scenarios"). Rather than
invent wording to match unseen letters, `docs/logs/2026-08-30-34-*.md`
audits actual coverage against every CRITICAL FIX item in the table
above (each traced to real, executed tests from this phase's own
commits) and states this explicitly rather than claiming an A-W
checklist was completed against text never seen.

§19's required realistic-week integration fixture (Mon/Tue/Thu/Fri gym,
Sat/Sun badminton, compound pressing exercising secondary exposure
end-to-end) is built: `tests/fixtures/realisticWeek.test.ts`, 4 tests,
exercising the full real production path (repos → `buildTrainingState`
→ `assembleAndBuildWorkout`) across a real two-week span.

## 4. Tests run

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run
 Test Files  36 passed (36)
      Tests  341 passed (341)
```

Command run for real (not assumed) after every one of the 9 commits in
this phase — see each `docs/logs/2026-08-30-2[6-9]-*.md` and
`-3[0-4]-*.md` entry for that commit's own real output. Test count grew
from 297 (end of the prior Next Phase report) to 341 across this
phase — 44 net new tests, though considerably more were added and some
pre-existing tests were rewritten where remediation correctly changed
their expected behavior (e.g. the "no exercises when no active goals"
test in `workoutBuilder.test.ts`, which the §7 normal-development layer
made obsolete — see `docs/logs/2026-08-30-29-*.md`).

## 5. Tests passed / failed

341 passed, 0 failed, 0 skipped.

## 6. Genuinely open items — named, not hidden

- **§8's specific 7-step weekly-programming allocation order.** This
  session's context has only a one-line paraphrase of §8 ("load full
  weekly context... in a specific 7-step allocation order"), not the
  seven steps themselves. `frequencyEngine`/`volumeEngine`/
  `resourceAllocation`/`recoveryEngine` together already implement most
  of what a real weekly-programming pass needs (frequency allocation,
  volume decisions, goal-priority time-budget splitting, recovery
  gating), but not assembled into the exact ordered sequence §8
  specifies, because that exact sequence isn't in this context.
  Remediation's own instructions are explicit that inventing a
  methodology when the real one isn't available is forbidden ("do not
  reinterpret the methodology; invent replacement rules... if the
  existing implementation conflicts with this document, change the
  implementation" — which requires having the document's actual words
  to change toward). Implementing a fabricated 7-step order would
  violate that instruction directly, so this is left open rather than
  guessed at.
- **§18's 23 lettered regression tests, verbatim.** As above — audited
  by requirement instead of by letter, since the letters' text isn't in
  this context.
- **A pre-existing, unrelated bug found in passing** (not part of this
  remediation's own scope, filed separately as `task_273b2256`): 22 of
  Blueprint's ~46 aesthetic outcomes have no `supporting_targets` field
  in the snapshot data at all, crashing `goalResolver.buildPriorityMap`
  for any goal referencing one — see `docs/logs/2026-08-30-31-*.md`.

Everything else the remediation specification's CRITICAL FIX items ask
for is real, wired into the actual production generation path, and
tested — see the table in §2 above.

## 7. What was explicitly NOT done, per the original spec's own instruction

Consistent with the prior Next Phase report: no UI work was performed
in this remediation phase either. Every capability above is reachable
today via `assembleAndBuildWorkout`/the engine modules directly and
their existing repository/route layer; a UI is a separate, follow-on
piece of work, and remediation's own instructions carry the same "do
not mark complete merely because the UI renders" constraint the
original spec did.
