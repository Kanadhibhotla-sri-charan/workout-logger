# 2026-09-04 — Current-Week Activity Overrides & Program Reconciliation

## What changed

Per `docs/CURRENT_WEEK_RECONCILIATION_SPEC.md`, fixed a real gap in the
prior phase's Gym/Badminton/Both/Unselected feature: changing a day's
activity from the weekly Program page was silently editing the user's
**recurring** Training Profile default, not a temporary current-week
change. A real-life "Saturday is normally Badminton, but this week I'm
also hitting the gym" edit would have permanently changed every future
Saturday too.

Added a new, minimal `week_activity_overrides` table
(`training_profile_id`, `week_start`, `day`, `activity`) — entirely
separate storage from the recurring profile — and a new focused endpoint,
`PUT /api/programming/week/days/:day/activity`, that writes to it instead.
`program.html`'s "Change activity" control on the Program page now calls
this endpoint (with copy clarifying "this changes only the current week"),
while the Profile page's full-form save is still the only thing that edits
the recurring default.

## Why no "reconciliation" logic was needed

Traced how `programs`/`program_sessions` are persisted first, per the
spec's own instruction — confirmed (again) they're legacy and unused by
the live path: `/week` and `/today` always recompute the entire plan live
from the profile + goals + real logged history on every request, nothing
about a generated plan is ever stored. So "reconciling the current week"
reduces to: feed the read path a different, week-scoped INPUT (this
week's effective Gym/Badminton/Both/Unselected schedule = profile default
with this week's overrides layered on top) instead of the raw profile —
the very next read is automatically the reconciled result, and completed
`WorkoutSession` history (a fully separate table) is never at risk.

A single pure function, `applyWeekOverrides` (`src/lib/dailyActivity.ts`),
does that layering; it's shared by the recurring-profile write path
(`TrainingProfileRepo.setDailyActivity`, refactored onto it — no behavior
change) and the new current-week read/write path
(`assembleWeeklyPlanInput`, `/week`, `/today`, the new PUT endpoint), so
the two can never compute "what does this day mean" differently. The
actual programming engine (`buildWeeklyProgrammingPlan`, `buildWorkout`,
`frequencyEngine`, `exerciseSelector`, ...) was not touched — it still
just consumes whatever Weekday sets it's handed.

## A real display bug fixed along the way

`/week` and `/today`'s `type`/`activity`/`sessionType` fields were still
reading the raw profile schedule for display, even after
`assembleWeeklyPlanInput` correctly started consulting the current-week
override for the engine's own eligible-day computation. Without this fix,
a current-week override would have correctly changed which days got real
gym sessions while the UI's day labels kept showing the stale profile
default. Both routes now derive `type`/`activity`/`sessionType` from the
same effective (override-applied) schedule the engine itself used.

## New tests

`tests/dailyActivity.test.ts` — 17 new tests for `applyWeekOverrides` (all
12 transitions, day/data isolation, purity, both Map and array override
input forms). `tests/weekActivityOverridesRepo.test.ts` — 8 new tests
(storage, upsert, per-week isolation, persistence, separation from the
profile). `tests/routes/weekActivityOverride.test.ts` — 24 new HTTP-level
tests covering all six required spec test groups (future-plan stability,
profile-unchanged, Gym→Both, Rest→Gym, completed-history protection, all
12 transitions) plus validation and the "one round trip" reconciliation
property. `tests/frontend/dailyActivityUI.test.ts` updated to assert
`program.html` now calls the new endpoint (never the old recurring-profile
one) and shows the current-week clarifying copy.

One of the "future-plan stability" tests initially asserted byte-identical
`plannedWork` for an unaffected day and genuinely failed — correctly: the
existing "normal development" layer's explainability metadata accurately
updates to describe a changed eligible-day count, which is desired
behavior, not instability. The test was corrected to compare only the
stable prescriptive fields (exercise/sets/reps), which is what the spec
actually asks to stay stable.

## Verification (real commands, real output)

```
$ npm run verify
 Test Files  54 passed (54)
      Tests  556 passed (556)
```

556 = 506 pre-existing (unchanged) + 50 new.

A real Playwright-driven browser smoke test (Chromium, against a running
`npm run dev` instance, fresh database) proved the exact property this
phase exists to deliver: saved a profile with Saturday=Rest, changed
Saturday to Badminton via the Program page's current-week control,
confirmed the Profile page still showed Saturday=Rest on a separate page
load, confirmed the Program page still showed Badminton after a full
reload, then changed it back. 10/10 checks passed. Full details in
`docs/CURRENT_WEEK_RECONCILIATION_REPORT.md`.

## Stop condition

Per the spec's own §17, no deployment was performed as part of this task.
