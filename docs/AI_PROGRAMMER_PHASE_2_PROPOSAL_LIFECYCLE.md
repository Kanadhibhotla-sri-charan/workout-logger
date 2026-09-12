# AI Programmer Phase 2 — Proposal Storage, Review, and Commit

Implements `docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md` on top of the first vertical slice (`docs/AI_PROGRAMMER_INTEGRATION_STATUS.md`). Adds persistent proposal storage, an explicit review/approval step, and the only code path allowed to write an AI proposal into the real workout/session data model.

> **Generation creates a proposal. Approval authorizes the proposal. Commit persists it into the workout system. These are separate operations.**

## Proposal lifecycle

```text
pending -> approved -> committed
   |           |
   v           v
rejected    expired
   ^           ^
   +-----------+
  (pending can also lapse to expired)
```

Five statuses (the "simpler implementation" option the task spec explicitly allows, chosen over the six-state `generated/reviewed/approved/committed/rejected/superseded/failed` machine since this application has no separate "review" UI step distinct from "approve" — approving IS the review decision):

| Status | Meaning |
|---|---|
| `pending` | Generated and validated, not yet reviewed. |
| `approved` | Explicitly approved; not yet committed. |
| `committed` | Persisted into `workout_sessions`/`workout_exercises`/`workout_sets`. Terminal. |
| `rejected` | Reserved for a future explicit reject action (no route exists yet — see Limitations). Terminal. |
| `expired` | Past its `expires_at` before being committed. Terminal. |

**Enforced valid transitions:** `pending -> approved`, `approved -> committed`, `pending -> expired`, `approved -> expired`. Every other transition (`committed -> approved`, `committed -> rejected`, `rejected -> committed`, `expired -> committed`, etc.) is rejected. Transitions are enforced in `src/repositories/aiProposalRepo.ts`, not a DB constraint/trigger — the same pattern this codebase already uses for `goal_phases` (see `src/repositories/goalPhaseRepo.ts`).

**Persistence:** `ai_program_proposals` (`src/db/schema.sql`) — `id` (always the same UUID as `AIWorkoutSessionProposal.proposalId`), `status`, `target_date`, `weekday`, `proposal_json` (the exact validated proposal, never the raw provider response), `context_hash`, `blueprint_commit`, `model_provider`/`model_name`/`request_id`, `committed_session_id` (a real FK to `workout_sessions.session_id`), `failure_reason`, and the full set of lifecycle timestamps (`created_at`/`updated_at`/`approved_at`/`committed_at`/`rejected_at`/`expires_at`).

## Endpoints

All four endpoints live in `src/server/routes/aiProgrammer.ts` and share the existing `AI_PROGRAMMER_ENABLED` feature flag (see **Feature flag** below) and the existing `AIProgrammerError` → `{ ok: false, error: CODE, message, details }` response convention.

### `POST /api/ai-programmer/generate-session` (updated)

Unchanged request/validation. On success, the validated proposal is now also persisted (status `pending`) and the response gains two fields:

```json
{ "ok": true, "proposal": { "...": "..." }, "proposalId": "...", "status": "pending", "contextHash": "...", "provider": "...", "model": "...", "requestId": "..." }
```

`proposalId` and `proposal.proposalId` are always the same string — the DB row's `id` reuses the in-memory proposal's own id rather than generating a second one (`src/ai-programmer/service/aiProgrammerService.ts`). A provider failure, a structural-validation failure, or a domain-validation failure creates **no** row at all — persistence only happens after both validation layers pass. A database write failure during persistence throws before the response is built, so a caller never sees `ok: true` for a proposal that wasn't actually saved.

Duplicate generation is **not** deduplicated: requesting the same still-editable `targetDate` twice creates two separate proposal rows with two different ids (no idempotency key/convention exists elsewhere in this codebase for this kind of request, so none was invented here).

### `GET /api/ai-programmer/proposals/:proposalId` (new)

Returns the persisted proposal plus lifecycle/audit metadata: `proposalId`, `status`, `targetDate`, `weekday`, `proposal` (full validated content), `contextHash`, `provider`/`model`/`requestId`, `committedSessionId`, and every timestamp. Unknown id → `404 AI_PROPOSAL_NOT_FOUND`. Never returns the raw provider response, an API key, an authorization header, a raw SQL error, or a stack trace — the response is built entirely from `src/repositories/aiProposalRepo.ts`'s typed record, which never stores any of those in the first place.

Retrieval is lazily truthful about expiry: if a `pending`/`approved` proposal's `expires_at` has passed, the very first read (whether via `GET`, `approve`, or `commit`) persists the `-> expired` transition right then — never via a background sweep — so `status` in the response always reflects reality.

### `POST /api/ai-programmer/proposals/:proposalId/approve` (new)

Explicit approval only. Never commits, never mutates `proposal_json`. Behavior by current status:

| Current status | Result |
|---|---|
| `pending` | → `approved`, `approved_at` set. `200`. |
| `approved` | No-op, returns the existing record unchanged. `200` (idempotent — approving twice is not an error). |
| `committed` | `409 AI_PROPOSAL_INVALID_STATE`. |
| `rejected` | `409 AI_PROPOSAL_INVALID_STATE`. |
| `expired` (or lapsed at read time) | `410 AI_PROPOSAL_EXPIRED`. |

### `POST /api/ai-programmer/proposals/:proposalId/commit` (new)

The **only** code path in this codebase allowed to write an AI proposal into `workout_sessions`/`workout_exercises`/`workout_sets`, via `commitAIProposalToPlannedSession()` (`src/ai-programmer/service/aiProposalLifecycle.ts`). Never calls the LLM/provider.

Preconditions checked, in order, before anything is written:

1. Proposal exists (`404` otherwise).
2. Already `committed`? → idempotent success (see **Idempotency**), not an error.
3. `expired` (including lazily-detected)? → `410 AI_PROPOSAL_EXPIRED`.
4. Status is exactly `approved`? → otherwise `409 AI_PROPOSAL_INVALID_STATE` (a `pending`, never-approved proposal cannot be committed).
5. Stored `proposal_json` parses and re-passes structural schema validation (`validateProposalSchema`) → otherwise `422 AI_PROPOSAL_VALIDATION_FAILED` (or, for genuinely corrupted JSON — which should never happen since this app only ever writes what it itself validated — an internal `500`, never a raw parser error).
6. The Blueprint commit captured at generation time still matches `BlueprintAdapter.getManifest().sourceCommit` → otherwise `422 AI_PROPOSAL_STALE`.
7. A **fresh** `AIProgrammerContext` is rebuilt via `buildProgrammerContext()` for the proposal's `targetDate` — this reuses the exact same past-date and completed/in-progress-session lock checks generation itself uses, throwing `409 AI_TARGET_NOT_EDITABLE` if either fails, rather than duplicating that logic.
8. `validateProposalDomain()` is re-run against that fresh context — this is what catches a changed authored prescription, an exercise no longer valid for its target, or a `targetDate`/`weekday` mismatch, exactly the same checks generation itself ran, just against now-current state → otherwise `422 AI_PROPOSAL_STALE`.
9. No existing `planned` session already occupies the target date (see **Conflict policy**) → otherwise `409 AI_PROPOSAL_CONFLICT`.

Only once all nine checks pass does the transaction run. Success (`200`) or idempotent-repeat (`200`) response shape is the same as `GET`'s, since a commit result is just the updated record.

## Conflict policy (spec §11)

The task spec's recommended default — **reject, never auto-overwrite** — is what's implemented:

- **Completed** or **in-progress** session on the target date → always rejected (`409 AI_TARGET_NOT_EDITABLE`), via the reused `buildProgrammerContext()`/`validateProposalDomain()` lock check (the same one generation itself already enforces).
- **Planned** session on the target date → rejected (`409 AI_PROPOSAL_CONFLICT`) by a dedicated check added for commit, since the existing lock check only ever treated completed/in-progress as locking. No replacement flag or override exists this phase — a genuine "replace this planned session" workflow is explicitly out of scope (task spec §2).

## Expiry policy (spec §12)

`expires_at = created_at + 24 hours` (`PROPOSAL_TTL_MS` / `computeExpiresAt()` in `src/repositories/aiProposalRepo.ts`), computed from plain UTC ISO instants (`nowIso()`/`toISOString()`) — never a calendar date or a wall-clock/local-timezone computation, so it is deterministic and timezone-safe regardless of the user's `TrainingProfile.timezone`.

