# Weekly volume planning (design, awaiting owner approval)

Status: DRAFT 2026-10-25. No code changed yet.

## Problem (found 2026-10-25 from production data, 10-04 to 10-25)

Owner: "the model is trying to cover every possible muscle on each given
day ... I want it to think like a trainer or a coach." The data agrees:

- `sessionPlanner.ts` (deterministic, applied to generation) picks the
  day's muscles and reserves exercise slots before the AI is called. The
  AI only fills in exercises, and adequacy completion adds back any
  planned muscle left short. Prompt rule 13 already tells the AI to be
  selective, but the plan overrides it.
- The planner ranks by weekly need (`rankTarget`: share of the weekly
  reference still unmet), then takes every muscle that fits, until the
  10-exercise cap. It never asks whether a later compatible session this
  week could take the muscle. So each Push day plans all three pecs and
  both delts: 10 slots on 10-19 and 10-20.
- The 10-exercise cap acts as the target, not a ceiling. The profile's
  60 min default and 90 min max are not used by the planner.
- Indirect work counts in weekly exposure (secondary 0.33,
  `exposureEngine.ts`), but in-session planning counts only direct sets
  (a muscle's own label), so every planned muscle needs its own exercise.
- Abs (core region) come last (accessory tier). With the 2-abs-exercise
  cap and 2 exercises needed per abs muscle, only one abs muscle fits a
  day. Obliques win the alphabetical tie, so rectus abdominis has been
  deferred in every plan logged (10-05 to 10-23). Abs per week (planned
  sets): 4, 9, 9, 4, 4, 4.

## Owner principles (2026-10-25)

1. Growth decides the numbers: each muscle has a weekly set target
   (growth for goals, at least maintenance for the rest). Frequency is
   not a goal in itself.
2. How a muscle's weekly number is spread across the week is free: both
   Push days, one of them, or uneven. Abs likewise; not every day.
3. Direct and indirect work both count.
4. The AI should make the coach's choice of what goes on which day.

## Design

### 1. Weekly ledger (deterministic, new `planning/weeklyLedger.ts`)

For every target, computed each time a session is planned:

- `weeklyTarget`: goal = the Complete package reference (unchanged);
  non-goal = see decision D1.
- `doneSoFar`: this week's logged exposure (direct 1.0 + secondary 0.33,
  the existing `weekly_exposure_units`), plus planned-but-not-yet-done
  days earlier in the week (existing `projectedExposure.ts`).
- `remaining = max(0, weeklyTarget - doneSoFar)`.
- `laterCapacity`: sum over the week's later gym days whose purpose can
  train this target (`eligibleForThisSession` rules, injury pause and
  recovery applied) of Blueprint's per-session max
  (`directSetsPerExposureCap`).
- Status today:
  - `must`: a goal muscle (D2), or `remaining > laterCapacity` (it can't
    wait).
  - `can_wait`: remaining > 0, but later sessions can hold it.
  - `met`: remaining = 0.
  - `not_today`: ineligible for today's purpose (unchanged).

On the last compatible day of the week every `can_wait` becomes `must`.
Skipped or extra sessions are handled automatically: the ledger is
rebuilt from what was actually logged.

### 2. Session planner

- `must` muscles are reserved exactly as today: floor, slots, refusal if
  impossible.
- `can_wait` muscles no longer get slots reserved. They are offered to
  the AI as options, with their remaining sets and per-session max.
- The abs-specific ordering goes away: obliques and rectus abdominis are
  ordinary targets in the ledger. A muscle can be deferred only while
  later capacity exists, so the alphabetical starvation ends. The
  2-abs-exercise cap per session stays.
- Session size: at most 10 exercises (unchanged hard cap), and an
  estimated duration of at most the profile maximum (90). The AI aims for
  the profile default (60). Duration is estimated from sets and rest with
  the same scaling `programmerContextBuilder.ts` already applies with
  `budgetMinutes`.

### 3. AI's job (prompt rule 13 rewritten around the ledger)

Include every `must` muscle. From the `can_wait` list, choose which
muscles to train today and with how many sets, like a coach: recovery,
what the next session of this type can take, variety, the user's logs and
notes. Credit indirect work: e.g. presses count toward front delts and
triceps, so they may need fewer direct sets. Name each `can_wait` muscle
left for later in `programmingRationale`, with the day it moves to.

