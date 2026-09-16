# Exercise-Slot-Consumption Fix + Non-Goal Muscle Rotation — Implementation Report

## Why

Two limitations were explicitly flagged as deferred, unfixed work in the previous
report (`docs/GOAL_CATEGORY_CONFLICT_AND_CAP_INCREASE_FIX_REPORT.md`):

1. Raising the session muscle cap to 7 gave more headroom but did not fix the
   underlying **greedy exercise-slot-consumption bug** in `applySessionRealismCap`
   — a legitimate top-N muscle could still be excluded ENTIRELY from its own
   session just because muscles ranked ahead of it happened to need 2-3
   exercises each and exhausted the 9-exercise budget first.
2. The user's own **non-goal muscle rotation design** (goal muscles keep
   existing priority-based selection; non-goal muscles rotate through a fixed
   sequence so the same ones never dominate forever) was approved but never
   implemented.

The user asked for both to be implemented now, committed immediately, with a
report and log per the session's established convention.

## Fix 1 — Exercise-Slot-Consumption Starvation Fix

**`src/engine/workoutBuilder.ts`, `applySessionRealismCap`**: previously, once a
target's own full exercise group didn't fit the REMAINING exercise budget, the
ENTIRE group was deferred (all-or-nothing). Now: if the muscle-count ceiling
isn't reached and at least one exercise slot remains, the target's own group is
TRIMMED to however many of its own exercises fit — never split mid-exercise
list arbitrarily, always keeping the group's own natural (already priority-
ordered) first N entries. A target only gets zero exercises (and a real
`session_realism_cap` skip) when the muscle-count ceiling is already reached,
or literally zero exercise slots remain.

`sessionRealismSkipsFor` was updated to accept the `kept` list alongside
`deferred`, and now excludes any target_id that appears in `kept` at all — a
partially-trimmed target already has real `plannedWork`, so giving it a skip
entry too would violate `assertNoContradictoryProgramState`'s own invariant (a
target cannot be both programmed and marked skipped). Its reduced volume
becomes real, traceable `unmetDirectSets` automatically, exactly like any other
under-delivered target — no new bookkeeping required.

This is the real fix for the `triceps-long-head` starvation case reported
earlier this session: that muscle was correctly ranked in the top-N the whole
time (confirmed via direct debug instrumentation in the prior investigation)
but could be zeroed out by whichever muscles happened to rank just ahead of it
needing more exercises than expected. It now receives its fair partial share
instead.

**Verification**: `tests/engine/sessionRealismCap.test.ts` gained a new test
using the exact previously-documented "known limitation" fixture
(`current_weekly_primary_sets: 0`, 9 competing targets) — empirically confirmed
`rectus-abdominis` is the target whose full need (3 exercises, verified via an
isolated build with the full budget) doesn't fit the remaining budget once
`lower-pec`/`mid-pec`/`obliques` are placed ahead of it; it now receives 1 real
exercise instead of zero, with real, non-zero `deliveredDirectSets` and no
contradictory skip entry.

## Fix 2 — Non-Goal Muscle Rotation

Per the user's own design: "Goal muscles: continue using the existing
priority-based selection. Non-goal muscles: use a rotating sequence so the
same non-goal muscles cannot repeatedly dominate while another eligible
non-goal muscle is continually ignored," with the concrete example "A,B → C,A
→ B,C → repeat, cycling forever, never resetting to A on a new week or
regeneration."

### Where the tie-break actually lived

