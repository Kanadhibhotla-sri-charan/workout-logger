# AI Weekly Programmer (generate_week) and three-role UI

**Commit:** `ebe8e6b` (merged in `e03801a`), 2026-09-23.

## What changed
- New `generate_week` AI role with its own contract, context builder,
  output schema and validators (a sibling of `reconcile_week`, not a
  reuse). `AIProgrammerService.generateWeek(weekStart)` returns the same
  shape as `computeFreshWeek`, so persistence is shared.
- `GET /week` and `/today` first-time generation went through one new
  decision point (`computeFreshWeekOrAI`) when `AI_PROGRAMMER_ENABLED`,
  never silently falling back to the deterministic planner after an AI
  failure. (Superseded on 2026-10-01 by explicit week generation, log 80.)
- Program page: "Generate this day with AI" names the exact day and says
  the other days stay unchanged; "Reconcile remaining week" shows a real
  before/after diff per changed day; day modal reordered (day info, then
  day actions, then week-wide actions).
- Day-swap investigation: a new HTTP-level test for swapping an
  AI-committed day with a Rest day; no defect reproduced, so no swap code
  changed.

## Deliberate boundary
The goal-completion repair is not wired into `generate_week` (its
context has no `decideVolume`).

## Verified
Typecheck/build clean; full suite at the then-current date-rot baseline.
