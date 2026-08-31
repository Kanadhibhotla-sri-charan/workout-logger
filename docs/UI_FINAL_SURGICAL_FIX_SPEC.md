# UI PHASE — FINAL SURGICAL FIX PASS

## DEV DIRECTIVE

This is a **surgical correction pass only**.

The UI phase has already been implemented. Do **not** redesign the UI, change programming methodology, refactor the core programming engine, introduce a frontend framework, or add new product scope.

> **DEV = HANDS. THIS DOCUMENT = BRAIN.**
>
> Every implementation decision required for this task is specified below.
> Do not reinterpret the requirements or make independent product decisions.

The goal is to fix exactly the two identified defects, add regression coverage, verify the complete application, and then stop.

---

# 1. FIX `/api/programming/today` ACTIVITY CLASSIFICATION

## CURRENT PROBLEM

`GET /api/programming/today` can incorrectly classify a recurring non-gym activity as:

```text
rest
```

when there is no gym session.
That is incorrect.
A day without a gym workout is not automatically a rest day.
The day may instead contain a scheduled non-gym activity such as badminton.

## 2. REQUIRED SESSION-TYPE PRECEDENCE

The Today endpoint MUST determine the day's type using this exact precedence:

```
1. Gym session exists
       ↓
   sessionType = "gym"

2. No gym session
   AND recurring non-gym activity exists
       ↓
   sessionType = configured activity type

3. No gym session
   AND no recurring non-gym activity
       ↓
   sessionType = "rest"
```

Therefore:

```
GYM > ACTIVITY > REST
```

This precedence is mandatory.
Do not use:

```
has exercises ? gym : rest
```

or any equivalent logic that ignores recurring activities.

## 3. USE THE EXISTING CANONICAL ACTIVITY DATA

Do not create a second activity configuration specifically for Today.
Locate the existing recurring-activity configuration already used by:

```
/api/programming/week
```

Use that same source of truth for:

```
/api/programming/today
```

The Today endpoint must derive its activity information from the existing training profile / recurring activity schedule.
Do not hard-code:

```
Saturday = badminton
```

into the route.
The implementation must remain data-driven.

## 4. BADMINTON EXAMPLE

If the training profile contains:

```
Saturday → badminton
```

and there is no gym workout programmed for that Saturday:

```
GET /api/programming/today?date=<Saturday>
```

MUST return a response whose canonical session type is:

```
badminton
```

It must NOT return:

```
rest
```

## 5. OTHER ACTIVITIES

Do not special-case badminton.
If the existing configuration supports another recurring activity, Today must return that configured canonical activity type.
For example:

```
configured activity
        ↓
canonical activity type
        ↓
today.sessionType
```

The route must not contain a growing list such as:

```
if badminton...
else if running...
else if cycling...
```

Use the existing configuration.

## 6. GYM PRECEDENCE

If a gym session exists for the date, the result must be:

```
gym
```

even if a recurring non-gym activity is also configured for that date.
Required precedence remains:

```
gym > activity > rest
```

Do not alter the programming methodology to resolve this.

## 7. TRUE REST DAY

If:

```
no gym session
AND
no recurring activity
```

then:

```
sessionType = "rest"
```

This must remain the fallback.

## 8. TODAY/WEEK MUST AGREE

For any given date, these two endpoints must agree about the canonical day type:

```
GET /api/programming/today?date=<date>
```

and:

```
GET /api/programming/week
```

For the matching date:

```
Today canonical type
==
Weekly Program canonical type
```

Do not compare UI display labels.
Compare the actual canonical values used by the API/data model.
The application must never produce a state such as:

```
Weekly Program:
Saturday → Badminton

Today:
Saturday → Rest
```

## 9. MANDATORY REGRESSION TEST — BADMINTON

Add an HTTP-level regression test using the existing test infrastructure.
The test must configure:

```
Saturday → badminton
No gym session on Saturday
```

Then execute:

```
GET /api/programming/today?date=<Saturday>
```

Assert:

```
HTTP 200
sessionType === "badminton"
```

Then execute:

```
GET /api/programming/week
```

Locate the same Saturday.
Assert that the weekly result also identifies the day as:

```
badminton
```

Finally assert:

```
today Saturday type === weekly Saturday type
```

This test is mandatory.

## 10. MANDATORY REGRESSION TEST — REST

Add an HTTP-level test for a genuine rest day.
Configure:

```
No gym session
No recurring activity
```

Call:

```
GET /api/programming/today?date=<date>
```

Assert:

```
HTTP 200
sessionType === "rest"
```

This ensures the implementation correctly distinguishes:

```
activity day
```

from:

```
rest day
```

## 11. MANDATORY REGRESSION TEST — GYM

Add or retain an HTTP-level test for a gym day.
Configure:

```
Gym session exists
```

Call:

```
GET /api/programming/today?date=<date>
```

Assert:

```
HTTP 200
sessionType === "gym"
```

If a recurring activity is also present, the expected result remains:

```
gym
```

because:

```
gym > activity > rest
```

## 12. MANDATORY TODAY/WEEK AGREEMENT TEST

