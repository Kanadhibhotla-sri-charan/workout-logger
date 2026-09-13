# FINAL DEV INSTRUCTION — Do Not Select an Arbitrary Workout During Session Conflicts

## Task

Fix the remaining session-resolution issue identified in the **13 September 2026, 15:48 review**.

The resolver now detects duplicate active planned sessions, but it still returns the most recent conflicting session as `selectedPlannedWorkout`. This allows `/today`, `/week`, or the logger to treat an arbitrary recovery candidate as the authoritative actionable workout.

### Core rule

> When the resolver detects an ambiguous active planned-session conflict, it must not return any session as the selected actionable workout.

For a conflict:

```ts
selectedPlannedWorkout === null
selectionConflict !== null
source === "conflict"
```

Do not rewrite unrelated scheduling, AI generation, blueprint, or programming logic.

---

## Files / Areas to Inspect

Start with the existing implementation and preserve its current architecture:

- `src/engine/selectedSessionResolver.ts`
- `tests/routes/actionableVsHistoricalIntegration.test.ts`
- Resolver unit tests
- `/today` route/service
- `/week` route/service
- Logger/session-detail route
- Relevant frontend files, including:
  - `public/today.html`
  - `public/program.html`
- Any shared helper that opens a workout by session ID

Use the repository's actual types, naming, error conventions, and response structure.

---

## 1. Correct the Resolver Contract

### Current problem

The resolver currently does something conceptually equivalent to:

```ts
const conflict = plannedAi.length > 1
  ? buildConflict(plannedAi)
  : null;

return {
  historicalSession: null,
  selectedPlannedWorkout: mostRecent(plannedAi),
  selectionConflict: conflict,
  source: conflict ? "conflict" : "ai",
};
```

This is incorrect because a conflicted candidate is not an authoritative selection.

### Required behavior

For multiple active planned AI sessions:

```ts
return {
  historicalSession: null,
  selectedPlannedWorkout: null,
  selectionConflict: {
    code: "MULTIPLE_ACTIVE_PLANNED_SESSIONS",
    message: "...",
    sessionIds: ["...", "..."],
  },
  source: "conflict",
};
```

For multiple active deterministic planned sessions, apply the same principle:

```ts
selectedPlannedWorkout: null
source: "conflict"
```

Use the existing conflict-code and response conventions if they already exist. Do not create duplicate incompatible types.

### Important

`mostRecent()` must not be used to populate `selectedPlannedWorkout` when an active planned-session conflict exists.

If the helper remains in the codebase for defensive historical fallback or deterministic ordering, that is acceptable, but it must not bypass conflict handling.

---

## 2. Preserve Valid Non-Conflict Behavior

Do not regress the behavior that is already working.

The resolver should continue to behave as follows:

### No session

```ts
historicalSession: null
selectedPlannedWorkout: null
selectionConflict: null
source: "none"
```

### One deterministic planned session

Return it as:

```ts
selectedPlannedWorkout: deterministicSession
selectionConflict: null
source: "deterministic"
```

### One AI planned session

Return it as:

```ts
selectedPlannedWorkout: aiSession
selectionConflict: null
source: "ai"
```

### AI planned plus deterministic planned

Preserve the existing valid AI supersession behavior:

- AI session is selected.
- Deterministic session is excluded from active selection or marked superseded according to the current model.
- No conflict is reported merely because a superseded deterministic record remains in history.

### Completed session

Return it as historical state:

```ts
historicalSession: completedSession
selectedPlannedWorkout: null
selectionConflict: null
```

### In-progress session

Return it according to the existing historical/current-session contract, but never expose it as a new planned workout.

Do not change the established completed/in-progress behavior unless required to make the conflict semantics correct.

---

## 3. Ensure Conflict Responses Cannot Open a Workout

Inspect every consumer of the resolver result.

The following rule must be enforced:

```ts
if (selectionConflict) {
  // Show conflict/recovery state.
  // Do not open a workout automatically.
} else if (selectedPlannedWorkout) {
  // Open the exact selected session ID.
} else if (historicalSession) {
  // Show historical/completed/in-progress state.
}
```

### Frontend requirements

For `/today`, `/week`, and logger/session-opening flows:

- Never open a workout from `selectedPlannedWorkout` when `selectionConflict` is present.
- Never use an arbitrary `.find()` over all sessions to bypass the resolver.
- Never fall back to the most recent session in the frontend.
- If a conflict is present, show a clear message such as:
  - "Multiple planned workouts exist for this date and need resolution."
- Do not automatically choose either conflicting session.
- Preserve existing UI styling and unrelated interactions.

