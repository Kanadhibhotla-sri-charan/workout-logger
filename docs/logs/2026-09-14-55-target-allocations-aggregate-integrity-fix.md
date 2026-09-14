# 2026-09-14 — `target_allocations_json` Aggregate-Integrity Fix

Commit (this entry's own). Full detail in
`docs/CROSS_WEEK_AGGREGATE_INTEGRITY_FIX_REPORT.md`. Follows directly
from log entry 54 (the Cross-Week Programming Intelligence Fix) — this
entry fixes a pre-existing, separate bug that entry's own carryover
mechanism exposed once deployed.

## Why

After regenerating the production week of 2026-09-14 with the
cross-week fix, Tuesday Push barely improved (19 exercises/139.6 min,
vs. the original bug's 19/135.2). Investigation found the immediately
preceding week (2026-09-07–13) had every one of its 4 real gym days
locked by a real completed workout, and its persisted
`target_allocations_json` showed `deliveredDirectSets: 0` for the
large majority of targets despite their real, displayed sessions
clearly containing that work (e.g. triceps: alloc said 0, really
delivered 6). `reconcileWeekProgram` was persisting the aggregate from
`buildWeeklyProgrammingPlan`'s own blind, in-memory recomputation —
which has no awareness of locking — rather than from what its own
locked-day-preservation loop actually kept on the calendar. The
cross-week fix then correctly, faithfully carried this corrupted
"unmet" backlog forward.

## What changed

- `src/engine/workoutBuilder.ts`: `rebuildTargetAllocationsFromFinalSessions`
  exported (was module-private), parameter narrowed to the two fields
  it reads.
- `src/engine/weekProgramReconciliation.ts`: `reconcileWeekProgram` now
  re-derives `targetAllocations` a second time, against the week's real
  final persisted sessions (re-read after its own reconciliation loop),
  instead of persisting the discarded hypothetical run's own aggregate.
  `requiredDirectSets`/`layer`/display metadata are carried over from
  the fresh computation, since those describe the target/goal itself,
  not which day delivers it.
- `tests/engine/targetAllocationsAggregateIntegrity.test.ts` (new):
  proves the fix for a fully-locked week, a partially-locked week, an
  unlocked-unchanged week, and a genuinely-zero-delivery target — all
  four confirmed genuinely discriminating (3 fail against the pre-fix
  code with the exact production signature).

## Verification

`npm run typecheck` / `npm run build` clean. Full suite baseline-diffed
against the session's established 229 pre-existing failures: zero new
failures. One incidental regression (a display-metadata field —
`goal_label`/`target_name`/`goal_id` — dropped by the rebuilt
allocation) was caught by the existing route-level test suite and
fixed by carrying that metadata over from the fresh computation by key.

## Recorded, not acted on

Four different history-lookback windows across the programming
pipeline (14-day rolling, current-calendar-week-only volume, AI's
further-truncated-to-3 exercise history, and the cross-week fix's own
1-week-back carryover bound) were audited from the actual code as part
of diagnosing this issue. Recorded as open design consideration item 24
in `docs/open-decisions.md` — explicitly not redesigned as part of this
fix.

## Not yet done

The production week of 2026-09-07–13 still holds its OLD, stale
`target_allocations_json` — this fix corrects the code going forward
but does not retroactively repair it. No existing route can reconcile
a past week (`PUT /week/days/:day/activity` and AI reconcile-week both
reject past target dates). Repairing that specific week's aggregate —
needed so 2026-09-14's own carryover reads the corrected backlog —
requires a one-off direct invocation of `computeFreshWeek`+
`reconcileWeekProgram` against that past week. Every one of its days is
locked, so this is provably content-safe (no `program_sessions` row can
change, only the aggregate), but it bypasses the normal API surface and
is therefore called out for separate explicit approval before running
against production.
