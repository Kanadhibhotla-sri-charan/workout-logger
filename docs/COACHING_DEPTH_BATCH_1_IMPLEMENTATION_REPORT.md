# Implementation Report — Coaching Depth Batch 1 (Foundation)

Spec: `docs/COACHING_DEPTH_BATCH_1_IMPLEMENTATION_SPEC.md`
Background context: `docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` (this batch implements the roadmap's own Phase 1 idea plus two additional foundation phases, per the newer, more detailed spec's own scope).

**Update:** Batch 1's own spec deliberately deferred wiring the profile module's preferred frequency and rep-range bias into live generation, exposing them only as read-only structured context. A subsequent **Coaching Depth Batch 2** pass implemented exactly that wiring — `developmentReferenceEngine.ts` and `workoutBuilder.ts` are now modified, matching the roadmap's own original design. This report has been updated to describe the current, cumulative state; see §11 for the exact Batch 2 changes and test coverage.

## 1. Every file added/modified

**New — `src/coaching/` (all three modules, per spec §3's exact directory layout):**
- `src/coaching/profiles/muscleProfileTypes.ts` — `MuscleProgrammingProfile`/`RepRangeBias` types, `validateMuscleProgrammingProfile`, `InvalidMuscleProgrammingProfileError`, `defaultProfileFor`.
- `src/coaching/profiles/muscleProfiles.ts` — the five curated profiles (six real target ids), `MUSCLE_PROFILE_MAPPING_GAPS`, `getProfile`.
- `src/coaching/profiles/muscleProfileService.ts` — `getPreferredFrequencyReference`/`getMinimumFrequencyReference`/`getMaximumFrequencyReference`, `getActualScheduledFrequency`, `getActualCompletedFrequency`, `applyRepRangeBias`.
- `src/coaching/programState/programStateTypes.ts` — `ProgramState`/`ProgramBlockKind` types and input types.
- `src/coaching/programState/programStateService.ts` — `calculateWeekIndex`, `getActiveProgramState`, `createInitialProgramState`, `advanceProgramState`, `resetProgramStateForNewProgram`, `getOrCreateActiveProgramState`.
- `src/coaching/history/historicalTypes.ts` — `HistoricalExerciseExposure`, `TargetHistoricalSummary`, `TrendDataQuality`, `BasicTrendDirection`.
- `src/coaching/history/historicalService.ts` — `getTargetHistory`, `getTargetSummary`, `getExerciseHistory`.
- `src/coaching/history/trendCalculations.ts` — `classifyDataQuality`, `calculateBasicTrend`.
- `src/coaching/foundationContext.ts` — `CoachingFoundationContext` type and `buildCoachingFoundationContext` (the §7 integration point).

**New — tests (`tests/coaching/`):**
- `tests/coaching/muscleProfiles.test.ts` (28 tests)
- `tests/coaching/programState.test.ts` (19 tests)
- `tests/coaching/historicalService.test.ts` (20 tests)
- `tests/coaching/foundationContext.test.ts` (9 tests)

**Modified:**
- `src/db/schema.sql` — added `coaching_program_state` table (additive, `CREATE TABLE IF NOT EXISTS`, no destructive migration).
- `src/ai-programmer/context/programmerContextTypes.ts` — added `coachingFoundation: CoachingFoundationContext` field to `AIProgrammerContext`.
- `src/ai-programmer/context/programmerContextBuilder.ts` — builds and attaches `coachingFoundation`.
- `src/ai-programmer/context/reconciliationContextTypes.ts` — added the identical `coachingFoundation` field to `AIReconciliationContext`.
- `src/ai-programmer/context/reconciliationContextBuilder.ts` — builds and attaches `coachingFoundation`.

No other files were touched by Batch 1 itself.

**Update (Batch 2) — modified:**
- `src/engine/developmentReferenceEngine.ts` — `getDevelopmentReference` now reads `getPreferredFrequencyReference(targetId)` and, when a curated profile supplies one, uses it in place of Blueprint's raw package `sessions_per_week_reference` (recalculating `weekly_direct_set_reference` accordingly); `direct_sets_per_exposure` and every other field are unaffected.
- `src/engine/workoutBuilder.ts` — the deterministic prescription-construction step (`attemptSelection`) now reads the chosen exercise's target's curated `repRangeBias` and applies `applyRepRangeBias` to that exercise's real Blueprint-authored `reps_range` before it is placed into the generated workout.

`volumeEngine.ts` and `exerciseSelector.ts` remain unmodified — see §11 below for full detail, and the "Design decisions worth flagging" section for why the wiring was deferred past Batch 1 and then implemented in Batch 2.

**Update (Batch 2) — new test file:**
- `tests/engine/coachingDepthBatch2Wiring.test.ts` (11 tests)

## 2. Existing architecture reused

- **Canonical target identity**: `BlueprintAdapter.getTarget(id)` (module-load-time validation of every curated profile's target id).
- **Exercise-to-target attribution**: `exerciseSelector.ts`'s `roleFor` — the exact same authoritative primary/secondary resolution `goalPhaseEngine.ts`'s own load-trend precedent already uses — supplemented only for the one case it cannot see (an approved outside-Blueprint exercise, via `OutsideBlueprintExercisesRepo`).
- **Load formula**: `weight * (1 + reps / 30)`, the exact existing formula from `goalPhaseEngine.ts`'s `gatherReviewEvidence`, reused verbatim (not re-derived) in `historicalService.ts`.
- **Trend methodology**: the same early-half/late-half average comparison `goalPhaseEngine.ts` already established, generalized to any target (not "one target per active goal, on demand only") in `trendCalculations.ts`, with an added tolerance band so a single noisy session cannot flip the verdict (spec §6.5's own explicit requirement, which the original precedent's plain `>`/`<` comparison did not have).
- **Date/week arithmetic**: `dateMath.ts`'s `weekRangeContaining`/`daysBetween`/`addDays`/`rollingRangeEnding` — no second week-boundary or date-arithmetic implementation.
- **Real workout data**: `WorkoutSessionsRepo.listSessionsInRange`/`getExercisePerformances` — the same repository every other real-history reader in this codebase uses.
- **Real current-week plan**: the AI context builders' own already-fetched `WeeklyProgramRepo` result (`weeklyProgram`/`persistedProgram`) is passed straight into `buildCoachingFoundationContext` — no second `WeeklyProgramRepo` read.
- **Per-user stable identity pattern**: `coaching_program_state`'s schema and keying convention (`user_id`/`program_id` primary key, one row per user) directly mirrors `non_goal_rotation_state`/`NonGoalRotationRepo` — this session's own established precedent for "a tiny per-user state table, read by every planner/context call."

## 3. Exact canonical IDs for all five profiles

| Spec row | Canonical Blueprint target id(s) | Preferred | Min | Max | Rep bias |
|---|---|---:|---:|---:|---|
| Rectus abdominis | `rectus-abdominis` | 4 | 2 | 5 | higher |
| Obliques | `obliques` | 4 | 2 | 5 | higher |
| Gastrocnemius | `gastrocnemius` | 4 | 2 | 5 | higher |
| Soleus | `soleus` | 4 | 2 | 5 | higher |
| Forearms | `forearm-flexors` **and** `forearm-extensors` | 3 | 2 | 4 | higher |

"Forearms" is not itself a single canonical Blueprint target — Blueprint splits it into two real, separately-trainable targets (`forearm-flexors`, `forearm-extensors`), each with its own exercise pool. Per spec §4.2's own instruction ("do not create a duplicate target"), this batch applies the spec's one "Forearms" row to **both** real targets rather than inventing a combined id. This is a documented mapping choice, not a gap — `MUSCLE_PROFILE_MAPPING_GAPS` is empty (verified: all six target ids exist in the current Blueprint snapshot).

## 4. Where program state is stored

New table `coaching_program_state` (additive migration, `src/db/schema.sql`), one row per user:

```sql
CREATE TABLE IF NOT EXISTS coaching_program_state (
  program_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  block_kind TEXT NOT NULL CHECK (block_kind IN ('base', 'development', 'deload')),
  block_start_date TEXT NOT NULL,
  block_length_weeks INTEGER NOT NULL,
  is_deload INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**`program_id` is this app's single user's own stable id (`UsersRepo.getOrCreateDefault().id`), not a `programs.id` row.** This is a deliberate adaptation, not a literal reuse of an existing "program" identifier: `WeeklyProgramRepo`'s own doc comment confirms every calendar week gets a **fresh** `programs` row (found by `programs.start_date`), so no `programs.id` value is stable across weeks the way a program-state anchor must be. The user's own id is the one identity in this single-user app that genuinely persists across weeks/regenerations — exactly the same reasoning `NonGoalRotationRepo` already documents for its own identical keying choice. `week_index` is **never stored** — it is always computed on read from `block_start_date` and a real reference date (see below), so it can never drift or be advanced by a mere app-open read.

## 5. Week-index and regeneration behavior

- `calculateWeekIndex(blockStartDate, referenceDate, weekBoundary)` normalizes both dates to their own week-start (via `weekRangeContaining`, honoring the user's actual `week_start_day`), takes the whole-week difference, and returns `max(1, weeksElapsed + 1)` — pure calendar-day arithmetic (no timezone/DST ambiguity, per `dateMath.ts`'s own documented UTC-midnight approach). Tested against Sunday/Monday boundaries, month boundaries, year boundaries, a non-Monday week boundary, and multi-week gaps.
- `referenceDate` is always an explicit parameter — this module never reads `Date.now()`/wall-clock time itself, so "app-open time" (in the sense of literal click-time-of-day) structurally cannot influence the result; only the real calendar date the caller already resolved (e.g. via `todayForUser`) can.
- **Regeneration never resets state**: `computeFreshWeek` (the weekly plan regeneration entry point) was **not modified** and does not call anything in `src/coaching/`. The only place program state is read is `buildCoachingFoundationContext`, called from the AI context builders — a plain, explicit context-build request, never the weekly regeneration path itself. `getOrCreateActiveProgramState` only *creates* a row the very first time one is read for a user; every subsequent read is a pure `SELECT`. Verified directly: building the foundation context for two different weeks of the same program never changes `blockId` (`tests/coaching/foundationContext.test.ts`), and building it twice with identical inputs produces a deep-equal result.
- `advanceProgramState`/`resetProgramStateForNewProgram` exist and are fully implemented/tested, but **nothing in this codebase calls them** — starting a new block or resetting a program is an explicit, deliberate action with no automatic trigger anywhere in Batch 1 (matching spec §12's non-goals).

## 6. Historical source records and missing-data behavior

- Source: the real, already-persisted `workout_sessions`/`workout_exercises`/`workout_sets` rows, read via `WorkoutSessionsRepo.listSessionsInRange`/`getExercisePerformances` — no new history table, no adapter that duplicates or rewrites historical records.
- Missing-data rules enforced throughout: a set's `weight`/`reps`/`rir` being `null` excludes it from `load`/`completedReps`/`rir` respectively (never treated as `0`); a target/exercise with zero real records reports `averageLoad`/`prescribedSets`/`completedSets`/`completionRatio` as `undefined` (never `0`); `getActualCompletedFrequency(targetId, history)` returns `null` when `history` itself is `null` ("no history known"), distinct from `0` for a real, checked history that legitimately found nothing.
- `completionStatus` derivation: `'skipped'` session status → `'missed'` (explicitly recorded); `'completed'` session status with all/some/zero of this exercise's own sets marked completed → `'completed'`/`'partial'`/`'unknown'` respectively (a completed session showing zero completed sets for one specific exercise is ambiguous — e.g. a substitution — so it is honestly `'unknown'`, never guessed); `'planned'`/`'in_progress'` → `'unknown'`.

## 7. Comparable-exposure rules

- `getExerciseHistory(exerciseId, ...)` returns records for **exactly that one exercise** — verified directly that a different real exercise's records (`plank`, also primary for `rectus-abdominis`) never appear in `cable-crunch`'s own exercise-level history, even though both train the same target.
- `getTargetHistory(targetId, ...)` legitimately aggregates every exercise that trains `targetId` as **primary** work (matching the existing `goalPhaseEngine.ts` precedent's own exclusion of merely-secondary/compound-overlap relationships from direct performance evidence) — this is the intended target-level rollup, not a violation of "don't combine incomparable exercises," which concerns exercise-level history specifically.
- `getTargetSummary`'s `averageLoad`/trend calculation pools only real `load` values already computed per-exposure (themselves exercise-specific, weight-and-reps-based) — never mixes in a differently-shaped metric.

## 8. Typecheck, build, unit, integration, and full-suite results

```
npm run typecheck   → clean
npm run build       → clean
npx vitest run tests/coaching/ tests/engine/coachingDepthBatch2Wiring.test.ts
                     → 5 test files, 87 tests, all passing
npm test -- --run (full suite)  → 130 test files: 116 passed, 14 failed
                                    1554 tests: 1323 passed, 231 failed
```

(Batch 1 alone added 76 tests across `tests/coaching/`; Batch 2 added 11 more in `tests/engine/coachingDepthBatch2Wiring.test.ts`, for 87 total coaching/wiring tests, all passing.)

## 9. Baseline versus new failures

**All 231 failing tests, across all 14 failing files, are pre-existing and unrelated to Coaching Depth (Batch 1 or 2).** Verified directly via `git stash` (reverting the relevant changes) and re-running the full suite at each stage: the failure count was **identical** (14 files / 231 tests) with and without Batch 1's changes, and again identical with and without Batch 2's changes. Root cause: several `tests/ai-programmer/*.test.ts` files hardcode a fixed calendar date (e.g. `SUNDAY = '2026-09-13'`) as a request `targetDate`, and `buildProgrammerContext`/`buildReconciliationContext` reject any `targetDate` that is "in the past relative to the current date." Real calendar time has since passed that hardcoded date, so these fixtures now fail purely from the passage of time — a pre-existing, date-drift test-fixture staleness issue with no connection to Coaching Depth. This session's own new tests deliberately use a safely-future date for anything that goes through the real AI context builders, to avoid this same trap for as long as reasonably possible.

**New/updated tests, Batch 1 + Batch 2 combined: 87, all passing.** Total passing count increased from 1236 (pre-Batch-1 baseline) to 1323 (current), with zero new failures beyond the same 231 pre-existing, unrelated ones.

(This date-drift issue affecting 14 pre-existing test files is being flagged separately as a suggested follow-up task, since fixing it is out of scope for this batch — see the "unrelated feature" non-goal in spec §11's acceptance criteria.)

## 10. Explicit confirmation

- **No automatic periodization**: `advanceProgramState`/`resetProgramStateForNewProgram` are never called by any code path in this codebase; block/week transitions require an explicit, deliberate call this batch does not wire up anywhere.
- **No automatic deload**: `isDeload`/`block_kind = 'deload'` are never set by any code in this batch; the column exists and is stored/read faithfully, nothing writes it except an explicit `advanceProgramState` call (unused).
- **Frequency reference is now wired (Batch 2)**: `getActualScheduledFrequency`/`getActualCompletedFrequency` still only ever *observe* real data (unchanged). But `MuscleProgrammingProfile`'s `preferredFrequencyPerWeek` — via `getPreferredFrequencyReference` — is now read by `developmentReferenceEngine.ts`'s `getDevelopmentReference`, which uses it in place of Blueprint's raw package frequency to recompute `sessions_per_week_reference`/`weekly_direct_set_reference` for a profiled target (see §11). This is a deliberate, direct volume/frequency effect of a curated *profile* — never of a *trend*.
- **No volume/frequency change is driven by a trend**: `calculateBasicTrend`'s output (`up`/`down`/`stable`/`unknown`) is only ever stored in `TargetHistoricalSummary.trend` and surfaced read-only in the AI context (`coachingFoundation.historicalSummaries`); nothing in `developmentReferenceEngine.ts`, `volumeEngine.ts`, or `workoutBuilder.ts` reads or consumes it to change a decision — trend remains purely observational.
- **Rep-range bias is now wired (Batch 2); exercise selection itself is untouched**: `applyRepRangeBias` is called from `workoutBuilder.ts`'s deterministic prescription-construction step, applied to the *already-chosen* exercise's own real Blueprint-authored `reps_range` — it narrows which end of that authored range the final `reps_min`/`reps_max` lean toward, never which exercise gets selected in the first place (see §11). `exerciseSelector.ts`'s own Gate 1-6 selection logic and `developmentPackages.ts`'s prescription-lookup path remain unmodified and are not consulted by, or aware of, any bias.
- **No fabricated data**: every missing-data rule above (§6) was implemented so a genuinely absent value stays `undefined`/`null` all the way through normalization and aggregation — verified by dedicated tests (`tests/coaching/historicalService.test.ts`'s "missing values remain missing" and "no history returns unknown/null" groups).

## 11. Batch 2 update — frequency reference and rep-range bias wired into live generation

Batch 1 deliberately deferred consuming the profile module's data (see "Design decisions" below for why). A subsequent **Coaching Depth Batch 2** pass implemented exactly that consumption, matching the roadmap's own original Phase 1 design:

- **`src/engine/developmentReferenceEngine.ts`** — `getDevelopmentReference` calls `getPreferredFrequencyReference(targetId)` (from the same read-only `src/coaching/profiles/` module Batch 1 built) and, when a curated profile supplies a `preferredFrequencyPerWeek`, uses it instead of Blueprint's raw package `frequency.sessions_per_week`. `weekly_direct_set_reference` is recalculated as `direct_sets_per_exposure × (effective frequency)`; `direct_sets_per_exposure` itself, and the behavior for a functional-goal target or a target with no development package, are unchanged. A target with no curated profile falls through to Blueprint's own raw frequency exactly as before this wiring.
- **`src/engine/workoutBuilder.ts`** — the single deterministic prescription-construction step (`attemptSelection`, inside `buildWeeklyProgrammingPlan`) resolves the curated `repRangeBias` for the target actually being prescribed and applies `applyRepRangeBias` to the *already-selected* exercise's own real Blueprint-authored `reps_range`, before that prescription is placed into the generated workout. The bias only ever narrows the authored `[min, max]` toward one end — it can never produce a value outside the authored range. It applies only to a real Blueprint-authored physique-target prescription; an approved outside-Blueprint exercise's own human-approved range, and any functional-goal target's prescription, are left untouched. Because the bias is resolved from the target actually being prescribed (not from any other target an exercise might secondarily expose), a shared exercise's secondary contribution to a different target never inherits this target's bias.
- **Tests**: `tests/engine/coachingDepthBatch2Wiring.test.ts` (11 tests) — a profiled target's development reference uses its curated frequency; an unprofiled target is unchanged; `weekly_direct_set_reference` equals `direct_sets_per_exposure × effective frequency`; a higher-biased target (including both `forearm-flexors` and `forearm-extensors`) shifts toward the high end of its authored range; a lower-biased target (exercised via a file-scoped test mock, since no curated profile currently uses `'lower'`) shifts toward the low end; the resulting range never exceeds the authored range, across every curated non-standard-bias target; an unprofiled target's range is exactly the authored range, unchanged; the generated `PlannedWorkItem` itself (not just the pure `applyRepRangeBias` function) carries the biased values; a functional-goal target's outside-Blueprint prescription is never biased.
- **Regression verification**: confirmed via `git stash` (reverting the Batch 2 changes) that the full suite's failing-test set is byte-identical with and without this wiring — the same 14 files / 231 pre-existing, date-drift-only failures, zero new failures either way. Wiring in real curated frequencies did change ranking/scheduling behavior for the profiled targets (`rectus-abdominis`, `obliques`, `gastrocnemius`, `soleus`, `forearm-flexors`, `forearm-extensors`) enough to break several *pre-existing* engine tests whose fixtures had baked in Blueprint's old raw frequency for those same targets; those fixtures were updated to reflect the new, intended behavior (never weakened) as part of this same pass.
- **`docs/COACHING_DEPTH_BATCH_1_IMPLEMENTATION_SPEC.md`** was also corrected in a follow-up pass: its Forearms profile row had recorded `repRangeBias: standard`, which never matched the roadmap (`docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` always specified `'higher'` for both `forearm-flexors` and `forearm-extensors`) or, after this Batch 2 pass, the source. Both `forearm-flexors` and `forearm-extensors` are curated with `repRangeBias: 'higher'` in `src/coaching/profiles/muscleProfiles.ts`, consistent with the roadmap and this report.

## Design decisions worth flagging

- **The roadmap document's own Phase 1 sketch** (`docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md`) proposed directly substituting a frequency override into `developmentReferenceEngine.ts`'s `getDevelopmentReference` and wiring rep-range bias into `workoutBuilder.ts`'s live prescription-lookup call site. **Batch 1's own spec deliberately deferred that wiring** — it repeatedly gave the safer option ("if the current planner cannot safely consume the preference, expose it as structured context and leave scheduling unchanged. Document that limitation" — spec §4.4) and its own exact build order (§9) stopped at "Step 5 — Context integration: combine profiles, state, current plan, and history. Expose read-only structured context to AI," with no step wiring anything into live generation. Given how much prior work in this session had gone into carefully tuning frequency/exposure/volume behavior (the exposure-cycle model, the rolling-window frequency gate, session-realism caps, etc.), directly modifying those files was judged out of scope for a "Coaching Foundation" batch and a materially larger, riskier change than what was asked for at the time.
- **That deferral was intentionally short-lived, not permanent**: Coaching Depth Batch 2 (§11 above) subsequently implemented exactly the roadmap's own original design, with regression coverage confirming the rest of the engine's carefully-tuned behavior was preserved.
- **What remains deferred/unimplemented**: consuming a target's *historical trend* (`calculateBasicTrend`'s `up`/`down`/`stable`/`unknown` output) to change scheduling, volume, or rep ranges, and any form of automatic periodization or deload (block transitions, `isDeload` being set automatically) — both remain purely observational/unimplemented, exactly as §10 above documents. Nothing in this codebase reads `TargetHistoricalSummary.trend` to drive a decision, and nothing calls `advanceProgramState`/`resetProgramStateForNewProgram` automatically.
- `DEFAULT_BLOCK_LENGTH_WEEKS = 4` and `DEFAULT_HISTORY_WINDOW_DAYS = 28` (`src/coaching/foundationContext.ts`) are documented, adjustable constants used only when a program's coaching state is first ever initialized (block length) or when summarizing history (window) — neither implies periodization behavior by itself.
- The trend-classification tolerance band (`TREND_STABLE_TOLERANCE = 0.05`, `src/coaching/history/trendCalculations.ts`) is a new, documented addition beyond the existing `goalPhaseEngine.ts` precedent (which used a bare `>`/`<` comparison with no tolerance) — necessary to satisfy spec §6.5's explicit "one bad session must not imply decline" requirement, which the original precedent alone does not guarantee.
