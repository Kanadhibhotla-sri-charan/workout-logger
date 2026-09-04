# Blueprint Picker + Daily Activity — Implementation Report

Per `docs/BLUEPRINT_PICKER_AND_DAILY_ACTIVITY_SPEC.md` §19.

```
Files changed:
src/contracts/types.ts                      (DailyActivity type — additive)
src/lib/dailyActivity.ts                    (new — derivation, single source of truth)
src/repositories/trainingProfileRepo.ts     (NoTrainingProfileError + setDailyActivity)
src/server/routes/trainingProfile.ts        (GET/PUT /daily-activities)
src/server/routes/programming.ts            (additive `activity` field on /week, /today)
public/app.js                               (createBlueprintExercisePicker component)
public/logger.html                          (Add Unplanned Exercise rewired to the picker)
public/profile.html                         (unified Gym/Badminton/Both/Rest weekly editor)
public/program.html                         (Change Activity control in the day modal)
public/style.css                            (.exercise-picker*, daily-activity styles)
tests/dailyActivity.test.ts                 (new — derivation unit tests)
tests/trainingProfile.test.ts               (extended — setDailyActivity, 12 transitions)
tests/routes/trainingProfileDailyActivities.test.ts  (new — HTTP-level route tests)
tests/routes/programming.test.ts            (extended — activity field on /week, /today)
tests/dailyActivityPlannerBehavior.test.ts  (new — planner behavior + history safety)
tests/frontend/exercisePicker.test.ts       (new — Feature A source regressions)
tests/frontend/dailyActivityUI.test.ts      (new — Feature B UI source regressions)
docs/BLUEPRINT_PICKER_AND_DAILY_ACTIVITY_SPEC.md    (this pass's spec, saved to the repo)
docs/BLUEPRINT_PICKER_AND_DAILY_ACTIVITY_REPORT.md  (this report)

Add Unplanned Exercise searchable dropdown:
PASS

Searches complete Blueprint library, no relevance filtering:
PASS

Arbitrary text cannot bypass Blueprint validation:
PASS

Substitute flow unchanged:
PASS

Gym/Badminton/Both/Unselected per weekday:
PASS

No separate stored "Rest" value:
PASS

Badminton-only day never becomes an automatic gym day:
PASS

"Both" = badminton + gym opportunity:
PASS

Activity changeable after program generation:
PASS

Plan reconciles without unnecessary full regeneration:
PASS

Completed/logged history never destroyed:
PASS

State persists across reload/restart:
PASS

Existing tests pass:
PASS

New tests cover the above:
PASS

npm ci:
PASS

npm run verify (clean checkout):
PASS

Browser smoke test:
PASS

Deployed from this environment:
NO (not required/attempted, per spec §19's final line)

Unrelated changes:
NONE

Known limitations:
See "Known limitations" section below.
```

## Design decisions (spec §19: inspect before coding)

**No engine changes were needed or made.** Before writing any code, I
traced exactly where `training_days` and `other_activity_schedule` are
consumed (`src/server/routes/programming.ts`, `src/engine/workoutBuilder.ts`,
`src/engine/frequencyEngine.ts`) and found gym-day eligibility
(`available_training_days` = `training_days`) was already fully
independent of badminton — a badminton-only day (never in
`training_days`) never received a gym session, and a day in both arrays
already produced both a real gym session and badminton recovery
awareness. `tests/dailyActivityPlannerBehavior.test.ts` proves this
directly against the unmodified engine, including the spec's own exact
example (Mon/Tue/Thu/Fri gym + Sat/Sun badminton → 4 gym sessions, never
6). The actual defect was entirely in the UI/data-entry layer: a flat
"Training days" multi-select plus a disconnected free-text "Recurring
activities" list made it easy for a user to put a badminton day into
`training_days` too, without any structural signal of what that would
do to that day's programming.

**No schema migration.** Per spec §6, `DailyActivity` (gym/badminton/
both/unselected) is a *derived* view over the two arrays that already
exist — `src/lib/dailyActivity.ts`'s `deriveDailyActivity` — never a
third storage location. `activity_type` on `training_profile_activities`
stays the free-text/open field it always was (a pre-existing test
exercises a non-badminton `'hiking'` value; it still passes, untouched).

**"Reconciliation" is structural, not a migration step.** `GET /api/
programming/week` and `/today` always recompute live from the current
`TrainingProfile` on every request — no "current week's plan" is ever
persisted (the `programs`/`program_sessions` tables exist in the schema
but are legacy/unused by the live generation path, confirmed by
inspection). So changing a day's activity via `setDailyActivity` needs
no separate reconciliation logic: the very next `/week` or `/today` read
already reflects it. `tests/routes/trainingProfileDailyActivities.test.ts`
proves this directly (`PUT` then `GET` without any intervening step).
Logged `WorkoutSession` rows live in a completely separate table
`setDailyActivity` never touches — proven directly by
`tests/dailyActivityPlannerBehavior.test.ts`'s history-safety tests
(a completed session, byte-for-byte unchanged, after the exact day it
was logged for changes activity).

**Feature A needed no new backend endpoint.** The Blueprint exercise
library is 123 exercises — small enough that `GET /api/blueprint/
exercises` (already existing, unchanged) is fetched once and filtered
client-side with a plain case-insensitive substring match, capped at 50
rendered results. This is definitionally "no relevance ranking" and
avoids adding a second, parallel search implementation.

