# Fix AI Weekly Reconciliation Review Findings — Implementation Report

**Spec:** `docs/DEV_INSTRUCTIONS_FIX_AI_WEEKLY_RECONCILIATION.md`
**Status:** All three review findings fixed as a targeted correction — no feature rewrite, no change to the Velona endpoint/auth contract, no weakening of existing session-selection/lock/approval/persistence safety rules.

---

## Finding 1 — Transactional, race-safe target-session conflict protection

### Files changed
- `src/ai-programmer/service/weekReconciliationLifecycle.ts`

### Functions changed
- `commitWeekReconciliation()` — fully restructured.
- New private `isExpectedCommitRejection(err)` helper.

### What changed
Previously, `commitWeekReconciliation` loaded the reconciliation record, ran structural/blueprint/domain validation, and ran the active-Gym-session conflict check (`findActiveGymSessionConflict`) **before** opening `db.transaction()` — leaving a gap, however small in this app's current single-process/synchronous-`better-sqlite3` execution model, between "we decided this is safe" and "we wrote it."

Every one of those checks now happens **inside the same `db.transaction()`** as the writes, reloaded fresh on every call:
1. Reload the reconciliation record by ID (`repo.getById`), with lazy expiry applied (`expireIfNeeded`).
2. Confirm it is still `approved` (idempotent early-return if already `committed`; typed error otherwise).
3. Reload and re-validate the persisted output (structural schema, Blueprint-commit staleness).
4. **Rebuild the full reconciliation context fresh** (`buildReconciliationContext`) and re-run domain validation against it — this is what answers "is the target program day still eligible for replacement," and it re-derives lock state rather than trusting anything computed earlier.
5. Re-read every session for the target date and re-run the exact same `findActiveGymSessionConflict` rule the generic write path and the single-session AI commit already share.
6. Only after all of the above pass does anything get written: the weekly-program records, the ONE target-day AI session, its `supersedes_program_session_id` pointer, and the `committed` status transition.

No second transaction mechanism was introduced — this uses the exact same `db.transaction()` abstraction (and the exact same conditional-`UPDATE ... WHERE status IN (...)` race-safe status transition in `AIWeekReconciliationRepo.markCommitted`) every other commit path in this codebase already uses.

A bug this restructuring surfaced and fixed along the way: moving `buildReconciliationContext` (which can throw `AITargetNotEditableError`/`AIContextIncompleteError`, both `AIProgrammerError` subclasses) inside the transaction meant the original narrow `instanceof` check in the `catch` block (only checking for `AIWeekReconciliation*` classes) would have wrongly reclassified those as a generic `AIWeekReconciliationCommitFailedError` and called `recordFailure` on them. `isExpectedCommitRejection` now checks `err instanceof AIProgrammerError` (the shared base class every one of these typed errors extends), so **any** deliberate, already-safely-typed rejection propagates unchanged — never reclassified, never recorded as a failure.

### Duplicate-prevention / idempotency
- A conflicting active/completed/in-progress Gym session on the target date is now caught with zero gap before the target-session INSERT — an `AIWeekReconciliationConflictError` (409) is thrown and the whole transaction rolls back before anything is written.
- A second commit of an **already-committed** reconciliation returns the existing `{sessionId, reconciliation}` — no new session, no re-run of any check.
- Two separate reconciliation records targeting the same date: the first commit that runs wins; the second's fresh in-transaction conflict check catches the session the first one just created and rejects with a typed conflict — never a duplicate actionable session, and the second reconciliation's own status stays `approved` (not silently advanced).
- No existing session is ever deleted to resolve a conflict — the commit simply refuses.

### Tests added (`tests/ai-programmer/weekReconciliationLifecycle.test.ts`, +4, now 21 total)
- An existing **completed** session on the target date blocks commit (surfaces as `AITargetNotEditableError`, never reclassified, never recorded as a failure) and is never replaced.
- An existing **in-progress** session on the target date blocks commit and is left completely untouched.
- Two reconciliations targeting the same date: the first commit succeeds, the second is safely rejected as a conflict — asserts exactly one actionable session exists afterward.
- The target-day session created by commit is the only new actionable AI session for that date (session count delta is exactly +1).