### 4. Checks (validators)

- Every `must` muscle meets its floor (unchanged rule, smaller set).
- No muscle exceeds Blueprint's per-session max (unchanged).
- Size within 10 exercises and the estimated profile maximum minutes.
- A `can_wait` muscle the AI leaves out is fine. If the AI includes one,
  it must get meaningful work (the existing meaningful-coverage minimum),
  not a token set.
- Adequacy completion tops up `must` muscles only; it no longer adds
  back `can_wait` muscles.
- After commit, the ledger is recalculated. If a muscle's remaining need
  can no longer fit in the rest of the week, it is shown as "short this
  week" on the session and in Insights; it is never silently dropped.

### 5. Indirect credit inside the session

The ledger counts secondary work (0.33) from exercises planned today,
both in `remaining` for later days and in the AI's options list (so the
AI sees "front delt: 6 left, today's presses already give about 2").
Floors for `must` muscles stay direct-set floors.

## Owner answers (2026-10-25)

- D1: (a) keep the Efficient numbers for non-goals. Owner noted the
  numbers so far look no different from before the project, goals
  included, and expected goals to be higher. Capacity check below sent
  back for confirmation.
- D2: goal muscles on every suitable day.
- D3: aim for 60 min, never over 90.

Capacity check (Blueprint references, `getDevelopmentReference`): goals
at Complete = triceps 24/wk, brachialis 8/wk. Non-goals at Efficient =
push muscles 52/wk, pull muscles 72/wk, forearms about 24/wk, core 32/wk
per abs target (looks too high; flagged for Blueprint). Real sessions:
median 20.5 sets in about 64 min, so 4 x 60 min is about 85-90 hard sets
a week, against about 240 sets of references.
Delivered 10-19 week: triceps about 7-10 direct, brachialis 5 (goals at
roughly a third of their reference). Goals get crowded out by covering
every muscle at its minimum.

### Owner rule, 2026-10-25: two-week cycle for non-goal muscles

- Goal muscles: Complete package number per calendar week (unchanged).
- Non-goal muscles: the same Efficient number, but it is due over a
  cycle of up to 14 days instead of 7. Each muscle has its own cycle.
  The moment its number is reached (direct + 0.33 indirect), a new cycle
  starts for that muscle, even mid-week (e.g. reached in 3 sessions, so
  the next cycle starts then).
- In the ledger, "later capacity" for a non-goal muscle runs to the end
  of its own cycle, not the end of the week.
- Load: goals 40/wk; non-goals 148 per 2 weeks = 74/wk; abs 64 per
  2 weeks = 32/wk (Blueprint's core number, flagged). Total about 146/wk,
  or about 115/wk if the abs number is corrected, minus some indirect
  credit. 60 min holds about 85-90/wk, so cycles can still run past
  14 days.
- Proposed overrun handling (to confirm): a cycle that reaches day 14
  unfinished keeps counting until its number is reached (the shortfall is
  not wiped). The most overdue muscles (lowest share done relative to time
  elapsed) are offered first. Weekly report shows each muscle's cycle
  progress.

## Open decisions for the owner

- D1. Non-goal weekly number. Blueprint defines growth ranges and says
  "adjust ... whether the target is a priority or a maintenance area", but
  gives no maintenance number. Options: (a) keep the Efficient package
  reference (current behaviour, a development number); (b) a maintenance
  floor of about one third of it (research: about 1/3 of growth volume
  maintains size), with the rest filled only if there is room.
  Recommended: (b).
- D2. Goal muscles on every compatible day (as now), or ledger-driven
  like the rest. Recommended: every compatible day; the owner said this
  is fine for triceps.
- D3. Aim for the profile default (60 min) and never exceed the max (90).
  Recommended as written.

## Rollout

1. Build behind a flag (`AI_WEEKLY_LEDGER_MODE=off|shadow|on`). In
   `shadow` the current planner still drives generation, and the ledger
   plan is logged beside it (like `session_plan_shadow`).
2. Tests: ledger maths, last-day promotion, skipped-day, indirect credit,
   abs rotation, size limits, validators, adequacy completion. Full suite
   stays at 0 new failures.
3. Shadow for one real week. Compare per day: muscles, slots, abs,
   estimated minutes, weekly totals reached.
4. Switch to `on` with owner approval. Backup and deploy per the usual
   steps; decision log section and change log.
