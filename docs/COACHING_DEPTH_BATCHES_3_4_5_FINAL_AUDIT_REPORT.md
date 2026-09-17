# Coaching Depth — Final Audit Report (Batches 3, 4, 5)

Post-delivery verification pass across all three remaining-work batches
(`docs/COACHING_DEPTH_REMAINING_BATCHES.md`), run from a clean dependency
install, plus a targeted correctness/wiring audit of each batch's own
stated design claims and known limitations. This report does not change
any production behavior — it verifies what Batches 3/4/5 already shipped
(commits `8ba5ec1`, `5fe6b8b`, `f00b08f`) and updates the roadmap/batch
tracking documents to reflect completion.

## 1. Files changed (across all three batches)

**Batch 3 — Periodization System** (16 files, +1493/-111):
`src/coaching/foundationContext.ts`, `src/coaching/periodization/deloadPolicy.ts` (new), `src/coaching/periodization/periodizationEventsRepo.ts` (new), `src/coaching/periodization/periodizationService.ts` (new), `src/coaching/periodization/reactiveTrendEvaluator.ts` (new), `src/coaching/programState/programStateService.ts`, `src/coaching/programState/programStateTypes.ts`, `src/db/client.ts`, `src/db/schema.sql`, `src/engine/config.ts`, `src/engine/workoutBuilder.ts`, `src/server/routes/programming.ts`, plus 4 test files (`tests/coaching/periodizationSystem.test.ts` new, `tests/coaching/programState.test.ts` extended, `tests/engine/coachingDepthBatch3PlannerIntegration.test.ts` new, `tests/routes/programming.test.ts` extended).

**Batch 4 — Exercise Variety & Preference** (11 files, +906/-11):
`src/db/client.ts`, `src/db/schema.sql`, `src/engine/config.ts`, `src/engine/exercisePairing.ts` (new), `src/engine/exerciseSelector.ts`, `src/engine/workoutBuilder.ts`, `src/repositories/exercisePreferencesRepo.ts` (new), `src/server/friendlyExplanation.ts`, `src/server/routes/programming.ts`, plus 2 test files (`tests/engine/coachingDepthBatch4ExerciseVarietyPreference.test.ts` new, `tests/routes/programming.test.ts` extended).

**Batch 5 — Programming Enrichment** (14 files, +1261/-1):
`src/blueprint/adapter.ts`, `src/blueprint/types.ts`, `src/coaching/structuralAdvisories/structuralAdvisoryService.ts` (new), `src/db/client.ts`, `src/db/schema.sql`, `src/engine/config.ts`, `src/engine/intensityTechniques.ts` (new), `src/engine/workoutBuilder.ts`, `src/repositories/profileFactorsRepo.ts` (new), `src/server/friendlyExplanation.ts`, `src/server/routes/programming.ts`, plus 3 test files (`tests/engine/coachingDepthBatch5PlannerIntegration.test.ts` new, `tests/engine/coachingDepthBatch5ProgrammingEnrichment.test.ts` new, `tests/routes/programming.test.ts` extended).

Full detail (exact rules, precedence, migration notes) is in each batch's own report — this section is a locator, not a restatement.

## 2. Features implemented per batch

**Batch 3 (roadmap Phase 2 + 4):** one canonical periodization/block-state mechanism (`coaching_program_state`, extended, never a second table) covering both calendar-based deload weeks and reactive (trend-triggered) deloads, plus explicit specialization blocks. `getPeriodizationContext` is the single read entry point; `programStateService.ts` is the single write path.