Pre-existing tests already covered: duplicate commit creates no second session; transaction failure leaves the reconciliation and week completely unchanged (full rollback, safe `failure_reason`); an existing `planned` conflicting session blocks commit.

---

## Finding 2 — Exact serialized Velona request diagnostics

### Files changed
- `src/ai-programmer/provider/velonaProvider.ts`
- `src/ai-programmer/service/tokenDiagnostics.ts`
- `src/ai-programmer/contracts/providerTypes.ts`
- `src/ai-programmer/service/aiProgrammerService.ts`

### Functions changed / added
- **New, exported** `buildVelonaUserTurnContent(request)` — the exact user-turn JSON string, a pure function of `request` alone (needs no `VelonaConfig`).
- **New, exported** `buildVelonaRequestBody(request, config)` — the exact full wire body; used by `generate()`'s real fetch path (`velonaProvider.ts`'s local `const body = { ... }` was replaced with a call to this function) so the built body and the diagnostics measuring it can never disagree.
- `VelonaProvider.generate()` — now attaches `requestDiagnostics` (`systemInstructionChars`, `userTurnChars`, `wirePayloadChars`, `configuredMaxOutputTokens`) to every successful response, computed from the exact `body` object that was actually `JSON.stringify`'d onto the wire.
- `AIProgrammerProviderResponse` — new optional `requestDiagnostics` field.
- `buildTokenDiagnostics(mode, request, response?)` — signature changed from `(mode, requestId, systemInstruction, userPayloadJson, outputSchemaJson, response?)` to `(mode, request: AIProgrammerProviderRequest, response?)`. It now:
  - Reuses `buildVelonaUserTurnContent(request)` to reconstruct the exact user-turn text for **any** provider (byte-exact when the serving provider actually is Velona, a same-shape approximation for a test fake) — `outputSchema` is never counted as a separate field, since it already lives inside this one reconstructed string.
  - Prefers `response.requestDiagnostics` (the provider's own exact figures) when present for `systemInstructionChars`/`userTurnChars`/`wirePayloadChars`/`configuredMaxOutputTokens`.
  - Leaves `wirePayloadChars`/`configuredMaxOutputTokens` `undefined` (never fabricated) when the provider supplied no `requestDiagnostics`.
  - Computes `estimatedInputTokens` from `[systemInstruction, userTurnContent].join('\n')` — the actual reconstructed text, not partial/mismatched components.
  - Exposes `actualInputTokens`/`actualOutputTokens`/`actualTotalTokens` straight from `response.usage`, `undefined` (never zero, never backfilled from the heuristic) when the provider reported none.
- `aiProgrammerService.ts`'s `generateSession()`/`reconcileWeek()` — now build and hold the `AIProgrammerProviderRequest` object explicitly and pass it (not separately-stringified pieces) to `buildTokenDiagnostics`.

### Diagnostic fields (final shape)
```ts
{
  mode, requestId,
  systemInstructionChars, userTurnChars,      // always populated — exact
  wirePayloadChars,                            // exact only when the provider supplies it (Velona); else undefined
  estimatedInputTokens,                        // heuristic (~4 chars/token) on the exact reconstructed text
  configuredMaxOutputTokens,                   // Velona's own config.max_tokens — a LIMIT, not usage; else undefined
  estimatedOutputTokens,                       // heuristic on the raw response text
  actualInputTokens, actualOutputTokens, actualTotalTokens, // provider's own usage metadata, or undefined
}
```
`estimated*` fields are always a labeled approximation (documented ~4-chars-per-token heuristic; no tokenizer dependency was added — none was justified for this targeted fix). `actual*` fields are the provider's own authoritative metadata when present, never fabricated otherwise.

### Tests added
- `tests/ai-programmer/tokenDiagnostics.test.ts` — **new file, 12 tests**: `systemInstructionChars`/`userTurnChars` match the exact reconstructed text; `outputSchema` is never double-counted; `wirePayloadChars`/`configuredMaxOutputTokens` are absent without provider diagnostics and taken verbatim when present; `estimatedInputTokens` is deterministic and matches the documented heuristic on the exact text; `estimatedOutputTokens` heuristic; actual usage is parsed when present and stays absent (never zero/backfilled) when not; mode/requestId pass through; diagnostics never contain raw context/schema content.
- `tests/ai-programmer/velonaProvider.test.ts` — **+6 tests**: the exact body sent to `fetch` equals `buildVelonaRequestBody`'s own output byte-for-byte; `buildVelonaUserTurnContent` needs no config and matches the real sent content; the user-turn content wraps context+outputSchema+request+instruction together (outputSchema is never a separate top-level field); a successful response's `requestDiagnostics` measures the exact wire body just sent; `wirePayloadChars`/`configuredMaxOutputTokens` reflect a changed `max_tokens`/`temperature` config.

---

## Finding 3 — Rehydrate the latest reconciliation proposal in the UI

### Files changed
- `public/program.html`
- `tests/frontend/weekReconciliationUI.test.ts`
- `tests/frontend/aiProposalUI.test.ts` (one pre-existing assertion's scope narrowed — see below)

### Functions changed
- `openDayModal(day, triggerEl)` — now builds `weekReconciliation = buildWeekReconciliationSection(day, modalToken)` **unconditionally, at modal-open time** (previously it was only ever constructed reactively, inside `buildChangeActivitySection`'s own `generationRequired` catch block), and appends its `.element` to the panel.
- `buildChangeActivitySection(day, weekReconciliation)` — now takes the shared reconciliation-section instance and, on a `generationRequired` failure for `requestedActivity: 'gym'`, calls `weekReconciliation.revealForSwapFailure()` instead of constructing a brand-new section.
- `buildWeekReconciliationSection(day, modalToken)` — fully rewritten. It is now a factory returning `{element, revealForSwapFailure}` and:
  - Starts hidden (`hidden: true`) and runs `discover()` immediately and unconditionally — `GET /week-reconciliations/latest?targetDate=<day.date>` — exactly mirroring `buildAiProposalSection`'s own discovery pattern (same `modalToken`/`isModalTokenCurrent()` stale-response guard).
  - `updateVisibility()` reveals the section once EITHER a real reconciliation record is found (any status: pending/approved/committed/rejected/expired) OR the deterministic swap fails this session (`revealForSwapFailure()`) — never both required, never shown pre-emptively when a plain swap remains untried.
  - Gates every rendered action behind `discoveryDone`, exactly like the single-session proposal section.
  - Renders the correct controls by lifecycle state via the existing `aiWeekReconciliationActionsFor` (unchanged) — pending → Approve, approved → Apply, committed → read-only "Applied," and expired/rejected fall through to the same `canGenerate` path as "no reconciliation," offering a fresh "Ask AI" retry rather than a dead end.
  - Never auto-calls Generate on rebuild — only a user click ever invokes `onGenerate`.
  - `inFlight` continues to guard every action against duplicate submissions.
  - New `resyncState()` — re-fetches `GET /week-reconciliations/:id` after a failed approve/commit, so displayed state always reflects the backend rather than only the last-known optimistic value.

### API contract
No new/changed backend endpoint was needed — `GET /api/ai-programmer/week-reconciliations/latest?targetDate=...` already existed (built in the prior phase) and already filters correctly by target date; this fix only wires the frontend to call it earlier and unconditionally, plus adds `resyncState()`'s use of the pre-existing `GET /week-reconciliations/:id`.

### Tests added/updated
- `tests/frontend/weekReconciliationUI.test.ts` — **+11 tests** (16 → 27): the section is now built at modal-open time and passed the modal token; the swap-failure path now calls `revealForSwapFailure()` (updated regex); a new "discovery/rehydration wiring" describe block source-asserts: discovery runs unconditionally on build; `found:false`/`found:true` seeding; visibility driven by discovery, not only swap failure; a fresh section/discover-call is built per `day.date` (so a different date can never hydrate the wrong record); `discover()` never calls `/reconcile-week` (no new AI call merely from reopening); actions are gated behind `discoveryDone` completing; expired/rejected fall through to the shared retry-offering rule; every async continuation checks `isCurrent()`; failed approve/commit calls `resyncState()`; a discovery failure degrades to "no known reconciliation" rather than throwing.
- `tests/frontend/aiProposalUI.test.ts` — one existing assertion (`discoveryDone = true` occurring exactly once) was narrowed from a whole-file `html.match` to `buildAiProposalSection`'s own function body, since `buildWeekReconciliationSection` now legitimately has its own, separate `discoveryDone` flag following the identical pattern — not a weakening, a correct scoping fix.

---

## Verification

```
npm run typecheck   # clean
npm run build       # clean
npm test -- --run   # 110 test files, 1326 tests, all passing (0 regressions)
```

Confirmed directly:
1. Existing tests remain green — full suite passes, no regressions.
2. New race/idempotency tests pass (Finding 1's 4 new tests, above).
3. `generate_session` still makes exactly one real Velona request per call (unchanged).
4. `reconcile_week` makes exactly one real Velona request, only when `/reconcile-week` is explicitly called.
5. The deterministic swap (`PUT /week/days/:day/activity`) still makes zero AI/fetch calls — reconfirmed via a live smoke test (below) and the existing route test asserting `fetchMock` is never invoked.
6. Diagnostics never expose the API key/authorization header — `requestDiagnostics`/`TokenDiagnostics` contain only counts, never content; verified by existing `safeLogFields` tests plus the new diagnostics tests' explicit "never contains raw content" assertion.
7. No secrets appear in logs — unchanged logging discipline (`console.log`/`console.error` calls only ever pass `safeLogFields`/the diagnostics object, both content-free).
8. A failed reconciliation never partially changes the week — proven by the existing rollback test plus Finding 1's new completed/in-progress/conflict tests.
9. A successful commit creates no duplicate target-day actionable session — proven by the existing idempotent-recommit test plus Finding 1's new two-reconciliations-same-date test.

### Manual smoke test (no authenticated Velona call, per standing policy)
Ran the built server against a scratch SQLite DB:
- `AI_PROGRAMMER_ENABLED` unset → `PUT /week/days/sunday/activity` (reuse policy, nothing to reuse) → real `409 generationRequired: true` (the exact condition the frontend now reveals the AI section for), confirming the deterministic path is untouched and still makes no AI call.
- `AI_PROGRAMMER_ENABLED=true` with a deliberately fake `VELONA_API_KEY` → `POST /reconcile-week` → the real context was built, a real HTTPS request reached `https://velona.in/gateway/v1/inference/run`, and the fake key was correctly rejected (`502 AI_PROVIDER_AUTHENTICATION_ERROR`), with the server log showing `[velona] request failed` and no key ever logged — confirming the restructured `buildVelonaRequestBody`/diagnostics wiring did not break the real request path.
- `GET /week-reconciliations/latest?targetDate=...` → `{ok:true, found:false}` for a date with no reconciliation, confirming the discovery endpoint the new UI rehydration logic depends on.

No authenticated Velona smoke test was run — consistent with this project's standing instruction to never use this session's own or fabricated credentials for the user's Velona account.

## Remaining limitations
- `wirePayloadChars`/`configuredMaxOutputTokens` in `TokenDiagnostics` are only ever populated when the serving provider is the real `VelonaProvider` (or any future provider that chooses to populate `requestDiagnostics`) — a test `FakeProvider` correctly reports these as `undefined` rather than a fabricated number, since a fake provider genuinely has no wire body.
- Finding 1's "concurrent commit attempts" test simulates the race by running two sequential commits against two separate reconciliation records for the same date (this app is a single Node process with a fully synchronous `better-sqlite3` connection and no `await` between any of `commitWeekReconciliation`'s precondition checks and its transaction, so two truly concurrent HTTP requests are already serialized by the event loop — the same documented rationale `aiProposalLifecycle.ts`'s own commit path relies on). The restructuring in this fix is genuine defense-in-depth against that assumption ever changing (a future multi-process/WAL deployment, an async provider health check inserted into the flow, etc.), not a fix for an exploitable race in the current runtime.
- Finding 3's discovery/rehydration DOM behavior is verified via source-level assertions against the shipped `program.html` (this repo has no browser/jsdom test harness), matching the exact convention `tests/frontend/aiProposalUI.test.ts` already established for the single-session proposal UI — not an executed browser test.