`compareRankings`'s existing sort order is: tier → needDeficit (normal-
development) / days-since-trained (maintenance) → recoveryNeed → `target_id`
alphabetical (the FINAL fallback, only reached once 1-3 are genuinely tied).
The real starvation mechanism this rotation targets is specifically that final
tie: several untouched `maintenance` targets (all `days_since_target_last_trained:
null`, no recovery caution) tie exactly, and the alphabetical fallback picks
the same early-alphabet subset every single week forever. This is a narrow,
surgical replacement of ONE existing tie-break rule — never a new fairness
mechanism, never touching needDeficit/recoveryNeed/tier, and never affecting
goal (specialization) muscles at all (they keep the exact same alphabetical
tie-break they always had, per the user's explicit "goal muscles: continue
using the existing priority-based selection").

### The ring and the tie-break value

`buildWeeklyProgrammingPlan` builds a fixed, alphabetically-sorted ring of
every non-goal `physique_target` id present in `input.targets` for this run
(which already includes every real Blueprint physique target not currently
claimed by an active goal). Each target's `rotationTieBreak` is its ring
position relative to the current cursor: `(ringIndex - cursor + N) % N`,
`N = ring.length`. Sorting ascending by this value starting from the cursor
reproduces the user's own example exactly:

- cursor 0 → order A,B,C (identical to the OLD pure-alphabetical order —
  every pre-existing fixture/test that never heard of rotation is unaffected)
- cursor 2 (after a 2-slot generation from 0) → order C,A,B
- cursor 1 (after another 2-slot generation from 2) → order B,C,A

`WeeklyPlanInput.nonGoalRotationCursor` (optional, defaults to 0) carries the
cursor in; `WeeklyProgrammingPlan.nonGoalRotationCursorAfter` carries the
advanced value out — advanced by the count of DISTINCT non-goal physique
targets that actually received real `plannedWork` this run (never by how many
were merely ranked), wrapped against the ring size.

### The real subtlety: regeneration stability

A week's plan is not generated exactly once — it can be regenerated multiple
times for the SAME `weekStart` (an activity-override reconciliation, an
actual-training adaptation pass). The very first implementation naively
persisted a single rolling cursor, advanced every time `computeFreshWeek` ran.
This broke immediately: two existing regression tests
(`tests/routes/weekActivityOverride.test.ts` Test 1,
`tests/routes/weekProgramPersistence.test.ts` §22.1) failed because an
UNRELATED day's activity change triggered a second `computeFreshWeek` call for
the same week, which read the cursor its OWN first generation had already
advanced to — silently re-ranking an unaffected day's non-goal composition and
violating the future-plan-stability guarantee
`weekProgramReconciliation.ts`'s `corePrescriptionEqual` exists to protect.

**Fixed** by redesigning `NonGoalRotationRepo` around per-week state rather
than a bare rolling counter: it stores which `weekStart` was most recently
generated, the cursor value THAT week used (`cursorUsed` — read back
byte-for-byte by every regeneration of the same week), and the value to hand
to the next, genuinely different week (`cursorAfter`). `cursorFor(userId,
weekStart)` returns `cursorUsed` if `weekStart` matches the stored one,
`cursorAfter` otherwise. Only `computeFreshWeek`'s detection of "this
`weekStart` differs from whatever is currently stored" (i.e., a genuinely new
week) calls `recordGeneration` — a regeneration of the same week never writes
anything, so `cursorFor` keeps returning the original value indefinitely.

**Known, deliberate, documented limitation**: only the single most recently
generated week is remembered, not a full per-week history. Regenerating an
OLDER week after a NEWER one already exists reads as "new" relative to
whatever is currently stored and rolls forward from the newer week's own
`cursorAfter`, not that older week's original value. In normal usage this
never occurs (a week is generated once, then only ever regenerated relative to
itself before the next real week begins) — this is the one gap the
user's own "simple rotation approach, no backlog/history table" explicitly
accepts, not an oversight. Documented in the repo's own doc comment and a
dedicated test.

### New persisted state

`non_goal_rotation_state` table (`user_id` PK, `week_start`, `cursor_used`,
`cursor_after`, `updated_at`) — additive, new table, safe on an existing
database. `src/repositories/nonGoalRotationRepo.ts` (new). Read by
`assembleWeeklyPlanInput` (every planner call, so a plain GET/AI-context build
always ranks consistently with the last real regeneration); written only by
`computeFreshWeek` (`src/server/routes/programming.ts`) — the one real "a new
week program was generated" boundary.

## Verification

- `npm run typecheck`: clean.
- Full suite, baseline-diffed against the last commit's own known-failure
  snapshot (230 pre-existing failures): **zero new failures, zero fixed
  failures — an exact match**. Every previously-passing test still passes.
- 18 new tests, all passing:
  - `tests/engine/sessionRealismCap.test.ts` — 1 new test proving the
    starvation fix directly (empirically verified against the real fixture
    that previously demonstrated the limitation).
  - `tests/engine/nonGoalMuscleRotation.test.ts` (new, 7 tests) — the exact
    A,B → C,A → B,C example reproduced against real `buildWeeklyProgrammingPlan`
    output; goal muscles proven unaffected; ring-wrap correctness;
    `nonGoalRotationCursorAfter` advancement; default-cursor backward
    compatibility.
  - `tests/repositories/nonGoalRotationRepo.test.ts` (new, 6 tests) — the
    per-week stability contract, the rolling-forward-across-weeks contract,
    and the one documented limitation, all directly verified.
- The two stability regressions found mid-implementation
  (`weekActivityOverride.test.ts`, `weekProgramPersistence.test.ts`) are
  confirmed passing again after the per-week redesign.

## Deployment

Committed to the repo per explicit instruction, overriding the usual
wait-for-approval step for this batch. **Not deployed** — deployment to
production was not requested.
