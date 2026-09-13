# FINAL — Actionable vs Historical Session Resolution Fixes

## Objective

Apply a focused correction to the workout session-selection system identified in the 13 September 2026, 14:52 review.

The previous resolver correction fixed the original row-order bug, but the current implementation can still select a completed workout over a later planned workout. It can also silently choose one of multiple active planned AI sessions based only on recency.

This task must make session semantics explicit and prevent users from being shown a hidden or inaccessible planned workout.

Do not rewrite unrelated scheduling, AI generation, blueprint, or workout-programming behavior.

---

## Repository Scope

Primary areas to inspect:

- `src/engine/selectedSessionResolver.ts`
- The shared session/programming service that creates or commits planned sessions
- API routes serving:
  - `/today`
  - `/week`
  - logger/session details
  - workout completion or status updates
- Frontend code that consumes the selected session, including `today.html` and related logger UI
- Existing session-resolution, scheduling, and AI supersession tests

Use the actual repository types and naming conventions. Do not introduce duplicate parallel resolver implementations.

---

## Required Product Semantics

### 1. Distinguish historical sessions from actionable sessions

A completed or in-progress session is not the same thing as an actionable planned workout.

The API and resolver must distinguish:

- `historicalSession`
  - A completed session that records what was already performed.
  - An in-progress session that the user is currently performing.
- `selectedPlannedWorkout`
  - The planned workout the user is allowed to start or continue.
- `selectionConflict`
  - A diagnostic object describing an invalid or ambiguous session state.

Do not represent a completed workout as if it were still an actionable planned workout.

### 2. Same-date replacement policy for this iteration

For the current implementation, do not support silently creating a second actionable Gym workout on a date that already has a completed or in-progress Gym session.

Therefore:

- A completed Gym session blocks creation/commit of another selected planned Gym session for the same user/date.
- An in-progress Gym session blocks creation/commit of another selected planned Gym session for the same user/date.
- Creation and AI commit endpoints must return a clear conflict response rather than creating a hidden planned session.
- The conflict response should identify the existing session and explain that the date already has a completed or in-progress Gym session.

Do not delete or overwrite the historical/in-progress session.

Future same-day makeup support can be added later as a separate feature. It must use an explicit second-session/actionable-session model rather than overloading the current selected-session resolver.

---

## Resolver Requirements

### 3. Keep one authoritative resolver

All server-side consumers must use the same authoritative resolver. Do not use independent `.find()`, first-row, or ad hoc ordering logic in routes or services.

The resolver must:

1. Load sessions for the authenticated user and target date.
2. Validate ownership and program scope.
3. Separate sessions into:
   - completed
   - in-progress
   - planned deterministic
   - planned AI/non-deterministic
   - superseded/cancelled/invalid, as applicable
4. Return an explicit resolution result rather than only a Boolean such as `showDeterministic`.

Recommended conceptual result:

```ts
type SelectedSessionResolution = {
  historicalSession: WorkoutSession | null;
  selectedPlannedWorkout: WorkoutSession | null;
  selectionConflict: {
    code: string;
    message: string;
    sessionIds?: string[];
  } | null;
  source: "completed" | "in_progress" | "ai" | "deterministic" | "none" | "conflict";
};
```

Adapt this shape to existing project types. Do not duplicate types if an equivalent type already exists.

### 4. Precedence must be explicit

For a normal single-session-per-day flow:

1. In-progress session takes precedence as the session currently being performed.
2. Completed session is returned as historical state and is not presented as a new actionable workout.
3. A planned AI session is selected only when no completed/in-progress session blocks the date.
4. A planned deterministic session is selected only when no higher-priority valid planned AI session exists.
5. No session returns `null`/`none`.

Important:

- Do not return a completed session as `selectedPlannedWorkout`.
- Do not allow a planned session to be silently hidden behind a completed session without exposing that it is blocked or conflicting.
- If the existing application intentionally treats completed sessions as the final state for the date, preserve that behavior explicitly through separate fields rather than conflating historical and actionable state.

### 5. Multiple active planned sessions must not be silently accepted

If more than one active planned session exists for the same user/date and session type:

