# Final Fix Specification — Selected Session Resolution and AI/Deterministic Precedence

## Context

This document defines the remaining fixes identified in the 13 September 2026, 14:19 review of the Workout Logger / AI Workout Programmer vertical slice.

The current implementation has correctly added explicit AI commit intents, transactional commits, provenance, supersession metadata, idempotency, and protection for completed/in-progress sessions.

The remaining work is focused on ensuring that the application has one unambiguous authoritative workout per user/date and that all API/UI surfaces resolve that workout consistently.

---

# 1. Replace `findRealGymSession()` with an Authoritative Resolver

## Problem

The current implementation uses a helper similar to:

```ts
function findRealGymSession(database: Database.Database, date: string) {
  return new WorkoutSessionsRepo(database)
    .listSessionsByDate(date)
    .find((session) => session.session_type === 'gym');
}
```

This returns the first Gym session, commonly based on database ordering such as `start_time ASC`.

That is not a valid precedence rule when multiple sessions exist for the same date.

Possible conflicts include:

- Deterministic session + AI session.
- Deterministic session + manual session.
- AI session + manual session.
- Completed session + newer planned session.
- Multiple AI sessions.
- A superseding AI session appearing after the deterministic session.

## Required fix

Create a single authoritative resolver, for example:

```ts
resolveSelectedSession(userId: string, date: string)
```

or an equivalent service appropriate to the existing architecture.

The resolver must inspect all relevant candidates and return one selected result based on explicit precedence rules.

It must never select a session merely because it is the first row returned by a repository query.

## Suggested return shape

```ts
type SelectedSessionResolution = {
  source: 'deterministic' | 'ai' | 'manual' | null;
  sessionId: string | null;
  programSessionId: string | null;
  status: 'planned' | 'in_progress' | 'completed' | null;
  plannedWorkSource: 'deterministic' | 'session' | null;
  isSuperseding: boolean;
};
```

Adapt field names to the existing codebase rather than introducing unnecessary duplication.

---

# 2. Define and Centralize Session Precedence

## Required precedence

Use a single documented rule across all read and write paths.

Recommended precedence:

1. A completed or in-progress workout remains authoritative for historical/active execution purposes.
2. An explicitly selected AI or manual replacement is authoritative over the deterministic prescription.
3. The deterministic `program_sessions` prescription is authoritative when no replacement exists.
4. If no session exists, return Rest or Unplanned according to the schedule model.

The exact ordering may be adjusted if the product model requires a different interpretation, but it must be explicit and consistent.

## Important distinction

The resolver must answer both:

1. Which session is authoritative?
2. Whether deterministic `plannedWork` should be displayed.

A helper that only returns:

```ts
{ showDeterministic: boolean }
```

is not sufficient by itself.

---

# 3. Enforce One Selected Planned Workout per User/Date

## Problem

The current conflict checks reduce duplicate creation but do not provide a database-level guarantee that only one planned workout is selected for a date.

The following concepts must not be conflated:

- A stored historical session.
- A deterministic program prescription.
- An AI-generated session.
- A selected user-facing planned workout.
- A superseded session.

## Required fix

Introduce explicit selected-session semantics.

Possible approaches:

### Option A: Selected flag

Add a field such as:

```text
selected = true/false
```

to the relevant session table.

Then enforce uniqueness for selected sessions:

```text
UNIQUE(user_id, date) WHERE selected = true
```

Use a partial unique index if supported by the database.

### Option B: Selected-session mapping

Create a dedicated mapping table:

```text
selected_sessions
-----------------
user_id
date
session_id
```

Enforce:

```text
UNIQUE(user_id, date)
```

This can be preferable if historical sessions must remain untouched and selection is a separate concern.

### Option C: Existing single-user model

If the application is intentionally single-user and the schema does not contain `user_id`, enforce uniqueness using the actual ownership key and document the single-user assumption.

## Required behavior

When an AI session supersedes a deterministic prescription:

- The AI session becomes the selected planned workout.
- The deterministic prescription remains available as baseline/history if needed.
- The deterministic prescription must not also appear as a second active planned workout.
- The relationship must be auditable through fields such as:
  - `source_type`
  - `supersedes_program_session_id`
  - `selected`

`supersedes_program_session_id` is provenance metadata. It is not a substitute for selected-session enforcement.

---

# 4. Make AI Supersession Atomic

When an AI workout replaces a deterministic prescription, the transaction must atomically:

