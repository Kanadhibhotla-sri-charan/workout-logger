# Fixes Task: AI Session Alignment, Activity Changes, and Non-Regenerative Plan Adjustments

## Context

The current implementation supports:

- Persisted weekly programming.
- Week-scoped manual activity overrides.
- Deterministic weekly-program reconciliation.
- AI-generated workout proposals.
- Committing an AI proposal into a planned gym session.

The review identified a gap between the weekly activity/program representation and AI-created planned sessions.

An additional product clarification is important:

> A change of plans should not automatically trigger a new program generation. Sometimes the user only wants a simple schedule swap, such as moving Thursday's gym session to Wednesday and moving Wednesday's rest day to Thursday.

This task should therefore separate:

1. **Schedule adjustments/swaps**, which may only move existing planned activities or prescriptions.
2. **Program regeneration**, which should happen only when the user explicitly requests it or when the change genuinely requires a new prescription.
3. **AI session replacement/alignment**, which must not silently create contradictions between weekly activity state and persisted workout sessions.

---

## Objective

Make activity changes and AI session commits predictable, explicit, and consistent without unnecessarily regenerating the user's program.

The implementation must preserve the distinction between:

- Changing the schedule.
- Replacing an activity.
- Regenerating a workout prescription.
- Creating an additional workout session.
- Editing or cancelling an already-created session.

Do not collapse all of these into one operation.

---

## Important Product Principle

### Do not regenerate by default

A user changing plans does not necessarily want a new workout program.

Examples:

- Move Thursday's existing gym session to Wednesday.
- Move Wednesday's rest day to Thursday.
- Move a gym prescription from one day to another without changing its exercises.
- Swap two days in the current weekly schedule.
- Change today's activity temporarily while preserving the rest of the generated week.

These should be treated as **schedule operations** where possible.

A new program generation should occur only when:

- The user explicitly asks for a new program or regenerated prescription.
- The requested change cannot be represented by moving/swapping existing activities.
- The existing prescription is no longer valid for the new context.
- A deterministic reconciliation rule explicitly requires regeneration.

The system should not regenerate merely because an activity label changed.

---

# Scope of Work

## Part 1 — Separate schedule changes from program regeneration

### 1.1 Define operation types

Introduce clear conceptual operation types.

Suggested model:

```ts
type ScheduleChangeMode =
  | 'swap'
  | 'move'
  | 'replace'
  | 'regenerate';
```

These names are illustrative. Adapt them to the existing architecture and naming conventions.

Definitions:

#### `swap`

Exchange the activities/program assignments of two days.

Example:

```text
Wednesday: Rest
Thursday: Gym A
```

After swap:

```text
Wednesday: Gym A
Thursday: Rest
```

The existing gym prescription should move with the gym activity where possible.

#### `move`

Move an activity or existing prescription from one day to another, leaving the source day with an appropriate resulting activity.

Example:

```text
Thursday Gym A → Wednesday
Thursday becomes Rest
```

#### `replace`

Replace a day's activity with another activity.

Example:

```text
Wednesday Rest → Gym
```

This may require a new gym prescription if no valid existing prescription can be moved or reused.

#### `regenerate`

Explicitly generate a new prescription/program based on the new schedule or changed goals/context.

This must be opt-in unless the system determines that reuse is impossible and the user has approved regeneration.

---

## Part 2 — Implement a simple schedule swap without regeneration

### Desired behavior

Given:

```text
Wednesday: Rest
Thursday: Gym with existing prescription A
```

The user requests:

```text
Swap Wednesday and Thursday
```

Expected result:

```text
Wednesday: Gym with prescription A
Thursday: Rest
```

### Requirements

- Reuse the existing gym prescription wherever possible.
- Do not invoke the LLM.
- Do not generate a new workout merely because the day changed.
- Do not alter the recurring profile.
- Store the change as a current-week schedule override or equivalent persisted schedule mutation.
- Preserve the identity of the existing prescription/session where the data model permits it.
- Ensure `/api/programming/week`, `/api/programming/today`, and the logger agree.
- Ensure the swap is reversible.
- Ensure repeated application does not produce additional duplicate sessions or prescriptions.

### Important distinction

A schedule swap is not necessarily the same as two independent activity overrides.

Naively applying:

```text
Wednesday = Gym
Thursday = Rest
```

may cause the reconciliation engine to discard or recreate the Thursday prescription depending on how it interprets overrides.

The implementation must explicitly preserve/move the relevant program assignment rather than relying on accidental regeneration behavior.

---

