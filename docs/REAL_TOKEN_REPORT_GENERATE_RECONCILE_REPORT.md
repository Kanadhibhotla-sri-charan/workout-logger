# Implementation Report — Real Dry-Run Token Report for Generate and Reconcile

Spec: `docs/DEV_INSTRUCTIONS_REAL_TOKEN_REPORT_GENERATE_RECONCILE.md`

## Summary

Implemented a no-provider-call diagnostic mode that builds the exact current `generate_session` and `reconcile_week` Velona request payloads from real database state, using the same production context builders, system instructions, output schemas, and request-body serializer production itself uses — never a second, hand-approximated payload. The mode never calls Velona/`fetch`, never returns or logs the API key or an Authorization header, and reports serialized sizes, estimated tokens, and a caller-priced cost projection, all clearly labeled as estimates/projections, never as actual provider billing.

## Files changed

- `src/ai-programmer/provider/velonaProvider.ts` — `buildVelonaRequestBody()`'s return type widened from the bare `VelonaRequestBody` to a new `VelonaPayloadBuildResult` (`{ body, systemInstruction, userTurnContent, outputSchemaJson }`), so production and diagnostics read the individual serialized pieces off the exact same object instead of a second reconstruction. `VelonaProvider.generate()` updated to destructure `.body` from the result; its `requestDiagnostics` construction is unchanged (still measured from this same result).
- `src/ai-programmer/service/tokenReport.ts` — **new**. `buildTokenReport(db, input)`: builds the real context (`buildProgrammerContext`/`buildReconciliationContext`), the real system instruction and output schema for the requested mode, assembles the exact `AIProgrammerProviderRequest` production would send, serializes it via `buildVelonaRequestBody`, and reports `measurements` (char/byte counts), `output` (token/limit estimates), and `costProjection` (caller-priced, labeled `projected_cost`). Never calls `fetch`/`provider.generate()`.
- `src/server/routes/aiProgrammer.ts` — added `GET /api/ai-programmer/token-report`. Access is gated independently of the main `AI_PROGRAMMER_ENABLED` flag (a dry-run report is exactly the tool needed *before* turning the live feature on): disabled by default (`AI_TOKEN_REPORT_ENABLED` must be `'true'`); if `AI_TOKEN_REPORT_ACCESS_TOKEN` is set, the request must carry a matching `x-token-report-token` header (checked in all environments); otherwise the route is only reachable when `NODE_ENV !== 'production'`. Every denial returns a bare `404` (never `403`/`401`) so the route's existence is not revealed to anonymous probing in production. Validates `mode` (must be exactly `generate_session` or `reconcile_week`), `date` (required, real calendar date), optional `reason`/`swapUnavailableReason` (reconcile only, forwarded verbatim, never used as instructions here), and optional `inputPricePerMillionTokens`/`outputPricePerMillionTokens` (non-negative numbers).
- `tests/ai-programmer/velonaProvider.test.ts` — updated the "exact body sent to fetch" assertion to read `.body` off `buildVelonaRequestBody`'s result; added a test that the result's `systemInstruction`/`userTurnContent`/`outputSchemaJson` pieces match the body exactly.
- `tests/ai-programmer/tokenReport.test.ts` — **new**, 14 tests: `buildTokenReport()` unit tests against a real in-memory database (see "Required tests" below).
- `tests/ai-programmer/tokenReportRoute.test.ts` — **new**, 13 tests: HTTP-level tests for `GET /api/ai-programmer/token-report` (access control, validation, success shape, secrets never leaked).

No other application behavior changed: workout generation, reconciliation, and every existing route are byte-for-byte the same as before this phase except for the `buildVelonaRequestBody` return-type widening (a superset of the previous return value, not a behavior change).

## Exact commands/endpoints used

Verification:
```
npm run typecheck
npm run build
npm test -- --run
npm run verify
```

Live dry-run reports (against a real, file-backed SQLite database, over the real HTTP server — see "Manual smoke test" below):
```
GET /api/ai-programmer/token-report?mode=generate_session&date=2026-09-13&inputPricePerMillionTokens=3&outputPricePerMillionTokens=15
GET /api/ai-programmer/token-report?mode=reconcile_week&date=2026-09-13&reason=Move+gym+session+to+Sunday&inputPricePerMillionTokens=3&outputPricePerMillionTokens=15
```

## Manual smoke test (no authenticated Velona call, per standing policy)

