# Claude Task — Phase 2 Cleanup Pass

## Objective

Perform a small cleanup and hardening pass on the completed Phase 2 AI Programmer proposal approval/commit workflow.

The core Phase 2 implementation is considered acceptable. Do **not** redesign the architecture, rewrite the deterministic workout engine, or introduce new product scope.

This pass is limited to the items below.

---

## 1. Sanitize persisted commit failure reasons

### Problem

The API correctly avoids returning raw internal errors to the client, but the current commit failure path may persist `err.message` directly into the proposal's `failure_reason`.

Raw error messages can expose internal implementation details such as:

- SQL statements or constraint information
- Table or column names
- Database internals
- Operational details
- Other sensitive diagnostic information

### Required change

Update the commit failure handling so that `failure_reason` contains a safe, stable, categorized message rather than an arbitrary internal error string.

For example:

```ts
repo.recordFailure(proposalId, 'commit_transaction_failed');
```

Or use a small classification helper if different safe categories are useful:

```ts
repo.recordFailure(proposalId, classifyCommitFailure(err));
```

The persisted value must not contain raw `err.message` or a stack trace.

Detailed diagnostics may still be written to controlled server logs if the existing logging approach supports that, but they must not be persisted in the proposal record or returned to the client.

### Tests

Add or update a test that:

1. Forces a persistence/transaction error containing a distinctive internal message.
2. Verifies the API response remains generic.
3. Verifies the stored `failure_reason` does not contain the internal error text.
4. Verifies a safe category/value is stored instead.

---

## 2. Strengthen expiry enforcement at commit time

### Problem

The proposal is checked for approval status and expiry before the transaction. The final commit transition should also protect the invariant that only an approved, unexpired proposal can become committed.

### Required change

Inspect the existing transaction and repository implementation.

Where practical within the current architecture, make the final commit transition enforce the relevant conditions atomically:

- Proposal is still in `approved` status.
- Proposal has not expired.
- Proposal is the expected proposal record.

Do not introduce unnecessary complexity or change the existing lifecycle semantics.

If the current transaction/repository design already provides an equivalent guarantee, document that clearly and avoid redundant changes.

### Tests

Add or update coverage for:

- An expired proposal cannot become committed.
- A proposal whose status changes before the final transition cannot become committed.
- A valid approved, unexpired proposal still commits normally.
- Repeated commit remains idempotent.

---

## 3. Use the authoritative persisted record ID in commit notes

### Problem

The commit note currently uses `proposal.proposalId`. These values are intentionally identical today, but the database record ID is the authoritative persisted identity.

### Required change

Where the commit note is constructed, prefer the loaded/persisted record ID:

```ts
notes: `AI-proposed session (proposal ${record.id})`
```

Use the actual variable name used by the implementation.

Do not change the public proposal ID contract or introduce a second identifier. This is only a clarity and future-proofing adjustment.

### Tests

Update the relevant commit test if needed so that the generated note contains the persisted proposal record ID.

---

## 4. Verification and regression checks

Run the project's complete verification command from a clean environment:

```bash
npm run verify
```

Also run any focused AI Programmer test command used by the repository, if one exists.

Confirm that:

- Existing tests continue to pass.
- Phase 2 proposal generation still works.
- Approval does not commit.
- Commit still creates one planned session.
- Repeated commit remains idempotent.
- Prescription fields remain preserved:
  - target reps minimum/maximum
  - target RIR minimum/maximum
  - target rest seconds
- Performed-set fields remain empty for a newly planned session.
- Blueprint staleness and domain revalidation behavior remain unchanged.
- Outside-Blueprint exercise rejection remains unchanged.
- No raw provider payload or internal error details are exposed through the API.

---

## Scope restrictions

Do not:

- Rewrite the AI Programmer architecture.
- Change the proposal lifecycle states.
- Add automatic commit behavior.
- Change the Blueprint-only scope of this phase.
- Add outside-Blueprint exercise support.
- Change prescription semantics.
- Put planned prescription values into performed-set fields.
- Remove or weaken existing validation.
- Add unrelated UI, database, or product features.
- Replace deterministic workout programming logic.

Keep the diff small and focused.

---

## Required final report

After implementation, report:

1. Files changed.
2. Exact changes made for each of the three cleanup items.
3. Tests added or updated.
4. Verification commands executed.
5. Exact verification results.
6. Any remaining limitations or follow-up recommendations.

The task is complete only when the cleanup is implemented and verification results are reported clearly.
