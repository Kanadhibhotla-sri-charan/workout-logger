# Implementation Report — Coaching Depth Batch 1 (Foundation)

Spec: `docs/COACHING_DEPTH_BATCH_1_IMPLEMENTATION_SPEC.md`
Background context: `docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` (this batch implements the roadmap's own Phase 1 idea plus two additional foundation phases, per the newer, more detailed spec's own scope — the roadmap's more aggressive "wire the frequency override directly into `developmentReferenceEngine.ts`" design was deliberately NOT taken; see "Design decisions" below).

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

No other files were touched. No existing engine file (`developmentReferenceEngine.ts`, `workoutBuilder.ts`, `volumeEngine.ts`, `exerciseSelector.ts`) was modified — see "Design decisions" below for why.

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
npx vitest run tests/coaching/   → 4 test files, 76 tests, all passing
npm test -- --run (full suite)  → 129 test files: 115 passed, 14 failed
                                    1543 tests: 1312 passed, 231 failed
```

## 9. Baseline versus new failures

**All 231 failing tests, across all 14 failing files, are pre-existing and unrelated to this batch.** Verified directly via `git stash` (reverting every Coaching Depth Batch 1 change) and re-running the full suite: the failure count was **identical** (14 files / 231 tests) both with and without this batch's changes. Root cause: several `tests/ai-programmer/*.test.ts` files hardcode a fixed calendar date (e.g. `SUNDAY = '2026-09-13'`) as a request `targetDate`, and `buildProgrammerContext`/`buildReconciliationContext` reject any `targetDate` that is "in the past relative to the current date." Real calendar time has since passed that hardcoded date (today is 2026-09-17 as of this report), so these fixtures now fail purely from the passage of time — a pre-existing, date-drift test-fixture staleness issue with no connection to Coaching Depth Batch 1. This session's own new tests (`tests/coaching/`) deliberately use a safely-future date (`2026-12-14`) for anything that goes through the real AI context builders, precisely to avoid this same trap for as long as reasonably possible.

**New tests added by this batch: 76, all passing.** Total passing count increased from 1236 (baseline) to 1312 (baseline + 76 new), with zero new failures.

(This date-drift issue affecting 14 pre-existing test files is being flagged separately as a suggested follow-up task, since fixing it is out of scope for this batch — see the "unrelated feature" non-goal in spec §11's acceptance criteria.)

## 10. Explicit confirmation

- **No automatic periodization**: `advanceProgramState`/`resetProgramStateForNewProgram` are never called by any code path in this codebase; block/week transitions require an explicit, deliberate call this batch does not wire up anywhere.
- **No automatic deload**: `isDeload`/`block_kind = 'deload'` are never set by any code in this batch; the column exists and is stored/read faithfully, nothing writes it except an explicit `advanceProgramState` call (unused).
- **No volume/frequency change driven by a profile or trend**: `getActualScheduledFrequency`/`getActualCompletedFrequency` only ever *observe* real data; `MuscleProgrammingProfile`'s frequency references are exposed as read-only structured context (`coachingFoundation.targetProfiles`) and are never read by `developmentReferenceEngine.ts`, `volumeEngine.ts`, or `workoutBuilder.ts` — those files were not modified. `calculateBasicTrend`'s output (`up`/`down`/`stable`/`unknown`) is likewise only ever stored in `TargetHistoricalSummary.trend` and surfaced read-only in the AI context; nothing consumes it to change a decision.
- **No exercise rotation**: `applyRepRangeBias` is a pure, standalone function; it is not called from `exerciseSelector.ts`, `workoutBuilder.ts`, or `developmentPackages.ts`'s prescription-lookup path in this batch.
- **No fabricated data**: every missing-data rule above (§6) was implemented so a genuinely absent value stays `undefined`/`null` all the way through normalization and aggregation — verified by dedicated tests (`tests/coaching/historicalService.test.ts`'s "missing values remain missing" and "no history returns unknown/null" groups).

## Design decisions worth flagging

- **The roadmap document's own Phase 1 sketch** (`docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md`) proposed directly substituting a frequency override into `developmentReferenceEngine.ts`'s `getDevelopmentReference` and wiring rep-range bias into `workoutBuilder.ts`'s live prescription-lookup call site. **This batch's own spec explicitly supersedes that sketch** — it repeatedly gives the safer option ("if the current planner cannot safely consume the preference, expose it as structured context and leave scheduling unchanged. Document that limitation" — spec §4.4) and its own exact build order (§9) stops at "Step 5 — Context integration: combine profiles, state, current plan, and history. Expose read-only structured context to AI," with no step wiring anything into live generation. Given how much prior work in this session has gone into carefully tuning frequency/exposure/volume behavior (the exposure-cycle model, the rolling-window frequency gate, session-realism caps, etc.), directly modifying those files was judged out of scope for a "Coaching Foundation" batch and a materially larger, riskier change than what was asked for. **Consuming these profiles/trends to actually change scheduling, volume, or rep ranges is deferred to a future batch**, exactly as the roadmap's own phase sequencing intends (Phase 2/4).
- `DEFAULT_BLOCK_LENGTH_WEEKS = 4` and `DEFAULT_HISTORY_WINDOW_DAYS = 28` (`src/coaching/foundationContext.ts`) are documented, adjustable constants used only when a program's coaching state is first ever initialized (block length) or when summarizing history (window) — neither implies periodization behavior by itself.
- The trend-classification tolerance band (`TREND_STABLE_TOLERANCE = 0.05`, `src/coaching/history/trendCalculations.ts`) is a new, documented addition beyond the existing `goalPhaseEngine.ts` precedent (which used a bare `>`/`<` comparison with no tolerance) — necessary to satisfy spec §6.5's explicit "one bad session must not imply decline" requirement, which the original precedent alone does not guarantee.
