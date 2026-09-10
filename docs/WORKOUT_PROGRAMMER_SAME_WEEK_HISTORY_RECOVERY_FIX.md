# Workout Programmer — Same-Week History & Day-Specific Recovery Fix

## Purpose

Implement the code-only fix identified by the Sep 7 / Sep 8 / Sep 11 forensic audit at deployed commit `368185f0f2c43a13012821e6b5452c6ad9bbeba8`.

The audit proved:

- Sep 7 and Sep 8 workout data is correctly stored.
- Every relevant historical exercise ID resolves to the current canonical Blueprint.
- No historical-data migration/normalization is needed.
- The root defect is that weekly generation/reconciliation uses the week's Monday as the history `asOfDate`.
- Therefore real Tue–Sun training in that same week is invisible to subsequent planning.
- Monday's same-day recovery signal is then incorrectly promoted into a whole-week skip.
- Friendly explanations inherit those bad values and can also incorrectly say "earlier today."

**Implementation is code/tests only. Do not modify historical data.**

---

# 1. Non-negotiable constraints

DO NOT:

- modify `workout_sessions`, `workout_exercises`, or `workout_sets`;
- modify goals, goal events, phases, phase reviews, assessments, or measurements;
- run `sync-blueprint`;
- change Blueprint exercise definitions or target mappings;
- create planned `workout_sessions` rows;
- create fake exposure history;
- manufacture missed-set debt;
- treat future generated programs as completed exposure;
- reintroduce `remainingWeeklySets` / `remainingWeeklyReference`;
- reintroduce time/equipment filtering into normal generation;
- redesign the current rolling-frequency/per-exposure architecture.

Preserve:

- locked-day protection;
- canonical reconciliation;
- rolling exposure/frequency logic;
- simulated-vs-real exposure separation;
- Blueprint-authored set caps;
- package sharing;
- Blueprint exercise validity;
- existing history semantics.

### Explicitly deferred

The audit found a separate Class E issue where a per-exposure prescription can spill into multiple exercises for one target (e.g. Hammer Curl + Cross-Body Hammer Curl). **Do not change that in this task.** It is a separate programming-quality review.

---

# 2. Root cause to fix

Current path:

`computeFreshWeek(db, weekStart, ...)`
→ `assembleWeeklyPlanInput(db, weekStart, ...)`
→ `buildTrainingState(db, weekStart)`
→ historical query uses `date <= weekStart`.

For week `2026-09-07`, the planner therefore sees Sep 7 but not Sep 8/10.

This produced:

- Sep 7 targets: `days_since = 0` → recovery `avoid` → whole-week skip.
- Sep 8 targets: `weekly_primary_sets = 0`, `last_trained_date = null`, `exercise_history = {}`.
- False "haven't trained this target yet this week".
- False "First time using this variation".
- No progression continuity.
- Incorrect fresh-deficit programming.

The DB itself is correct.

---

# 3. Separate programming week from history/as-of date

The system must explicitly distinguish:

```text
programmingWeekStart
```

from:

```text
historyAsOfDate
```

Example:

```text
programmingWeekStart = 2026-09-07
historyAsOfDate      = 2026-09-11
```

The week remains anchored to Monday for calendar/program structure, but historical training may be read through the actual reference date.

Do not simply rename the existing variable. Make the distinction explicit in the data flow/type contract.

A valid implementation may use either:

```ts
computeFreshWeek(db, programmingWeekStart, budgetMinutes, historyAsOfDate)
```

or an equivalent typed options object.

Keep `buildTrainingState(db, asOfDate)` as the historical boundary mechanism. The fix is to pass the correct `asOfDate`, not to weaken its date filtering.

---

# 4. Fix every canonical caller

Audit and update all current `computeFreshWeek()` callers, including:

- `GET /api/programming/week`
- `PUT /api/programming/week/days/:day/activity`
- `reconcileAfterActualTraining`
- any canonical one-off regeneration path.

For current-week generation/reconciliation:

- programming week = requested/current calendar week;
- history as-of = actual current/reference date available to the planner.

After completing a Tuesday workout, reconciliation must see that Tuesday workout.

On Friday, a plan for the week beginning Monday must be able to see completed Monday, Tuesday, and Thursday workouts.