## Part 3 — AI proposal commit must explicitly define replacement behavior

### Current issue

AI proposal commit creates a planned gym session but does not necessarily update the weekly activity/program representation.

This can produce:

```text
Weekly program: Wednesday = Rest
Workout sessions: Wednesday = Planned Gym
```

### Required behavior

AI commit must not silently create a contradiction.

Before committing an AI proposal, the system must know whether the proposal is:

1. A workout for an existing gym day.
2. A replacement for a non-gym activity.
3. An additional session.
4. A replacement for an existing planned session.

### Initial implementation recommendation

For this vertical slice, support only explicit replacement or existing-gym-session completion.

Do not implement additional same-day sessions unless the data model and UI fully support them.

Suggested intent:

```ts
type AICommitIntent =
  | 'fill_existing_gym_day'
  | 'replace_day_activity';
```

Potential behavior:

#### Existing gym day

If the target day is already Gym:

- Treat the AI proposal as the workout prescription for that gym day.
- Do not create a duplicate planned gym session if one already exists.
- Reuse or explicitly replace the existing planned session according to defined rules.

#### Rest or badminton day

If the target day is Rest or Badminton:

- Require explicit user confirmation that the AI workout replaces the day's planned activity.
- Update the current-week activity representation consistently.
- Then create or associate the planned AI gym session.
- Do not silently treat it as an additional session.

#### Additional session

Do not support this in the first implementation unless explicitly designed and tested.

---

## Part 4 — Define conflict behavior for existing sessions

The system must distinguish session status before changing the day.

### Completed session

- Never delete or rewrite it.
- Preserve it as historical truth.
- Do not retroactively change its activity type because the weekly schedule changed.

### In-progress session

- Do not silently replace or remove it.
- Reject the conflicting schedule change with a clear explanation.
- Require a separate abandon/cancel workflow if such a workflow exists.

### Planned session

- Do not silently delete it.
- Either:
  - Reuse/move it when the operation is a valid schedule move/swap, or
  - Require explicit cancellation/replacement confirmation.

### No session

- A replacement can create a new planned session if the user explicitly requested it.
- A simple swap should reuse the existing prescription where possible.

---

## Part 5 — Define how weekly program persistence interacts with swaps

Inspect and preserve the existing responsibilities of:

- `src/server/routes/programming.ts`
- `src/engine/weekProgramReconciliation.ts`
- `src/repositories/weekActivityOverridesRepo.ts`
- Weekly program persistence/read services
- Workout session repositories
- AI proposal lifecycle services

### Required design decision

Determine whether the current persisted weekly-program model can represent:

```text
Wednesday = existing Thursday gym prescription
Thursday = rest
```

without generating a new prescription.

If it cannot, extend the model or add a schedule-assignment layer rather than forcing the deterministic planner to regenerate unnecessarily.

Possible conceptual separation:

```text
Weekly activity schedule
    ↓
Program assignment / prescription identity
    ↓
Workout session instance
```

The exact implementation should follow the current schema and architecture.

### Do not do this

Do not solve the issue by making `/week` infer gym activity from any row in `workout_sessions`.

The weekly program should remain authoritative for weekly schedule representation. Session data should not silently override it during reads.

---

# API / UI Considerations

## User-facing actions should be explicit

Potential actions:

- `Swap days`
- `Move workout`
- `Replace today's activity`
- `Generate a new workout`
- `Regenerate this week`

Do not present all of these as one generic “change activity” action if their effects differ.

### Example UI confirmation

For Rest → AI Gym:

> Wednesday is currently Rest. Do you want to replace Wednesday's activity with this gym workout, or keep Rest and add a separate session?

If additional sessions are not supported:

> This version supports replacing the day's activity. It will not add a second same-day session.

For Thursday Gym → Wednesday:

> Move Thursday's existing gym workout to Wednesday without generating a new workout?

This should be a schedule operation, not a regeneration request.

---

# Acceptance Criteria

## Schedule swap

- [ ] Wednesday Rest and Thursday Gym can be swapped.
- [ ] The existing Thursday gym prescription is reused on Wednesday.
- [ ] Thursday becomes Rest.
- [ ] No LLM call occurs.
- [ ] No new prescription is generated unnecessarily.
- [ ] No duplicate planned session is created.
- [ ] The recurring profile remains unchanged.
- [ ] The weekly response reflects the swap.
- [ ] The today response reflects the swap.
- [ ] The logger reflects the same assignment.
- [ ] Repeating the same request is idempotent.
- [ ] The swap can be reversed.

