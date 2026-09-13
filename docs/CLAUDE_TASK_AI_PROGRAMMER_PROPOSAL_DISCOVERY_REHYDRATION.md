# Claude Task — Persisted AI Proposal Discovery and UI Rehydration

## Objective

Improve the AI Programmer frontend so that existing proposals are discoverable and restored when the user reopens a day.

The current single-session AI Programmer workflow is implemented:

1. Generate proposal
2. Review proposal
3. Approve proposal
4. Explicitly commit proposal
5. Open the resulting planned workout

However, proposal state currently lives only in the modal's local JavaScript state. If the user closes and reopens the modal, the UI may not know that a pending or approved proposal already exists.

This task should make proposal state persistent and discoverable by target date, then rehydrate the UI from the backend.

Do not implement full-week AI programming, reconciliation, automatic approval, or automatic commit.

---

## 1. Inspect the existing backend and frontend first

Review the actual current implementation of:

- AI proposal routes
- Proposal repository
- Proposal lifecycle service
- Proposal database schema
- `public/program.html`
- `public/app.js`
- Existing AI proposal UI tests
- Existing workout/session retrieval routes

Do not assume endpoint names or response shapes. Reuse existing contracts where possible.

Determine whether the current system already has:

- A list/search endpoint
- A proposal lookup by target date
- A way to retrieve the latest proposal for a date
- A proposal status filter
- A proposal expiration field
- A committed session reference

Prefer extending an existing endpoint or adding a small, well-defined endpoint rather than introducing redundant APIs.

---

## 2. Add a safe proposal-discovery capability

The frontend needs a way to ask:

> "Is there an existing relevant AI proposal for this target date?"

The preferred behavior is to retrieve the latest relevant proposal for the selected date.

Define the exact semantics before implementing:

### Relevant proposal states

At minimum, consider:

- `pending`
- `approved`
- `committed`
- `expired`
- `rejected`, if supported by the actual backend

Prefer returning the latest active proposal (`pending` or `approved`) for UI rehydration.

A committed proposal may also be returned if useful so the UI can show that the date already has a committed AI session.

Expired or rejected proposals should not prevent the user from generating a fresh proposal.

### Ordering

Use a deterministic ordering, such as:

1. Most recently created proposal for the target date
2. Stable ID tie-breaker if needed

Do not rely on unspecified database ordering.

### Response safety

The discovery response must not expose:

- Provider payloads
- API keys
- Raw internal errors
- Internal stack traces
- Unnecessary database fields

Return only the proposal fields already intended for the review UI.

---

## 3. Suggested endpoint shape

Use the project's existing route conventions.

A possible shape is:

```text
GET /api/ai-programmer/proposals?targetDate=YYYY-MM-DD
```

or:

```text
GET /api/ai-programmer/proposals/latest?targetDate=YYYY-MM-DD
```

Do not blindly use these names if another convention is already established.

The endpoint should:

- Validate the date format
- Apply the same editability/domain boundaries as appropriate
- Return either:
  - The latest relevant proposal, or
  - A clear "no proposal found" response
- Avoid treating an expired proposal as an active proposal
- Be deterministic
- Have clear behavior for malformed dates and missing parameters

If a list endpoint is more appropriate for future use, keep the first implementation narrow and document its semantics.

---

## 4. Rehydrate the frontend modal

Update the existing AI Programmer UI so that opening a day performs discovery before deciding which actions to show.

Desired behavior:

### No existing proposal

Show:

- Generate AI Workout Proposal

### Pending proposal found

Show:

- Existing proposal details
- Pending status
- Approve Proposal
- No commit action yet

### Approved proposal found

Show:

- Existing proposal details
- Approved status
- Commit to Planned Workout

### Committed proposal found

Show:

- Existing proposal details, if useful
- Committed status
- Open planned workout action using the stored committed session ID

### Expired/rejected proposal found

Treat it as non-active for generation purposes.

If useful, show a small informational message such as:

> The previous proposal is no longer active. You can generate a new one.

Do not make expired/rejected proposals block generation.

---

## 5. Avoid stale or conflicting local state

The backend must remain authoritative.

Requirements:

- On modal open, fetch the canonical proposal state.
- After generation, approve, or commit, update local state from the canonical server response.
- After a failed action, resync from the backend.
- When switching to another day, clear the previous day's local proposal state before loading the new date.
- Do not display proposal details from one date under another date.
- Prevent overlapping discovery requests from causing an older response to overwrite a newer selected date.
- Preserve the existing in-flight guards.

If necessary, use a request token, sequence number, or `AbortController` to prevent stale responses from winning.

---

## 6. Generation behavior with existing proposals

Define and implement safe behavior when the user clicks Generate while an existing proposal is present.

Preferred behavior:

- If a pending or approved proposal exists, do not silently create another one.
- Show the existing proposal and its available action.
- If the user needs a new proposal, provide a clearly intentional regeneration action only if the backend supports it safely.

Do not add regeneration by simply creating unlimited duplicate proposals unless the product semantics explicitly support that.

If regeneration is out of scope, state that clearly in the UI or implementation report.

For committed proposals, do not generate another proposal automatically for the same date without an explicit, well-defined policy.

---

## 7. Date and status behavior

Reuse the existing date selection and editability rules.

The UI must continue to:

- Avoid AI actions for completed days.
- Avoid AI actions for in-progress days.
- Respect backend validation.
- Handle dates with existing deterministic plans.
- Handle planned-session conflicts.
- Handle expired proposals.
- Handle stale Blueprint/domain validation failures.

Do not duplicate the full backend programming rules in the browser.

---

## 8. Testing requirements

Add backend tests for proposal discovery:

1. Returns the latest relevant proposal for a target date.
2. Uses deterministic ordering.
3. Does not return an expired proposal as active.
4. Handles no proposal found.
5. Handles malformed/missing target date.
6. Does not expose provider payloads or internal fields.
7. Correctly handles pending, approved, and committed states.
8. Does not accidentally return a proposal belonging to another date.

Add frontend tests for:

1. Modal discovery on open.
2. No proposal → Generate action.
3. Pending proposal → Review + Approve.
4. Approved proposal → Review + Commit.
5. Committed proposal → Open planned workout.
6. Expired/rejected proposal does not block generation.
7. Switching dates does not display stale proposal data.
8. Older discovery response cannot overwrite newer date state.
9. Existing proposal prevents accidental duplicate generation.
10. Discovery/API failures show safe user-facing errors.
11. Loading state prevents duplicate discovery requests.
12. Raw backend error details are not rendered.

If browser-level tests are available, add at least one end-to-end check:

1. Generate a proposal.
2. Close the modal.
3. Reopen the same date.
4. Verify the proposal is restored.
5. Approve it.
6. Close/reopen again.
7. Verify approved state and commit action are restored.

---

## 9. Documentation

Update the implementation report with:

- The discovery endpoint and exact semantics
- Which statuses are considered active
- How ordering is determined
- How the frontend rehydrates state
- How stale requests are prevented
- How duplicate generation is prevented
- Tests added
- Verification results
- Any intentional limitations

Explicitly document whether regeneration is supported or deferred.

---

## Scope restrictions

Do not:

- Implement full-week generation.
- Implement reconciliation with the deterministic weekly program.
- Add automatic approval.
- Add automatic commit.
- Add outside-Blueprint exercise support.
- Change proposal lifecycle semantics unnecessarily.
- Change prescription semantics.
- Rewrite the existing frontend framework or introduce a new framework.
- Create duplicate proposal APIs without inspecting existing routes.
- Allow unlimited duplicate proposals by default.
- Expose raw provider payloads or internal errors.
- Add unrelated UI features.

Keep the implementation incremental, focused, and compatible with the accepted Phase 2 backend and current proposal review UI.

---

## Required final report

After implementation, report:

1. Files changed.
2. Discovery endpoint added or reused.
3. Exact active-proposal semantics.
4. Ordering and expiry behavior.
5. Frontend rehydration flow.
6. Stale-request and duplicate-generation protection.
7. Tests added or updated.
8. Verification commands executed.
9. Exact verification results.
10. Manual/browser test results, if available.
11. Any remaining limitations or deferred decisions.
