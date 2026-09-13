# AI Programmer Phase 2 — Cleanup Pass Report

Implements `docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_CLEANUP_PASS.md` on top of the Phase 2 proposal approval/commit workflow and its correction pass (branch `ai-programmer-first-vertical-slice`, prior commit `62be58e`). Small, focused diff — no architecture change, no lifecycle-state change, no new scope.

## Files changed

- `src/repositories/aiProposalRepo.ts` — `transition()` gains an optional extra-WHERE-clause parameter; `markCommitted()` uses it to add an atomic `expires_at >= @now` condition.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — added `classifyCommitFailure()`; the commit failure catch block now logs the raw error server-side and persists only a safe category; the `markCommitted()` failure branch now distinguishes an expiry-guard rejection from a status race; the commit note now reads `record.id` instead of `proposal.proposalId`.
- `tests/repositories/aiProposalRepo.test.ts` — 2 new tests for the atomic expiry guard.
- `tests/ai-programmer/aiProposalRoutes.test.ts` — extended the existing rollback test with failure-reason sanitization assertions; extended the existing successful-commit test with a note-content assertion.

No schema change, no new endpoint, no new error code, no lifecycle-state change.

## Item 1 — Sanitize persisted commit failure reasons

**Change:** `commitAIProposalToPlannedSession()`'s catch block previously did:

```ts
repo.recordFailure(proposalId, err instanceof Error ? err.message : 'unknown commit error');
```

Now:

```ts
console.error(`AI proposal commit failed for proposal ${proposalId}:`, err);
repo.recordFailure(proposalId, classifyCommitFailure(err));
```

where `classifyCommitFailure()` is a small, local, closed-set classifier:

```ts
function classifyCommitFailure(err: unknown): string {
  if (err instanceof UnknownExerciseError) return 'exercise_resolution_failed';
  return 'commit_transaction_failed';
}
```

The raw error (which could contain SQL text, constraint/table/column names, or other internal detail) is still fully visible via `console.error` on the server's own controlled log — nothing about debuggability was lost — but only one of the two fixed category strings above is ever persisted into `failure_reason` or reachable through any API response.

**Tests:** extended the existing `'a persistence failure mid-commit rolls back'` test (`tests/ai-programmer/aiProposalRoutes.test.ts`) — it already forced a persistence error at exactly the right point; added:
1. A deliberately distinctive internal-looking message (`'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed on internal_table_xyz'`).
2. An assertion that the API response body does not contain that string.
3. A direct query of `ai_program_proposals.failure_reason` asserting it does not contain the internal string or the substring `'SQLITE_CONSTRAINT'`.
4. An assertion that the stored value is exactly the safe category `'commit_transaction_failed'`.

## Item 2 — Strengthen expiry enforcement at commit time

