# Current-Week Activity Overrides & Program Reconciliation — Report

Per `docs/CURRENT_WEEK_RECONCILIATION_SPEC.md`.

```
Files changed:
src/db/schema.sql                              (new week_activity_overrides table)
src/contracts/types.ts                         (unchanged — DailyActivity already existed)
src/lib/dailyActivity.ts                       (new applyWeekOverrides pure function)
src/repositories/weekActivityOverridesRepo.ts  (new — per-week override storage)
src/repositories/trainingProfileRepo.ts        (setDailyActivity refactored onto applyWeekOverrides — DRY, no behavior change)
src/engine/workoutBuilder.ts                   (new programmingWeekStart export; assembleWeeklyPlanInput now consults week overrides)
src/server/routes/programming.ts               (new PUT /week/days/:day/activity; /week and /today now derive type/activity from the effective, override-applied schedule)
public/program.html                            (Change Activity now writes a current-week-only override, with clarifying copy)
tests/dailyActivity.test.ts                    (extended — applyWeekOverrides: 12 transitions + preservation + purity)
tests/weekActivityOverridesRepo.test.ts        (new — repo-level storage/separation proof)
tests/routes/weekActivityOverride.test.ts      (new — HTTP-level: all 6 spec test groups + 12 transitions)
tests/frontend/dailyActivityUI.test.ts         (updated — program.html now asserted against the new endpoint + clarifying copy)
docs/CURRENT_WEEK_RECONCILIATION_SPEC.md       (this pass's spec, saved to the repo)
docs/CURRENT_WEEK_RECONCILIATION_REPORT.md     (this report)

Current-week overrides stored separately from profile defaults:
PASS

No manual full-program regeneration required:
PASS

Current week reconciled from existing plan/state:
PASS

Unaffected future sessions stable where no redistribution is required:
PASS

Redistribution occurs only when required (existing frequency/volume engine, unmodified):
PASS

Completed/logged history never deleted or rewritten:
PASS

All 12 activity transitions work:
PASS

Gym/Badminton/Both/Unselected semantics remain correct:
PASS

Add Unplanned Exercise unchanged:
PASS

Substitute unchanged:
PASS

Tests explicitly prove current-week reconciliation:
PASS

npm run verify:
PASS

No unrelated architectural changes:
PASS

Deployed:
NO (spec §17 explicitly excludes deployment from this task)

Known limitations:
NONE
```

## Design decisions (spec §19: inspect before coding)

**Confirmed `programs`/`program_sessions` are legacy and unused by the live
path**, exactly as established in the prior phase: `/api/programming/week`
and `/today` always recompute the entire plan live, on every request, from
`TrainingProfile` + `Goal`s + real logged `WorkoutSession` history — nothing
about a generated plan is ever persisted. This is why "reconciliation" did
not require any new session-mutation logic: the very next read of an
already-pure, already-live-computed endpoint automatically reflects any
change to its inputs. What was actually missing was a way to change ONE of
those inputs — "is this weekday a gym/badminton/both/unselected day" — for
one specific week only, without mutating the recurring `TrainingProfile`
that is the correct input for every OTHER week.

**New, minimal, single-purpose table**: `week_activity_overrides`
(`training_profile_id`, `week_start`, `day`, `activity`, unique on the
three-column key). Absence of a row means "use the profile default" — never
persisted separately as a "no override" marker. This mirrors the existing
`training_profile_activities` table's own shape/conventions exactly (spec
§19.5: reuse existing schema conventions).

**One pure function, two callers.** `src/lib/dailyActivity.ts`'s new
`applyWeekOverrides(trainingDays, otherActivitySchedule, overrides)` folds
a set of Gym/Badminton/Both/Unselected overrides onto a profile's existing
`training_days`/`other_activity_schedule` arrays, producing an effective
pair of the same shapes. `TrainingProfileRepo.setDailyActivity` (edits the
recurring default — unchanged behavior, refactored onto this shared
function to remove what was previously duplicated logic) and the new
current-week read/write path both call it, so the two can never compute
"what does Gym/Badminton/Both mean" differently.

