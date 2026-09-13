# Fixes Task — Activity Changes, Non-Regenerative Scheduling, and AI Session Alignment

## Context

The current implementation has introduced schedule-swap support and improved AI activity alignment, but the latest review identified several remaining inconsistencies.

The product requirement is:

> A change of plans must not automatically trigger a new program generation. A simple schedule adjustment should reuse the existing program/prescription wherever possible. Regeneration should happen only when explicitly requested or when the user is clearly informed and confirms that it is necessary.

Example:

```text
Wednesday: Rest
Thursday: Gym — existing prescription A
```

User asks:

> Move Thursday's gym workout to Wednesday.

Expected result:

```text
Wednesday: Gym — existing prescription A
Thursday: Rest
```

Expected properties:

- No LLM call.
- No unnecessary deterministic program generation.
- Existing prescription is reused/moved.
- No duplicate planned session.
- Weekly program, today view, and logger remain consistent.

This task is intended to finish the behavior cleanly rather than add another partial compatibility layer.

---

# Main Objectives

1. Separate schedule operations from program generation.
2. Ensure ordinary activity changes do not silently regenerate by default.
3. Ensure AI proposal commits cannot create contradictions between weekly activity and workout sessions.
4. Prevent active planned sessions from becoming orphaned when an activity is changed.
5. Keep schedule swaps/moves idempotent and consistent across all read paths.
6. Avoid introducing unnecessary new abstractions or duplicating existing reconciliation logic.

---

# Required Product Rules

## Rule 1 — Schedule adjustment is not regeneration

The following operations must not invoke the LLM or regenerate a workout prescription by default:

- Swap two days.
- Move an existing gym prescription to another day.
- Exchange a gym day and a rest day.
- Exchange two existing gym days.
- Move an existing planned workout session with its schedule assignment.

These operations should reuse existing program/prescription data.

## Rule 2 — Regeneration must be explicit

A new program or workout prescription should be generated only when:

- The user explicitly selects “Generate/regenerate”.
- The existing prescription cannot be reused and the user explicitly approves generation.
- A documented domain rule requires regeneration and the UI clearly communicates that fact before proceeding.

Do not silently fall back from “reuse” to “regenerate”.

## Rule 3 — AI commit must have an explicit meaning

An AI proposal must be interpreted as one of the following:

- Filling an existing gym day.
- Replacing the current day's non-gym activity with gym.
- Additional same-day session.

For this phase, do not implement additional same-day sessions unless the data model and UI fully support them.

Recommended supported intents:

```ts
type AICommitIntent =
  | 'fill_existing_gym_day'
  | 'replace_day_activity';
```

---

# Fix 1 — Remove unsafe AI commit fallback

## Current problem

The AI commit endpoint still allows an omitted intent to preserve legacy behavior.

That means a request can create a planned gym session on a Rest or Badminton day without updating the weekly activity/program representation.

Possible inconsistent state:

```text
Weekly activity: Rest
Workout session: Planned Gym
```

## Required behavior

Choose one of the following, preferably option A.

### Option A — Require intent

For new commit requests:

```json
{
  "intent": "fill_existing_gym_day"
}
```

or:

```json
{
  "intent": "replace_day_activity"
}
```

If intent is missing:

- Return a clear `400` validation response.
- Do not create a session.
- Do not mutate the weekly program.
- Do not mark the proposal committed.

### Option B — Safe transitional compatibility

If backward compatibility is genuinely required:

- Missing intent is allowed only when the target date is already an effective Gym day.
- Missing intent on Rest or Badminton must be rejected.
- Do not preserve unrestricted legacy behavior.

## Acceptance criteria

- [ ] AI commit on an effective Gym day can fill that day without creating a duplicate.
- [ ] AI commit on Rest without replacement intent is rejected.
- [ ] AI commit on Badminton without replacement intent is rejected.
- [ ] No orphaned planned session is created on rejected requests.
- [ ] Error responses clearly explain the required intent.

---

# Fix 2 — Make AI replacement and weekly activity mutation consistent

## Current problem

For:

```text
intent = replace_day_activity
```

the implementation updates the weekly activity and creates the planned AI session.

This is directionally correct, but the operation must be treated as one coherent workflow.

## Required behavior

For Rest/Badminton → Gym replacement:

1. Validate the proposal.
2. Validate the target date and current week.
3. Check existing sessions and conflicts.
4. Confirm that replacement is explicitly requested.
5. Update the current-week activity representation.
6. Reconcile the weekly program only if required by the replacement policy.
7. Create or associate the planned AI session.
8. Mark the proposal committed.
9. Return the resulting weekly/activity/session state.

Do not allow a successful response where only one side of the state changed.

## Transaction requirement

The following changes must be coordinated transactionally wherever the current database architecture permits:

- Week activity override.
- Relevant weekly program assignment/reconciliation.
- AI planned session creation.
- Proposal committed state.

If the existing repository boundaries prevent one transaction, implement a deliberate rollback/compensation strategy. Do not use best-effort independent writes without recovery.

## Important constraint

Do not invoke full program generation merely because the user selected replacement.

If an existing valid gym prescription can be reused or the AI proposal itself is the intended prescription, use it.

---

# Fix 3 — Stop leaving active planned sessions orphaned

## Current problem

Changing a day from Gym to Rest/Badminton can leave an existing `planned` gym session in `workout_sessions`.

The weekly activity then says Rest/Badminton while the session remains an active-looking Planned Gym session.

The implementation correctly avoids deleting historical data, but an active `planned` session cannot simply remain unexplained.

## Required behavior

### Completed session

- Never delete.
- Never rewrite.
- Preserve as historical truth.

### In-progress session

- Reject activity replacement/schedule removal.
- Return a clear conflict.
- Require a separate completion/abandonment workflow.

### Planned session

For this phase, use the safer policy:

- Reject changing the day away from Gym while an active planned session exists, unless the operation explicitly moves/reuses that session.
- Do not silently delete or silently leave it detached.

Suggested error:

```text
This day has an active planned workout session. Move or cancel that session before changing the activity.
```

## Alternative only if already supported

If the application already has a proper cancellation state and all read paths understand it, an explicit user-confirmed cancellation may be supported.

Do not invent a new `detached` state unless the complete lifecycle is implemented.

## Acceptance criteria

- [ ] Gym → Rest with no session succeeds.
- [ ] Gym → Badminton with no session succeeds.
- [ ] Gym → Rest with a planned session is rejected or requires explicit cancellation.
- [ ] Gym → Badminton with a planned session is rejected or requires explicit cancellation.
- [ ] Gym → Rest with an in-progress session is rejected.
- [ ] Completed sessions remain untouched.
- [ ] No active planned session becomes invisible/orphaned.

---

# Fix 4 — Correctly distinguish `swap` from `move`

## Current problem

The current `move` endpoint is reportedly an alias for `swap`.

A swap means:

```text
A ↔ B
```

A move means:

```text
A → B
```

These are not always equivalent.

Example:

```text
Wednesday: Badminton
Thursday: Gym
```

A true move may mean:

```text
Wednesday: Gym
Thursday: Rest
```

A swap means:

```text
Wednesday: Gym
Thursday: Badminton
```

## Required decision

Either:

### Option A — Keep only swap for now

- Remove or hide the `/move` endpoint if it is only an alias.
- Expose the operation as `swap`.
- Do not claim to support general move semantics.

### Option B — Implement true move semantics

Define exactly:

- Source day.
- Destination day.
- What happens to the source day.
- What happens to the destination activity.
- Whether an existing prescription/session moves with the activity.
- What happens if the destination already contains a gym prescription/session.

Do not leave an endpoint named `move` that silently performs a different operation.

## Recommendation

Use Option A unless the UI already needs true move behavior.

---

# Fix 5 — Define which planned sessions are movable

## Current problem

The schedule operation collects all sessions with:

```ts
status === 'planned'
```

The comments describe these as AI-created planned sessions, but the query may include any planned session source.

## Required decision

Choose and document one rule.

### Option A — All planned sessions are schedule-bound

Then:

- Any planned session on a swapped day moves with that day's scheduled activity.
- This behavior must be documented and tested.
- Any unsupported session types must be excluded explicitly.

### Option B — Only schedule-owned sessions move

Then identify session origin/ownership reliably, such as:

```ts
source: 'deterministic_program' | 'ai_proposal' | 'manual'
```

and define which sources are movable.

Do not rely on comments to imply AI-only behavior when the query moves every planned session.

---

# Fix 6 — Verify program-session identity semantics

