# Implementation Report — Coaching Depth Batch 5 (Programming Enrichment)

Spec: `docs/COACHING_DEPTH_BATCH_5_PROGRAMMING_ENRICHMENT_SPEC.md` — combines roadmap Phase 5 (Intensity Techniques), Phase 7 (Structural Balance Advisories), and Phase 8 (Individual Profile Factors), per `docs/COACHING_DEPTH_REMAINING_BATCHES.md`. This is the final batch of the consolidated 3-batch remaining-work plan.

## 1. Files changed

**Blueprint layer:**
- `src/blueprint/types.ts` — new `BlueprintIntensityTechnique` type; `BlueprintProgramming.intensityTechniques` retyped from `unknown[]` to `BlueprintIntensityTechnique[]` (the field already existed in the vendored snapshot, unused and untyped until now).
- `src/blueprint/adapter.ts` — `listIntensityTechniques()`/`getIntensityTechnique(id)`.

**Schema/migration:**
- `src/db/schema.sql` — new `user_profile_factors` table (generic factor store, current-state not event-log, `user_confirmed` defaults to false).
- `src/db/client.ts` — comment noting the table needs no `addColumnIfMissing` (brand new).

**Repository:**
- `src/repositories/profileFactorsRepo.ts` (new) — `ProfileFactorsRepo`: `set`/`remove`/`get`/`listAll`/`listActive`/`effectiveValue`. Mirrors `ExercisePreferencesRepo`'s current-state/compute-at-read-time discipline; `effectiveValue` returns `null` unless the record is live, non-expired, **and** explicitly `user_confirmed`.

**Intensity techniques (`src/engine/intensityTechniques.ts`, new):**
- `TrainingExperienceLevel` type (`novice`/`intermediate`/`advanced`) — the one profile factor this batch wires into a real effect.
- `evaluateEligibilityForExercise` (private) checks, in order: target type (physique-only), avoidance, deload state, progression history, then iterates Blueprint's own real catalog (`drop-set`/`rest-pause`/`myo-reps`) matching each technique's real `suitable_exercise_types`/`suitable_when_fatigue_cost_at_most`/`suitable_when_skill_demand_at_most`/`suitable_when_stability_demand_at_most` against the candidate exercise's own real Blueprint fields, gated by this app's own `minimumExperienceByTechniqueId` policy.
- `assignWeeklyIntensityTechniques` — the public orchestrator: enforces per-session and per-week application caps and never re-applies to the same exercise twice in a week, deterministically (day/item order is the only tie-break).
- `src/engine/config.ts` — `INTENSITY_TECHNIQUE_POLICY` (`disabledDuringDeload: true`, `maxApplicationsPerSession: 1`, `maxApplicationsPerWeek: 2`, `minimumExperienceByTechniqueId`).