**Batch 4 (roadmap Phase 6a + 6b + 9):** explicit exercise preference/avoidance (`exercise_preferences` table), exercise-family-aware rotation (Gate 4 extended via Blueprint's real `overlaps_with` field), and antagonist push/pull exercise pairing (`exercisePairing.ts`), all reusing the existing Gate 1-6 selection hierarchy rather than a parallel mechanism.

**Batch 5 (roadmap Phase 5 + 7 + 8):** intensity techniques from Blueprint's own real vendored catalog (drop-set/rest-pause/myo-reps) matched against real exercise demand fields and gated by a confirmed training-experience profile factor; two evidence-backed structural balance advisories (push/pull imbalance, persistent goal-target coverage gap); a generic user-confirmed profile-factor store.

## 3. Focused test results

```
npx vitest run tests/coaching/ \
  tests/engine/coachingDepthBatch3PlannerIntegration.test.ts \
  tests/engine/coachingDepthBatch4ExerciseVarietyPreference.test.ts \
  tests/engine/coachingDepthBatch5ProgrammingEnrichment.test.ts \
  tests/engine/coachingDepthBatch5PlannerIntegration.test.ts

Test Files  9 passed (9)
     Tests  158 passed (158)
```

All coaching-depth-specific test files (profiles, program state, periodization, historical trends, foundation context, exercise variety/preference, programming enrichment, and both batches' planner-integration suites) pass with zero failures.

## 4. Full-suite results

Reproduced from a clean dependency install (`rm -rf node_modules && npm ci`, exit 0) followed by the composed `npm run verify` (`build` → `typecheck` → `test`):

```
npm run build       → clean
npm run typecheck   → clean
npm test -- --run   → 135 test files: 121 passed, 14 failed
                       1652 tests: 1421 passed, 231 failed
```

The 231-failure list was diffed byte-for-byte against `/tmp/final_fail_tests.txt` — the baseline established before Batch 3 began, itself matching the pre-existing failure set documented since `COACHING_DEPTH_BATCH_1_IMPLEMENTATION_REPORT.md`. **Zero new failures across all three batches, combined.**

## 5. Pre-existing failures (not introduced by any of these batches)

All 14 failing test files, 231 failing tests, share one root cause: hardcoded historical dates in AI-programmer test fixtures (`tests/ai-programmer/reconciliationContextBuilder.test.ts`, `programmerContextBuilder.test.ts`, `weekReconciliationService.test.ts`, `weekReconciliationValidators.test.ts`, and related files) that are now in the past relative to the session's current date, tripping `AITargetNotEditableError`'s "targetDate is in the past" guard. This is a test-fixture staleness issue (documented since Batch 1), not a Coaching Depth defect — no file touched by Batches 3, 4, or 5 is implicated in any of these failures.

## 6. Verification-question audit results

Three targeted audits were run against the actual source (not the reports' own claims) by independent research agents, each instructed to read real file:line evidence rather than trust prior documentation.

**Batch 3 — single canonical periodization mechanism: CONFIRMED.**
- Single derivation point: `derivePeriodizationStateAndReason` and all block/week/deload-status logic exist only in `programStateService.ts`. A repo-wide grep for every related term (`deloadActive`, `periodizationState`, `blockNumber`, `weekIndex`, `isDeload`, `scheduledDeloadWeek`, `block_kind`, etc.) found no independent computation anywhere outside the canonical module and its two pure consumers.
- Single read path: `getPeriodizationContext(` has exactly two real call sites (`workoutBuilder.ts:2842`, `programming.ts:951`), called once per `assembleWeeklyPlanInput` invocation — never once per target.
- Single write path: every `coaching_program_state` write lives only in `programStateService.ts`; `db/client.ts` only runs additive schema migrations.
- Deload effects applied exactly once each: set-volume reduction at `workoutBuilder.ts:1239`, rep-range-bias override at `workoutBuilder.ts:1468` — both single call sites with explicit "applied exactly once" comments.
- No second/competing week-index or block mechanism found anywhere in `src/`.

**Batch 4 — documented limitations are intentional, not hidden defects: CONFIRMED.**
- No-UI limitation verified accurate: zero references to `/api/programming/preferences`, `exercise_preferences`, or `paired_with_exercise_id/name` anywhere in `public/*.html`/`app.js` — and since the frontend never reads these fields, there is no silent-failure risk from their absence.
- Explainability data genuinely reaches API responses: `ExerciseSelectionResult.reasoning`/`decisive_gate`/`rejected_candidates`/`avoided_candidates` and `paired_with_exercise_id`/`paired_with_exercise_name` all survive intact through `enrichPlannedWork`/`toTodayExerciseShape` into both `/week` and `/today` JSON — only a dedicated "explain an arbitrary past selection" endpoint is genuinely missing, exactly as the report states.
- `EXERCISE_ROTATION.maxConsecutiveUsesBeforeRotationConsidered`/`recentUseWindowExposures` are confirmed unused anywhere in `src/` or `tests/`, but the actual rotation mechanism (Gate 4, `sameExerciseFamily()` against Blueprint's real `overlaps_with` field) is fully functional and independent of those constants — a documented future tunable, not a broken feature.
- No undocumented `TODO`/`FIXME`/"not implemented"/stub markers found in `exerciseSelector.ts`, `exercisePairing.ts`, or `exercisePreferencesRepo.ts`.

**Batch 5 — intensity techniques, structural advisories, and profile factors are genuinely wired into the planner: CONFIRMED.**
- `assignWeeklyIntensityTechniques` is called for real inside `buildWeeklyProgrammingPlan` (`workoutBuilder.ts:2220`), after pairing and after `assertNoContradictoryProgramState`; its output is merged back into the real `sessions` array that gets returned, not discarded.
- `WeeklyPlanInput.trainingExperience` is populated for real in `assembleWeeklyPlanInput` from `ProfileFactorsRepo.effectiveValue(...)` (`workoutBuilder.ts:2855`) — not a dead field.
- The full production chain was traced end-to-end: `GET /api/programming/week` → `ensureWeekProgramGenerated` → `computeFreshWeek` → `assembleWeeklyPlanInput` → `buildWeeklyProgrammingPlan`. This is the real user-facing path, not a side path.
- `evaluateStructuralAdvisories` is called both inside `buildWeeklyProgrammingPlan` (attached as `structuralAdvisories`) and independently in the `GET /api/programming/structural-advisories` route — both real computations, no stubs.
- `ProfileFactorsRepo`'s `GET`/`PUT`/`DELETE` routes call the real repo methods against the real `user_profile_factors` table (schema confirmed to match the repo's own column set exactly).
- `tests/engine/coachingDepthBatch5PlannerIntegration.test.ts` proves this is a live conditional path, not a pass-through: the SAME target/exercise/history produces `applied_intensity_technique.technique_id === 'drop-set'` under confirmed advanced experience + no deload, `null` with no confirmed experience, and `null` (with a deload-specific `suppressed_reason`) under an active deload — a same-input/different-condition contrast that could not pass against a hardcoded stub.
- Non-interference confirmed by reading `evaluateEligibilityForExercise`'s own guard: `trainingExperience === null` causes every experience-gated technique to be skipped, falling through to "no eligible technique" — so any pre-Batch-5 caller that never sets `trainingExperience` gets `applied_intensity_technique: null` universally, provably by code inspection, not just by test outcome.

## 7. Deferred items (unchanged from each batch's own report, re-confirmed still deferred and still intentional)

- **No UI was built for any of the three batches.** Preferences, avoidance, pairing state, intensity-technique state, structural advisories, and profile factors are all exposed only via JSON API routes; nothing in `public/` renders them. This is a consistent, explicitly-documented scope reduction across Batches 3, 4, and 5 under the stated time constraints, re-confirmed harmless in §6 above (no frontend code assumes any of this data exists).
- **`trainingExperience`/`periodizationContext` are not forwarded through `BuildWorkoutInput`'s single-day legacy path** (`buildWorkout`, used by `assembleAndBuildWorkout`) — only the real production weekly path (`GET /api/programming/week`) resolves them. Documented in both the Batch 3 and Batch 5 reports.
- **Only `training_experience` has a real programming effect** among Batch 5's generic profile-factor categories; the `user_profile_factors` table/repo are generic enough to support the roadmap's other listed factors (equipment, schedule, movement restrictions, etc.) later without a schema change, but those effects were not built in this pass — most either already have dedicated mechanisms elsewhere (equipment/schedule via `TrainingProfile`; exercise-specific restrictions via Batch 4's `exercise_preferences`) or were out of scope.
- **No dedicated explanation/debugging endpoints** beyond what the structured response objects themselves already carry (`IntensityTechniqueEvaluation.suppressed_reason`, `StructuralAdvisory.evidence`/`explanation`, `ExerciseSelectionResult.reasoning`, `ExercisePairingResult.reasoning`).
- **No persistence for structural advisories or intensity-technique cross-week exposure history** — both are recomputed fresh from already-loaded real data on every call rather than stored, a deliberate choice to avoid a second, driftable source of truth (documented in the Batch 5 report's known limitations, §8).
- **Block-transition events are not logged** to `coaching_periodization_events` — only reactive evaluations are (Batch 3 report, known limitations).

## 8. Known production risks

- **Test-fixture date drift will continue to grow the pre-existing 231-failure baseline over time** unless the AI-programmer test fixtures (§5) are updated to use relative/dynamic dates instead of hardcoded ones. This is a pre-existing condition, not introduced by Coaching Depth, but it will make future "diff against baseline" verification passes noisier the longer it goes unfixed.
- **Intensity-technique and structural-advisory data has no UI**, so a real user has no way to discover, review, or act on any of it today except by calling the JSON API directly — functionally invisible to the actual product experience until a UI is built. This does not affect correctness of the deterministic planner, only feature discoverability.
- **`user_profile_factors` currently has exactly one real consumer** (`training_experience` gating intensity-technique eligibility). If a future batch adds more factor categories without also revisiting the precedence rules in the Batch 5 report §5, there is a risk of a new factor being wired in a way that doesn't clearly rank below safety/goals/Blueprint boundaries the way `training_experience` does today — worth a deliberate review at that time, not an issue today.
- **No schema `CHECK` constraint on `user_profile_factors.value`** (unlike `exercise_preferences.preference`, which is CHECK-constrained) — validity for `training_experience` is enforced only in the route layer (`SUPPORTED_PROFILE_FACTORS` in `programming.ts`), not the database. A future direct-DB write (e.g. a migration script) could insert an invalid value that `effectiveValue()` would then return verbatim to `intensityTechniques.ts`'s narrowing check, which already defensively treats any unrecognized string as `null` (see `workoutBuilder.ts`'s `trainingExperience` narrowing) — so the actual blast radius is nil today, but this is worth tightening if the table gains more write paths later.

## 9. Documentation updated

- `docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` — status line changed from "proposed, not yet approved" to "fully implemented," with a phase-by-phase delivery table added.
- `docs/COACHING_DEPTH_REMAINING_BATCHES.md` — new §0 delivery-status section marking all three batches complete, with a note that a post-delivery audit (this report) confirmed the reports accurately describe what shipped.
