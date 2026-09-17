# Implementation Report — Coaching Depth Batch 3 (Periodization System)

Spec: `docs/COACHING_DEPTH_BATCH_3_PERIODIZATION_SYSTEM_SPEC.md` — combines roadmap Phase 2 (calendar-based periodization) and Phase 4 (reactive deloads) into one batch, per `docs/COACHING_DEPTH_REMAINING_BATCHES.md`.

## 1. Files changed

**Schema/migration:**
- `src/db/schema.sql` — extended `coaching_program_state` (Batch 1's table) with `block_number`, `reactive_trigger_status`, `reactive_triggered_at`, `reactive_deload_start_date`, `reactive_deload_end_date`, `cooldown_until`, `last_evaluated_at`, `specialization_target_id`, `specialization_goal_id`. New append-only `coaching_periodization_events` table.
- `src/db/client.ts` — `addColumnIfMissing` calls for every new column, safe on an existing database (same pattern as every prior migration in this codebase).

**Config:**
- `src/engine/config.ts` — added `DELOAD_POLICY`, `REACTIVE_TRIGGER`, `DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS` (the last one moved out of `foundationContext.ts`'s own local constant so both Batch 1's foundation context and this batch's calendar rollover share one default, never two).

**Coaching modules:**
- `src/coaching/programState/programStateTypes.ts` — added `PeriodizationState`, `DeloadReason`, `ReactiveTriggerStatus` types and extended `ProgramState`/added `UpdateReactiveStateInput`.
- `src/coaching/programState/programStateService.ts` — added `computeScheduledDeloadWeek`, the periodization-state/deload-reason derivation, automatic calendar block rollover (`advanceToNextBlockIfDue`, invoked from `getActiveProgramState`), and `updateReactiveState`.
- `src/coaching/periodization/deloadPolicy.ts` (new) — the one centralized deload modifier (set-volume multiplier, rep-range bias, reactive-deload duration/cooldown date functions).
- `src/coaching/periodization/reactiveTrendEvaluator.ts` (new) — the transparent, multi-signal reactive-trigger evidence engine.
- `src/coaching/periodization/periodizationEventsRepo.ts` (new) — append-only observability log.
- `src/coaching/periodization/periodizationService.ts` (new) — the orchestrator (`getPeriodizationContext`), the single place every caller reads periodization state and the only write path for reactive evaluation outcomes.
- `src/coaching/foundationContext.ts` — now imports the shared `DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS` instead of its own local constant.

**Planner integration:**
- `src/engine/workoutBuilder.ts` — `WeeklyPlanInput`/`BuildWorkoutInput` gained an optional `periodizationContext` field; `assembleWeeklyPlanInput` populates it via `getPeriodizationContext`; `buildWeeklyProgrammingPlan`'s per-target loop applies `applyDeloadSetVolumeReduction` to `desiredWeekly` exactly once when active; `attemptSelection`'s rep-range-bias site overrides the target's curated bias with the deload's own low-end bias when active.

**API:**
- `src/server/routes/programming.ts` — new `GET /api/programming/periodization` read-only status endpoint.

**Tests (all new, all passing):**
- `tests/coaching/programState.test.ts` — extended with Batch 3 describe blocks (scheduled deload activation, automatic block transition, manual-deload-block non-perpetuation, reactive state via `updateReactiveState`, combined-condition, cooldown).
- `tests/coaching/periodizationSystem.test.ts` (new, 12 tests) — deload policy pure functions, reactive trend evaluator (insufficient data, single-target watch, multi-target trigger, cooldown/already-deloaded blocking), orchestrator lifecycle (scheduled deload, once-per-day evaluation, trigger persists window + logs event, no double-trigger).
- `tests/engine/coachingDepthBatch3PlannerIntegration.test.ts` (new, 3 tests) — the real generated `PlannedWorkItem` reflects the deload's set reduction and rep-bias override, and is unaffected when no periodization context is supplied.
- `tests/routes/programming.test.ts` — 2 new tests for `GET /api/programming/periodization`.

## 2. State model

One canonical record (`coaching_program_state`, extended, never a second table). Deliberately **not** stored: `periodization_state` and `deload_reason` — both are pure functions of the block's calendar dates plus the stored reactive-evidence fields, computed on every read exactly the same way Batch 1's `weekIndex` was already computed rather than stored. This mirrors that existing precedent and structurally rules out the two ever drifting out of sync with the calendar or with each other.

**Stored (genuinely evidence-based, cannot be recomputed from the calendar):** `block_number`, `reactive_trigger_status` (`not_evaluated`/`clear`/`watch`/`triggered` — never `cooldown`, which is derived), `reactive_triggered_at`, `reactive_deload_start_date`/`reactive_deload_end_date`, `cooldown_until` (set once, at trigger time, as `end + 14 days` — never recomputed later), `last_evaluated_at` (once-per-day rate limit), `specialization_target_id`/`specialization_goal_id` (explicit-only).

**Computed, never stored:** `weekIndex` (Batch 1, unchanged), `scheduledDeloadWeek` (= `blockLengthWeeks` — the last week of every block), `periodizationState` (`ACTIVE`/`SCHEDULED_DELOAD`/`REACTIVE_DELOAD`), `deloadReason` (`calendar`/`reactive`/`manual`/`combined`/`null`), `isDeload` (mirrored into the legacy `is_deload` column for cheap SQL inspection, but the returned value is always derived, never read back from that column), `reactiveTriggerStatus`'s public `cooldown` overlay.

## 3. Trigger rules

- **Scheduled (calendar):** the block's own last week is always its scheduled deload — a pure function of `blockLengthWeeks`, no separate stored value.
- **Automatic block transition:** happens on any read once `weekIndex > blockLengthWeeks` — idempotent, calendar-driven only (never by app-open count). Preserves the previous block's kind/length for the normal `base`/`development` case; a manually-declared whole-block deload (`block_kind = 'deload'`) is the one exception — it never perpetuates into the next block, which falls back to `DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS`/`base`.
- **Reactive:** `evaluateReactiveDeloadTrigger` requires (a) ≥6 real completed sessions in a 21-day lookback, (b) ≥2 *different* targets independently showing `calculateBasicTrend === 'down'` (Batch 1's own trend engine, unmodified), (c) no active cooldown, (d) no already-active reactive deload. One declining target alone reports `watch`, never `triggered`. Evaluation runs at most once per real calendar day (`getPeriodizationContext`'s own rate limit via `lastEvaluatedAt`) and is fully transparent — every field spec §9.3 asks for (`signals`, `sessions_considered`, `lookback_start/end`, `blocking_reasons`, `recommended_action`, `evaluation_timestamp`) is present in the result.
- **Combined:** a reactive window overlapping the block's own scheduled deload week (or a manual deload block) reports `deloadReason: 'combined'` rather than stacking two independent reductions.

## 4. Deload policy

Centralized in `src/coaching/periodization/deloadPolicy.ts` + `config.ts`'s `DELOAD_POLICY`: `setVolumeMultiplier: 0.5` (never below 1 set — `applyDeloadSetVolumeReduction`), `repRangeBias: 'lower'` (reuses Batch 1/2's own `applyRepRangeBias`, never a second range-narrowing implementation), `maxReactiveDeloadDurationWeeks: 1`. Applied **exactly once** in `buildWeeklyProgrammingPlan`, at the single `desiredWeekly` computation site — every downstream skip-threshold/placement check reads the already-reduced value, so it can never be applied twice. The rep-range override happens at the one existing Batch 2 bias-application site, overriding (not stacking with) the target's own curated bias while a deload is active.

## 5. Migration details

Purely additive: `addColumnIfMissing` for every new `coaching_program_state` column (no `CHECK` constraints on the migrated columns, matching every prior migration's own convention — validity is enforced in the TypeScript service layer, which is the only code that ever writes these columns), plus `CREATE TABLE IF NOT EXISTS coaching_periodization_events`. An existing database with no periodization history reads every new column as `NULL`/its default and behaves exactly as a brand-new program would. No existing table's rows are altered or deleted.

## 6. Tests run

```
npm run typecheck   → clean
npm run build       → clean
npx vitest run tests/coaching/ tests/engine/coachingDepthBatch2Wiring.test.ts tests/engine/coachingDepthBatch3PlannerIntegration.test.ts tests/routes/programming.test.ts
                     → all passing
npm test -- --run (full suite) → 132 test files: 118 passed, 14 failed
                                   1582 tests: 1351 passed, 231 failed
```

The failing-test-name list was diffed against the pre-existing baseline established across every prior batch in this session (`diff` → `IDENTICAL_TO_BASELINE`) — **zero new failures**. All 14 failing files are the same pre-existing, unrelated date-drift fixture issue documented in `COACHING_DEPTH_BATCH_1_IMPLEMENTATION_REPORT.md` §9.

This required real attention: wiring `getPeriodizationContext` into `assembleWeeklyPlanInput` means every single existing test that reaches that function now also runs a reactive-trend evaluation on its first call. The evidence thresholds (≥6 completed sessions, ≥2 independently declining targets) turned out to be conservative enough that no pre-existing fixture accidentally satisfied them — confirmed empirically by the full-suite run, not merely assumed.

## 7. Known limitations

- **`assembleAndBuildWorkout`'s single-day construction path does not forward `periodizationContext`** — only `buildWorkout`'s manually-constructed object (now fixed, used directly by tests) and `computeFreshWeek`'s real weekly-generation path (which passes `assembleWeeklyPlanInput`'s full output straight through) are wired. `computeFreshWeek` is the actual production entry point behind `GET /api/programming/week`, so the real user-facing path is fully covered; `assembleAndBuildWorkout` is a narrower legacy single-day helper.
- **No UI page was built.** The spec's UI requirements (§13) are exposed only via the new `GET /api/programming/periodization` JSON endpoint, complete with a human-readable `explanation` field — nothing in `public/` renders it yet. This is a genuine, explicit scope reduction made under this batch's own time constraints, not an oversight.
- **Block-transition events are not logged** to `coaching_periodization_events` — only reactive evaluations (triggered and suppressed) are. A block's own calendar rollover is fully visible via `block_number`/`block_start_date` changing, so this is a minor observability gap, not a correctness one.
- **Specialization blocks** have full state support (`specialization_target_id`/`specialization_goal_id`, explicit-only, never set automatically by anything in this codebase) but no dedicated route/UI to set them yet — they can only be written directly via `updateReactiveState` today.
