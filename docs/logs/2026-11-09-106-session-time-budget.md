# 106 · Session time budget (step 3: minutes)

Date: 2026-11-09 · Status: deployed 2026-11-09 (fc8af95, backup pre-fc8af95-20261109T070049Z.sqlite)

## Why
Logged sessions ran 85-97 min (2 Nov 85, 3 Nov 95, 6 Nov 97, 9 Nov 95)
against the profile's 60-min aim and 90-min maximum, and nothing decided
what gives way. Owner's order (2026-11-05/09): the add-on first, then
flexibility down to 5 min, then other muscles; goal sets never cut.

## How
src/ai-programmer/planning/sessionTime.ts (pure), applied in
withWeeklyLedger before the plan:
- due sets (goal + other "must") x MINUTES_PER_SET 3.5 (owner's logs: 2.9
  to 4.7 min per set, rest included) + flexibility + add-on + shoulder care
- over the aim: drop the add-on; then shorten flexibility (re-planned with
  a smaller time box, never under 5 min); then "can wait" muscles get only
  the minutes left (liftSetBudget, read by the planner's can-wait fill)
- over the maximum: set reductions on non-goal "must" muscles, largest first
- goal sets and shoulder care are never cut
- the brief carries `sessionTime` (estimate and the cuts, in words); the
  service attaches the add-on and the flexibility block as decided.

## Dry run (production copy)
Tue 10 Nov Pull: about 61 min; flexibility 11 -> 8 min; can-wait muscles
(forearm extensors, abs) left to Friday.
