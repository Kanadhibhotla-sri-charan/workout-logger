# Workout Programmer — Surgical Follow-Up Fix
## Current-Week Activity Overrides & Program Reconciliation

**Target:** Latest `workout-logger-main.zip` after the previous implementation
**Audience:** Claude / development agent
**Purpose:** Fix the remaining gap identified in review.
**Do not redo the already-accepted exercise-picker work.**

---

# 1. Current status

The previous implementation successfully addressed:

- Add Unplanned Exercise now uses a real searchable Blueprint picker.
- The picker searches the full Blueprint exercise library.
- Blueprint-ID validation remains intact.
- Existing Substitute behavior remains separate.
- Daily activity supports Gym / Badminton / Both / unselected.
- Badminton-only days no longer automatically become gym sessions.

Those parts are **accepted and must not be unnecessarily modified**.

The remaining problem is the distinction between:

1. the user's recurring Training Profile, and
2. the already-generated/current week's actual plan.

The current implementation changes the recurring profile and then relies on `/api/programming/week` recomputing the plan from that profile on every read.

That does **not** satisfy the requirement for a true current-week edit/reconciliation workflow.

---

# 2. Core requirement

When the user changes the activity of a day from the existing weekly program, the application must modify/reconcile the **current week's uncompleted plan**.

It must NOT simply behave as:

```text
Change current day
→ modify recurring profile
→ throw away/recompute the whole week
```

The desired behavior is:

```text
Current weekly program
→ user changes one day's activity
→ persist a current-week override
→ reconcile the affected uncompleted plan
→ preserve completed/history data
→ preserve unaffected future sessions where possible
```

---

# 3. Separate profile defaults from current-week overrides

The recurring Training Profile should remain the user's normal/default weekly activity pattern.

Example:

```text
Monday    Gym
Tuesday   Gym
Wednesday Unselected
Thursday  Gym
Friday    Gym
Saturday  Badminton
Sunday    Badminton
```

The current week may temporarily differ.

Example:

```text
Training Profile default:
Saturday = Badminton

Current week:
Saturday = Both
```

Changing Saturday for the current week must NOT silently change the user's recurring default unless the user explicitly edits/saves the profile.

This distinction is essential.

---

# 4. Current-week activity state

Introduce a persisted representation of the current week's per-day activity override.

Conceptually:

```text
week
weekday
activity
```

Activity:

```text
gym
badminton
both
```

No stored `rest` activity is required.

An absent override means:

> use the Training Profile's default for that day.

A current-week override can explicitly represent:

> unselected/rest

if needed.

Use the existing SQLite/schema/migration conventions. Do not introduce unnecessary new infrastructure.

If the existing program persistence model can safely support this without redundant tables, reuse it.

---

# 5. Existing program must be the basis for reconciliation

When the user changes a day from the weekly program:

1. Load the current week's persisted/generated program state.
2. Determine the existing activity for that day.
3. Apply the requested activity override.
4. Reconcile only the uncompleted portion of the week.
5. Preserve completed/logged sessions and history.
6. Preserve unaffected future sessions whenever possible.

Do NOT simply call the top-level fresh-program-generation operation and replace the whole week.

---

# 6. Required activity transitions

Every transition must work:

```text
Gym → Badminton
Badminton → Gym
Gym → Both
Both → Gym
Badminton → Both
Both → Badminton

Unselected → Gym
Unselected → Badminton
Unselected → Both

Gym → Unselected
Badminton → Unselected
Both → Unselected
```

The UI may display "Rest" or "No training" for the unselected state, but the persisted model should continue to use the existing unselected/absence semantics rather than introducing a redundant `rest` activity unless technically unavoidable.

---

# 7. Reconciliation behavior

## A. Gym → Badminton

If the day has an uncompleted gym session:

- remove that uncompleted gym plan from the day
- mark the day as badminton
- do not delete any historical/logged workout data
- if removing the gym day creates a programming allocation problem, redistribute only what is necessary across remaining eligible future gym days

Do not regenerate unrelated future sessions merely because one day changed.

---

## B. Badminton → Gym

If the day was badminton-only:

- retain the activity override as Gym
- create an appropriate gym session for that day using the existing programming logic
- account for the surrounding week's training load
- do not alter completed history

---

## C. Gym → Both

The day should become:

```text
Gym + Badminton
```

Retain/add an appropriate gym session and retain badminton.

Existing badminton/recovery/fatigue logic may be used to select an appropriate gym session.

Do not treat Both as merely a gym day with an informational note.

---

## D. Both → Badminton

Remove the uncompleted gym component for that day.

Retain badminton.

Do not delete completed workout history.

---

## E. Unselected → Gym / Badminton / Both

Add the selected activity to the current week.

For Gym or Both, create an appropriate gym component when required.

For Badminton, do not invent a gym session.

---

## F. Any activity → Unselected

Remove uncompleted planned training activity for that day.

Do not delete historical/logged workouts.

---

# 8. Minimal-change principle

The reconciliation algorithm should follow this priority:

### Priority 1
Never alter completed/logged history.

### Priority 2
Keep unaffected future sessions unchanged.

### Priority 3
Correctly represent the newly selected activity.

### Priority 4
If gym workload/session allocation needs redistribution, modify the minimum number of future uncompleted sessions required to maintain the existing programming constraints.

This is preferable to full-week regeneration.

---

# 9. Example acceptance scenario

Start with a generated week:

```text
Mon    Gym    Push
Tue    Gym    Pull
Wed    Rest
Thu    Gym    Legs
Fri    Gym    Push
Sat    Gym    Pull
Sun    Gym    Legs
```

User changes:

```text
Saturday: Gym → Badminton
```

Expected:

```text
Mon    Gym       Push
Tue    Gym       Pull
Wed    Rest
Thu    Gym       Legs
Fri    Gym       Push
Sat    Badminton
Sun    Gym       Legs
```

If the programming engine determines that the removed Saturday gym workload must be redistributed, it may adjust the minimum necessary future session(s), but it must not casually replace the entire weekly plan.

---

# 10. Temporary current-week change must not rewrite the default profile

Example:

Profile:

```text
Saturday = Badminton
```

Current week override:

```text
Saturday = Both
```

After the current week ends, the profile should still be:

```text
Saturday = Badminton
```

unless the user explicitly changes the Training Profile.

This allows real-life flexibility without constantly editing the default profile.

---

# 11. API design

Create/use a focused current-week endpoint.

Conceptually:

```text
PUT /api/programming/week/:weekId/days/:day/activity
```

or another route consistent with the project's conventions.

Request:

```json
{
  "activity": "gym"
}
```

Allowed activity values:

```text
gym
badminton
both
```

Use the existing unselected/clear convention for rest.

The endpoint must:

1. validate the activity
2. identify the current week
3. persist the override
4. reconcile the uncompleted plan
5. return the updated day/week state

Do not make the endpoint modify the recurring Training Profile unless the user explicitly requested a profile change.

---

# 12. UI behavior

The existing weekly-program activity-change UI can remain.

When the user selects a new activity:

```text
Change activity
→ save
→ reconcile
→ update the visible weekly program
```

The user should NOT be told:

> "Regenerate program to apply changes."

No manual regeneration should be required.

Show a small loading state while reconciliation occurs.

On failure:

- do not partially update the UI
- show a clear error
- retain the previous displayed state

---

# 13. Relationship with Training Profile UI

The Training Profile still controls the user's default recurring schedule.

The weekly program's activity selector controls the current week's actual schedule.

If the user explicitly edits the Training Profile, that should update the default profile according to the existing profile behavior.

Do not confuse the two operations.

If the existing application currently uses the same UI control for both, adjust the labeling/context so the user can understand whether they are editing:

- default Training Profile, or
- current week's plan.

---

# 14. Do not break the existing accepted features

The following must remain unchanged unless technically necessary:

## Add Unplanned Exercise

- Full Blueprint library.
- Searchable picker.
- Explicit exercise selection.
- Blueprint ID validation.
- No relevance filtering.

## Substitute

- Existing candidate/relevance/equipment-aware flow.
- Existing UI/behavior.
- Do not replace it with the unrestricted Add Unplanned Exercise picker.