## Feature A detail: Add Unplanned Exercise

`public/logger.html`'s `buildAddExerciseSection` previously used an
`<input list="…">` + `<datalist>` — real dropdown behavior is
browser/OS-dependent with `<datalist>`, which was the actual defect (not
the backend validation, which was already correct). Replaced with
`createBlueprintExercisePicker` (new, in `public/app.js`): a text input
+ results list, explicit click-to-select only (typing never counts as a
selection), a "Selected: X (Blueprint)" indicator, a "No Blueprint
exercises found." empty state, and the submit button disabled until a
real selection exists. `openSubstitutePicker` (the separate, equipment/
target-aware Substitute flow) was not touched — confirmed both by a
source diff (the only changed lines in `logger.html` are inside
`buildAddExerciseSection`) and by a real browser test exercising the
picker end to end (see below).

## Feature B detail: Per-Day Training Activity

`public/profile.html`'s old "Training days" `<select multiple>` and
free-text "Recurring activities" list are replaced by one "Weekly
training schedule" section: 7 rows, each a single Gym/Badminton/Both/
Rest `<select>`. On load, each day's initial value is derived from the
loaded profile the same way the backend derives it. On Save, the 7
values are translated back into `training_days` + badminton entries in
`other_activity_schedule`, merged with (a) any pre-existing non-badminton
recurring activity on that day (this trimmed UI has no editor for those,
but never deletes them — spec §5) and (b) any existing badminton day's
notes (so switching Both→Badminton, say, doesn't silently blank a
previously-recorded note).

`public/program.html`'s day-detail modal gained a "Change activity"
control (spec §11's exact suggested shape: current activity shown, then
Gym/Badminton/Both/"Rest / clear"), writing through the new focused
`PUT /api/training-profile/daily-activities/:day` endpoint and
re-fetching the week on success — never a full profile resubmission or
"regenerate everything" action. A "Both" day's badminton component is
now also visible directly on the week-grid card (`"Push + Badminton"`),
not only inside the modal — `/week`'s response gained a purely additive
`activity` field for exactly this, alongside the pre-existing `type`
field which no existing consumer's meaning changed (`type` is still
`'gym'` for a Both day, exactly as before).

## Verification (real commands, real output)

Full suite, working tree:

```
$ npm run verify
 Test Files  52 passed (52)
      Tests  506 passed (506)
```

506 = 445 pre-existing tests (unchanged, all still passing) + 61 new:
8 (`dailyActivity.test.ts`) + 17 (`trainingProfile.test.ts` additions) +
7 (`trainingProfileDailyActivities.test.ts`) + 3 (`programming.test.ts`
additions) + 5 (`dailyActivityPlannerBehavior.test.ts`) + 12
(`exercisePicker.test.ts`) + 9 (`dailyActivityUI.test.ts`).

Genuinely clean checkout (`git stash create` + `git archive` + manual
copy of untracked new files, matching a real `git clone`):

```
$ npm ci
$ npm run verify
 Test Files  52 passed (52)
      Tests  506 passed (506)
```

### Browser smoke test

Playwright (pre-installed in this environment, not a project dependency)
drove Chromium against a running `npm run dev` instance on a fresh
in-memory database, covering every acceptance-criteria behavior that a
static source test cannot: 20/20 checks passed —

```
Profile: weekly schedule renders 7 rows                              PASS
Profile: save succeeds, values persist across a full page reload
  (Monday=gym, Tuesday=both, Wednesday=badminton, Thursday=unselected) PASS x4
Program: week grid renders all 7 days                                PASS
Program: day modal shows "Change activity" + current activity         PASS
Program: Both -> Gym via the modal control; "+ Badminton" hint
  disappears from the week-grid card immediately after                PASS
Today -> Logger: navigation works (started a real workout session)    PASS
Logger: exercise picker input renders                                 PASS
Logger: nonsense query shows "No Blueprint exercises found."          PASS
Logger: "squat" query returns real results                            PASS
Logger: Add exercise disabled before selection, enabled after          PASS
Logger: selected indicator names the chosen exercise                  PASS
Logger: typing again after selection re-disables Add (forces
  re-selection — arbitrary text can never bypass validation)          PASS
Logger: Add exercise actually submits                                 PASS
```

Independently confirmed via a direct API read after the smoke test that
the submitted exercise (`back-squat`) was persisted on the real workout
session with its correct Blueprint id — not merely "no crash."

## Known limitations

- Feature A's search is a plain substring match with no fuzzy/typo
  tolerance — acceptable per spec §3 ("matching should primarily be
  based on exercise name/text search... no relevance filtering"), and
  the library is small enough (123 exercises) that this is not a UX gap
  in practice.
- `public/profile.html` no longer has an editor for a hypothetical
  non-badminton recurring activity (e.g. a custom "hiking" entry) — such
  data is preserved if it already exists (never deleted), but a user
  cannot currently add a new one through this page. The backend/repo
  layer still fully supports arbitrary `activity_type` values
  unconstrained (spec explicitly requires this stay open); only this
  page's UI is now scoped to the Gym/Badminton/Both/Rest model the spec
  asked for.
- Per spec §19's closing line, this implementation was not deployed from
  this development environment.