The swap implementation may preserve the row occupying each `day_index` while exchanging the prescription content.

Example:

```text
Before:
program_session_id ps1 → Wednesday prescription A
program_session_id ps2 → Thursday prescription B

After:
ps1 → Wednesday prescription B
ps2 → Thursday prescription A
```

This is acceptable only if `program_sessions.id` represents a day slot rather than the immutable identity of a prescription artifact.

## Required review

Inspect:

- Foreign keys referencing `program_sessions.id`.
- Workout sessions referencing program sessions.
- UI state keyed by program-session IDs.
- Any historical/audit logic relying on prescription identity.
- Reconciliation assumptions.

## Required outcome

Document whether IDs represent:

- Stable day slots, or
- Stable prescription identities.

If they represent prescription identities, move the actual assignment/identity rather than overwriting content in place.

Do not change this blindly without checking consumers.

---

# Fix 7 — Make the normal activity endpoint's regeneration policy explicit

## Current problem

The existing endpoint:

```text
PUT /api/programming/week/days/:day/activity
```

still calls the deterministic planner/reconciliation flow.

That may be correct for a “replace and regenerate” operation, but it conflicts with the new non-regenerative scheduling principle if used for ordinary plan changes.

## Required behavior

Separate these concepts in the API and UI.

Suggested conceptual operations:

```text
POST /api/programming/week/swap
```

Pure schedule swap:

- No LLM.
- No new prescription generation.
- Reuse existing assignments.

```text
POST /api/programming/week/move
```

Only if true move semantics are implemented.

```text
PUT /api/programming/week/days/:day/activity
```

Activity replacement/override.

This endpoint must have an explicit policy, such as:

```json
{
  "activity": "gym",
  "prescriptionPolicy": "reuse"
}
```

or:

```json
{
  "activity": "gym",
  "prescriptionPolicy": "regenerate"
}
```

If no reusable prescription exists under `reuse`:

- Return a clear response that generation is required, or
- Ask the user to explicitly choose regeneration.
- Do not silently call the planner.

## Important distinction

The deterministic planner may still be used for explicit regeneration. The task is not to remove generation; it is to stop using generation as an automatic side effect of every schedule adjustment.

---

# Fix 8 — Ensure weekly UI accurately represents AI-created planned sessions

The weekly response now distinguishes the effective activity from the presence of a deterministic program snapshot.

That is correct in principle.

However, when a day is Gym because of an AI replacement and there is no deterministic `plannedWork` snapshot, the UI must not imply that the day has no workout.

## Required behavior

For a Gym day with an AI-created planned session:

- Show that a planned workout exists.
- Provide an action to open/resume the planned session.
- Avoid displaying an empty state that suggests no workout is scheduled.
- Keep `/week`, `/today`, and logger behavior consistent.

Potential response shape:

```ts
plannedSession: {
  id: string;
  source: 'ai' | 'deterministic';
  status: 'planned' | 'in_progress' | 'completed';
}
```

Do not fabricate deterministic `plannedWork` data for an AI session unless the schema explicitly supports that representation.

The existing `hasUnpersistedSnapshot` field may remain useful internally, but it should either be consumed by the UI or replaced with a clearer user-facing field.

---

# Test Requirements

## A. Pure schedule swaps

- [ ] Rest Wednesday ↔ Gym Thursday.
- [ ] Badminton Wednesday ↔ Gym Thursday.
- [ ] Gym Monday ↔ Gym Thursday.
- [ ] Swap twice restores the original state.
- [ ] Existing prescription moves with the gym activity.
- [ ] Existing planned session moves correctly.
- [ ] No LLM call.
- [ ] No unnecessary deterministic generation.
- [ ] No duplicate session.
- [ ] Recurring profile is unchanged.
- [ ] Repeated identical request is idempotent.
- [ ] `/week`, `/today`, and logger agree.

## B. True move, if implemented

- [ ] Gym Thursday → Wednesday with Thursday becoming Rest.
- [ ] Gym Thursday → Wednesday with Thursday becoming Badminton.
- [ ] Destination already has an activity.
- [ ] Destination already has a planned session.
- [ ] Source has a planned session.
- [ ] Source has a completed session.
- [ ] Source has an in-progress session.
- [ ] Move is reversible.
- [ ] Repeated move is idempotent.

## C. Activity replacement