Add an explicit regression test proving that Today and Weekly Program agree.
For the same configured profile/date:

```
GET /api/programming/today?date=<date>
GET /api/programming/week
```

Extract the corresponding canonical day types.
Assert:

```
todayType === weekType
```

At minimum, this must be exercised for the badminton scenario.

## 13. FIX PROGRAM PAGE "DELIVERED" TERMINOLOGY

### CURRENT PROBLEM

The Program page currently uses wording equivalent to:

```
X of Y planned sets delivered this week
```

This is misleading.
The engine's existing field:

```
deliveredDirectSets
```

represents work that survived programming/resource/time fitting and exists in the final planned program.
It does NOT represent work physically completed by the user.
Actual physical completion happens in the Logger.

## 14. REQUIRED PROGRAM PAGE TERMINOLOGY

Where the Program page describes programmed volume, the UI must use:

```
Required
Programmed
Unmet
```

For example:

```
Required: 8 sets
Programmed: 6 sets
Unmet: 2 sets
```

Or an equivalent compact presentation:

```
6 programmed · 2 unmet
```

The existing visual layout may remain unchanged.
Only the terminology/labeling needs to change.

## 15. EXACT SEMANTIC DEFINITIONS

The UI must communicate these meanings:

```
Required
=
the volume the programming model determined was required

Programmed
=
the volume that the final fitted program actually contains

Unmet
=
the required volume that could not be fitted into the final program
```

These are programming concepts.
They are NOT actual workout completion metrics.

## 16. DO NOT USE "DELIVERED" FOR PROGRAMMED VOLUME

On the Program page, do not describe programmed volume using:

```
Delivered
Completed
Performed
Actual
Done
```

The Program page should use:

```
Required
Programmed
Planned
Unmet
```

as appropriate.
The backend field:

```
deliveredDirectSets
```

may remain unchanged.
Map it at presentation time:

```
deliveredDirectSets
        ↓
Programmed
```

Do NOT rename the backend/domain field merely to fix the UI wording.

## 17. PLANNED VS ACTUAL MUST REMAIN SEPARATE

The application has two different concepts:

```
PROGRAMMING
```

and:

```
ACTUAL WORKOUT PERFORMANCE
```

The distinction must remain explicit.
Program page:

```
Required: 8
Programmed: 6
Unmet: 2
```

Logger:

```
Planned: 4 sets
Actual: 3 completed
```

Do not merge these concepts.
Do not imply:

```
Programmed = Completed
```

## 18. REQUIRED TERMINOLOGY REGRESSION

Use the existing frontend/browser test infrastructure.
Add the smallest practical assertion proving that the Program UI displays the programmed-volume concept as:

```
Programmed
```

and does not present it to the user as:

```
Delivered
```

Do not introduce a new frontend framework.
Do not introduce a new testing framework solely for this assertion.

## 19. DO NOT CHANGE THE PROGRAMMING ENGINE

The programming engine is frozen.
Do NOT modify:

```
Aesthetics-first priority
Goal priority ordering
Maximum active goals
Primary exposure = 1.00
Secondary exposure = 0.33
Compound exposure
PPL + Upper split
Monday lower-body prohibition
Badminton methodology
Blueprint-first exercise selection
Outside-Blueprint fallback
Time fitting
Equipment constraints
Progression
History
Determinism
```

The only backend programming change allowed in this task is the correction to the Today endpoint's session-type classification.
Do not use this task as an opportunity to improve or reinterpret programming logic.

## 20. DO NOT REDESIGN THE UI

Do NOT redesign:

```
Navigation
Page structure
Visual theme
Card structure
Logger workflow
Goal workflow
History workflow
Profile workflow
```

Do not change layouts unless the existing terminology change requires a minimal adjustment.
Do not introduce unrelated CSS changes.
Do not refactor unrelated components.

## 21. DO NOT TOUCH CALORIE TRACKER

The calorie-tracker integration is a future phase.
Do NOT implement:

```
workout calorie calculations
actual workout calorie export
calorie tracker API integration
energy expenditure calculations
daily calorie reconciliation
```

Those are explicitly out of scope for this task.

## 22. EXPECTED FILE CHANGES

Expected minimum changes:

```
Existing /api/programming/today route
Relevant route test file
public/program.html
Relevant existing frontend/browser test
```

If another file must change:

```
document the exact reason
```

Do not modify unrelated files.

## 23. IMPLEMENTATION ORDER

Follow this exact sequence.

Step 1
Locate:

```
/api/programming/today
```

implementation.

Step 2
Locate the canonical recurring-activity source used by:

```
/api/programming/week
```

Step 3
Make Today use that same recurring-activity context.

Step 4
Implement exact precedence:

```
gym > activity > rest
```

Step 5
Add the badminton regression test.

Step 6
Add the rest regression test.

Step 7
Add the gym regression test.

Step 8
Add the Today/Week agreement regression test.

Step 9
Update Program-page wording:

```
delivered → programmed
```

where the word refers to programmed volume.

Step 10
Add terminology regression coverage.

Step 11
Run the existing type/format checks.

Step 12
Run the complete test suite.

Step 13
Run the production build.