- A `pending`/`approved` proposal past its `expires_at` cannot be approved (`410`) or committed (`410`).
- Expiry is re-checked at both approval and commit time (via the shared `loadCurrent()` helper in `aiProposalLifecycle.ts`), not assumed from a single check at generation time.
- Expiry is exposed on retrieval (`GET` reflects `status: "expired"` once lapsed) but never deletes the row or its history — the record stays queryable forever with its full audit trail intact.
- If a proposal is `approved` and then lapses before commit, it is **not** committed — the documented policy above (expire, don't grandfather) applies uniformly regardless of prior approval.

## Stale-context / stale-Blueprint detection (spec §13)

Rather than storing the entire generation-time context, only two pieces of fingerprint metadata are stored: `context_hash` (from the first vertical slice's own `hashContext()`) and `blueprint_commit` (`BlueprintAdapter.getManifest().sourceCommit`, the same fingerprint `programs.blueprint_commit`/`WeeklyProgramRepo` already use elsewhere in this codebase). At commit time:

- The stored `blueprint_commit` is compared against the current one — a mismatch is an immediate `422 AI_PROPOSAL_STALE`, no further checks needed.
- A **fresh** context and a full domain-validation re-run (see commit preconditions 7-8 above) catch every other kind of drift the task spec calls out — a changed authored prescription, an exercise no longer valid for its target, a target date whose weekday no longer matches — without needing separate ad hoc staleness checks for each one.
- The proposal is never silently regenerated or altered when it's found stale — the caller must request an entirely new proposal.

## Idempotency and concurrency (spec §9)

**Idempotency:** repeating a successful commit request returns the exact same `committedSessionId` and does not create a second session — `commitAIProposalToPlannedSession()` checks `status === 'committed'` first and short-circuits to the existing result before touching the database again.

**Race protection** is a genuinely conditional database update, not an in-memory boolean: `AIProposalRepo`'s private `transition()` helper issues `UPDATE ai_program_proposals SET status = ... WHERE id = ? AND status IN (...)` — the `WHERE status IN (...)` clause is part of the SQL statement itself. Two racing attempts to commit the same proposal can never both succeed: whichever `UPDATE` the SQLite engine applies first changes the row's status out of `approved`, so the second `UPDATE`'s own `WHERE` clause matches zero rows (`result.changes === 0`), which the code treats as "lost the race" and rolls back its own transaction rather than leaving an orphaned session. In this specific application (a single Node process, a synchronous `better-sqlite3` connection, no `await` anywhere between a commit's preconditions and its transaction) two "simultaneous" HTTP requests are additionally serialized in practice by Node's single-threaded event loop — but the conditional `UPDATE` is what makes the guarantee real rather than an assumption that happens to hold today.

## Transaction / atomicity guarantees (spec §9)

The commit's actual writes — creating the `workout_sessions` row, its `workout_exercises`/`workout_sets` rows (one exercise-performance insert per proposed exercise, via the existing `WorkoutSessionsRepo.addExercisePerformance()`), and marking the proposal `committed` with its `committed_session_id` — all happen inside one `db.transaction(...)` (better-sqlite3's built-in `BEGIN`/`COMMIT`/`ROLLBACK` wrapper), the same pattern already used elsewhere in this codebase (e.g. `WorkoutSessionsRepo.addExercisePerformance`, `ProgramsRepo.createProgramSession`). If any step throws — including the conditional `markCommitted()` update losing a race, or a downstream `WorkoutSessionsRepo` call failing — the entire transaction rolls back: no half-created session, no orphaned exercise/set rows, and the proposal's `status` is left exactly where it was (`approved`), never marked `committed` for a write that didn't actually happen. A persistence failure records a non-status-changing `failure_reason` for audit and returns `500 AI_PROPOSAL_COMMIT_FAILED`, never a raw SQL error or stack trace.

## Feature flag (spec §17)

All four endpoints — including `GET`/`approve`/`commit`, not just `generate-session` — are gated behind the same `AI_PROGRAMMER_ENABLED === "true"` flag (`isAiProgrammerEnabled()`). This is a deliberate, conservative choice: even though approval/commit never call the LLM/provider, keeping the entire proposal surface behind one flag keeps "disabled" simple, deterministic, and easy to reason about — there is no partial-disabled state where generation is off but a previously-generated proposal can still be approved/committed. When disabled, every one of these routes returns `503 { ok: false, error: "AI_PROGRAMMER_DISABLED" }` before touching the database. There is no automatic fallback from a failed/disabled generation to an automatic commit — commit is always a separate, explicit, human-triggered request.

## Single-user authorization (spec §7)

This application has no authentication/authorization layer anywhere (see `docs/architecture.md`'s single-user scope note). The approval and commit endpoints are consequently **not** multi-user-authorization boundaries — any caller who can reach this server at all can approve/commit any proposal. This is consistent with every other route in this codebase (there is no per-user access control on programs, goals, or sessions either) and is not a new limitation introduced by this phase; it is documented here explicitly per the task spec's own instruction not to pretend otherwise.

## Local testing without a real Velona key

Exactly the existing convention (`docs/AI_PROGRAMMER_INTEGRATION_STATUS.md`'s own section) extends unchanged: `tests/repositories/aiProposalRepo.test.ts` uses a real in-memory SQLite database with no network; `tests/ai-programmer/aiProposalRoutes.test.ts` mocks global `fetch` and drives the real Express app via `supertest`, exercising generate → retrieve → approve → commit end-to-end. To exercise the workflow manually: set `AI_PROGRAMMER_ENABLED=true` and a stub Velona provider (see the existing doc), `POST /generate-session`, take the returned `proposalId`, `POST /proposals/:id/approve`, then `POST /proposals/:id/commit`.

## Remaining limitations / explicit non-goals (unchanged from task spec §2)

- No `reject` endpoint exists yet — `rejected` is a defined, enforced terminal status in the schema/repo (a proposal can never be approved/committed once in that state), but nothing currently transitions a proposal into it. A future explicit `POST /proposals/:id/reject` would be a small, additive change.
- No automatic approval, no automatic commit after generation, no provider-side memory, no new exercise generation outside the Blueprint, no replacement programming engine, no automatic changes to completed workouts or the weekly program, and no UI beyond the API itself — all exactly as the task spec requires.
- No multi-user authorization architecture (see **Single-user authorization** above) — this was already true of the entire application and is not newly introduced here.
