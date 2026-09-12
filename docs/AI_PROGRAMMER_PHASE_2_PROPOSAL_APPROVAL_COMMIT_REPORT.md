# AI Programmer Phase 2 — Implementation Report

Implements `docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md` on top of the first vertical slice and its correction/cleanup passes (branch `ai-programmer-first-vertical-slice`). Full design/behavior reference: `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md`.

## Implementation

### Files changed

**New:**
- `src/repositories/aiProposalRepo.ts` — `AIProposalRepo`, `AIProposalRecord`/`AIProposalStatus` types, `effectiveStatus()`, `computeExpiresAt()`, `MalformedProposalJsonError`.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — `getProposal()`, `approveProposal()`, `commitAIProposalToPlannedSession()`.
- `tests/repositories/aiProposalRepo.test.ts` (17 tests).
- `tests/ai-programmer/aiProposalRoutes.test.ts` (27 tests).
- `docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md` (the task spec itself, saved verbatim per this session's convention).
- `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md` (full design/behavior doc).
- `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT_REPORT.md` (this file).

**Modified:**
- `src/db/schema.sql` — added `ai_program_proposals` table + two indexes.
- `src/ai-programmer/errors.ts` — added 7 new error classes (`AIProposalNotFoundError`, `AIProposalInvalidStateError`, `AIProposalExpiredError`, `AIProposalConflictError`, `AIProposalStaleError`, `AIProposalValidationFailedError`, `AIProposalCommitFailedError`) and extended `AIProgrammerErrorCode`.
- `src/ai-programmer/service/aiProgrammerService.ts` — `generateSession()` now persists the validated proposal via `AIProposalRepo` and returns `proposalId`/`status` alongside the existing fields.
- `src/server/routes/aiProgrammer.ts` — added `GET /proposals/:proposalId`, `POST /proposals/:proposalId/approve`, `POST /proposals/:proposalId/commit`; `generate-session`'s response gained `proposalId`/`status`.
- `docs/AI_PROGRAMMER_INTEGRATION_STATUS.md` — updated to reflect that generation now persists, with a pointer to the new lifecycle doc.

### Migration / table added

`ai_program_proposals` (`src/db/schema.sql`), added as a new `CREATE TABLE IF NOT EXISTS` block per this repo's existing no-migration-runner convention (the whole schema is re-applied idempotently on every `openDb()` call). Columns exactly match the task spec's §4 recommended field list (`id`, `status`, `target_date`, `weekday`, `proposal_json`, `context_hash`/`blueprint_commit` in place of the spec's generic "context/blueprint version" wording, `model_provider`/`model_name`/`request_id`, `committed_session_id`, `failure_reason`, and the full timestamp set). `id TEXT PRIMARY KEY` follows this codebase's existing convention, and `committed_session_id` is a real `REFERENCES workout_sessions(session_id) ON DELETE SET NULL` foreign key (confirmed enforced — `foreign_keys = ON` is set in `src/db/client.ts`, and an early test iteration that pointed it at a fake session id was caught by a genuine `SqliteError: FOREIGN KEY constraint failed` and fixed).

### Proposal status lifecycle

Five statuses: `pending -> approved -> committed`, with `pending`/`approved` able to lapse to `expired`, and a `rejected` terminal status defined in the schema/repo for a future reject action (no route commits a proposal there yet — see Remaining limitations). This is the task spec's explicitly-permitted "simpler implementation" option, chosen over the six-state `generated/reviewed/approved/committed/rejected/superseded/failed` machine since nothing in this application needs a `reviewed` state distinct from `approved`. Transitions are enforced entirely in `AIProposalRepo`'s private `transition()` helper via a genuinely conditional SQL `UPDATE ... WHERE status IN (...)` — not a get-then-set race, and not a DB constraint/trigger (matching this codebase's existing `goal_phases` state-machine style).

### Endpoints added

- `GET /api/ai-programmer/proposals/:proposalId`
- `POST /api/ai-programmer/proposals/:proposalId/approve`
- `POST /api/ai-programmer/proposals/:proposalId/commit`
- `POST /api/ai-programmer/generate-session` (existing route, extended response shape only)

All four share the existing `AI_PROGRAMMER_ENABLED` feature flag and the existing `AIProgrammerError` → `{ ok, error, message, details }` response convention.

### Repository/service functions added

- `AIProposalRepo.create/getById/approve/markCommitted/markExpired/recordFailure` (`src/repositories/aiProposalRepo.ts`).
- `getProposal()`, `approveProposal()`, `commitAIProposalToPlannedSession()` (`src/ai-programmer/service/aiProposalLifecycle.ts`) — the last is the task spec's explicitly-requested function name and is the **only** code path in this codebase permitted to write an AI proposal into `workout_sessions`/`workout_exercises`/`workout_sets`, via the existing `WorkoutSessionsRepo.createSession()`/`addExercisePerformance()` (no new, parallel persistence system was introduced).

### Commit transaction design

`commitAIProposalToPlannedSession()` runs nine preconditions (existence, not-already-committed idempotency check, expiry, status, JSON/structural revalidation, Blueprint-commit staleness, a freshly-rebuilt-context domain revalidation, planned-session conflict) **before** opening a transaction. Only the actual writes — session creation, per-exercise `addExercisePerformance()` calls, and the proposal's `approved -> committed` transition — run inside one `db.transaction(...)` (better-sqlite3's synchronous `BEGIN`/`COMMIT`/`ROLLBACK`), the same pattern already used by `WorkoutSessionsRepo.addExercisePerformance` and `ProgramsRepo.createProgramSession` elsewhere in this codebase. Any failure inside the transaction (including the conditional `markCommitted()` update losing a race) rolls the whole thing back — verified directly by a test that makes `WorkoutSessionsRepo.addExercisePerformance` throw mid-commit and asserts no session row survives and the proposal stays `approved`.

### Conflict policy

Task spec §11's recommended default: reject, never auto-overwrite. Completed/in-progress conflicts are caught by reusing the existing `buildProgrammerContext()`/`validateProposalDomain()` lock check (`AITargetNotEditableError`, `409`); a `planned`-session conflict — not covered by that existing check, which only ever treated completed/in-progress as locking — is a new, dedicated check added for commit (`AIProposalConflictError`, `409`).

### Expiry policy

`expires_at = created_at + 24h` exactly (`PROPOSAL_TTL_MS`/`computeExpiresAt()`), computed from plain UTC ISO instants — deterministic and timezone-safe regardless of `TrainingProfile.timezone`. Checked (and lazily persisted) at both approval and commit via a shared `loadCurrent()` helper, never via a background sweep, so a proposal's stored history is never silently deleted.

### Stale-context policy

`blueprint_commit` (reusing the exact same `BlueprintAdapter.getManifest().sourceCommit` fingerprint `programs.blueprint_commit` already uses elsewhere) is compared first; a fresh `buildProgrammerContext()` + `validateProposalDomain()` re-run then catches every other kind of drift (changed authored prescription, no-longer-valid exercise, date/weekday mismatch) without needing separate ad hoc checks for each. Both paths map to `422 AI_PROPOSAL_STALE`, per spec §13's recommended error code.

### Idempotency strategy

A commit already in `committed` status short-circuits to the existing `committedSessionId` before touching the database again — verified by both a repeated-sequential-request test and a `Promise.all`-fired concurrent-request test (both return the same `committedSessionId`; exactly one `workout_sessions` row exists for the date). The underlying race protection is the conditional `UPDATE ... WHERE status IN (...)` in `AIProposalRepo.transition()`, not an in-memory flag, per spec §9's explicit requirement.

### Feature flag behavior

All four proposal-related routes are gated behind the existing `AI_PROGRAMMER_ENABLED === "true"` check — a deliberate, conservative choice documented in `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md`'s **Feature flag** section (even though approve/commit never call the provider, keeping the whole proposal surface behind one flag avoids a partial-disabled state).

## Verification

All commands run from a clean state on branch `ai-programmer-first-vertical-slice`:

```
$ npm ci
added 196 packages, and audited 197 packages in 5s
(pre-existing npm audit warnings, unrelated to this change; no new ones introduced)

$ npm run build
> tsc -p tsconfig.build.json && cp src/db/schema.sql dist/db/schema.sql
(clean, no errors)

$ npx tsc --noEmit
(clean, no errors)

$ npm test   (== npx vitest run)
 Test Files  93 passed (93)
      Tests  965 passed (965)

$ npm run verify   (build + typecheck + test composed)
 Test Files  93 passed (93)
      Tests  965 passed (965)
(re-run after npm ci to confirm — identical result)
```

### Focused test runs

```
$ npx vitest run tests/repositories/aiProposalRepo.test.ts tests/ai-programmer/aiProposalRoutes.test.ts \
    tests/ai-programmer/aiProgrammerService.test.ts tests/ai-programmer/aiProgrammerRoute.test.ts
 Test Files  4 passed (4)
      Tests  61 passed (61)
```

Covers, by name, every category the task spec's §15/§18 requires: proposal repository (create/retrieve/transitions/expiry/malformed-JSON — 17 tests), generation route (persistence, no-row-on-any-validation-failure, separate ids per generation — folded into the 27-test route file), retrieval route (known/unknown/security), approval route (idempotent/invalid-state/expired/content-unchanged), commit route (success/idempotent-repeat/all three conflict types/stale-Blueprint/stale-exercise/malformed-JSON/rollback-on-persistence-failure/concurrent-commit/disabled-flag/security).

### Verification by reversion

Per this session's established discipline: stashed every modified source file (`errors.ts`, `aiProgrammerService.ts`, `schema.sql`, `aiProgrammer.ts` route) and moved the two new source files (`aiProposalRepo.ts`, `aiProposalLifecycle.ts`) aside, then re-ran the new test files against the reverted tree. Result: 24 of 27 route tests failed (the remaining 3 happened to still pass incidentally — e.g. a 404-on-unknown-id check that also holds when the whole feature is simply absent) and the repository test file failed to even resolve its import, confirming the new tests genuinely exercise the new code rather than passing vacuously. Restored all files and re-ran the full suite (965/965 passed again) before proceeding.

### Concurrency/rollback tests specifically

- `'concurrent commit attempts for the same proposal do not create duplicate sessions'` — fires two `POST .../commit` requests via `Promise.all`, asserts both return `200` with the identical `committedSessionId` and exactly one session row exists.
- `'a persistence failure mid-commit rolls back: no orphaned session, proposal stays approved'` — `vi.spyOn(WorkoutSessionsRepo.prototype, 'addExercisePerformance')` forced to throw, asserts `500 AI_PROPOSAL_COMMIT_FAILED`, zero session rows for the date, and the proposal's status is still `approved` (not `committed`) with `committedSessionId` still `null`.
- `'a changed Blueprint commit since generation is detected as staleness'` and `'an exercise that is no longer Blueprint-valid is caught by commit-time revalidation'` — both directly exercise the stale-Blueprint/stale-context revalidation path (spec §13's required test category).

## Remaining limitations

- **No `POST /proposals/:id/reject` endpoint.** `rejected` is a fully-defined, enforced terminal status in the schema and `AIProposalRepo`'s transition rules (a proposal can never leave that state once in it), but nothing currently transitions a proposal into it — the task spec requires approval/commit explicitly but never actually requires a reject action to exist yet. A future endpoint would be a small, additive change (one new repo method following the exact same conditional-update pattern as `approve()`).
- **No multi-user authorization on approve/commit.** This application has no authentication layer anywhere (goals, programs, sessions are all equally unauthenticated) — this is not a new limitation introduced by this phase, and is documented explicitly in `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md` per the task spec's own instruction not to pretend otherwise.
- **No automatic deduplication of generate-session requests.** Requesting the same still-editable date twice creates two separate `pending` proposal rows — deliberate, per task spec §5 ("do not automatically deduplicate proposals unless the repository already has a clear idempotency convention"; none exists here for this kind of request).
- **Malformed stored `proposal_json` surfaces as a generic 500,** not a dedicated `422`. This should never happen in practice (the row is only ever written by this codebase's own `JSON.stringify` of an already-validated object), so it was deliberately left as a should-never-happen internal error rather than given its own polished error path — documented in both the code comments and the lifecycle doc.
- **No deviation from the task spec's required scope** — every explicit non-goal (automatic approval, automatic commit after generation, provider-side memory, outside-Blueprint exercises, a replacement programming engine, automatic changes to completed workouts/the weekly program, UI beyond the API, new multi-user auth architecture) was left out exactly as instructed.

## Final state

```
$ git status
(clean after this report's own commit — see below)

$ git rev-parse HEAD
<recorded at the commit this report ships with — see the commit accompanying this file>

$ git log -1 --oneline
<same commit>
```
