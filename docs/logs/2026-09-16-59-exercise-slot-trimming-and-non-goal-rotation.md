# 2026-09-16 — Exercise-Slot-Consumption Fix + Non-Goal Muscle Rotation

Commit (this entry's own). Full detail in
`docs/EXERCISE_SLOT_TRIMMING_AND_NON_GOAL_ROTATION_FIX_REPORT.md`. Follows
directly from log entry 58, closing its two explicitly deferred items.

## Why

Entry 58 flagged two unfixed limitations: raising the session muscle cap
to 7 didn't fix the underlying greedy exercise-slot-consumption bug that
could still zero out a legitimate top-N muscle, and the user's own
non-goal-muscle rotation design (approved earlier in the session) was
never implemented. The user asked for both now.

## What changed

- `src/engine/workoutBuilder.ts`, `applySessionRealismCap`: a target
  whose own exercise group doesn't fully fit the remaining budget is now
  TRIMMED to however many of its own exercises fit, instead of being
  excluded entirely — a target only gets zero exercises when the
  muscle-count ceiling is already reached or no slots remain at all.
  `sessionRealismSkipsFor` now excludes any partially-kept target from
  the cap-skip list (it already has real plannedWork; giving it a skip
  too would violate `assertNoContradictoryProgramState`).
- `compareRankings`'s final alphabetical tie-break is now
  rotation-based for two NON-goal targets only — goal (specialization)
  targets keep the exact same alphabetical tie-break unchanged, per the
  user's own "goal muscles: continue using existing priority-based
  selection." The rotation ring is every non-goal physique target
  present in a run, sorted alphabetically; `rotationTieBreak =
  (ringIndex - cursor) mod N` reproduces the user's own "A,B → C,A →
  B,C → repeat" example exactly.
- `WeeklyPlanInput.nonGoalRotationCursor` (in, optional, default 0) /
  `WeeklyProgrammingPlan.nonGoalRotationCursorAfter` (out) thread the
  cursor through the pure engine.
- New `non_goal_rotation_state` table + `src/repositories/
  nonGoalRotationRepo.ts`: stores which week was most recently
  generated, the cursor it used, and the cursor for the next week.
  Read by every planner call; written only by `computeFreshWeek`
  (`src/server/routes/programming.ts`) when it detects a genuinely new
  `weekStart` — never on a regeneration of the same week.

## A real stability bug caught mid-implementation

A naive single rolling-counter cursor broke two existing tests
(`weekActivityOverride.test.ts` Test 1, `weekProgramPersistence.test.ts`
§22.1): regenerating a week for an unrelated day's activity change read
the cursor that week's OWN first generation had already advanced to,
silently re-ranking an unaffected day's non-goal composition. Fixed by
redesigning the repo around per-week state (`cursorUsed`/`cursorAfter`)
so every regeneration of the SAME week reads back its own original
cursor, and only a genuinely different `weekStart` rolls forward.
Documented, deliberate limitation: only the single most-recently
generated week is remembered, not a full history — regenerating an
older week after a newer one already exists is a narrow, accepted gap
(see the repo's own doc comment and test).

## Verification

`npm run typecheck` clean. Full suite baseline-diffed against the last
commit's own known-failure snapshot: exact match, zero new failures,
zero regressions. 18 new tests added across
`tests/engine/sessionRealismCap.test.ts` (+1),
`tests/engine/nonGoalMuscleRotation.test.ts` (new, 7), and
`tests/repositories/nonGoalRotationRepo.test.ts` (new, 6) — all passing,
directly proving the starvation fix and the exact rotation example.

## Not yet deployed

Committed per explicit instruction overriding the usual wait-for-approval
step for this batch. Deployment to production was not requested.