Ran the built server against a scratch, file-backed SQLite database (not `:memory:`) seeded with a representative real state: a real training profile (timezone, weekly training days, equipment, session-duration bounds), one active aesthetic goal (`chest-front-width`), and one completed historical gym session with a logged set — then hit the real HTTP endpoint with `AI_TOKEN_REPORT_ENABLED=true` and a deliberately fake `VELONA_API_KEY`/`VELONA_MODEL` (the fake key is never sent anywhere — the dry-run mode never calls `fetch`, confirmed by both the route's own tests and by observing zero outbound network activity during this run).

### Generate measurements (`mode=generate_session`, `date=2026-09-13`)

| Field | Value |
|---|---|
| requestId | `85093ece-c1e5-4332-bc29-60712b2f16c9` |
| weekStart | `null` (not applicable to Generate) |
| model / baseUrl | `velona-default` / `https://velona.in/gateway/v1` |
| configuredMaxOutputTokens | 4096 |
| systemInstructionChars | 2,610 |
| userTurnContentChars | 59,908 |
| modelInputChars (system + user turn) | 62,518 |
| estimatedInputTokens | 15,630 |
| contextJsonChars / bytesUtf8 | 57,906 / 57,978 |
| outputSchemaJsonChars / bytesUtf8 | 1,776 / 1,776 |
| wireBodyChars / bytesUtf8 | 70,013 / 70,105 |
| estimatedTypicalOutputTokens | 2,000 (fits under configured max_tokens) |
| estimatedTotalTokens | 17,630 |

### Reconcile measurements (`mode=reconcile_week`, `date=2026-09-13`, `reason=Move gym session to Sunday`)

| Field | Value |
|---|---|
| requestId | `b9ce7826-9b8f-4b70-9643-a2b216af9ed7` |
| weekStart | `2026-09-07` (Monday of the target week) |
| model / baseUrl | `velona-default` / `https://velona.in/gateway/v1` |
| configuredMaxOutputTokens | 4096 |
| systemInstructionChars | 2,694 |
| userTurnContentChars | 62,939 |
| modelInputChars (system + user turn) | 65,633 |
| estimatedInputTokens | 16,409 |
| contextJsonChars / bytesUtf8 | 59,924 / 60,000 |
| outputSchemaJsonChars / bytesUtf8 | 2,791 / 2,791 |
| wireBodyChars / bytesUtf8 | 73,510 / 73,606 |
| estimatedTypicalOutputTokens | 3,000 (fits under configured max_tokens) |
| estimatedTotalTokens | 19,409 |

### Token-count method / estimated vs. provider-reported

`tokenCountMethod: "chars_div_4_estimate"` for both — this repository has no tokenizer library installed (confirmed via `grep -i token package.json`, no hits), so per spec §5 the documented `Math.ceil(chars / 4)` heuristic is used, computed from the exact `systemInstruction + userTurnContent` text length (never from `wireBodyChars`, which includes JSON envelope/config overhead not necessarily counted as model input). **All counts in both reports are estimates — no live Velona call was made or attempted, so no provider-reported (`usage.prompt_tokens`/`usage.completion_tokens`) figures exist for this run.**

### Sample projected-cost calculation

Using `inputPricePerMillionTokens=3`, `outputPricePerMillionTokens=15` (illustrative, caller-supplied — not hard-coded anywhere in the codebase):

- Generate: `estimatedInputCost = 15,630 / 1,000,000 × 3 = 0.04689`; `estimatedOutputCost = 2,000 / 1,000,000 × 15 = 0.03`; `estimatedTotalCost = 0.07689`.
- Reconcile: `estimatedInputCost = 16,409 / 1,000,000 × 3 = 0.049227`; `estimatedOutputCost = 3,000 / 1,000,000 × 15 = 0.045`; `estimatedTotalCost = 0.094227`.

All three are returned under `costProjection.label: "projected_cost"` — never presented as an actual billed amount.

### Confirmation no Velona API call occurred

- The route/service code path (`tokenReport.ts`) contains no call to `fetch`, `VelonaProvider.generate()`, or any network client — verified by direct code inspection and enforced by tests (`tests/ai-programmer/tokenReport.test.ts` and `tests/ai-programmer/tokenReportRoute.test.ts` both stub global `fetch` to throw immediately if invoked, and every test — including both live-report-shape tests — passes).
- During the live smoke test above, the process's only network-adjacent config was the fake `VELONA_API_KEY`/`VELONA_MODEL` (used solely to satisfy `loadVelonaConfig()`'s required fields for reporting `model`/`baseUrl`/`maxOutputTokens` in the report) — no outbound request was made to `https://velona.in` or anywhere else.
- Both HTTP responses returned `200 OK` with the full report and no error, confirming the entire path (context build → serialize → measure) completed without ever reaching the network.