1. Validate the proposal and current schedule state.
2. Validate that the target date is eligible.
3. Resolve the deterministic program session, if one exists.
4. Create or update the AI workout session.
5. Mark the AI session as selected.
6. Mark or record the deterministic prescription as superseded.
7. Persist exercises and planned set prescriptions.
8. Mark the AI proposal as committed.

If any step fails, none of the changes should remain.

## Required invariant

There must never be a committed AI proposal that has no corresponding selected workout session.

There must never be a selected AI workout that is only partially persisted.

---

# 5. Strengthen Deterministic Program-Session Ownership

## Problem

The current supersession lookup maps the target date to a weekly program session using the week start and day index.

That is reasonable, but the lookup should verify that the matched prescription belongs to the active/current program.

## Required checks

Before assigning `supersedes_program_session_id`, verify:

- The weekly program is the active/current program.
- The week snapshot is valid for the target date.
- The day index maps to the target date correctly.
- The matched program session is not archived or obsolete.
- The proposal is not operating against stale program state.
- There is no ambiguity caused by multiple active programs.

If the application guarantees one active program, document that invariant and add a test.

---

# 6. Make `/today`, `/week`, and Logger Use the Same Resolver

## Problem

The weekly route currently uses a display decision such as `showDeterministic`, while actual session selection may still be performed by a separate helper.

This creates a risk that different surfaces select different workouts.

## Required fix

Use the same authoritative resolver for:

- `/today`
- `/week`
- Workout detail
- Logger initialization
- Logger completion
- Daily summary/progress
- Any “open today's workout” action

## Required response shape

The API should expose an explicit selected workout object, for example:

```json
{
  "activity": "gym",
  "selectedPlannedWorkout": {
    "sessionId": "session-123",
    "source": "ai",
    "status": "planned",
    "isSelected": true,
    "supersedesProgramSessionId": "program-session-456"
  },
  "plannedWork": null
}
```

The exact schema may differ, but the frontend must not infer authority from `plannedWork` being empty.

## Required UI invariant

For a given date:

```text
/today selected workout
=
/week selected workout
=
logger-opened workout
=
logger-completed workout
```

If an AI session supersedes deterministic programming, the UI must not show Rest or “no workout planned” simply because deterministic `plannedWork` is null.

---

# 7. Keep `plannedWork` and `plannedSession` Semantically Clear

## Required semantics

- `plannedWork` represents deterministic weekly exercise programming.
- `plannedSession` or `selectedPlannedWorkout` represents the actual selected persisted workout session.
- An AI/manual session must not fabricate deterministic `plannedWork`.
- An empty/null `plannedWork` must not imply that no workout exists if a selected persisted session exists.

## Recommended API documentation

```text
plannedWork:
  Deterministic program prescription, when applicable.

selectedPlannedWorkout:
  The authoritative persisted workout selected for the date.

If selectedPlannedWorkout exists, it is the workout the user should open and perform.
```

---

# 8. Clarify `reuse`, `swap`, `move`, and `regenerate`

## `reuse`

`reuse` means:

> Use the prescription already assigned to the target date.

It does not:

- Search other dates.
- Move another day's prescription.
- Borrow a prescription from elsewhere in the week.
- Implicitly regenerate a workout.

If the target date has no reusable prescription, return a clear result or error.

## `swap`

`swap` means:

> Exchange the schedule assignments of two dates.

A pure swap must:

- Be deterministic.
- Not invoke the LLM.
- Not regenerate exercises.
- Preserve historical workout records.
- Reject protected completed/in-progress cases.

## `move`

`move` means:

> Move a specific activity/prescription from one date to another, with explicit source-date behavior.

The API must state what happens to the source date:

- It becomes Rest.
- It receives the displaced target activity.
- It retains another explicitly specified activity.

Do not leave source-date behavior implicit.

## `regenerate`

`regenerate` means:

> Create a new exercise prescription for a date.

It may invoke deterministic generation or AI according to explicit policy.

It must not be triggered implicitly by:

- Swap.
- Move.
- Schedule-only activity change.
- Reuse.

---

# 9. Define Movable Session Ownership and Protection

## Movable sessions

The following may be movable if unstarted:

- Future deterministic prescriptions.
- Future selected AI sessions.
- Future selected manual sessions.

## Protected sessions

The following must not be silently moved, overwritten, or converted:

- In-progress workouts.
- Completed workouts.
- Historical logged exercise/set data.

## Required rejection behavior

Reject operations when:

- The source session is completed.
- The source session is in progress.
- The target date has an unresolved competing session.
- Multiple possible owners exist.
- The requested operation would overwrite historical data.
- The selected session cannot be determined unambiguously.

Errors should be user-safe and explain the action required.

---