- Do not silently rely on `created_at DESC` as the business rule.
- Detect the duplicate/ambiguous state.
- Return a `selectionConflict` with:
  - a stable conflict code
  - a human-readable message
  - the conflicting session IDs
- Where a read endpoint needs to remain usable, it may expose a deterministic recovery candidate, but it must mark the response as conflicted and must not claim that the state is valid.
- Write/commit paths must reject creation of another active planned session while the conflict exists, unless the operation is an explicit repair/supersession operation.

Suggested conflict code:

```text
MULTIPLE_ACTIVE_PLANNED_SESSIONS
```

Use the project's existing error-code conventions if available.

### 6. Preserve AI supersession provenance

When an AI session supersedes a deterministic session:

- Preserve the deterministic session as superseded/history according to the existing data model.
- Ensure it is excluded from active selection.
- Ensure the AI session is selected only if it belongs to the authenticated user and active program.
- Do not fabricate a deterministic `plannedWork` object when the AI session is the selected plan.
- Keep source/provenance fields intact so the UI and diagnostics can explain why the selected workout exists.

---

## Write-Path Protection

### 7. Enforce the date conflict before creating or committing

Apply the same guard to every supported path that can create a planned Gym session, including:

- deterministic plan creation
- AI plan commit
- regenerate/reconcile operations
- reuse operations
- move/copy operations when the destination date already has a completed/in-progress Gym session
- any manual "create planned workout" endpoint

The guard must:

1. Use the authoritative user/date/session-type lookup.
2. Check completed and in-progress sessions first.
3. Reject the write with HTTP `409 Conflict` or the project's established equivalent.
4. Return a stable error code and useful message.
5. Avoid partial writes.
6. Run inside the relevant transaction when the operation is transactional.

Suggested error code:

```text
DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION
```

Do not apply this restriction to unrelated session types unless the existing domain model treats them as the same session type.

### 8. Prevent duplicate active planned sessions

Before creating/committing an AI or deterministic planned session:

- Detect existing active planned sessions for the same user/date/session type.
- If the operation is intended to replace an existing session, perform an explicit atomic supersession/replacement.
- If it is not an explicit replacement, return `409 Conflict`.
- Never create a second active planned session and depend on recency ordering to select one.

The transaction must ensure that the following cannot happen through normal supported paths:

```text
two active planned Gym sessions
same user
same date
same session type
```

If the database supports an appropriate partial/conditional unique constraint, use it. If not, enforce it transactionally in the service layer and document that limitation clearly.

Do not claim a database-level invariant unless one actually exists.

---

## API Contract Updates

### 9. Make the response contract explicit

Update `/today`, `/week`, logger/session-detail, and related endpoints so their response semantics are unambiguous.

Where applicable, expose fields equivalent to:

```json
{
  "historicalSession": null,
  "selectedPlannedWorkout": {
    "id": "..."
  },
  "selectionConflict": null
}
```

For a completed date:

```json
{
  "historicalSession": {
    "id": "...",
    "status": "completed"
  },
  "selectedPlannedWorkout": null,
  "selectionConflict": null
}
```

For an ambiguous duplicate state:

```json
{
  "historicalSession": null,
  "selectedPlannedWorkout": null,
  "selectionConflict": {
    "code": "MULTIPLE_ACTIVE_PLANNED_SESSIONS",
    "message": "Multiple active planned Gym sessions exist for this date.",
    "sessionIds": ["...", "..."]
  }
}
```

Use the project's actual response structure. The important requirement is that consumers can distinguish:

- what was already performed,
- what can be started,
- and whether the data is invalid or ambiguous.

### 10. Frontend behavior

Update all relevant frontend consumers:

- `/today`
- `/week`
- workout logger
- session detail/open-workout actions

Rules:

- Open the logger by the explicit selected actionable session ID.
- Never select a session with an unqualified `.find()` over all sessions.
- Do not make a completed session appear as a new planned workout.
- If only a completed session exists, show completed/history state.
- If a conflict exists, show a clear recovery/error state rather than opening an arbitrary session.
- If an actionable planned session exists, open that exact session by ID.
- Preserve existing UI styling and unrelated behavior.

---

## Data-Recovery / Existing-Data Handling

