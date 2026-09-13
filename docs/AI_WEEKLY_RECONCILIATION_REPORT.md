# AI-Powered Weekly Reconciliation — Implementation Report

**Spec:** `docs/DEV_INSTRUCTIONS_IMPLEMENT_AI_WEEKLY_RECONCILIATION_ONE_ITERATION.md`
**Status:** Implemented as one cohesive vertical slice — real UI → route → service → context → Velona → validation → persistence, end to end.

---

## 1. Summary

When a user changes a day's activity and a simple day-swap is not appropriate (there is nothing existing to reuse for that day, so the deterministic path reports `generationRequired: true`), the app now offers a genuinely new capability: **AI Week Reorganization**. This makes a real HTTP call to Velona in a dedicated `reconcile_week` provider mode, asking it to generate the target day's workout and revise the full 7-day week around it. The result is persisted as a `pending` reconciliation proposal and only ever applied to the real week (`workout_sessions` / `program_sessions` / `week_activity_overrides`) after the user explicitly approves it and then explicitly commits it — mirroring the existing single-session AI proposal's pending → approved → committed gate exactly.

The pre-existing simple-swap path (`PUT /api/programming/week/days/:day/activity` with `prescriptionPolicy: 'reuse' | 'schedule-only'`, and the deterministic `swapDayActivities`/`moveActivity` engine functions) is completely unchanged and still makes zero AI calls.

## 2. Files changed

### New files

| File | Purpose |
|---|---|
| `src/ai-programmer/contracts/weekReconciliationTypes.ts` | `AIWeekReconciliationOutput` — the dedicated 7-day output schema type (distinct from the single-session `AIWorkoutSessionProposal`). |
| `src/ai-programmer/contracts/weekReconciliationOutputSchema.ts` | The plain-JSON prompt schema sent to the provider for `reconcile_week`. |
| `src/ai-programmer/context/reconciliationContextTypes.ts` | `AIReconciliationContext` — a sibling type to `AIProgrammerContext`, with a 7-day `existingProgram` view. |
| `src/ai-programmer/context/reconciliationContextBuilder.ts` | `buildReconciliationContext()` — assembles the full context, reusing `assembleWeeklyPlanInput`/`buildTargetContexts` (exposure/history/recovery), `isDayLocked` (lock definition), and `resolveSelectedSession` (real-session resolution) rather than re-deriving any of them. |
| `src/ai-programmer/validation/weekReconciliationOutputValidator.ts` | Structural schema validation for the 7-day output. |
| `src/ai-programmer/validation/weekReconciliationDomainValidator.ts` | Domain validation — locked-day preservation, target-date activity requirement, real exercise/target IDs (reuses `validateExerciseAgainstTargets`). |
| `src/repositories/aiWeekReconciliationRepo.ts` | `AIWeekReconciliationRepo` — persistence for the pending/approved/committed/rejected/expired lifecycle, in its own table (`ai_week_reconciliation_proposals`), structurally mirroring `AIProposalRepo`. |
| `src/ai-programmer/service/tokenDiagnostics.ts` | `buildTokenDiagnostics`/`logTokenDiagnostics` — shared token-budget diagnostics for **both** `generate_session` and `reconcile_week`. |
| `src/ai-programmer/service/weekReconciliationLifecycle.ts` | `getWeekReconciliation`/`approveWeekReconciliation`/`commitWeekReconciliation` — the only code that ever writes a reconciliation into the real data model. |

### Modified files