## Manual replacement

- [ ] Rest → Gym requires an explicit replacement action.
- [ ] Badminton → Gym requires an explicit replacement action.
- [ ] If a valid existing gym prescription can be moved/reused, it is reused.
- [ ] If a new prescription is required, the system does not generate it silently.
- [ ] The user is told when regeneration is required or selected.
- [ ] Weekly activity and planned session remain consistent.

## AI proposal commit

- [ ] AI commit identifies whether it fills an existing gym day or replaces another activity.
- [ ] Rest/badminton → Gym cannot silently create a planned gym session while weekly activity remains unchanged.
- [ ] Existing planned sessions are handled explicitly.
- [ ] Repeated commit remains idempotent.
- [ ] Completed sessions are never deleted.
- [ ] In-progress sessions are protected.
- [ ] Failed alignment does not leave an orphaned session or inconsistent override.
- [ ] No additional same-day session behavior is introduced accidentally.

## Regeneration control

- [ ] A simple swap does not invoke the planner/LLM unnecessarily.
- [ ] Explicit regeneration still works.
- [ ] The UI/API clearly distinguishes schedule adjustment from regeneration.
- [ ] Existing deterministic generation behavior remains intact for cases that genuinely require it.

---

# Test Matrix

## Swap tests

1. Rest Wednesday ↔ Gym Thursday.
2. Badminton Wednesday ↔ Gym Thursday.
3. Gym Monday ↔ Gym Thursday.
4. Swap twice and verify the original state is restored.
5. Swap when one day has no persisted prescription.
6. Swap when the gym day has a planned session.
7. Swap when the gym day has a completed session.
8. Swap when the gym day has an in-progress session.
9. Repeat the same swap request.
10. Verify no duplicate sessions or prescriptions.

## Replacement tests

1. Rest → Gym with no existing session.
2. Badminton → Gym with no existing session.
3. Rest → Gym when a reusable gym prescription exists elsewhere in the week.
4. Gym → Rest with no session.
5. Gym → Rest with planned session.
6. Gym → Rest with in-progress session.
7. Gym → Rest with completed session.
8. Replacement attempt without explicit intent.
9. Replacement failure halfway through the operation.

## AI tests

1. AI proposal for an existing gym day.
2. AI proposal for a rest day with explicit replacement.
3. AI proposal for a badminton day with explicit replacement.
4. AI proposal for a rest day without replacement intent.
5. AI proposal when another planned session exists.
6. Repeated commit of the same proposal.
7. Commit failure after session creation begins.
8. Commit failure while updating weekly activity.
9. Verify `/week`, `/today`, and logger consistency.
10. Verify no unintended LLM call during a simple schedule swap.

---

# Non-Goals

Do not include the following unless separately approved:

- Full multi-activity-per-day scheduling.
- Automatic support for badminton plus gym as two independent same-day sessions.
- Full-week AI program generation.
- Automatic recurring-profile changes.
- Rewriting historical/completed workout sessions.
- Making `/week` infer activity from workout-session rows.
- Regenerating the entire week for every activity change.
- Silent cancellation or deletion of planned sessions.
- Replacing the deterministic planner with an LLM.

---

# Implementation Guidance

1. Inspect the existing weekly override and reconciliation behavior before changing schemas.
2. Identify whether prescription identity can move between days without recreation.
3. Prefer a dedicated schedule-operation service over embedding swap logic directly in route handlers.
4. Keep read endpoints deterministic and based on persisted weekly-program state.
5. Keep AI proposal commit transactional.
6. Coordinate weekly activity assignment and planned-session creation in one consistent workflow.
7. Use explicit intent fields rather than inferring replacement from the mere existence of an AI proposal.
8. Preserve historical sessions.
9. Add tests before changing behavior in the reconciliation engine.
10. Run the full verification command after implementation:

```bash
npm run verify
```

---

# Final Expected Outcome

The system should support three clearly different user intentions:

### 1. “Move Thursday's workout to Wednesday”

A simple schedule move/swap.

- Reuse the existing prescription.
- No unnecessary regeneration.
- No LLM call.

### 2. “I want to train today instead of resting”

An explicit activity replacement.

- Update the current day's activity.
- Create or reuse a gym prescription/session as appropriate.
- Keep weekly state and session state aligned.

### 3. “Generate a new workout/program for this changed situation”

An explicit regeneration request.

- Invoke the relevant deterministic/AI generation flow.
- Clearly communicate that a new prescription is being generated.

These must not be treated as the same operation.
