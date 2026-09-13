# Claude Task — AI Programmer Proposal Review UI

## Objective

Build the first minimal frontend workflow for the completed AI Programmer single-session vertical slice.

The backend proposal lifecycle is now implemented and accepted:

1. Generate a single-session AI proposal.
2. Retrieve the proposal.
3. Explicitly approve it.
4. Explicitly commit it into a planned workout session.

This task should expose that workflow through the existing vanilla HTML/CSS/JavaScript frontend.

This is a focused UI integration task. Do not expand the AI Programmer into full-week generation, reconciliation, automatic programming, or a new frontend framework.

---

## Current backend contract to use

Before changing anything, inspect the actual implemented routes and types. Do not assume paths or response shapes if the code differs.

The UI should use the existing AI Programmer API endpoints for:

- Proposal generation
- Proposal retrieval, if needed
- Proposal approval
- Proposal commit

Use the actual route names, request bodies, response envelopes, status values, and error codes found in the repository.

Do not duplicate backend validation or programming logic in the browser.

---

## 1. Choose the correct integration point

Inspect the existing frontend pages and determine the most natural location for the first AI Programmer workflow.

Likely candidates include:

- `public/today.html`
- `public/index.html`
- An existing programming/plan page
- A small dedicated AI Programmer page if that is cleaner

Prefer integrating into an existing relevant page rather than creating unnecessary navigation or a large new UI surface.

The UI should make it clear that this is an AI-generated proposal awaiting user review—not an automatically committed workout.

---

## 2. Add a single-session proposal workflow

Implement a simple user flow for a selected editable target date:

### Step A — Generate

Provide a clear action such as:

> Generate AI Workout Proposal

The UI must:

- Use the selected target date.
- Call the backend generation endpoint.
- Show loading state.
- Prevent duplicate submissions while the request is in progress.
- Display a useful success or error state.
- Never expose API keys, raw provider payloads, stack traces, or internal error messages.

The UI must not automatically approve or commit after generation.

### Step B — Review

Render the returned proposal in a readable review panel.

At minimum, show:

- Target date
- Proposal status
- Generated timestamp, if available
- Provider/model metadata only if already intended for user display
- Exercises in proposal order
- Exercise name
- Target/muscle information, if available
- Role, if available
- Number of sets
- Rep range
- RIR range
- Rest duration
- Any proposal-level notes or rationale that are part of the approved public contract

Do not invent missing fields.

The review should clearly distinguish planned prescription from performed workout data.

### Step C — Approve

Provide an explicit action:

> Approve Proposal

Approval must:

- Call the approval endpoint.
- Update the displayed status.
- Keep the proposal visible after approval.
- Not commit automatically.
- Disable or replace the approval action once approved.
- Handle expiry, invalid state, and server errors gracefully.

### Step D — Commit

After approval, provide a separate explicit action:

> Commit to Planned Workout

The UI must clearly communicate that this creates the planned workout/session.

Commit must:

- Call the commit endpoint.
- Show a loading state.
- Prevent duplicate clicks.
- On success, display the created session ID or a user-friendly link/action to open the planned workout, if the existing routes support it.
- Update the proposal status to committed.
- Avoid creating duplicate sessions if the user retries.
- Handle the backend's idempotent response correctly.

Do not combine approval and commit into one action.

---

## 3. Respect lifecycle states

The UI must correctly represent the backend lifecycle:

```text
pending → approved → committed
```

Also handle:

- Expired proposals
- Failed proposals
- Unknown/deleted proposals
- Already committed proposals
- Invalid transitions
- Target date that is no longer editable
- Existing planned-session conflict
- Blueprint staleness or domain revalidation failure

Use the backend's actual status/error codes where available.

Do not silently retry an operation that could create an unintended state transition.

---

## 4. Date and editability rules

The UI must not imply that any date is editable.

Use the existing application's date-selection and editability conventions where possible.

At minimum:

- Do not allow generation for a completed or in-progress workout date.
- Do not bypass backend validation.
- If the backend rejects a date, show a concise user-facing explanation.
- Do not hard-code a date-specific rule that conflicts with the backend.

If the existing page already knows the selected date, reuse that source rather than creating a second conflicting date state.

---

## 5. Error handling and privacy

All user-visible errors must be safe and understandable.

Map known backend errors to concise messages where possible, for example:

- AI Programmer is disabled
- Target date cannot be edited
- Proposal expired
- Proposal is not approved
- Proposal is already committed
- A planned workout already exists
- The proposal is stale and must be regenerated
- The AI provider is temporarily unavailable
- The proposal could not be validated

For unknown errors, show a generic message such as:

> Something went wrong. Please try again.

Never render:

- Raw exception messages
- SQL errors
- Stack traces
- Provider request payloads
- API keys
- Internal file paths
- Raw provider responses

---

## 6. UI quality requirements

Keep the UI consistent with the existing application.

Requirements:

- Use the existing vanilla JS/CSS approach.
- Do not introduce React, Vue, or another framework.
- Reuse existing components/styles/helpers where practical.
- Make loading, success, error, and disabled states obvious.
- Ensure buttons cannot be double-submitted.
- Ensure the review panel is readable on desktop and mobile-sized screens.
- Use semantic HTML and accessible button labels.
- Do not rely solely on color to communicate status.
- Avoid excessive UI complexity.

A simple, reliable review panel is preferable to a visually elaborate dashboard.

---

## 7. Testing requirements

Add frontend/API integration tests using the repository's existing testing conventions.

At minimum, cover:

1. Generate proposal successfully.
2. Generation failure displays a safe error.
3. Proposal renders its prescription correctly.
4. Approval is a separate action.
5. Approval changes status to approved.
6. Approval does not call commit.
7. Commit is unavailable before approval.
8. Commit succeeds after approval.
9. Successful commit displays the resulting planned-session reference.
10. Repeated commit does not create duplicate UI actions or sessions.
11. Expired proposal is handled safely.
12. Backend validation/conflict errors are displayed safely.
13. Raw internal error text is not rendered.
14. Loading states prevent duplicate requests.

If the repository has no browser test framework, follow its existing test strategy and add the closest meaningful route/UI-controller tests without introducing a large new testing stack unless necessary.

---

## 8. Documentation

Add or update a concise implementation report documenting:

- UI entry point selected
- Endpoints used
- State transitions represented
- Error handling approach
- Tests added
- Any intentional limitations

Do not claim full-week AI programming or reconciliation support. This task is only the single-session proposal review/approval/commit UI.

---

## Scope restrictions

Do not:

- Implement full-week generation.
- Implement reconciliation.
- Replace the deterministic engine.
- Add automatic approval.
- Add automatic commit.
- Add outside-Blueprint exercise support.
- Change backend lifecycle semantics.
- Change prescription semantics.
- Move planned prescription values into performed-set fields.
- Add a frontend framework.
- Add unrelated dashboard features.
- Expose raw provider data or internal errors.
- Rewrite existing pages unnecessarily.

Keep the implementation focused and incremental.

---

## Required final report

After implementation, report:

1. Files changed.
2. UI entry point and user flow.
3. Exact backend endpoints integrated.
4. Lifecycle/state handling.
5. Error and privacy handling.
6. Tests added or updated.
7. Verification commands executed.
8. Exact verification results.
9. Screenshots or a manual testing walkthrough, if available.
10. Any remaining limitations.