| File | Change |
|---|---|
| `src/ai-programmer/contracts/providerTypes.ts` | Added `AIProgrammerMode = 'generate_session' \| 'reconcile_week'`. |
| `src/ai-programmer/errors.ts` | 9 new `AIWeekReconciliation*` error classes, mirroring the single-session error shapes/status codes exactly. |
| `src/ai-programmer/service/aiProgrammerService.ts` | Added `reconcileWeek()` method and `buildWeekReconciliationSystemInstruction()`; `generateSession()` now also returns token diagnostics. |
| `src/ai-programmer/context/programmerContextBuilder.ts` | Extracted `buildTargetContexts()` (was inline) and exported `activityTypesForDailyActivity` — pure, behavior-preserving refactor so the reconciliation context reuses the exact same exposure/history/recovery/valid-exercise shaping, never a second copy. |
| `src/ai-programmer/validation/programmerOutputValidator.ts` | Exported `validateExercise`/`isIsoDate`/`isStringArray`/`isPositiveInt`/`isNonNegativeNumber`/`containsDangerousContent` for reuse by the new week-reconciliation validator. |
| `src/ai-programmer/validation/programmerDomainValidator.ts` | Extracted `validateExerciseAgainstTargets()` (was inline in the per-exercise loop) — reused as-is by the new week-reconciliation domain validator. |
| `src/db/schema.sql` | Added `ai_week_reconciliation_proposals` table + 2 indexes. |
| `src/server/routes/aiProgrammer.ts` | Added the 5 new routes (see §3). |
| `public/app.js` | Added `AI_WEEK_RECONCILIATION_*` error-message mappings and `aiWeekReconciliationActionsFor()`. |
| `public/program.html` | Wired the `generationRequired` fallback (for `requestedActivity: 'gym'`) to the new AI reconciliation flow instead of a deterministic single-day regenerate; added `buildWeekReconciliationSection()`/`buildWeekReconciliationReview()`. |
| `docs/AI_PROGRAMMER_CONTEXT_SPEC.md`, `docs/VELONA_PROVIDER_INTEGRATION_SPEC.md` | Addendum notes pointing to this report. |

## 3. New route

All under the existing `aiProgrammerRouter` (`/api/ai-programmer`):

- `POST /reconcile-week` — body `{ targetDate, requestedActivity: 'gym', reason?, swapUnavailableReason? }`. Calls `service.reconcileWeek(...)`, which makes the real Velona request and persists a `pending` record. Returns `{ok, mode: 'reconcile_week', output, reconciliationId, status, contextHash, provider, model, requestId, diagnostics}`.
- `GET /week-reconciliations/latest?targetDate=...` — discovery, mirrors `GET /proposals/latest`.
- `GET /week-reconciliations/:reconciliationId` — retrieval.
- `POST /week-reconciliations/:reconciliationId/approve` — explicit approval only, never commits.
- `POST /week-reconciliations/:reconciliationId/commit` — the only route that writes into `workout_sessions`/`program_sessions`/`week_activity_overrides`. No `intent` field (unlike the single-session commit route) — a week reconciliation always both fills the target day's session and aligns whichever days' activity representation the model actually changed.

## 4. New service method

`AIProgrammerService.reconcileWeek(input)`:

```
enabled check → buildReconciliationContext (validates target date's editability)
  → provider.generate({ mode: 'reconcile_week', ... })
  → parse → structural validate → domain validate
  → AIWeekReconciliationRepo.create() (status: pending)
```

A provider failure, invalid JSON, or a validation failure throws before any row is persisted — the existing week is left completely unchanged (verified in `tests/ai-programmer/weekReconciliationService.test.ts`).

## 5. New context builder

`buildReconciliationContext(db, {targetDate, requestedActivity, reason?, swapUnavailableReason?})` returns `AIReconciliationContext`, containing:

- `existingProgram`: all 7 days (Monday–Sunday) of the target week — date, weekday, effective activity, `locked` (via the shared `isDayLocked`), the persisted deterministic plan snapshot (if any), and the real actionable session (via the shared `resolveSelectedSession`).
- `lockedDates`: the flat list of locked dates the model must return unchanged.
- `routine.proposedChange`: the explicit current vs. requested activity for the target date.
- `targets`: the same real exposure/history/recovery/valid-exercise-catalogue data `generate_session` already assembles, via the shared `buildTargetContexts`.
- `activeGoals`, `profile`, `objectives`, `executionContext` (equipment/time filtering explicitly disabled), `outputRequirements`, and `diagnostics` (warnings/missingData/`approxContextSizeChars`).

Rejects (via `AITargetNotEditableError`/`AIContextIncompleteError`) exactly the same "not editable" cases the single-session context does for the target date itself — a locked or past date can never be the *subject* of a reconciliation, though other days in the week may legitimately be locked and are simply preserved.

## 6. New schema/types

- `AIWeekReconciliationOutput` (`weekReconciliationTypes.ts`): `schemaVersion: 'ai-week-reconciliation.v1'`, `mode: 'reconcile_week'`, `targetDate`, `requestedActivity: 'gym'`, exactly 7 `days[]` (each with `date`/`weekday`/`activity`/`changeType`/`locked`/`session`), and `reconciliation: {changedDates, preservedLockedDates, rationale, warnings}`.
- Exercises inside a day's session reuse `AIWorkoutExerciseProposal` plus one added field, `classification` (`specialization | normal_development | maintenance`).