**Structural advisories (`src/coaching/structuralAdvisories/structuralAdvisoryService.ts`, new):**
- `evaluateStructuralAdvisories(targets, asOf)` — pure function, two real, evidence-backed categories: `push_pull_imbalance` (rolling-window push vs. pull exposure share, using the same `PUSH_PHYSIQUE_TARGETS`/`PULL_PHYSIQUE_TARGETS` classification Batch 4's pairing reuses) and `persistent_target_coverage_gap` (an active goal target with zero rolling exposure across its *entire* rolling window). `src/engine/config.ts` — `STRUCTURAL_ADVISORY_POLICY` (`pushPullWatchShareBelow: 0.4`, `pushPullReviewShareBelow: 0.3`).

**Planner integration (`src/engine/workoutBuilder.ts`):**
- `WeeklyPlanInput` gained `trainingExperience?: TrainingExperienceLevel | null`.
- `PlannedWorkItem` gained `applied_intensity_technique: AppliedIntensityTechnique | null`.
- `DecisionExplanation` gained `intensity_technique_evaluation: IntensityTechniqueEvaluation | null`.
- `WeeklyProgrammingPlan` gained `structuralAdvisories: readonly StructuralAdvisory[]`.
- `buildWeeklyProgrammingPlan`: computes `structuralAdvisories` from `input.targets` (independent, read-only); after every session's final post-pairing exercise set is known, runs one whole-week `assignWeeklyIntensityTechniques` pass and stamps `applied_intensity_technique`/`intensity_technique_evaluation` onto each `PlannedWorkItem` — the pass structurally cannot alter `sets`/`primary_exposure`/`secondary_exposure` (its own input type never carries them).
- `assembleWeeklyPlanInput` resolves `trainingExperience` via `ProfileFactorsRepo.effectiveValue(userId, 'training_experience', historyAsOfDate)`.

**Explanations:**
- `src/server/friendlyExplanation.ts` — `buildFriendlyPlannedReasoning` appends a plain-language sentence (from Blueprint's own real `what` text) when a technique was applied.

**API (`src/server/routes/programming.ts`):**
- `GET /api/programming/intensity-techniques` — Blueprint's real catalog, verbatim.
- `GET /api/programming/structural-advisories` — computed fresh via `assembleWeeklyPlanInput` + `evaluateStructuralAdvisories` (no full weekly plan needed just to read advisories).
- `GET`/`PUT`/`DELETE /api/programming/profile-factors[/:factorName]` — `PUT` only accepts `training_experience` for now (the one factor with a real effect); `userConfirmed` defaults to `false`.
- `enrichPlannedWork` now also returns `paired_with_exercise_name`-style pass-through for the new fields via the existing spread (no explicit change needed beyond the type widening already done for Batch 4's pairing name).

**Tests (all new, all passing):**
- `tests/engine/coachingDepthBatch5ProgrammingEnrichment.test.ts` (27 tests) — `assignWeeklyIntensityTechniques` (real Blueprint-suitability matches/mismatches, deload suppression, no-confirmed-experience, novice-insufficient, no-progression-history, avoidance, functional_goal exclusion, session/week caps, no-double-application, determinism), `evaluateStructuralAdvisories` (insufficient evidence, REVIEW/WATCH thresholds, balanced-volume no-advisory, coverage-gap for/not-for a specialization target, purity/determinism), `ProfileFactorsRepo` (absence, unconfirmed, confirmed, expiry, replace-not-merge, explicit removal, active-vs-all listing).
- `tests/engine/coachingDepthBatch5PlannerIntegration.test.ts` (8 tests) — the real generated `PlannedWorkItem`/`WeeklyProgrammingPlan` reflect technique application, experience gating, deload suppression, and structural advisories; proves sets/exposure/rep-range are byte-identical whether or not a technique was applied; proves no-op behavior with no new fields supplied; proves idempotency across repeated calls.
- `tests/routes/programming.test.ts` — 8 new tests across the three new route groups.

## 2. Intensity-technique rules

- **Enrichment, never replacement (spec §2.1):** a technique is a pure annotation (`instruction`/`extra_fatigue_note`/`applied_to_working_set_number`) — it never changes `sets`, `reps_min`/`reps_max`, `primary_exposure`, or `secondary_exposure`. Enforced by construction: `assignWeeklyIntensityTechniques`'s own input type (`TechniqueCandidateItem`) never carries those fields, so it structurally has no way to touch them (proven directly by the integration test comparing a technique-applied vs. non-applied run of the identical target/history).
- **Real catalog, real suitability data, app-only policy layered on top:** the technique catalog and its suitability fields come straight from Blueprint's own vendored `intensityTechniques` data — nothing invented. Only the experience-gating minimums and frequency caps are this app's own explicit policy (`config.ts`), since Blueprint's raw data has no such fields.
- **Eligibility order:** target type → avoidance → deload state → progression history → Blueprint suitability match → confirmed experience minimum. A functional_goal target is `considered: false` (out of scope entirely, not merely ineligible).
- **Deload suppression is unconditional** in this batch — no technique is flagged as an approved low-stress exception (spec §4.8's "only explicitly approved low-stress exceptions" — none exist yet).
- **Frequency/session limits** are enforced per real generated week (session cap 1, weekly cap 2, no exercise twice), deterministically, using the day/item order already established by the rest of the pipeline.

## 3. Structural-advisory rules

- **Two categories, both derived entirely from data the planner already computes** (`TargetBuildContext.rolling_exposure_units`/`rolling_window_days`/`is_specialization`) — no new tracking, no second source of truth.
- **Evidence thresholds are conservative by design:** `push_pull_imbalance` requires a combined push+pull rolling total of at least 4 exposure units before it will ever fire (spec §5.3: a fresh program never gets a strong advisory); `persistent_target_coverage_gap` requires literally zero exposure across the *entire* rolling window for an active goal target, not a single missed session.
- **Advisories never alter the program in this batch** — `affects_prescription` is always `false`; no adjustment rule is implemented (spec §5.6's stated default), which is itself the safest, spec-compliant choice given the batch's scope.

## 4. Profile-factor rules

- `user_profile_factors` is a **generic** store (any `factor_name`/`value` pair with `source`/`user_confirmed`/`expires_at`), but only `training_experience` is wired into a real programming effect and only `training_experience` is accepted by the `PUT` route's validation — spec §6.2's "only use factors that are supported by the current product requirements and data model."
- **Conservative default (spec §2.2/§6.3):** `effectiveValue` returns `null` — genuine absence, never a guessed novice/intermediate default — unless a record is live, non-expired, **and** explicitly `user_confirmed = true`. A caller with no confirmed experience simply sees every experience-gated technique as ineligible, never a fallback assumption.

## 5. Precedence and conflict handling

Per spec §6.4's stated precedence (safety/restrictions → locked sessions → required coverage/goals → equipment → user-confirmed profile factors → programming quality → soft preferences → tie-breakers): this batch's one real profile-factor effect (training-experience gating of intensity techniques) sits structurally below every existing constraint, because it is evaluated only *after* the base prescription (exercise, sets, reps, RIR) is already fully and independently decided — a technique can only ever be layered on top of an exercise the existing Gate 1-6 hierarchy, fatigue/volume model, and Batch 4 avoidance rules already approved. It can never widen, narrow, or override any of those decisions.

## 6. Migration details

Purely additive: `CREATE TABLE IF NOT EXISTS user_profile_factors`, no changes to any existing table. An existing database has zero rows in the new table, so every `ProfileFactorsRepo.effectiveValue` call returns `null` for every user until they explicitly confirm a factor — no automatic enablement, no inferred restriction, matching spec §10's migration requirements exactly. `assembleWeeklyPlanInput`'s new `ProfileFactorsRepo` read and `buildWeeklyProgrammingPlan`'s new technique-assignment pass are both no-ops (produce the pre-Batch-5 output unchanged) for any caller that never supplies `trainingExperience` or has no confirmed factor.

## 7. Tests run

```
npm run build       → clean
npm run typecheck   → clean
npx vitest run tests/engine/coachingDepthBatch5ProgrammingEnrichment.test.ts tests/engine/coachingDepthBatch5PlannerIntegration.test.ts tests/routes/programming.test.ts
                     → 27 + 8 + 33 passing (43 new tests total)
npm test -- --run (full suite) → 135 test files: 121 passed, 14 failed
                                   1652 tests: 1421 passed, 231 failed
```

The failing-test-name list was diffed against the same established baseline used for every prior batch this session (`diff /tmp/final_fail_tests.txt <current>` → identical, zero lines of difference) — **zero new failures**. All 14 failing files are the same pre-existing, unrelated date-drift fixture issue documented in `COACHING_DEPTH_BATCH_1_IMPLEMENTATION_REPORT.md` §9.

## 8. Known limitations

- **No UI was built.** The spec's UI requirements (§9) are exposed only via the new JSON routes — nothing in `public/` renders technique/advisory/profile-factor state yet, matching the same explicit scope reduction Batches 3 and 4 already documented for their own UI gaps.
- **`trainingExperience` is not forwarded through `BuildWorkoutInput`'s single-day legacy path** (`buildWorkout`) — only the real production weekly path (`assembleWeeklyPlanInput` → `buildWeeklyProgrammingPlan`, behind `GET /api/programming/week`) resolves it. This mirrors Batch 3's own documented limitation for `periodizationContext` on that same legacy helper.
- **Only `training_experience` has a real programming effect.** The spec's other listed profile-factor categories (equipment, schedule, movement restrictions, recovery constraints, etc.) either already have dedicated, pre-existing mechanisms elsewhere in this app (equipment/schedule via `TrainingProfile`; exercise-specific restrictions via Batch 4's `exercise_preferences`) or were left out of this batch's scope — the `user_profile_factors` table and repo are generic enough to support them later without a schema change.
- **Advisory persistence was intentionally not built.** Spec §10 lists "structural advisory records or snapshots" as a *potential* persisted artifact; since every real fact behind both advisory categories is already derivable from data the planner loads on every call, advisories are computed fresh on read rather than stored, avoiding a second, driftable source of truth.
- **No standalone "why was this advisory/technique/factor decision made" explanation endpoint** beyond what's already carried on the structured objects themselves (`IntensityTechniqueEvaluation.suppressed_reason`, `StructuralAdvisory.evidence`/`explanation`) and the one sentence added to `buildFriendlyPlannedReasoning`.