- [ ] Rest → Gym with no existing session.
- [ ] Badminton → Gym with no existing session.
- [ ] Existing reusable prescription is reused where appropriate.
- [ ] No silent regeneration.
- [ ] Explicit regeneration works.
- [ ] Gym → Rest with no session.
- [ ] Gym → Badminton with no session.
- [ ] Gym → Rest with planned session.
- [ ] Gym → Badminton with planned session.
- [ ] Gym → Rest with in-progress session.
- [ ] Completed session remains untouched.

## D. AI proposal commit

- [ ] Existing Gym day + `fill_existing_gym_day`.
- [ ] Rest day + `replace_day_activity`.
- [ ] Badminton day + `replace_day_activity`.
- [ ] Rest day without intent is rejected.
- [ ] Badminton day without intent is rejected.
- [ ] Missing intent on Gym day follows the documented compatibility policy.
- [ ] Existing planned session conflict is handled explicitly.
- [ ] Repeated commit returns the same session and creates no duplicate.
- [ ] Failure during alignment leaves no orphaned session.
- [ ] Failure during session creation leaves no stale override.
- [ ] `/week`, `/today`, and logger remain consistent.

## E. Regression checks

- [ ] Existing weekly persistence tests pass.
- [ ] Existing activity override tests pass.
- [ ] Existing AI proposal lifecycle tests pass.
- [ ] Existing logger/session tests pass.
- [ ] Existing frontend tests pass.
- [ ] TypeScript compilation passes.
- [ ] Build passes.
- [ ] Full verification passes.

---

# Non-Goals

Do not implement these in this task unless separately approved:

- Full multi-activity-per-day scheduling.
- Automatically supporting badminton plus gym as two independent same-day activities.
- Full-week AI program generation.
- Automatic recurring-profile modification.
- Deleting or rewriting completed workout history.
- Inferring weekly activity from arbitrary workout-session rows.
- Replacing the deterministic planner with an LLM.
- Adding a new session status without implementing its complete lifecycle.
- Adding multiple overlapping compatibility modes that make behavior difficult to understand.

---

# Implementation Approach

1. Inspect the current implementation and tests before modifying behavior.
2. Write down the state invariants first.
3. Keep pure swap/move operations separate from generation.
4. Keep AI proposal commit transactional.
5. Use explicit intent and explicit regeneration policy.
6. Reject unsafe ambiguous operations rather than silently guessing.
7. Preserve historical sessions.
8. Avoid duplicating reconciliation logic.
9. Prefer a small, coherent implementation over several partially overlapping endpoints.
10. Add regression tests for every state transition before declaring completion.

## State invariants

The implementation should preserve these invariants:

### Invariant 1

A successful AI replacement must not leave the weekly activity saying Rest/Badminton while the active planned session is a Gym session for the same intended day.

### Invariant 2

A pure schedule swap must not invoke program generation.

### Invariant 3

A planned session must not silently become detached from the weekly schedule while remaining active-looking as `planned`.

### Invariant 4

Completed and in-progress sessions must not be silently moved, deleted, or rewritten.

### Invariant 5

The recurring profile must not be modified by current-week schedule operations.

### Invariant 6

Repeated requests must not create duplicate prescriptions or sessions.

---

# Verification

Run from a clean environment:

```bash
npm ci
npm run verify
```

Also verify manually:

1. Generate a week containing Rest Wednesday and Gym Thursday.
2. Swap Wednesday and Thursday.
3. Confirm Wednesday now shows the original Thursday workout.
4. Confirm Thursday is Rest.
5. Confirm no planner or LLM call occurred.
6. Commit an AI proposal on a Rest day without intent and confirm rejection.
7. Commit an AI proposal with explicit replacement intent and confirm weekly/session alignment.
8. Attempt to change away from a day with an active planned session and confirm safe conflict behavior.
9. Check `/week`, `/today`, and logger consistency.

---

# Completion Standard

Do not mark this task complete merely because the new endpoints exist or the happy-path tests pass.

The task is complete only when:

- Simple swaps/moves reuse existing plans without regeneration.
- Explicit regeneration is distinguishable from schedule adjustment.
- AI commits cannot create silent weekly/session contradictions.
- Active planned sessions cannot become orphaned.
- Swap and move semantics are accurately named and implemented.
- All relevant read paths show one consistent state.
- The full verification suite passes.