## 7. Persistence / transaction behavior

- A **separate table**, `ai_week_reconciliation_proposals` (not the single-session `ai_program_proposals`), with the same pending → approved → committed/rejected/expired lifecycle, 24h TTL, lazy expiry on read, and race-safe conditional `UPDATE ... WHERE status IN (...)` transitions.
- `commitWeekReconciliation` re-validates everything fresh at commit time: structural re-validation of the stored JSON, a Blueprint-commit staleness check, a **freshly rebuilt** `buildReconciliationContext` (re-catches a day that became locked or past between generation and commit), domain re-validation against that fresh context, and an active-gym-session conflict check on the target date (via the shared `findActiveGymSessionConflict`).
- Exactly **one real `workout_sessions` row** is created, for the target date only — every other day the model changed gets its `program_sessions` deterministic-plan snapshot written (`changeType: 'new' | 'modified'`) or removed (`changeType: 'removed'`), and a `week_activity_overrides` row is written for any day whose effective activity actually changed. An `'unchanged'` day's persisted snapshot is left untouched.
- All of the above writes happen inside a **single `db.transaction()`**. On any failure inside it (verified via a mocked mid-transaction throw), the whole transaction rolls back — no orphaned session, no orphaned override, no partial `program_sessions` write — and only a safe, fixed-category `failure_reason` (`'commit_transaction_failed'`) is persisted; the real error is logged server-side only, never returned to the client.

## 8. Frontend integration

`public/program.html`'s existing `buildChangeActivitySection` already had a `generationRequired` fallback (the exact "no simple swap available" case). That fallback now branches:

- `requestedActivity === 'gym'` → the new `buildWeekReconciliationSection(day)`: **Ask AI to reorganize this week** → real `POST /reconcile-week` → review panel (rationale, days affected, the target day's new exercises via the same `buildAiExerciseCard` the single-session review already uses, warnings) → **Approve** → **Apply to this week** (commit) → modal closes and the week reloads.
- `requestedActivity === 'both'` (not supported by `reconcile-week` in this iteration) → the prior, purely deterministic "Generate a new workout for this day" button, unchanged.

Handled explicitly via the existing `aiApi`/`mapAiErrorCode` machinery (extended with 9 new `AI_WEEK_RECONCILIATION_*` messages): AI disabled, provider timeout/unavailable, invalid output (schema/domain), stale state, active-session conflict, invalid state. Nothing is ever labeled as "AI" unless a real Velona call actually happened — the deterministic path's own UI copy is completely untouched.

## 9. Token diagnostics

`buildTokenDiagnostics(mode, requestId, systemInstruction, userPayloadJson, outputSchemaJson, response?)` now runs for **both** `generate_session` and `reconcile_week`, logging `{mode, requestId, systemInstructionChars, userPayloadChars, totalSerializedInputChars, estimatedInputTokens, outputSchemaChars, estimatedOutputTokens, outputTokensAreExact}` — using the provider's own `usage` metadata as authoritative when present, else a documented ~4-chars-per-token estimate, never claimed exact. Never logs API keys, headers, or full context/response content.

## 10. Tests added

105 new tests, across 6 new files:

| File | Tests | Covers |
|---|---:|---|
| `tests/ai-programmer/reconciliationContextBuilder.test.ts` | 19 | Context tests: 7 days, effective/requested activity, existing program, real exposure/history data, locked dates, valid exercise catalogue, self-contained, diagnostics. |
| `tests/ai-programmer/weekReconciliationValidators.test.ts` | 25 | Schema + domain validation: day-count/enum/classification failures, locked-day preservation, target-day activity requirement, unknown exercise/target rejection, `preservedLockedDates` mismatch. |
| `tests/ai-programmer/weekReconciliationService.test.ts` | 9 | Provider/service tests: `reconcile_week` passed to provider, correct context, invalid JSON/schema/domain failure → no DB row, provider failure → no DB row, AI-disabled → no provider call, metadata/diagnostics returned. |
| `tests/ai-programmer/weekReconciliationLifecycle.test.ts` | 17 | Persistence/commit tests: approve idempotency/invalid-state/expired, target-day-only real session, only-changed-day snapshots/overrides, locked days untouched, staleness/conflict rejection, full-rollback-on-failure with no partial writes. |
| `tests/ai-programmer/weekReconciliationRoutes.test.ts` | 19 | Route tests: valid/invalid requests, reconcile-week calls AI (fetch invoked) vs. the deterministic swap route not calling AI, provider failure leaves the week unchanged, approve/commit lifecycle via HTTP. |
| `tests/frontend/weekReconciliationUI.test.ts` | 16 | Error-code mapping, `aiWeekReconciliationActionsFor` lifecycle gating, and source-level wiring assertions against the shipped `program.html`. |

## 11. Verification results

```
npm run verify   # = npm run build && npm run typecheck && npm test
```

- **Build:** passes (`tsc -p tsconfig.build.json` + schema copy).
- **Typecheck:** passes, zero errors.
- **Test:** **109 test files, 1294 tests, all passing** (1189 pre-existing + 105 new; zero regressions).

## 12. Manual smoke test (no authenticated Velona call)

Per this project's established policy, no request was ever made using the user's real Velona credentials. Instead, the built server was run against a scratch SQLite database with `AI_PROGRAMMER_ENABLED=true` and a deliberately fake `VELONA_API_KEY`, confirming the full real pipeline end-to-end:

1. `PUT /api/programming/week/days/sunday/activity` with `{activity: 'gym', prescriptionPolicy: 'reuse'}` on a day with nothing to reuse → real `409` with `generationRequired: true` (the exact condition the new frontend branch now handles).
2. `POST /api/ai-programmer/reconcile-week` with a real target date → the real context was built successfully and a real HTTPS request reached `https://velona.in/gateway/v1/inference/run`, which correctly rejected the fake key → `502 AI_PROVIDER_AUTHENTICATION_ERROR`, with the server log showing `[velona] request failed` (no key/secret logged).
3. With `AI_PROGRAMMER_ENABLED` unset, both `POST /reconcile-week` and `GET /week-reconciliations/latest` correctly returned `503 AI_PROGRAMMER_DISABLED` without making any network call.

This confirms the route → service → context-builder → real-HTTP-provider-call chain is genuinely wired, without ever using real credentials. **No authenticated Velona smoke test was run**, consistent with the standing instruction that this session never use its own or fabricated credentials for the user's Velona account.

## 13. Acceptance criteria

- [x] Simple swaps remain deterministic and make no AI call (`PUT /week/days/:day/activity` unchanged; proven in route tests).
- [x] Explicit reconciliation makes a real Velona API call (confirmed live in §12; unit-tested via provider mocking).
- [x] Reconciliation uses a dedicated `reconcile_week` mode.
- [x] The context contains the full affected week (`existingProgram`, 7 days) and current state.
- [x] The model returns a dedicated weekly reconciliation schema (`AIWeekReconciliationOutput`).
- [x] The response is structurally and domain validated.
- [x] Locked/completed/in-progress days are protected (re-derived from a fresh context at commit, never trusted from the model).
- [x] No partial database mutation is possible (single transaction, verified rollback test).
- [x] No deterministic-only fallback disguises itself as AI reconciliation (the "both" case keeps the old, honestly-labeled deterministic button; the "gym" case makes a real call).
- [x] The frontend invokes the actual reconciliation path (`buildWeekReconciliationSection` calls the real `/reconcile-week`/`/approve`/`/commit` endpoints).
- [x] Token diagnostics exist for Generate and Reconcile.
- [x] All tests pass (1294/1294).
- [x] Typecheck and build pass.
- [x] Documentation is updated (this report, plus addenda in the context/provider specs).

## 14. Notable design decisions (autonomous, not yet validated against user feedback)

- `PUT /week/days/:day/activity` is left completely unchanged — the new capability is entirely additive (`/reconcile-week`, `/week-reconciliations/*`), since research confirmed no existing swap/AI-decision logic exists anywhere to retrofit.
- A wholly separate table/repo (`ai_week_reconciliation_proposals`/`AIWeekReconciliationRepo`) rather than reusing the day-scoped `ai_program_proposals`, per the spec's own explicit instruction not to store a weekly object inside a single-session row.
- Only the target date gets a new real `workout_sessions` row on commit; every other changed day gets its `program_sessions` snapshot updated only — consistent with the existing architecture's separation between deterministic plan snapshots and real actionable sessions.
- The frontend redirects the existing "Generate a new workout" fallback button (from the `reuse` policy's `generationRequired` response) to the new AI flow only for `requestedActivity: 'gym'`, since `reconcile-week` does not support `'both'` in this iteration; the `'both'` case keeps the prior deterministic-only button, honestly labeled.