For future weeks, do not allow future planned days to become history merely because their dates are inside the generated week. Real history must never extend beyond the actual reference/current date.

---

# 5. Required same-week behavior

For week Sep 7–13:

### Sep 7

Real Sep 7 completed work is visible.

### Sep 8

If Sep 8 is completed, subsequent same-week regeneration must see it.

### Sep 10

If Sep 10 is completed, subsequent same-week regeneration must see it.

### Sep 11

The planner must be able to see completed Sep 7, Sep 8 and Sep 10 history, subject to the actual reference date.

The planner must NOT behave as though the whole week is still Monday morning.

---

# 6. Fix recovery scope

Current bad behavior:

```text
Monday target trained
→ days_since = 0
→ recovery = avoid
→ weekLevelSkips
→ target removed from entire week
```

Required behavior:

```text
Monday:
  target trained today → avoid another direct exposure today

Tuesday:
  reevaluate

Wednesday:
  reevaluate

Thursday:
  reevaluate

Friday:
  reevaluate
```

A same-day recovery constraint is **day/exposure scoped**, not automatically week scoped.

Do not remove the same-day protection itself.

---

# 7. Integrate recovery with simulated planning state

Preserve the existing:

- `simulatedLastExposureDate`
- `exposureDatesThisRun`
- rolling frequency logic
- per-exposure architecture.

For later simulated days, recovery/frequency must account for relevant real and simulated exposures.

Important distinction:

```text
REAL HISTORY
→ actual DB-backed exposure

SIMULATED EXPOSURE
→ current planning run only
→ never persisted as actual history
```

Do not create a second independent frequency engine.

---

# 8. Secondary exposure

Do not change existing exposure coefficients or Blueprint mappings in this task.

However, Monday incidental secondary touches (e.g. front delt/triceps from incline press, obliques from cable crunch) must not cause a same-day recovery signal to become an automatic whole-week exclusion.

The existing primary/secondary semantics remain authoritative.

---

# 9. Fix friendly explanations

Inspect:

`src/server/friendlyExplanation.ts`

Current logic effectively treats:

```text
days_since === 0
```

as:

> "already trained earlier today"

That is unsafe when the planner's reference date is not the real date being described.

Required:

- Say "earlier today" only when the actual training date equals the evaluated/planned date.
- If the last training date is earlier, mention the actual historical date, e.g. "trained on Monday, Sep 7".
- Never fabricate a date.
- Do not merely change wording while leaving the upstream state wrong.

The explanation layer should receive/use enough date context to distinguish a true same-day condition from a stale planner reference date.

---

# 10. Sep 7 / Sep 8 regression scenario

Use the real audited facts.

### Sep 7 completed

- cable-fly: 4
- cable-lateral-raise: 4
- overhead-triceps-extension: 4
- cable-pushdown: 4
- incline-dumbbell-press: 3
- cable-crunch: 3

### Sep 8 completed

- lat-pulldown-wide-pronated: 3
- chest-supported-row: 3
- cable-rear-delt-builder: 3
- hammer-curl: 2
- barbell-ez-bar-curl: 3
- wrist-curl: 1 completed
- reverse-wrist-curl: 2

The second Sep 8 Wrist Curl set is incomplete and must remain excluded.

Tests must prove that when planning after Sep 8:

### Lat Width

recognizes Sep 8 exposure and history for `lat-pulldown-wide-pronated`.

### Back Thickness

recognizes Sep 8 primary exposure/history for `chest-supported-row` plus valid secondary overlap.

### Brachialis / Arm Thickness

recognizes Sep 8 `hammer-curl`.

### Biceps

recognizes Sep 8 `barbell-ez-bar-curl` plus valid secondary hammer-curl exposure.

### Rear Delt

recognizes Sep 8 `cable-rear-delt-builder`.

### Forearm Extensors

recognizes Sep 8 `reverse-wrist-curl`.

### Forearm Flexors

recognizes only the one completed Wrist Curl set.

---

# 11. Variation-history regression

These exact Sep 8 IDs already exist in history:

```text
lat-pulldown-wide-pronated
chest-supported-row
hammer-curl
barbell-ez-bar-curl
reverse-wrist-curl
```

When planning after Sep 8, their `exercise_history` must be non-empty.

Therefore the programmer must not generate a "first time using this variation" state merely because the session occurred earlier in the same programming week.