# 10. Add Mixed-Source Conflict Handling

The commit and scheduling services must explicitly handle these combinations:

- Deterministic + AI.
- Deterministic + manual.
- AI + manual.
- Completed deterministic + planned AI.
- In-progress deterministic + planned AI.
- Multiple AI sessions.
- Existing superseded session + new AI proposal.
- Existing selected session + idempotent recommit.

The result must always be one of:

1. Select the existing authoritative session.
2. Explicitly replace/supersede it.
3. Reject the operation with a clear conflict.
4. Perform a supported deterministic swap/move.

Never silently create another competing selected workout.

---

# 11. Required Regression Test Matrix

## A. Authoritative resolver

- No session; deterministic prescription exists.
- Deterministic session only.
- AI session supersedes deterministic session.
- Manual session supersedes deterministic session.
- AI and manual sessions coexist.
- Multiple AI sessions exist.
- Completed session plus planned replacement.
- In-progress session plus planned replacement.
- Resolver does not depend on repository row order.
- Resolver returns source, ID, status, and supersession metadata.

## B. Selected-session uniqueness

- Two AI commits target the same date concurrently.
- AI commit targets a date with deterministic prescription.
- AI commit targets a date with selected manual session.
- Database rejects duplicate selected sessions.
- Recommitting a committed proposal is idempotent.
- Failed transaction leaves no selected orphan session.

## C. AI commit

- `fill_existing_gym_day` with deterministic Gym day.
- `fill_existing_gym_day` with deterministic Rest day.
- `replace_day_activity` from Rest to Gym.
- `replace_day_activity` from Gym to Rest, where supported.
- Invalid or missing intent.
- Stale proposal.
- Existing selected session conflict.
- Supersession metadata is correct.
- All writes commit atomically.

## D. Reuse

- Reuse existing target-date prescription.
- Reuse with no target-date prescription.
- Another date has a prescription, but target does not.
- Confirm reuse does not move another date's prescription.
- Confirm reuse never silently regenerates.

## E. Swap

- Gym ↔ Rest.
- Gym ↔ Gym.
- Rest ↔ Rest.
- Swap does not invoke LLM.
- Swap does not regenerate exercises.
- Swap preserves completed history.
- Swap rejects protected sessions.
- Swap updates `/today` and `/week` consistently.

## F. Move

- Move future deterministic Gym session.
- Move future AI-selected Gym session.
- Move to an empty target date.
- Move to an occupied target date.
- Explicit source-date behavior.
- Source is completed.
- Source is in progress.
- Source ownership is ambiguous.

## G. UI/API consistency

- `/today` and `/week` agree after AI commit.
- `/today` and `/week` agree after swap.
- `/today` and `/week` agree after move.
- Logger opens the same session returned by `/today`.
- Completion updates the same selected session.
- AI-selected Gym is not displayed as Rest because `plannedWork` is null.
- Stale frontend data is refreshed after schedule changes.

---

# 12. Required Invariants

The implementation must enforce the following:

1. At most one selected planned workout exists for a user/date.
2. Every selected workout has valid provenance.
3. A completed or in-progress workout cannot be silently rescheduled.
4. A pure swap never regenerates exercises.
5. `reuse` never silently becomes `regenerate`.
6. AI commits cannot create an orphan competing workout.
7. `/today`, `/week`, logger, and completion use the same resolver.
8. Historical workout logs are immutable through schedule operations.
9. Every move, swap, replacement, and regeneration is auditable.
10. The user-facing schedule has one unambiguous interpretation per date.

---

# 13. Clean Verification

Run verification from a clean environment:

```bash
rm -rf node_modules
npm ci
npm run verify
```

The canonical verification command should include:

```text
npm run build
npm run typecheck
npm test
```

Document:

- Exact command.
- Test count.
- Pass/fail result.
- Date of verification.
- Any intentionally excluded suites.
- Node/npm versions if relevant.

Do not report inconsistent test totals from different environments or commands.

---

# Definition of Done

This work is complete when:

- `findRealGymSession()` is replaced or bypassed by a complete authoritative-session resolver.
- Selected-session uniqueness is enforced at the database/service level.
- AI supersession is atomic and auditable.
- Active program-session ownership is validated.
- `/today`, `/week`, logger, and completion use the same resolution logic.
- `plannedWork` and selected persisted sessions have clear semantics.
- `reuse`, `swap`, `move`, and `regenerate` are explicitly separated.
- Mixed deterministic/AI regression tests pass.
- Clean verification passes with one documented test result.
- No supported flow can create two competing selected workouts for the same date.
