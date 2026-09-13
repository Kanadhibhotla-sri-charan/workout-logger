# AI Programmer Phase 2 — Explicit Proposal Review and Commit Workflow

## Purpose

Implement the next phase of the AI Programmer integration: an explicit, safe workflow that allows a generated AI workout proposal to be reviewed and then committed only through an intentional application action.

The first vertical slice is already implemented and accepted as proposal-only:

```text
POST /api/ai-programmer/generate-session
        ↓
Context construction
        ↓
Velona provider
        ↓
Structural validation
        ↓
Blueprint/domain validation
        ↓
Validated proposal
```

This task adds **proposal storage, retrieval, review state, and explicit commit behavior**.

The AI must never directly write a workout session to the database. The application remains responsible for persistence, locking, reconciliation, and all final integrity checks.

---

# 1. Core design principles

The following principles are mandatory:

1. AI-generated output is an untrusted proposal until validated.
2. A proposal must be explicitly approved before it can be committed.
3. The provider must never receive database write access.
4. The application, not the model, owns proposal identity.
5. Completed and in-progress workout sessions are immutable and protected.
6. A proposal cannot be committed if its underlying context or Blueprint assumptions are no longer valid.
7. Committing a proposal must be transactional and idempotent.
8. A proposal must not silently overwrite an existing planned, completed, or in-progress session.
9. The deterministic engine remains authoritative for safety, Blueprint validity, and persistence rules.
10. This phase must not introduce automatic background commits.

---

# 2. Scope of this phase

Implement:

- Persistent AI proposal records.
- Proposal status lifecycle.
- Proposal retrieval.
- Explicit approval/commit endpoint.
- Transactional commit into the existing planned-workout/session model.
- Revalidation immediately before commit.
- Conflict handling.
- Idempotency.
- Audit metadata.
- Tests and documentation.

Do not implement:

- Automatic approval.
- Automatic commit after generation.
- Provider-side memory.
- New exercise generation outside the Blueprint.
- A replacement programming engine.
- Automatic changes to completed workouts.
- Automatic rewriting of the weekly program.
- UI redesign beyond any minimal API contract needed for testing.
- Multi-user authorization architecture unless already present in the repository.

---

# 3. Recommended proposal lifecycle

Use an explicit status machine.

Recommended statuses:

```text
generated
        ↓
reviewed
        ↓
approved
        ↓
committed
```

Terminal or invalid states:

```text
rejected
expired
superseded
failed
```

A simpler implementation may use:

```text
pending
approved
committed
rejected
expired
```

Choose the smallest lifecycle compatible with the existing repository conventions, but document it clearly.

## Required transition rules

Valid examples:

```text
generated → reviewed
reviewed → approved
reviewed → rejected
approved → committed
approved → expired
```

Invalid examples:

```text
committed → approved
committed → rejected
rejected → committed
expired → committed
```

If the implementation does not need a separate `reviewed` state, use `pending → approved → committed`, but preserve explicit approval.

---

# 4. Proposal persistence model

Add a repository/table/model for AI proposals using the project's existing database migration and repository conventions.

The exact table name may follow the repository's naming style. A reasonable name is:

```text
ai_program_proposals
```

## Recommended fields

At minimum:

```text
id
status
target_date
weekday
user/profile reference if the existing app requires one
proposal_json
context_fingerprint or context_version metadata
blueprint_version or blueprint_fingerprint
model_provider
model_name
request_id
created_at
updated_at
approved_at
committed_at
rejected_at
expires_at
committed_session_id
failure_reason
```

Use the existing timestamp and ID conventions.

## Important storage rules

- Store the validated proposal, not the raw provider response.
- Do not store API keys, authorization headers, or raw provider request credentials.
- Do not store unbounded raw prompts unless there is an explicit, documented reason.
- If context is stored, store only the required audit-safe context snapshot or a fingerprint/version reference.
- Proposal JSON must be bounded and validated before persistence.
- The database record must preserve the exact validated proposal that was shown for review.
- Do not regenerate or reinterpret the proposal during commit.

## JSON storage

If SQLite JSON text is used:

- serialize the validated proposal deterministically where practical
- validate/parsing failures must be handled explicitly
- do not trust stored JSON without revalidation at read/commit boundaries

---

# 5. Update generation endpoint

The existing endpoint:

```text
POST /api/ai-programmer/generate-session
```

must continue to generate a validated proposal.

After successful validation, it should persist the proposal in `pending` or `generated` status and return:

```json
{
  "proposal": {
    "...": "validated proposal"
  },
  "proposalId": "application-generated-id",
  "status": "pending"
}
```

Adapt the exact response shape to the existing API conventions.

## Required behavior

- Provider failure: do not create a proposal record.
- Structural validation failure: do not create a proposal record.
- Domain validation failure: do not create a proposal record.
- Database persistence failure: return an appropriate server error and do not claim the proposal was saved.
- Successful persistence: return the persisted proposal ID and status.
- The persisted proposal must be the same validated proposal returned to the caller.

## Duplicate generation

Do not automatically deduplicate proposals unless the repository already has a clear idempotency convention.

If duplicate generation is allowed, document that each successful generation creates a separate proposal ID.

---

# 6. Add proposal retrieval endpoint

Add an endpoint following the repository's route conventions, for example:

```text
GET /api/ai-programmer/proposals/:proposalId
```

## Required behavior

Return:

- proposal ID
- status
- target date
- weekday
- validated proposal
- creation/update timestamps
- approval/commit timestamps where applicable
- committed session ID where applicable
- expiry information
- safe audit metadata

Do not return:

- raw provider payload
- API keys
- authorization headers
- internal database errors
- raw prompts containing secrets
- unrestricted internal stack traces

Unknown proposal ID should return the repository's standard not-found response.

---

# 7. Add explicit approval endpoint

Add an endpoint following existing conventions, for example:

```text
POST /api/ai-programmer/proposals/:proposalId/approve
```

Approval must be an explicit application action.

## Required behavior

- Only a pending/reviewable proposal can be approved.
- Already approved proposal approval should be idempotent or return a clearly documented conflict.
- Committed proposals cannot be re-approved.
- Rejected/expired proposals cannot be approved.
- Approval must not commit the workout.
- Approval must not mutate the proposal's workout content.
- Approval should record `approved_at`.
- Approval should preserve the exact proposal JSON.

If the application has no authentication layer yet, document that this endpoint is intended for the current single-user application and do not pretend it provides multi-user authorization.

---

# 8. Add explicit commit endpoint

Add an endpoint following existing conventions, for example:

```text
POST /api/ai-programmer/proposals/:proposalId/commit
```

This endpoint is the only new path that may persist the proposed workout into the existing workout/program data model.

## Commit preconditions

Before committing, verify all of the following:

- Proposal exists.
- Proposal status is `approved`.
- Proposal has not expired.
- Proposal has not already been committed.
- Proposal JSON parses successfully.
- Proposal passes structural validation.
- Proposal passes Blueprint/domain validation.
- Target date is still valid.
- Target date and weekday still match.
- The relevant training profile still exists.
- The current Blueprint version/fingerprint is compatible.
- No completed session exists for the target date.
- No in-progress session exists for the target date.
- No conflicting planned session exists, unless the existing product explicitly supports replacement.
- The proposal's exercise IDs still exist.
- Authored prescriptions still match.
- The deterministic engine's final safety constraints still pass.

Do not rely only on validation performed during generation. The environment may have changed between generation and commit.

---

# 9. Commit transaction and idempotency

The commit operation must be transactional.

Recommended sequence:

```text
Begin transaction
    ↓
Lock/recheck proposal
    ↓
Revalidate proposal and current state
    ↓
Check target-date conflicts
    ↓
Create planned workout/session using existing repository APIs
    ↓
Mark proposal committed
    ↓
Commit transaction
```

## Required properties

### Atomicity

If workout persistence fails, the proposal must not be marked committed.

If marking the proposal committed fails, the workout creation must roll back.

### Idempotency

If the same commit request is repeated after a successful commit:

- do not create a duplicate workout/session
- return the existing committed result, or return a documented idempotent response
- preserve the same `committed_session_id`

### Race protection

Two simultaneous commit requests for the same proposal must not create duplicate sessions.

Use the database transaction, unique constraints, conditional updates, or existing locking conventions.

Do not implement race protection only with an in-memory boolean.

---

# 10. Existing data-model integration

Do not create a parallel workout-session system.

Use the existing repositories and models for:

- planned program/session creation
- workout session records
- exercise/set prescription persistence
- target/date associations
- session status
- program/week relationships

Locate and reuse the existing APIs before adding new persistence functions.

The AI proposal should be translated into the existing domain model through a dedicated application/service function, for example:

```text
commitAIProposalToPlannedSession()
```

That function should:

1. Accept only a validated proposal.
2. Revalidate current state.
3. Map proposal exercises to existing Blueprint exercise records.
4. Create the appropriate planned workout/session records.
5. Return the created session ID and relevant metadata.
6. Never call the LLM/provider.

---

# 11. Conflict policy

Define and document what happens when the target date already has a planned session.

Recommended default:

- Do not overwrite an existing planned session automatically.
- Return a conflict response.
- Require a separate, future replacement workflow if replacement is desired.

At minimum, protect:

```text
completed
in_progress
```

These must never be overwritten by this feature.

For an existing planned session, choose one of:

1. Reject with conflict.
2. Allow commit only if an explicit replacement flag and separate approval policy exist.
3. Treat the proposal as a draft alternative without committing.

For this phase, **rejecting planned-session conflicts is recommended**.

---

# 12. Expiry policy

Proposals should not remain indefinitely commit-able if the context can become stale.

Implement an expiry policy using either:

- a fixed TTL from creation, or
- a context/Blueprint version validity check plus a conservative TTL

A reasonable initial policy is:

```text
expires_at = created_at + 24 hours
```

Adapt this if the product has a stronger requirement.

## Required behavior

- Expired proposals cannot be approved or committed.
- Retrieval should expose expiry status.
- Commit must recheck expiry.
- Expiry must not delete audit history automatically.
- Expiry should be deterministic and timezone-safe.

If a proposal is already approved but expires before commit, it should not be committed unless the documented policy explicitly allows it.

---

# 13. Context and Blueprint staleness

Generation-time context may become stale before commit.

Store enough metadata to detect relevant changes, such as:

- Blueprint snapshot/version/fingerprint
- training profile version or updated timestamp
- target date
- relevant weekly-program version/fingerprint
- deterministic engine/schema version

Do not require storing the entire context unless necessary.

At commit:

- compare stored metadata with current state
- revalidate the proposal against the current Blueprint and profile
- reject with a clear stale-proposal response if the proposal is no longer compatible

Recommended error code:

```text
AI_PROPOSAL_STALE
```

Do not silently regenerate or alter the proposal during commit.

---

# 14. API error contract

Use the repository's existing error format.

At minimum, distinguish:

```text
404 — proposal not found
400 — malformed request
409 — invalid state or target-date conflict
410 — proposal expired
422 — proposal no longer passes domain validation / stale proposal
500 — persistence or unexpected server failure
```

Suggested machine-readable error codes:

```text
AI_PROPOSAL_NOT_FOUND
AI_PROPOSAL_INVALID_STATE
AI_PROPOSAL_EXPIRED
AI_PROPOSAL_CONFLICT
AI_PROPOSAL_STALE
AI_PROPOSAL_VALIDATION_FAILED
AI_PROPOSAL_COMMIT_FAILED
```

Do not expose raw SQL errors, stack traces, provider payloads, or secrets.

---

# 15. Tests required

## Repository tests

- create proposal
- retrieve proposal
- update status
- reject invalid status transition
- persist and parse validated proposal JSON
- preserve timestamps
- preserve committed session ID
- expiry handling

## Generation endpoint tests

- successful generation persists proposal
- response ID equals persisted proposal ID
- provider failure creates no proposal
- schema validation failure creates no proposal
- domain validation failure creates no proposal
- persistence failure does not return a successful proposal

## Retrieval tests