Genuinely unused variations such as:

```text
cross-body-hammer-curl
seated-cable-row
straight-arm-pulldown
face-pull
rear-delt-row
incline-dumbbell-curl
reverse-curl
```

may still correctly receive first-time explanations when no historical record exists.

---

# 12. Target-history regression

After Sep 8 is completed, same-week planning must not report these as untouched:

```text
lat-width
back-thickness
brachialis-arm-thickness
biceps
rear-delt
forearm-extensors
forearm-flexors
```

Their actual exposure must come from the real completed data and current exposure engine.

Do not hardcode expected numbers into production logic.

---

# 13. Recovery regression

Create a test where:

1. A target is trained on Monday.
2. Monday's same-day direct repeat is blocked.
3. The next day reevaluates the target.
4. A later day can consider the target again if all other rules permit.
5. Monday recovery does NOT create a permanent week-level skip.

Also test that a target trained earlier on the same day remains protected from another direct exposure on that same day.

---

# 14. Reconciliation regression

Test the real canonical post-workout path:

1. Generate a week.
2. Complete a Tuesday workout.
3. Trigger normal reconciliation.
4. Inspect future program state.
5. Assert the completed Tuesday session is visible to the rebuilt training state.
6. Assert no fake workout/exposure rows were created.

At least one regression must exercise the actual canonical reconciliation caller rather than only mocking `buildTrainingState`.

---

# 15. Future-plan safety

A future planned session must NOT enter:

- recent completed history;
- target exposure;
- variation history;
- rolling exposure;
- actual frequency history.

Program generation remains planning-only.

No `workout_sessions`, `workout_exercises`, or `workout_sets` rows should be created merely by generating a plan.

---

# 16. Locked-day safety

Preserve the existing locked-day rule.

Completed/in-progress historical days remain protected.

For the known deployment state:

- Sep 7 completed/locked
- Sep 8 completed/locked
- Sep 10 completed/locked

must not be rewritten by regeneration.

No historical workout data may be changed by this task.

---

# 17. Preserve current architecture

Do not regress:

- rolling frequency limits;
- minimum spacing;
- simulated exposure dates;
- per-exposure prescription;
- Blueprint-authored set caps;
- package sharing;
- exercise validity;
- time/equipment invariance;
- no weekly-debt/reference bucket.

The task is specifically:

**same-week history visibility + day-specific recovery + truthful explanations.**

---

# 18. Required test matrix

Add regression coverage for at least:

1. Monday workout visible on Monday.
2. Tuesday completed workout visible to same-week later-day generation.
3. Thursday completed workout visible to same-week Friday generation.
4. Sep 8 Lat Pulldown variation history recognized.
5. Sep 8 Chest-Supported Row history recognized.
6. Sep 8 Hammer Curl history recognized.
7. Sep 8 Barbell/EZ Curl history recognized.
8. Sep 8 Reverse Wrist Curl history recognized.
9. Incomplete Sep 8 Wrist Curl set excluded.
10. Monday same-day recovery blocks only same-day repeat.
11. Monday recovery does not permanently skip the target for Friday.
12. Simulated exposure affects later-day recovery appropriately.
13. No false "first time" explanation.
14. No false "haven't trained this target this week" explanation.
15. "Earlier today" only when the relevant training date is actually the evaluated date.
16. Earlier training is described with its actual date.
17. Actual post-workout reconciliation sees newly completed same-week history.
18. Future plans do not become actual history.
19. Locked sessions remain unchanged.
20. No workout_* rows are created by generation.
21. Rolling frequency remains correct.
22. Simulated history remains non-persistent.
23. Authored set caps remain intact.
24. Blueprint validity remains intact.
25. Package sharing remains intact.
26. Time/equipment invariance remains intact.

---

# 19. Do not overfit the Sep 11 exercise list

Do NOT make tests require a specific final exercise list merely because it looks better.

The objective is to correct the programmer's state.

Tests should assert:

- real history is visible;
- exposure is correct;
- recovery scope is correct;
- variation history exists;
- explanations are truthful;
- existing programming rules remain intact.

The exact exercise selection remains the programmer's responsibility.

---

# 20. Implementation sequence