If the API already returns a conflict object, use it rather than inventing a second frontend conflict format.

---

## 4. Update API / Route Behavior

Ensure `/today` and `/week` expose the corrected resolver result consistently.

For a duplicate planned-session conflict, the response must communicate:

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

Adapt the exact nesting to the current API contract.

The key requirements are:

1. `selectionConflict` is present.
2. `selectedPlannedWorkout` is `null`.
3. No route substitutes another session.
4. `/today` and `/week` agree on the same conflicted state.
5. The logger does not open a conflicting session automatically.

Do not turn a read conflict into a random HTTP error if the current API is designed to render a conflict state. Follow the existing route conventions.

---

## 5. Add / Update Tests

### Resolver unit tests

Add or update tests for:

#### Duplicate AI planned sessions

```ts
const result = resolveSelectedSession([...]);

expect(result.source).toBe("conflict");
expect(result.selectionConflict?.code)
  .toBe("MULTIPLE_ACTIVE_PLANNED_SESSIONS");
expect(result.selectedPlannedWorkout)
  .toBeNull();
```

#### Duplicate deterministic planned sessions

Assert the same behavior:

```ts
expect(result.selectionConflict).not.toBeNull();
expect(result.selectedPlannedWorkout).toBeNull();
```

#### Valid AI plus deterministic supersession

Assert that this is not incorrectly classified as a duplicate conflict:

```ts
expect(result.source).toBe("ai");
expect(result.selectionConflict).toBeNull();
expect(result.selectedPlannedWorkout?.session_id)
  .toBe(aiSession.session_id);
```

#### Completed session

```ts
expect(result.historicalSession?.session_id)
  .toBe(completedSession.session_id);
expect(result.selectedPlannedWorkout)
  .toBeNull();
expect(result.selectionConflict)
  .toBeNull();
```

### Integration tests

Update:

`tests/routes/actionableVsHistoricalIntegration.test.ts`

Specifically, replace any expectation equivalent to:

```ts
expect(thursdayAfter.selectedPlannedWorkout).not.toBeNull();
```

with assertions that reflect the conflict contract:

```ts
expect(thursdayAfter.selectionConflict).not.toBeNull();
expect(thursdayAfter.selectionConflict?.code)
  .toBe("MULTIPLE_ACTIVE_PLANNED_SESSIONS");
expect(thursdayAfter.selectedPlannedWorkout)
  .toBeNull();
```

Add endpoint-level coverage proving that:

- `/today` returns no actionable workout for the conflicted date.
- `/week` returns no actionable workout for the conflicted date.
- Both endpoints expose the same conflict code and conflicting IDs.
- The logger/open-workout path does not automatically open either conflicting session.

If the logger is not directly testable through the current integration harness, add the narrowest appropriate service/route test that proves it refuses to open a conflicted selection.

### Frontend checks

If frontend tests exist, add a test that confirms:

- conflict state prevents opening;
- valid selected session opens by exact ID;
- no fallback `.find()` is used.

If no frontend test framework exists, perform a targeted code inspection and document the checked paths.

---

## 6. Do Not Add Same-Day Makeup Functionality

This task is only about making ambiguous session state safe.

Do not implement:

- a second actionable Gym session on the same date;
- a makeup-workout workflow;
- automatic conflict repair;
- automatic deletion of one conflicting session;
- automatic supersession of one arbitrary conflicting session.

Those are separate product decisions and must not be introduced here.

---

## 7. Verification

Run the project's normal clean verification process.

Use the actual package scripts from `package.json`. If applicable:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci
npm run verify
```

Also run targeted tests for:

- `selectedSessionResolver`
- `actionableVsHistoricalIntegration`
- programming/session routes
- logger/session-opening behavior

Before reporting completion, verify all of the following:

- Duplicate active planned sessions produce `selectionConflict`.
- Duplicate active planned sessions produce `selectedPlannedWorkout: null`.
- No endpoint selects a conflicting session by recency.
- No frontend path opens a workout when `selectionConflict` exists.
- Valid AI supersession still works.
- Completed and in-progress behavior is not regressed.
- `/today` and `/week` agree.
- Tests pass.
- The implementation report accurately describes conflict behavior.

---

## Completion Criteria

The fix is complete only when:

1. Ambiguous active planned-session states are detected.
2. Ambiguous states never return an actionable selected workout.
3. The UI displays a conflict/recovery state instead of opening an arbitrary session.
4. `/today`, `/week`, and logger behavior are consistent.
5. Tests explicitly assert `selectedPlannedWorkout === null` during conflict.
6. No unrelated behavior is rewritten.