Step 14
Run the existing browser smoke test.

Step 15
Perform the manual smoke checks specified below.

Step 16
Report exact results.

Step 17
If the acceptance gate passes:

```
STOP.
```

## 24. VERIFICATION COMMANDS

From a clean checkout/environment, run:

```
npm ci
```

Then:

```
npm run verify
```

Then run the repository's existing browser smoke-test command.
If the repository contains additional existing verification commands required by its scripts/documentation, run them.
Do not invent a new verification system.

## 25. TEST RESULT HONESTY

This is mandatory.
Do NOT claim:

```
PASS
```

unless the test/command was actually executed successfully.
If a command:

```
fails
times out
cannot run because of environment limitations
```

report that exact state.
Do not convert:

```
not run
```

into:

```
pass
```

Do not claim browser testing based only on source-code inspection.

## 26. REQUIRED MANUAL SMOKE TEST

A — Gym day
Open Today on a gym day.
Expected:

```
Gym
```

B — Badminton day
Open Today on a configured badminton day.
Expected:

```
Badminton
```

Must NOT show:

```
Rest
```

C — Genuine rest day
Open Today on a genuine rest day.
Expected:

```
Rest
```

D — Weekly consistency
Open:

```
Weekly Program
```

Find a badminton day.
Then open:

```
Today
```

for that same date.
Both must show the same activity type:

```
Badminton
```

E — Program volume
Open:

```
Program
```

Expected terminology:

```
Required
Programmed
Unmet
```

The page must NOT describe programmed volume as:

```
Delivered
Completed
Actual
Performed
```

F — Actual workout logging
Start a programmed workout.
Complete fewer sets than planned.
Expected distinction:

```
Planned: X
Actual: Y completed
```

The application must not imply that the planned/programmed number was actually performed.

## 27. ACCEPTANCE GATE

The UI phase is complete ONLY when every item below is true.

Today

* `/api/programming/today` correctly identifies gym days.
* `/api/programming/today` correctly identifies badminton days.
* `/api/programming/today` correctly identifies other configured recurring activities.
* `/api/programming/today` correctly identifies genuine rest days.
* Precedence is exactly `gym > activity > rest`.

Consistency

* Today and Weekly Program agree on day type.
* Badminton regression passes.
* Rest regression passes.
* Gym regression passes.
* Today/Week agreement regression passes.

Program UI

* Program page no longer describes programmed volume as "delivered".
* Program page uses "Programmed" for fitted/programmed volume.
* Program page distinguishes Required / Programmed / Unmet.
* Program page does not imply programmed volume was completed.

Logger

* Logger still distinguishes Planned vs Actual.
* Actual completion remains based on real user logging.

Regression safety

* Existing programming-engine tests remain green.
* No programming methodology was changed.
* No unrelated architecture was changed.
* No calorie-tracker functionality was added.

Verification

* `npm ci` succeeds.
* `npm run verify` succeeds.
* Production build succeeds.
* Existing browser smoke test succeeds.
* Manual smoke tests succeed.

## 28. STOP CONDITION

Once every acceptance-gate item passes:
STOP.
Do not continue implementing anything else.
Do not:

```
redesign the programming engine
add programming rules
add goal methodology
refactor the UI architecture
introduce a frontend framework
start calorie calculations
modify the calorie tracker
add speculative analytics
```

At that point:

```
UI PHASE = DONE
```

## 29. NEXT PHASE — DO NOT IMPLEMENT NOW

The next phase will address the integration between actual workout logging and the calorie tracker.
The intended future flow is:

```
Workout Programmer
        ↓
Planned Workout
        ↓
Workout Logger
        ↓
Actual Completed Sets / Reps / Load / Duration
        ↓
Completed Workout Record
        ↓
Calories Tracker
        ↓
Actual Workout Energy Expenditure
        ↓
Daily Calorie Balance
```

Do NOT implement this during the current task.

## 30. REQUIRED DEV REPORT

After implementation, return exactly this structure:

```
Files changed:
<exact list>

Today activity-type fix:
PASS/FAIL

Today/week agreement:
PASS/FAIL

Badminton regression:
PASS/FAIL

Rest regression:
PASS/FAIL

Gym regression:
PASS/FAIL

Program terminology fix:
PASS/FAIL

Logger planned-vs-actual:
PASS/FAIL

npm ci:
PASS/FAIL

npm run verify:
PASS/FAIL

Production build:
PASS/FAIL

Browser smoke test:
PASS/FAIL

Manual smoke test:
PASS/FAIL

Unrelated changes:
YES/NO

If YES:
<exact explanation>

Known limitations:
<exact list or NONE>
```

Do not omit failed or unexecuted checks.

## FINAL DIRECTIVE

This is the final surgical correction pass for the current UI phase.
Fix exactly these two defects:

```
1. Incorrect Today activity classification.
2. Incorrect Program-page "delivered" terminology.
```

Add the specified regression tests.
Run the specified verification.
Do not reinterpret the requirements.
Do not improve unrelated code.
Do not reopen frozen programming methodology.
Do not create additional product scope.
Do not implement the next phase.
Implement → test → verify → report → STOP.