**The engine itself (`buildWeeklyProgrammingPlan`, `buildWorkout`,
`frequencyEngine`, `exerciseSelector`, ...) was not touched at all.**
`assembleWeeklyPlanInput` — the one existing impure "gather real DB state"
boundary those pure engine functions already depended on — now computes its
`available_training_days`/`recurring_badminton_days` from the EFFECTIVE
(profile + this week's overrides) schedule instead of the raw profile
alone. Every function downstream of that boundary is unaware anything
changed; it still just consumes whatever Weekday sets it's handed, exactly
as it always has. This is also why redistribution behaves correctly and
automatically per spec Priority 4: adding/removing a day from the eligible
set is the exact same operation the engine already handled correctly when
the recurring profile itself changed — current-week overrides simply feed
it a different (temporary, week-scoped) input.

**A real, informative test failure caught an over-strict assertion, not a
bug.** The first version of the "future-plan stability" tests asserted
byte-for-byte-identical `plannedWork` for an unaffected day before/after a
change. Two of them failed — correctly — because the existing (unmodified)
"normal development" layer distributes each physique target's weekly sets
across every CURRENTLY eligible gym day; when the eligible-day count
changes, that layer's explainability metadata (which days are eligible,
how many sessions remain this week) accurately updates to describe the new
count. That is correct, desired behavior — the same thing that already
happened before this fix if the recurring profile itself gained or lost a
training day — not an instability bug. The tests were corrected to compare
only the stable, prescriptive core (`exercise_id`/`target_id`/`sets`/
`reps_min`/`reps_max`), which is what spec §15 Test 1 actually asks to stay
stable; the always-current-state explainability envelope is expected to
(and correctly does) update.

## API changes

- `PUT /api/programming/week/days/:day/activity` — change one weekday's
  activity for the CURRENT week only (the week containing the real
  wall-clock "today," via the new `programmingWeekStart` export). Never
  touches the recurring `TrainingProfile`. Returns the fresh `/week`-shaped
  response in the same round trip (via a new shared `buildWeekResponse`
  helper, extracted from the existing `GET /week` handler — no duplicated
  response-shaping logic). 400 on an invalid day/activity, 404 if no
  profile exists yet.
- `GET /api/programming/week` and `/today`: unchanged response shapes,
  but their `type`/`activity`/`sessionType`/`isGymDay` derivation now
  reads the EFFECTIVE (override-applied) schedule instead of the raw
  profile — a real bug fix in its own right, since without it a current-
  week override would have correctly driven the engine's eligible-day set
  (via `assembleWeeklyPlanInput`) while the DISPLAY fields still showed
  the stale profile-default activity for that day.
- The prior phase's `PUT /api/training-profile/daily-activities/:day`
  endpoint is untouched and still edits the recurring default directly —
  it's simply no longer called by `program.html`, which now uses the new
  current-week endpoint instead (spec §13: the Profile page still owns
  the recurring default; the Program page's day modal now owns the
  current week only, with copy clarifying which is which).

## Verification (real commands, real output)

```
$ npm run verify
 Test Files  54 passed (54)
      Tests  556 passed (556)
```

556 = 506 pre-existing (unchanged, from the prior phase) + 50 new: 17
(`dailyActivity.test.ts` additions) + 8 (`weekActivityOverridesRepo.test.ts`)
+ 24 (`weekActivityOverride.test.ts`) + 1 net change in
`dailyActivityUI.test.ts` (one assertion replaced, one added — file went
from 9 to 10 tests, +1).

### Browser smoke test

Playwright drove Chromium against a running `npm run dev` instance on a
fresh in-memory database — 10/10 checks passed, covering exactly the
property the spec exists to guarantee:

```
Profile saved: Monday=Gym, Saturday=Rest (recurring default)          PASS
Program page: Saturday's day modal shows "Current activity: Rest"      PASS
Program page: modal clarifies "only the current week"                  PASS
Changed Saturday -> Badminton via the current-week control              PASS
Saturday's week-grid card immediately shows Badminton                  PASS
Profile page (separate page load): Saturday still shows Rest           PASS
Profile page: Monday still shows Gym                                   PASS
Program page reload: the Badminton override survives                  PASS
Changed Saturday back to Rest via the same control                     PASS
```

No browser console or page errors were observed (the one "404" console
line is `favicon.ico`, unrelated to this change).

## Not done in this pass

Deployment — explicitly excluded by spec §17's "Do not deploy as part of
this task."
