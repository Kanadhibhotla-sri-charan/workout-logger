# `target_allocations_json` Aggregate-Integrity Fix — Investigation & Implementation Report

## Symptom that led here

After deploying the Cross-Week Programming Intelligence Fix and regenerating the production week of 2026-09-14, Tuesday Push stayed at 19 exercises / 139.6 minutes — barely different from the original reported bug (19 / 135.2 min) — while Wednesday/Thursday improved substantially. This report investigates why, per an explicit read-only-first investigation request.

## Root cause: `target_allocations_json` can be completely disconnected from the real, displayed plan

`reconcileWeekProgram` (`src/engine/weekProgramReconciliation.ts`) has always correctly protected **locked** days (a real completed/in-progress workout exists for that date) — their persisted `program_sessions.snapshot_json` is never rewritten, no matter what a fresh computation says. This part was and remains correct.

The defect was in the **aggregate**: `programs.target_allocations_json` was persisted verbatim from `aggregates.targetAllocations` — the caller's `computeFreshWeek()` result, itself `buildWeeklyProgrammingPlan`'s own blind, in-memory `sessions[]`. That in-memory plan has **zero awareness of locking** — it happily constructs a full hypothetical week from scratch, using whatever real exposure/history exists as of the call's own `historyAsOfDate`, and describes candidate work for every gym day as if none of it were already fixed in place. `reconcileWeekProgram` then discards that hypothetical content for any locked day (correctly) — but still persisted the hypothetical run's own aggregate summary, unconditionally, every time.

**Production evidence** (2026-09-07 to 2026-09-13, a week where every one of the 4 real gym days later became locked by a real completed workout): a systematic cross-check of every target with a real requirement found **19 of 24 real mismatches** between what `target_allocations_json` claimed and what was actually sitting in `program_sessions`:

| target | alloc says delivered | actually delivered (real persisted sessions) |
|---|---|---|
| triceps (specialization) | 0 | 6 |
| triceps-long-head (specialization) | 0 | 4 |
| gluteus-maximus (normal) | 0 | 8 |
| back-thickness (normal) | 0 | 5 |
| upper-pec, upper-traps | 4, 4 | 4, 4 — matched, plausibly coincidental |

The pattern affected specialization and normal-development targets identically, ruling out goal-handling logic as the cause, and affected nearly every muscle group simultaneously — a signature consistent with a whole-week structural defect, not a per-target one. The Cross-Week Programming Intelligence Fix reads exactly this `unmetDirectSets` value as real backlog (`workoutBuilder.ts`'s `carryoverByTarget`), so it faithfully propagated the corrupted numbers into the next week's `desiredWeekly` — the mechanism itself was never at fault; its input was.

Ruled out explicitly: eligible-session detection (correct), muscle/session mapping (correct), allocation objects not consumed (they were — by the discarded hypothetical run), exercise selection failure (ran fine, just for the wrong scenario), dedup/capacity filtering (no evidence), specialization-goal-specific handling (affects both goal and non-goal targets identically), and anything AI-related (this entire path is deterministic; no provider call occurs here).

## Fix

`rebuildTargetAllocationsFromFinalSessions` (`workoutBuilder.ts`) — the one existing, already-correct function that derives `WeeklyPlanTargetAllocation[]` from real session content — is now:
1. **Exported** (was module-private), with its parameter narrowed to only the two fields it reads (`date`/`plannedWork`), so a second caller can reuse it without needing a full `WeeklyPlanSession`.
2. **Called a second time** inside `reconcileWeekProgram`, after its own locked-day-preservation loop finishes, against the week's real **final** persisted sessions (re-read via `repo.getByWeekStart`) — never against the discarded hypothetical run.

`requiredDirectSets`/`layer` per target are still taken from the fresh computation — those describe what the target/goal needs this week (a function of `desiredWeekly` + carryover), not which specific day ends up delivering it, so reusing them is correct. Display-only enrichment fields (`target_name`/`goal_id`/`goal_label`, added by `programming.ts`'s `computeFreshWeek`) are carried over by key onto the corrected allocation, since they describe the target/goal itself and don't depend on delivery.

### Changed
- `src/engine/workoutBuilder.ts`: `rebuildTargetAllocationsFromFinalSessions` exported, parameter type narrowed.
- `src/engine/weekProgramReconciliation.ts`: `reconcileWeekProgram` re-derives `targetAllocations` from the real final sessions before calling `repo.updateAggregates`.

### Regression proof — locked and partially locked weeks

`tests/engine/targetAllocationsAggregateIntegrity.test.ts` (new), calling `reconcileWeekProgram` directly with hand-built fixtures:
- **Fully locked week**: genesis delivers 5 real sets; the day is then locked; a later hypothetical run claims 0 delivered — the persisted aggregate now correctly shows `deliveredDirectSets: 5`, `unmetDirectSets: 5` (never the bogus 0/full-required).
- **Partially locked week**: one locked day (5 sets, preserved) + one unlocked day genuinely rewritten (4 sets) — the aggregate correctly sums both real contributions (9), with `allocatedSessionDates` spanning both real dates.
- **Unlocked, unchanged week**: confirms a stale/wrong fresh aggregate (999) never leaks through when the real content didn't change.
- **Zero-delivery target**: confirms a target that genuinely got nothing still gets a real, explicit zero entry (never silently dropped).

Verified genuinely discriminating: reverting the fix fails 3 of these 4 tests with the exact production signature (`0` instead of `5`, `4` instead of `9`, `999` leaking through unchanged).

One regression surfaced and fixed during this work: `tests/routes/programming.test.ts`'s "Goal 1's own priority survives" test failed because the rebuilt allocation initially dropped `goal_label`/`target_name`/`goal_id` — fixed by the display-metadata carry-over described above.

Full suite baseline-diffed against the session's established 229 pre-existing (stale-calendar-date) failures: zero new failures, before and after the display-metadata fix.

## Answers to the specific questions asked

- **Legitimate prioritization?** No — a real priority scheme would show a principled pattern; near-uniform zeros across unrelated muscle groups, contradicted by the real calendar, is not that.
- **Accidental bug?** Yes, confirmed and fixed as above.
- **Why so many unrelated targets at once?** The defect is at the whole-week aggregate level (triggered once any day locks), not target-specific — hence it touches everything simultaneously.
- **Was the cross-week fix amplifying an upstream problem?** Yes — the carryover mechanism itself worked exactly as designed; it faithfully propagated whatever `unmetDirectSets` it was given. It was given corrupted data.

## What remains (not done as part of this fix)

- The production week of 2026-09-07–13 (now fully in the past, fully locked) still has its **old, stale** `target_allocations_json` — this fix corrects the code going forward but does not retroactively repair already-persisted aggregates. No existing HTTP route can trigger `reconcileWeekProgram` for a past week (`PUT /week/days/:day/activity` and the AI reconcile-week endpoint both operate only on the current/future week). Fixing this week's own aggregate — and therefore giving 2026-09-14's carryover the corrected backlog — requires a one-off, direct invocation of `computeFreshWeek`+`reconcileWeekProgram` for that specific past week. Since every one of its days is locked, this is provably content-safe (no `program_sessions` row can change), but it bypasses the normal API surface, so it's called out separately for explicit approval before being run against production.
- The four history-lookback windows this investigation surfaced are recorded as open design consideration item 24 in `docs/open-decisions.md` — deliberately not redesigned as part of this fix.
