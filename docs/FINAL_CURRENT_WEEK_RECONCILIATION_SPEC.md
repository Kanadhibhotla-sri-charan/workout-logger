# Workout Programmer — Final Current-Week Reconciliation Fix

## Purpose

This is a **surgical follow-up fix** to the current Workout Programmer implementation.

The previous implementation correctly added:

- Full Blueprint exercise search for **Add Unplanned Exercise**
- First-class daily activities:
  - Gym
  - Badminton
  - Both
  - Unselected/Rest
- Persisted **current-week activity overrides** through `week_activity_overrides`
- Separation between recurring Training Profile defaults and current-week overrides

However, the current implementation still **rebuilds the entire week from the planner whenever the week is read**.

That is not sufficient for the intended product behavior.

The required behavior is:

> When the user changes an activity for the current week, preserve the already-generated future/uncompleted plan wherever possible and make only the minimum changes necessary to reconcile the week.

Do **not** redesign the application or replace the existing architecture unnecessarily.

---

# 1. Non-Negotiable Existing Behavior

## 1.1 Add Unplanned Exercise

KEEP the existing implementation.

It must continue to:

- Search the entire Blueprint exercise library
- Not filter by relevance, muscle group, goal, or generated program
- Display valid Blueprint exercises for selection
- Require an explicit selection
- Submit/store the underlying Blueprint exercise ID
- Reject arbitrary typed text that is not selected from the Blueprint library

Do not regress this feature.

## 1.2 Substitute

**DO NOT MODIFY THE SUBSTITUTE FLOW.**

The existing Substitute behavior is already correct.

Do not replace it with the Add Unplanned picker.

Do not alter:

- substitute candidate generation
- relevance ordering
- equipment filtering
- Blueprint/non-Blueprint candidate handling
- browser-side substitute selection behavior

Any changes required for current-week reconciliation must remain isolated from Substitute.

---

# 2. Existing Daily Activity Model

Keep the existing model:

```ts
type DailyActivity =
  | 'gym'
  | 'badminton'
  | 'both'
  | 'unselected';
```

UI may continue to display `unselected` as **Rest**.

Semantics:

| Activity | Gym | Badminton |
|---|---:|---:|
| Gym | Yes | No |
| Badminton | No | Yes |
| Both | Yes | Yes |
| Unselected / Rest | No | No |

Do not introduce a separate persisted `rest` activity unless there is a compelling existing architectural reason.

---

# 3. Recurring Training Profile vs Current Week

These are separate concepts and must remain separate.

## Recurring Training Profile

Represents the user's normal/default weekly schedule.

Example:

```text
Mon  Gym
Tue  Gym
Wed  Rest
Thu  Gym
Fri  Gym
Sat  Badminton
Sun  Badminton
```

## Current Week

Represents the actual plan for a particular calendar week.

It may temporarily override the recurring profile.

Example:

```text
Recurring:
Sat = Badminton

Current week:
Sat = Both
```

Changing Saturday for the current week must **NOT** change the recurring Training Profile.

The existing `week_activity_overrides` implementation should be retained.

---

# 4. Critical Missing Requirement: True Plan Reconciliation

## Current problem

The current implementation effectively does:

```text
Current Profile
      +
Current Week Override
      ↓
Build entire weekly plan again
      ↓
Return newly generated week
```

This is not true reconciliation.

It can make the output look correct while still discarding the identity/state of the already-generated future plan.

## Required behavior

The system must instead behave conceptually like:

```text
Existing Current-Week Plan
          +
New Activity Override
          ↓
Reconcile only what changed
          ↓
Preserve unaffected future/uncompleted sessions
          ↓
Redistribute only when necessary
```

The exact persistence mechanism should reuse the application's existing structures where practical.

Do not create a second, unnecessary workout-program architecture.

---

# 5. Persistence Requirement

There must be a persisted representation of the current week's generated plan/state sufficient to distinguish:

1. Existing sessions that were already generated
2. Sessions that are completed
3. Sessions that are in progress / have logged activity
4. Future/uncompleted sessions that should be preserved
5. Newly required sessions caused by an activity change
6. Sessions that must be removed or replaced because an activity was removed

The implementation may extend existing program/session persistence if appropriate.

Do not blindly create duplicate weekly-program tables if the existing database model can safely support this.

The important requirement is behavioral correctness, not a specific table design.

---

# 6. Reconciliation Rules

When a current-week activity is changed:

## Rule A — Preserve unaffected future sessions

If a future/uncompleted session does not need to change because of the activity override:

**Keep it.**

Do not regenerate its exercise prescription merely because the planner was called again.

For example:

```text
Mon Push A
Tue Pull A
Thu Legs A
Fri Push B
Sat Badminton
Sun Rest
```

Changing Wednesday:

```text
Rest → Gym
```

must not unnecessarily regenerate:

```text
Mon Push A
Tue Pull A
Thu Legs A
Fri Push B
Sat Badminton
Sun Rest
```

Only Wednesday's required change should be introduced, with redistribution only if required.

---

# 7. New Gym Day

If:

```text
Rest → Gym
```

for a current-week day:

1. Preserve unaffected existing future sessions.
2. Determine whether the weekly gym programming now requires an additional session.
3. Add/reconcile only the necessary session.
4. Do not regenerate unrelated sessions.
5. Preserve completed history.

Example:

```text
Existing:
Mon Push A
Tue Pull A
Thu Legs A
Fri Push B
Sat Badminton

Wednesday → Gym
```

The result should preserve existing sessions wherever possible and introduce/reconcile Wednesday rather than rebuilding Monday, Tuesday, Thursday, Friday, etc.

---

# 8. Gym → Badminton

If:

```text
Gym → Badminton
```

for a current-week day:

1. The day's gym session must no longer be treated as an active gym session.
2. Existing completed/logged workout history must remain untouched.
3. If the removed future gym workload needs redistribution to maintain the intended weekly structure, redistribute only the necessary workload.
4. Preserve unrelated future sessions.
5. Do not alter the recurring profile.

---

# 9. Gym → Both

If:

```text
Gym → Both
```

then:

- Keep the gym session for that day wherever possible.
- Add badminton as the day's activity/context.
- Do not create a second gym workout merely because the activity is `both`.

Expected semantics:

```text
Both = one gym session + badminton activity
```

---

# 10. Badminton → Gym

If:

```text
Badminton → Gym
```

then:

- Remove badminton from the current week's activity for that day.
- Introduce/reconcile the required gym session.
- Preserve unrelated existing future sessions.
- Do not alter the recurring Training Profile.

---

# 11. Badminton → Both

If:

```text
Badminton → Both
```

then:

- Preserve the badminton activity.
- Add the gym session required for the day.
- Do not create duplicate badminton entries.
- Preserve unrelated future sessions.

---

# 12. Both → Gym

If:

```text
Both → Gym
```

then:

- Keep the gym session.
- Remove badminton from the current week's activity.
- Do not unnecessarily regenerate the gym prescription.

---

# 13. Both → Badminton

If:

```text
Both → Badminton
```

then:

- Remove the current week's gym activity.
- Preserve badminton.
- Redistribute gym workload only if required.
- Preserve unrelated future sessions.

---

# 14. Any Activity → Rest

If a day becomes:

```text
Unselected / Rest
```

then:

- No gym session should remain scheduled for that day unless it is already completed/in-progress and therefore historical state must be preserved.
- No badminton activity should remain for that current-week day.
- Any future gym workload that genuinely needs redistribution should be handled minimally.
- Do not alter unrelated future sessions.

---

# 15. Rest → Any Activity

If a rest day becomes:

- Gym
- Badminton
- Both

then introduce only the necessary current-week activity/session.

Do not regenerate unrelated future workouts.

---

# 16. Completed / Logged History Is Immutable

This is a hard requirement.

If a workout has already been:

- completed
- logged
- partially logged/in progress

then changing the current week's activity must **never delete, rewrite, or silently replace the historical workout record**.

The system must preserve:

- WorkoutSession
- logged exercises
- sets
- reps
- weights
- timestamps
- completion state

Current-week reconciliation applies to the **remaining future/uncompleted plan**, not historical activity.

---

# 17. Today Endpoint

`/api/programming/today` must use the same current-week activity override/reconciliation state as `/api/programming/week`.

It must not independently reconstruct a contradictory version of today's plan.

If today's activity is changed:

- the UI must immediately reflect the current-week override
- the underlying current-week plan must remain consistent
- historical logged data must remain untouched

---

# 18. Week Endpoint

`/api/programming/week` must return the persisted/reconciled current-week state.

It must NOT simply discard the existing week's plan and regenerate the entire week on every GET.

Repeated calls to:

```text
GET /api/programming/week
```

must return the same persisted plan/state unless an explicit user action or other legitimate state transition changes it.

---

# 19. Current-Week Override API

Keep the existing current-week activity endpoint:

```text
PUT /api/programming/week/days/:day/activity
```

It should:

1. Validate the requested activity.
2. Determine the relevant current week.
3. Persist the activity override.
4. Reconcile the existing current-week plan.
5. Return the resulting current-week state.

Do not route current-week edits through:

```text
/api/training-profile/daily-activities/:day
```

The recurring profile endpoint must remain for recurring/default profile editing.

---

# 20. Important Preservation Principle

The planner may still be used when genuinely necessary.

However:

> **Planner output must not automatically overwrite an existing future session simply because the planner was invoked again.**

If an existing session is still valid under the new activity configuration, preserve it.

If a session must change, change only that session or the minimum affected set.

---

# 21. Avoid Overengineering

Do NOT:

- rewrite the entire workout engine
- replace SQLite
- introduce a new backend framework
- introduce a new frontend framework
- change deployment architecture
- change Nginx/systemd
- modify Substitute
- modify Add Unplanned Exercise unnecessarily
- remove `week_activity_overrides`
- create duplicate scheduling systems without need

Make the smallest safe change that satisfies the actual behavior.

---

# 22. Required Tests

Add/modify tests so that they test **state preservation**, not merely deterministic planner output.

## 22.1 Persisted future-session preservation

Test:

1. Generate a current week.
2. Capture an existing future session's persisted identity/prescription.
3. Change an unrelated day's activity.
4. Re-read the week.
5. Assert the original future session remains the same persisted session/prescription.

Do NOT merely assert that two fresh planner calls happen to return equal JSON.

---

## 22.2 Current-week override isolation

Test:

1. Set recurring Saturday = Badminton.
2. Change current-week Saturday = Both.
3. Assert current week = Both.
4. Assert recurring profile still = Badminton.

---

## 22.3 All activity transitions

Test all meaningful transitions:

```text
Gym → Badminton
Gym → Both
Gym → Rest

Badminton → Gym
Badminton → Both
Badminton → Rest

Both → Gym
Both → Badminton
Both → Rest

Rest → Gym
Rest → Badminton
Rest → Both
```

---

## 22.4 Completed history protection

Test:

1. Create/log/complete a workout session.
2. Change that day's current-week activity.
3. Assert the historical session still exists unchanged.
4. Assert logged exercises/sets/reps remain unchanged.

---

## 22.5 Repeated GET stability

Test:

```text
GET /api/programming/week
GET /api/programming/week
GET /api/programming/week
```

and ensure the persisted current-week state is stable.

The test should detect accidental regeneration that creates new session identities or changes future prescriptions.

---

## 22.6 Today consistency

Test that:

```text
GET /api/programming/today
```

and the corresponding day in:

```text
GET /api/programming/week
```

agree on the current activity/session state.

---

# 23. Existing Feature Regression Tests

Ensure the following still pass:

### Add Unplanned Exercise

- full Blueprint library available
- explicit selection required
- Blueprint ID submitted
- arbitrary text rejected

### Substitute

- existing substitute behavior unchanged
- candidate filtering/order unchanged
- existing Substitute tests pass

---

# 24. Database Safety

If schema changes are required:

- use the existing SQLite migration/schema conventions
- make migrations safe to run on an existing database
- do not delete existing workout history
- do not drop existing program/session tables
- preserve existing data

The implementation must work against an already-used production-style database containing workout history.

---

# 25. Verification Requirements

Before declaring the work complete, run:

```bash
npm run verify
```

This must pass cleanly.

Also run any additional relevant tests specifically covering:

- current-week reconciliation
- persisted session preservation
- activity transitions
- completed history
- Add Unplanned Exercise
- Substitute

If verification cannot be run, **do not claim that it passed**.

---

# 26. Final Acceptance Criteria

The implementation is accepted only if ALL are true:

- [ ] Add Unplanned Exercise still searches the full Blueprint library.
- [ ] Add Unplanned requires an actual Blueprint selection.
- [ ] Substitute is unchanged.
- [ ] Gym / Badminton / Both / Rest semantics are correct.
- [ ] Recurring Training Profile and current-week overrides are separate.
- [ ] Current-week activity changes do not modify recurring profile defaults.
- [ ] Current-week overrides persist after reload.
- [ ] The current week's existing future/uncompleted sessions are preserved where possible.
- [ ] The entire week is NOT blindly regenerated on every read.
- [ ] Reconciliation changes only the minimum necessary sessions.
- [ ] Gym workload is redistributed only when actually necessary.
- [ ] Completed/in-progress history is never deleted or rewritten.
- [ ] `/week` and `/today` remain consistent.
- [ ] All activity transitions are tested.
- [ ] Tests prove persisted session preservation, not just deterministic output equality.
- [ ] Existing Add Unplanned tests pass.
- [ ] Existing Substitute tests pass.
- [ ] `npm run verify` passes cleanly.
- [ ] No deployment or infrastructure changes are made as part of this task.

---

# 27. Final Instruction to the Implementer

**Do not treat this as a request to redesign the Workout Programmer.**

The previous implementation already solved most of the feature.

Your job now is to make the smallest targeted change that turns:

```text
current-week override + full regeneration
```

into:

```text
current-week override + persisted plan reconciliation
```

while preserving existing future sessions and historical workout data.

When finished, provide:

1. A concise summary of files changed.
2. A concise explanation of how persisted current-week reconciliation works.
3. The exact test command(s) run.
4. The actual verification result.
5. Any migration/schema changes made.
6. Confirmation that Add Unplanned Exercise was preserved.
7. Confirmation that Substitute was not modified.
8. Confirmation that no deployment was performed.