---

# 15. Tests that are currently missing

Add tests specifically proving that this is a **current-week reconciliation**, not merely profile recomputation.

## Test 1 — Future-plan stability

1. Create/generate a week with multiple future gym sessions.
2. Capture the IDs/content of unaffected future sessions.
3. Change one future day from Gym → Badminton.
4. Reload the week.
5. Assert that:
   - changed day reflects Badminton
   - unaffected future sessions remain unchanged where no redistribution is required

---

## Test 2 — Profile remains unchanged

1. Profile default: Saturday = Gym.
2. Current week override: Saturday = Badminton.
3. Reload current week.
4. Confirm Saturday = Badminton.
5. Reload Training Profile.
6. Confirm default Saturday is still Gym.

---

## Test 3 — Gym → Both

1. Start with a Gym day.
2. Change to Both.
3. Confirm badminton is present.
4. Confirm an appropriate gym component remains/is created.
5. Confirm completed history is untouched.

---

## Test 4 — Rest → Gym

1. Start with an unselected/rest day.
2. Change to Gym.
3. Confirm a gym session is created.
4. Confirm other days are not unnecessarily regenerated.

---

## Test 5 — Completed-history protection

1. Have a completed/logged workout on a day.
2. Change that day's activity.
3. Confirm the historical workout/session/set records remain intact.
4. Only the future/uncompleted plan may change.

---

## Test 6 — All transitions

Parameterize tests for all required transitions:

```text
gym → badminton
badminton → gym
gym → both
both → gym
badminton → both
both → badminton
unselected → gym
unselected → badminton
unselected → both
gym → unselected
badminton → unselected
both → unselected
```

---

# 16. Important edge case

If the user changes the activity of a day **after that day's gym workout has already been completed/logged**:

- never delete or rewrite the completed workout
- do not retroactively turn the historical workout into badminton
- the activity override may affect only future/uncompleted planning

The app's training history is authoritative.

---

# 17. Verification

Run:

```bash
npm run verify
```

Then manually test:

1. Generate/load a week.
2. Change Gym → Badminton.
3. Refresh.
4. Confirm it remains changed.
5. Change Badminton → Both.
6. Refresh.
7. Change Both → Gym.
8. Change Gym → Unselected.
9. Change a rest day → Gym.
10. Log a workout.
11. Change a future day.
12. Confirm the logged workout is untouched.
13. Reload Training Profile.
14. Confirm current-week overrides did not silently rewrite the recurring profile.

Also inspect the final diff.

Do not deploy as part of this task.

---

# 18. Acceptance criteria

This task is complete only when:

- [ ] Current-week activity changes are persisted separately from recurring profile defaults.
- [ ] Changing a day does not require manual full-program regeneration.
- [ ] The current week is reconciled from the existing plan/state.
- [ ] Unaffected future sessions remain stable where possible.
- [ ] Redistribution occurs only when required.
- [ ] Completed/logged history is never deleted or rewritten.
- [ ] All activity transitions work.
- [ ] Gym-only, Badminton-only, Both, and unselected semantics remain correct.
- [ ] Add Unplanned Exercise still works exactly as before.
- [ ] Substitute still works exactly as before.
- [ ] Tests explicitly prove current-week reconciliation.
- [ ] `npm run verify` passes.
- [ ] No unrelated architectural changes are introduced.
- [ ] No deployment is performed during this task.

---

# 19. Implementation discipline

Before coding:

1. Inspect how `programs` and `program_sessions` are currently persisted.
2. Inspect how the current week is identified.
3. Inspect how completed vs future sessions are represented.
4. Determine the smallest safe persistence mechanism for current-week overrides.
5. Reuse existing planner/reconciliation logic where possible.

Do not invent a second competing weekly-program system if the existing persisted program model can be extended.

After coding:

1. Run the full test suite.
2. Run build/typecheck.
3. Review database migration behavior.
4. Review the diff for unrelated changes.
5. Verify the acceptance scenarios manually.
6. Report any unresolved ambiguity rather than silently choosing destructive behavior.

**The goal is a surgical fix to current-week activity editing, not a rewrite of the planner.**