1. Inspect all `computeFreshWeek()` callers.
2. Introduce an explicit `historyAsOfDate`/equivalent typed concept.
3. Keep `programmingWeekStart` separately for calendar anchoring.
4. Fix current-week generation/reconciliation to use the appropriate real history reference date.
5. Make same-day recovery day-specific rather than week-level.
6. Ensure simulated exposure state remains separate from real history.
7. Fix explanation date semantics.
8. Add the Sep 7/Sep 8 regression tests.
9. Run the complete test suite.
10. Run typecheck/build/verification.

---

# 21. Verification commands

Run the repository's existing validation commands, including:

```text
npm test
npm run typecheck
npm run build
```

and the project's existing verification command(s).

Do not weaken/delete existing tests.

Do not claim success without actual output.

---

# 22. Post-fix Sep 11 regeneration

Only after code/tests pass, the unlocked Sep 11 program may be regenerated through the existing canonical path:

```text
computeFreshWeek()
→ reconcileWeekProgram()
```

Do not regenerate/rewrite locked Sep 7, Sep 8, or Sep 10.

No ad-hoc SQL.

No database migration.

---

# 23. Data-safety verification

Before any optional Sep 11 regeneration:

1. Back up SQLite.
2. Record hashes for:
   - workout_sessions
   - workout_exercises
   - workout_sets
   - goals
   - goal_events
   - goal_phases
   - goal_phase_reviews
   - aesthetic_assessments
   - measurements
3. Regenerate only through canonical reconciliation.
4. Verify hashes remain unchanged.
5. Verify locked sessions remain unchanged.
6. Verify no workout_* rows were added/modified.
7. Run:
   - `PRAGMA integrity_check`
   - `PRAGMA foreign_key_check`

---

# 24. Required implementation report

Create:

```text
docs/WORKOUT_PROGRAMMER_SAME_WEEK_HISTORY_RECOVERY_FIX_REPORT.md
```

Include:

1. Files changed.
2. Exact reference-date architectural change.
3. How current-week reconciliation now sees real same-week training.
4. How recovery scope changed.
5. How explanations changed.
6. Tests added.
7. Full test/typecheck/build/verification results.
8. Confirmation that no DB migration occurred.
9. Confirmation that no Blueprint data changed.
10. Confirmation that no historical workout data changed.
11. Confirmation that no fake exposure history was created.
12. Confirmation that locked days remain protected.
13. Explicit confirmation that the separate Class E multi-exercise per-exposure issue was NOT changed.

---

# 25. Final acceptance criteria

The task is complete only if:

### History
- Same-week completed sessions are visible to later same-week planning.
- Sep 8 history is correctly recognized by Sep 11 planning.
- Exact exercise variation history is preserved.
- Incomplete sets remain excluded.

### Recovery
- Same-day recovery remains enforced.
- Same-day recovery is not promoted to a whole-week skip.
- Recovery is evaluated against the actual candidate/simulated day.

### Explanations
- No false "first time" for an exercise with same-week history.
- No false "haven't trained this target this week" when actual exposure exists.
- "Earlier today" only appears for a true same-day condition.
- Historical dates are truthful.

### Architecture
- Programming week and history/as-of date are separate.
- Canonical generation/reconciliation callers use the correct history date.
- Rolling frequency and per-exposure architecture remain intact.
- No weekly debt bucket is reintroduced.
- No time/equipment filtering is reintroduced.

### Data safety
- No historical workout rows changed.
- No migration.
- No fake exposure.
- Locked days unchanged.
- Goals/measurements/assessments/phases unchanged.
- Blueprint unchanged.

### Validation
- Regression tests pass.
- Full test suite passes.
- Typecheck passes.
- Build passes.
- Existing verification passes.

## Core principle

The programmer must distinguish:

```text
WHAT WEEK AM I PROGRAMMING?
        ≠
HOW MUCH REAL TRAINING HISTORY DO I KNOW?
```

For example:

```text
programmingWeekStart = Sep 7
historyAsOfDate      = Sep 11
```

The week remains Sep 7–13, but the planner must not pretend it is still Monday morning.

Real completed training flows:

```text
REAL WORKOUT
→ SQLite
→ trainingState(asOfDate)
→ exposure/history/recovery
→ programmer
```

Generated plans flow separately:

```text
GENERATED PLAN
→ simulated planning state only
→ never actual exposure
```

Implement the smallest robust code change that establishes this separation without rewriting historical truth.