## Required tests (spec §11) — mapping to what was written

1. **Shared builder output equals the payload shape used by the production provider** — `tests/ai-programmer/velonaProvider.test.ts` ("buildVelonaRequestBody also returns the individual pieces..."); `tests/ai-programmer/tokenReport.test.ts` ("uses the real Generate/Reconcile context builder and the shared Velona serializer, matching production byte-for-byte").
2. **Dry-run mode never invokes `fetch`** — `tokenReport.test.ts` and `tokenReportRoute.test.ts`, both stub `fetch` to throw and assert it is never called, for both modes.
3. **Generate report uses the real Generate context builder** — `tokenReport.test.ts`, cross-checked against an independently-called `buildProgrammerContext`.
4. **Reconcile report uses the real Reconcile context builder** — `tokenReport.test.ts`, cross-checked against an independently-called `buildReconciliationContext`, and asserts the correct `weekStart`.
5. **`userTurnContentChars` equals the exact serialized user-turn content length** — asserted in both mode's tests in `tokenReport.test.ts`.
6. **`wireBodyChars` equals `JSON.stringify(body).length`** — asserted directly in `tokenReport.test.ts` for both modes.
7. **UTF-8 byte count is calculated correctly** — `tokenReport.test.ts` recomputes `Buffer.byteLength` independently for the wire body, context JSON, and output schema JSON and asserts equality.
8. **Context/schema are not double-counted** — `tokenReport.test.ts` asserts `modelInputChars === systemInstruction.length + userTurnContent.length` exactly (never additionally summing `contextJsonChars`/`outputSchemaJsonChars`, which are already embedded inside `userTurnContent`).
9. **Missing target date or invalid mode returns a clear validation error** — `tokenReportRoute.test.ts`: missing/invalid `date`, missing/invalid `mode`, and invalid price inputs all assert `400` with a string `error` message.
10. **API keys and authorization headers never appear in reports or logs** — `tokenReport.test.ts` and `tokenReportRoute.test.ts` both assert the serialized report/HTTP response never contains the configured fake API key or the substring `"bearer "`/`"authorization"`.
11. **Cost formulas are correct** — `tokenReport.test.ts`: exact-formula assertions for both prices supplied, `null` when no pricing supplied, and partial pricing (only one side computed).
12. **Existing Generate and Reconcile tests remain passing** — confirmed by the full suite run below (112/112 test files, 1354/1354 tests, zero regressions).

## Verification

```
npm run typecheck   → clean
npm run build       → clean
npm test -- --run   → 112 test files passed, 1354 tests passed
npm run verify      → 112 test files passed, 1354 tests passed
```

## Acceptance criteria (spec's own checklist)

- [x] Both Generate and Reconcile contexts are built through production code paths (`buildProgrammerContext`/`buildReconciliationContext`, unmodified).
- [x] Both use the exact shared Velona serialization builder (`buildVelonaRequestBody`).
- [x] The dry run makes zero external API calls (enforced by tests; confirmed live).
- [x] Exact character and UTF-8 byte counts are reported (`*Chars`/`*BytesUtf8` fields).
- [x] Model-input token estimates are clearly labelled (`tokenCountMethod: "chars_div_4_estimate"`, never claimed exact or provider-billed).
- [x] Output limits are clearly separated from actual output usage (`configuredMaxOutputTokens` vs. `estimatedTypicalOutputTokens`/`estimatedOutputTokens`, with an explanatory `note`).
- [x] Cost projection accepts model-specific pricing (`inputPricePerMillionTokens`/`outputPricePerMillionTokens` query params).
- [x] No secrets are exposed (tested).
- [x] Tests pass (112/112 files, 1354/1354 tests).
- [x] Dev provides actual measured reports for both request types (above).

## Remaining limitations

- `estimatedTypicalOutputTokens` is a documented planning value (§6: 2000/3000), not a prediction of what any specific request will actually produce — the report's own `note` field says this explicitly. It is `null`, with an explanatory note, whenever the recommended value would exceed the currently configured `VELONA_MAX_TOKENS` (exercised by a dedicated test that sets `VELONA_MAX_TOKENS=1000`).
- `tokenCountMethod` is always `chars_div_4_estimate` in this repository — no tokenizer library is installed, and per spec §5 one was not added solely for this feature.
- The route's access control (`AI_TOKEN_REPORT_ENABLED` / optional `AI_TOKEN_REPORT_ACCESS_TOKEN` / `NODE_ENV` fallback) is a new, purpose-built convention — this codebase has no prior authenticated/admin-only route to follow, since it is a single-user application with no auth layer anywhere else.