**Investigation:** the pre-existing design already had a real, DB-level atomic guard against a *status* race (the conditional `UPDATE ... WHERE status IN ('approved')` from the original Phase 2 pass) — that part already satisfied "not merely an in-memory boolean." What it did **not** do was fold *expiry* into that same atomic condition: expiry was checked only as a separate pre-condition (`loadCurrent()`'s lazy expiry check) before the transaction even started. In this specific application (synchronous `better-sqlite3`, single Node process, no `await` between the pre-check and the transaction) that pre-check is in practice always accurate — but the task asked for the invariant to be protected at the final transition itself, not merely by an earlier check that happens to be recent enough today.

**Change:** `AIProposalRepo.transition()` gained an optional extra-WHERE-clause parameter (`extraWhereSql`/`extraWhereParams`), and `markCommitted()` now uses it:

```ts
markCommitted(id: string, sessionId: string): AIProposalRecord | undefined {
  return this.transition(
    id,
    ['approved'],
    'committed',
    ', committed_at = @committed_at, committed_session_id = @committed_session_id',
    { committed_at: nowIso(), committed_session_id: sessionId },
    ' AND expires_at >= @now',
    { now: nowIso() }
  );
}
```

The final `UPDATE` statement is now `... WHERE id = @id AND status IN ('approved') AND expires_at >= @now` — a single atomic SQL statement enforcing status, expiry, and identity (`id = @id`, inherently exact since it's a primary-key match) together. `commitAIProposalToPlannedSession()`'s handling of a zero-row result was updated to distinguish which condition actually failed (re-reading the row and checking its expiry) so the correct error (`AIProposalExpiredError`/410 vs. `AIProposalInvalidStateError`/409) is still returned to the caller in either case, and the whole transaction still rolls back on either failure exactly as before (no orphaned session).

**Tests:** two new repository-level tests (`tests/repositories/aiProposalRepo.test.ts`):
- `'markCommitted(): rejects an approved proposal whose expires_at has already passed, even before markExpired() has run'` — directly sets `expires_at` into the past via raw SQL on a row whose stored `status` still reads `'approved'` (simulating the exact gap the lazy-transition design leaves open), then asserts `markCommitted()` returns `undefined` and nothing about the row changes.
- `'markCommitted(): still succeeds for an approved proposal that has not yet expired'` — the positive-case regression guard.

**Verified by reversion:** temporarily removed the `extraWhereSql` argument from `markCommitted()`'s call (reverting only that one line) and re-ran the new test — it failed exactly as expected (`markCommitted()` returned a committed record instead of `undefined`). Restored and re-confirmed green.

**Already-satisfied parts of item 2 (no change needed, per the task's own "if already provided, document" clause):**
- "A proposal whose status changes before the final transition cannot become committed" — the original `WHERE status IN ('approved')` conditional update already provided this; unchanged.
- "A valid approved, unexpired proposal still commits normally" — unchanged; still passes.
- "Repeated commit remains idempotent" — unchanged (the `record.status === 'committed'` short-circuit at the top of `commitAIProposalToPlannedSession()` is untouched); still passes.

## Item 3 — Use the authoritative persisted record ID in commit notes

**Change:**

```ts
notes: `AI-proposed session (proposal ${record.id})`,
```

(previously `proposal.proposalId`, where `proposal` is the re-validated, parsed `structural.value` object rather than the loaded `AIProposalRecord`). `record.id` and `proposal.proposalId` are guaranteed identical today (`AIProposalRepo.create()` always uses the in-memory proposal's own `proposalId` as the row's `id` — no second identifier was introduced, and none is proposed here either, per the task's explicit instruction not to). This is a pure clarity/future-proofing change: the note now references the actually-loaded, authoritative persisted row rather than a value that happens to travel alongside it.

**Tests:** extended the existing `'commits an approved proposal, creating a real planned session with the proposed exercises'` test with an assertion that the created session's `notes` field contains the proposal id used to look it up.

## Verification commands executed (from a clean environment)

```
$ npm ci
added 196 packages, and audited 197 packages in 3s
(pre-existing npm audit warnings only — unrelated to this change, no new ones introduced)

$ npm run build
> tsc -p tsconfig.build.json && cp src/db/schema.sql dist/db/schema.sql
(clean, no errors)

$ npx tsc --noEmit
(clean, no errors)

$ npm run verify   (build + typecheck + test composed)
 Test Files  93 passed (93)
      Tests  973 passed (973)
```

### Focused AI Programmer test run

```
$ npx vitest run tests/ai-programmer tests/repositories/aiProposalRepo.test.ts tests/workoutSessions.test.ts
 Test Files  10 passed (10)
      Tests  166 passed (166)
```

## Exact verification results against the task's required checklist

- **Existing tests continue to pass** — 973/973 (up from 971 before this pass; +2 net from the two new repository tests, with test additions/extensions inside already-existing test files for items 1 and 3 rather than new files).
- **Phase 2 proposal generation still works** — `tests/ai-programmer/aiProposalRoutes.test.ts`'s generation-persistence tests pass unchanged.
- **Approval does not commit** — unchanged approval tests pass (`approves a pending proposal ... without committing it`).
- **Commit still creates one planned session** — `'commits an approved proposal, creating a real planned session with the proposed exercises'` passes (now also asserting the note contains the persisted record id).
- **Repeated commit remains idempotent** — `'repeated commit is idempotent: same committedSessionId, no duplicate session created'` and the concurrent-commit test both pass unchanged.
- **Prescription fields remain preserved** (target reps min/max, target RIR min/max, target rest seconds) — `'an approved proposal with distinctive reps/RIR/rest is committed with that exact prescription intact'` passes unchanged; this cleanup pass touched neither the prescription-mapping code nor its fields.
- **Performed-set fields remain empty for a newly planned session** — same test's assertions on `set.reps`/`weight`/`rir`/`rpe`/`rest_seconds`/`completed` being null/false pass unchanged.
- **Blueprint staleness and domain revalidation behavior remain unchanged** — the staleness tests (`blueprint_commit` mismatch, authored-prescription drift, `contextHash`-is-audit-only) pass unchanged; none of that logic was touched.
- **Outside-Blueprint exercise rejection remains unchanged** — `'a proposal retargeted (post-generation) at an approved outside-Blueprint exercise is still rejected'` passes unchanged.
- **No raw provider payload or internal error details are exposed through the API** — the pre-existing "never leaks API key" tests still pass, and this pass adds a direct assertion that a distinctive internal error message is absent from both the API response and the persisted `failure_reason`.

## Remaining limitations / follow-up recommendations

- `classifyCommitFailure()` currently distinguishes only two categories (`exercise_resolution_failed`, `commit_transaction_failed`). This is intentionally minimal per the task's "avoid unnecessary complexity" instruction; a future pass could add more categories (e.g. distinguishing a SQLite constraint violation from an unexpected JS error) if that distinction becomes operationally useful, but nothing here requires it today.
- The new `expires_at >= @now` guard on `markCommitted()` cannot be triggered end-to-end through the HTTP route in a test, because the service's own `loadCurrent()` pre-check already lazily transitions and rejects an actually-expired proposal before the transaction is ever reached in this synchronous, single-process architecture — reproducing the exact race window would require mocking time/monkey-patching rather than a real scenario. It is instead verified directly and unambiguously at the repository layer (where the atomic SQL guarantee actually lives), which is the correct place to prove it.
- No other follow-up work identified; scope restrictions in the task spec (no architecture rewrite, no lifecycle changes, no new endpoints/features) were fully respected.

## Final state

```
$ git status
working tree clean at commit 0cbefd8 (this report's own commit)

$ git rev-parse HEAD
0cbefd8072eae76c527e557165df6b59d2f8f337

$ git log -1 --oneline
0cbefd8 AI Programmer Phase 2 cleanup pass: sanitize failure_reason, atomic expiry guard, note uses record.id
```