### 11. Handle already-existing invalid data safely

The new code must not assume the database is already clean.

For existing records:

- Multiple active planned sessions must be detected and reported as a conflict.
- A completed/in-progress session plus a planned session on the same date must not cause the planned session to be silently presented as valid.
- Do not automatically delete records.
- Do not silently mark records completed or superseded merely to hide the problem.
- If a repair utility already exists, integrate with it; otherwise expose enough IDs and diagnostics for a controlled repair.

If a safe deterministic read fallback is necessary, mark it as a conflict and log enough information to investigate it.

---

## Tests Required

Add or update tests at both resolver/service and endpoint levels.

### Resolver/unit tests

Cover at minimum:

1. No session.
2. One deterministic planned session.
3. One AI planned session.
4. AI planned plus deterministic planned; AI wins and deterministic is superseded/excluded.
5. One completed session; returned as historical, not actionable.
6. One in-progress session; returned as current/historical state, not a new planned workout.
7. Completed plus later planned session; planned session is blocked/conflicted, not silently selected.
8. In-progress plus planned session; planned session is blocked/conflicted.
9. Multiple active AI planned sessions; conflict is returned.
10. Multiple active deterministic planned sessions; conflict is returned or handled according to the same explicit invariant.
11. Superseded/cancelled sessions are excluded from active selection.
12. User/program ownership boundaries prevent cross-user or cross-program selection.
13. Tie-breaking is not used as a substitute for conflict detection.

### Write-path/service tests

Cover:

1. Creating a planned session on a completed date returns `409`.
2. Creating a planned session on an in-progress date returns `409`.
3. AI commit on a completed date returns `409` without partial writes.
4. AI commit on an in-progress date returns `409` without partial writes.
5. Creating a second active planned session returns `409`.
6. Explicit replacement/supersession is atomic.
7. Move/copy/reuse operations apply the same destination-date guard.
8. Existing historical sessions remain unchanged after rejected writes.

### Endpoint/integration tests

Cover actual response behavior for:

- `/today`
- `/week`
- logger/session detail/open action
- completion/status update where relevant

Verify that:

- completed sessions appear as historical/completed;
- actionable planned sessions are returned by explicit ID;
- conflicts are surfaced consistently;
- no endpoint reintroduces first-row or unqualified `.find()` selection;
- `/today` and `/week` agree on the selected session;
- the logger opens the same session ID that the resolver selected.

---

## Logging and Diagnostics

Add concise structured logging for invalid states, without logging sensitive data.

At minimum, log:

- user ID or safe internal identifier according to project conventions
- date
- session type
- conflict code
- conflicting session IDs
- operation that encountered the conflict

Do not log tokens, passwords, full request bodies, or unrelated personal data.

---

## Verification

Run the repository's normal verification commands from a clean dependency state.

Expected sequence, adapted to the project's package manager:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci
npm run verify
```

If `verify` is not the correct script, inspect `package.json` and run the project's complete typecheck, lint, unit-test, and integration-test commands.

Also perform targeted checks:

```powershell
npm test -- selectedSessionResolver
npm test -- programming
```

Use the actual test command/filter syntax supported by the repository.

Before reporting completion, verify:

- TypeScript/build passes.
- Lint passes.
- Resolver tests pass.
- Service/write-path tests pass.
- `/today` and `/week` integration tests pass.
- Logger opens the resolver-selected session ID.
- No active planned duplicate is created through supported paths.
- No completed/in-progress session is accidentally exposed as a new actionable workout.
- The implementation report does not claim a database invariant unless one is genuinely implemented.

---

## Completion Criteria

This task is complete only when:

- There is one authoritative resolver.
- Historical and actionable session concepts are separate.
- Completed/in-progress dates cannot receive hidden replacement planned Gym sessions through supported write paths.
- Multiple active planned sessions are detected rather than silently resolved by recency.
- AI supersession remains ownership-safe and provenance-preserving.
- `/today`, `/week`, and the logger use the same explicit session ID.
- Integration tests prove consistent behavior.
- Verification has been run cleanly and the result is reported accurately.

Keep the implementation focused. Do not introduce same-day makeup functionality in this task.