- known proposal returned
- unknown proposal returns 404
- raw provider payload is not returned
- safe metadata is returned
- committed session ID is returned after commit

## Approval tests

- pending proposal can be approved
- approval does not commit
- already approved behavior is deterministic/idempotent
- rejected proposal cannot be approved
- expired proposal cannot be approved
- committed proposal cannot be approved
- proposal content remains unchanged after approval

## Commit tests

- approved proposal commits successfully
- pending proposal cannot commit
- rejected proposal cannot commit
- expired proposal cannot commit
- malformed stored JSON cannot commit
- changed Blueprint prescription causes rejection
- changed exercise validity causes rejection
- completed session conflict is rejected
- in-progress session conflict is rejected
- planned-session conflict follows documented policy
- commit creates the correct existing domain records
- proposal is marked committed only after successful persistence
- persistence failure rolls back proposal/session changes
- repeated commit does not create duplicates
- concurrent commit attempts do not create duplicates
- committed session ID is stable

## Security/error tests

- raw provider payload never appears in API response
- API keys never appear in API response or logs
- SQL errors are not exposed
- diagnostic output remains bounded

---

# 16. Documentation required

Update or create documentation covering:

- proposal lifecycle
- endpoint contracts
- approval versus commit distinction
- expiry policy
- conflict policy
- stale-context behavior
- idempotency behavior
- transaction guarantees
- current single-user authorization assumptions
- feature flag behavior
- how to test the workflow locally

Include a clear statement:

> Generation creates a proposal. Approval authorizes the proposal. Commit persists it into the workout system. These are separate operations.

---

# 17. Feature flag and rollout

Keep the feature behind the existing AI Programmer feature flag or introduce a clearly named one if necessary.

Recommended behavior:

- generation remains disabled unless configured
- proposal retrieval/approval/commit endpoints should not expose unsafe functionality when the feature is disabled
- disabled behavior should be deterministic and documented
- no automatic fallback from failed AI generation to automatic commit

Do not enable production commit behavior by default.

---

# 18. Final verification requirements

Run from a clean dependency state:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

Also run focused tests for:

```text
proposal repository
generation route
retrieval route
approval route
commit route
transaction rollback
idempotency/concurrency
stale Blueprint validation
```

Report the exact commands and results.

Also report:

```bash
git status
git rev-parse HEAD
git log -1 --oneline
```

Do not claim verification passed unless the commands actually completed successfully.

---

# 19. Required developer final report

Report:

## Implementation

- files changed
- migration/table added
- proposal status lifecycle
- endpoints added
- repository/service functions added
- commit transaction design
- conflict policy
- expiry policy
- stale-context policy
- idempotency strategy
- feature flag behavior

## Verification

Include exact results for:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

Include focused test results and any concurrency/rollback tests.

## Remaining limitations

Clearly list:

- anything not implemented
- any environment limitation
- any known follow-up work
- any deviation from this task
- any authorization limitations in the current single-user application

---

# Acceptance criteria

- [ ] Proposal records are persisted only after successful validation.
- [ ] Stored proposal contains the validated proposal, not raw provider output.
- [ ] Proposal retrieval endpoint works.
- [ ] Approval is explicit and does not commit.
- [ ] Commit requires approval.
- [ ] Commit revalidates current Blueprint and training state.
- [ ] Completed and in-progress sessions are protected.
- [ ] Planned-session conflict policy is implemented and documented.
- [ ] Commit is transactional.
- [ ] Repeated commit is idempotent.
- [ ] Concurrent commit attempts cannot create duplicate sessions.
- [ ] Proposal expiry is implemented.
- [ ] Stale Blueprint/context changes are detected.
- [ ] Proposal status transitions are enforced.
- [ ] Raw provider payloads and secrets are never exposed.
- [ ] Existing workout/session repositories and models are reused.
- [ ] No parallel workout persistence system is introduced.
- [ ] No automatic commit is introduced.
- [ ] Regression tests cover generation, retrieval, approval, commit, rollback, conflict, expiry, and idempotency.
- [ ] Clean verification is run and actual results are reported.
