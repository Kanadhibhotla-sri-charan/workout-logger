# 2026-09-04 — Blueprint Exercise Picker + Per-Day Training Activity

## What changed

Two related product fixes per `docs/BLUEPRINT_PICKER_AND_DAILY_ACTIVITY_SPEC.md`
(the full spec text, saved verbatim to the repo per this session's
established practice).

**1. Add Unplanned Exercise — real searchable picker (Feature A).**
`public/logger.html` previously used a native `<input list>` +
`<datalist>` for picking a Blueprint exercise to add outside the
generated plan — unreliable dropdown behavior across
browsers/platforms, even though the backend's Blueprint-id validation
was already correct. Replaced with `createBlueprintExercisePicker`
(new, `public/app.js`): a real search input + results list over the
complete Blueprint library (case-insensitive substring match, no
relevance/muscle/goal filtering, capped at 50 rendered results),
requiring an explicit click-to-select before the "Add exercise" button
enables, with a distinct "Selected: X (Blueprint)" indicator and a "No
Blueprint exercises found." empty state. The separate,
equipment/target-aware Substitute flow (`openSubstitutePicker`) was not
touched.

**2. Per-Day Training Activity — Gym/Badminton/Both/Unselected
(Feature B).** Every weekday is now an explicit one of four states,
editable both from the Profile page (a new unified weekly-schedule
picker replacing the old disconnected "Training days" multi-select +
free-text "Recurring activities" list) and, per-day, directly from the
weekly Program page's day modal (a new "Change activity" control).
This is a *derived* model (`src/lib/dailyActivity.ts`) over the
existing `training_days`/`other_activity_schedule` storage — no schema
migration — and required **no engine changes**: tracing the
consumption of both arrays through `programming.ts` and
`workoutBuilder.ts` before writing any code showed gym-day eligibility
was already fully independent of badminton (a badminton-only day was
never in `training_days`, so it never got a gym session). The actual
defect was entirely in the old UI, which made it easy to put a
badminton day into "Training days" too without any signal of the
consequence. `tests/dailyActivityPlannerBehavior.test.ts` proves the
spec's own example directly against the unmodified engine: Mon/Tue/
Thu/Fri gym + Sat/Sun badminton produces exactly 4 gym sessions, never
6.

"Reconciliation" after an activity change needed no new logic either:
`/api/programming/week` and `/today` already recompute live from the
current profile on every request (nothing about a generated plan is
ever persisted — the `programs`/`program_sessions` tables are legacy
and unused by the live path), so a change is visible on the very next
read. Logged `WorkoutSession` rows are a fully separate table
`setDailyActivity` never touches, proven by two explicit history-safety
tests (a completed session survives byte-for-byte after the exact day
it was logged for changes activity).

## API changes

- `GET /api/training-profile/daily-activities` — the derived
  Gym/Badminton/Both/Unselected state for all seven weekdays.
- `PUT /api/training-profile/daily-activities/:day` — change one day's
  activity without resubmitting the whole profile; returns the fresh
  week. 404 if no profile exists yet, 400 on an invalid day/activity.
- `GET /api/programming/week` and `/today` gained an additive
  `activity` field per day — never changing the existing `type`/
  `sessionType` fields other code already depends on. This is what lets
  the UI show "Both" for a day that already has a real gym session
  (`type: 'gym'`) plus a recurring badminton entry, which `type` alone
  can't represent.

## New tests

`tests/dailyActivity.test.ts` (8), `tests/trainingProfile.test.ts`
additions (17 — all 12 listed transitions plus data-preservation/
persistence/no-profile-yet cases), `tests/routes/
trainingProfileDailyActivities.test.ts` (7), `tests/routes/
programming.test.ts` additions (3 — activity field including a real
"both" scenario), `tests/dailyActivityPlannerBehavior.test.ts` (5 —
planner behavior + history safety), `tests/frontend/
exercisePicker.test.ts` (12), `tests/frontend/dailyActivityUI.test.ts`
(9). 61 new tests total.

## Verification (real commands, real output)

```
$ npm run verify
 Test Files  52 passed (52)
      Tests  506 passed (506)
```

506 = 445 pre-existing (unchanged) + 61 new. Re-run against a
genuinely clean checkout (`git stash create` + `git archive` + manual
copy of untracked new files) with identical results.

A real Playwright-driven browser smoke test (Chromium, against a
running `npm run dev` instance, fresh database) covered both features
end-to-end: saved a weekly schedule (Gym/Both/Badminton/Rest) and
confirmed it survives a full page reload; changed a "Both" day to
Gym-only from the Program page's day modal and confirmed the
"+ Badminton" hint disappears immediately; searched, selected, and
actually submitted a real Blueprint exercise ("back-squat") through the
new picker, independently confirmed persisted via a direct API read
afterward; confirmed the Add button correctly disables/re-enables
around selection state and typing. 20/20 checks passed. Full details in
`docs/BLUEPRINT_PICKER_AND_DAILY_ACTIVITY_REPORT.md`.

## Stop condition

Per the spec's own closing line, this implementation was not deployed
from this development environment.
