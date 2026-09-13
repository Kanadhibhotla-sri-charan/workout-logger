# Implementation Report — Finalize and Execute AI Token Measurement

Spec: `docs/DEV_INSTRUCTIONS_TOKEN_MEASUREMENT_NEXT_ITERATION.md`

## Summary

Corrected the token-report contract's unavailable-estimate semantics (`null`, never `0`), added a CLI dry-run command (`npm run ai:token-report`) as the primary interface (per the spec's own preference), kept the existing protected HTTP endpoint working against the identical `buildTokenReport()` implementation (no duplicated report logic), added a real, non-fabricated context-size summary, and restructured cost projection into separate typical/maximum figures driven by an optional per-model pricing map. No provider/network call is made anywhere in this path; no real API key or model choice is required or recommended by this iteration.

## Files changed

- `src/ai-programmer/service/tokenReport.ts` — rewritten contract:
  - `TokenEstimate.estimatedTypicalOutputTokens` and `estimatedTotalTokens` are `number | null` (previously `estimatedOutputTokens` defaulted unavailable to `0`, which this iteration removes entirely as a field — `estimatedTypicalOutputTokens` is now the single source of truth for that value, and `estimatedTotalTokens` is `null` whenever it is).
  - `measurements` field names now consistently pair `*Chars` with `*Utf8Bytes` (e.g. `systemInstructionChars`/`systemInstructionUtf8Bytes`), and now include `modelInputUtf8Bytes` (previously missing) computed as the sum of the system/user-turn byte counts.
  - New `contextSummary`: `historySessionCount` (distinct dates across every target's bounded exercise history — real data already present in the built context), `activeGoalCount`, `weeklyProgramDayCount`, `lockedDayCount`, `plannedSessionCount` (reconcile_week only; `null` for generate_session, whose context has no comparable field), `overrideCount` (a real `WeekActivityOverridesRepo` read for the context's week — the same lookup the context builders themselves perform internally, never a fabricated count).
  - `costProjection` restructured into `inputCost` (shared), `typicalOutputCost`/`typicalTotalCost` (only when `estimatedTypicalOutputTokens` is available), and `maximumOutputCost`/`maximumTotalCost` (always computable from `configuredMaxOutputTokens` once pricing exists — a ceiling, never confused with an expected cost). Pricing is now an optional `{source, models: {modelName: {inputUsdPerMillionTokens?, outputUsdPerMillionTokens?}}}` map (`TokenReportPricing`), looked up by the actually-configured model name — a model with no entry reports `null` costs, never a guessed price.
- `src/server/routes/aiProgrammer.ts` — `GET /token-report` updated for the new contract: query params renamed `inputUsdPerMillionTokens`/`outputUsdPerMillionTokens` (from `inputPricePerMillionTokens`/...), translated into an ad-hoc single-model `TokenReportPricing` (source: `"query-params"`) keyed by `loadVelonaConfig().model` before calling the identical `buildTokenReport()` the CLI uses — no duplicated report logic. Access control (disabled by default via `AI_TOKEN_REPORT_ENABLED`, optional `AI_TOKEN_REPORT_ACCESS_TOKEN` header, `NODE_ENV`-gated fallback, bare 404 on denial) is unchanged from the prior iteration.
- `src/ai-programmer/cli/tokenReportCli.ts` — **new**. `npm run ai:token-report -- --mode <mode> --target-date <date> [--reason] [--swap-unavailable-reason] [--pricing-file <path>] [--json] [--help]`. Calls the exact same `buildTokenReport()` — never a second, hand-rolled report implementation. Never calls `fetch`/`provider.generate()`. Does not require a *real* API key (only that `VELONA_API_KEY`/`VELONA_MODEL` be set, per the existing, unchanged `loadVelonaConfig()` contract — the value is never used for any network call in this mode). `--json` prints machine-readable JSON only on stdout (errors always go to stderr, in both modes); without `--json`, prints the documented human-readable summary. Exported `runTokenReportCli(argv, io)` takes injectable stdout/stderr/db for fast in-process testing (no subprocess spawn).
- `config/ai-model-prices.example.json` — **new**. Example pricing file matching `--pricing-file`'s expected shape, with illustrative (non-authoritative) example model names/prices.
- `package.json` — added the `"ai:token-report"` script.
- `tests/ai-programmer/tokenReport.test.ts` — rewritten for the new contract (null-vs-0 semantics, renamed measurement fields, `contextSummary`, restructured `costProjection`).
- `tests/ai-programmer/tokenReportRoute.test.ts` — updated for the renamed query params and response shape; added a test that HTTP responses also represent an unavailable typical estimate as `null`.
- `tests/ai-programmer/tokenReportCli.test.ts` — **new**, 19 tests covering `parseArgs`, both modes, validation errors, `--json` output validity and stdout/stderr separation, pricing (file-based, missing entry, malformed file, nonexistent file), and that `fetch` is never invoked.

No workout-generation, reconciliation, or existing endpoint behavior changed — this iteration only touches the diagnostic token-report path.

## Exact CLI commands used

```bash
npm run ai:token-report -- --mode generate_session --target-date 2026-09-14 \
  --pricing-file /path/to/demo-prices.json

npm run ai:token-report -- --mode generate_session --target-date 2026-09-14 \
  --pricing-file /path/to/demo-prices.json --json

npm run ai:token-report -- --mode reconcile_week --target-date 2026-09-14 \
  --reason "Move gym session to Sunday" --pricing-file /path/to/demo-prices.json

npm run ai:token-report -- --mode reconcile_week --target-date 2026-09-14 \
  --reason "Move gym session to Sunday" --pricing-file /path/to/demo-prices.json --json
```

Run against a scratch, file-backed SQLite database (`DB_PATH` env var) seeded with a representative real state: a real training profile, one active aesthetic goal (`chest-front-width`), and one completed historical gym session with a logged set. `VELONA_API_KEY`/`VELONA_MODEL` were set to deliberately fake/placeholder values (`fake-key-never-used-dry-run-only` / `velona-default`) — never a real credential — since this mode never calls Velona and the values are only used to populate `model`/`baseUrl`/`configuredMaxOutputTokens` in the report. `demo-prices.json` was a one-model pricing file (`{"models": {"velona-default": {"inputUsdPerMillionTokens": 3, "outputUsdPerMillionTokens": 15}}}`) so the reports below demonstrate a real, non-null cost projection; the checked-in `config/ai-model-prices.example.json` uses different illustrative model names (`example-small-model`/`example-large-model`) since it is not meant to imply the actually-configured model's real price.

## Generate-session JSON report (real database state)

```json
{
  "generatedAt": "2026-09-13T15:22:58.457Z",
  "mode": "generate_session",
  "requestId": "fe3c5273-be43-4cb1-97a6-17797474c8bd",
  "targetDate": "2026-09-14",
  "weekStart": null,
  "model": "velona-default",
  "baseUrl": "https://velona.in/gateway/v1",
  "measurements": {
    "systemInstructionChars": 2610,
    "systemInstructionUtf8Bytes": 2630,
    "userTurnContentChars": 59901,
    "userTurnContentUtf8Bytes": 59973,
    "contextJsonChars": 57899,
    "contextJsonUtf8Bytes": 57971,
    "outputSchemaJsonChars": 1776,
    "outputSchemaJsonUtf8Bytes": 1776,
    "modelInputChars": 62511,
    "modelInputUtf8Bytes": 62603,
    "wireBodyChars": 70006,
    "wireBodyUtf8Bytes": 70098
  },
  "tokenEstimate": {
    "tokenEstimateMethod": "chars_div_4_estimate",
    "estimatedInputTokens": 15628,
    "estimatedTypicalOutputTokens": 2000,
    "configuredMaxOutputTokens": 4096,
    "estimatedTotalTokens": 17628,
    "note": "Planning value for generate_session (fits under the configured max_tokens of 4096). Actual completion length is only known after a live request."
  },
  "contextSummary": {
    "historySessionCount": 1,
    "activeGoalCount": 1,
    "weeklyProgramDayCount": 7,
    "lockedDayCount": 0,
    "plannedSessionCount": null,
    "overrideCount": 0
  },
  "costProjection": {
    "model": "velona-default",
    "pricingSource": "/path/to/demo-prices.json",
    "inputUsdPerMillionTokens": 3,
    "outputUsdPerMillionTokens": 15,
    "inputCost": 0.046883999999999995,
    "typicalOutputCost": 0.03,
    "typicalTotalCost": 0.076884,
    "maximumOutputCost": 0.061439999999999995,
    "maximumTotalCost": 0.10832399999999999,
    "label": "projected_cost"
  }
}
```

## Reconcile-week JSON report (real database state)

```json
{
  "generatedAt": "2026-09-13T15:23:08.871Z",
  "mode": "reconcile_week",
  "requestId": "c7d25dce-fb2d-4fb9-90da-58c729bfa596",
  "targetDate": "2026-09-14",
  "weekStart": "2026-09-14",
  "model": "velona-default",
  "baseUrl": "https://velona.in/gateway/v1",
  "measurements": {
    "systemInstructionChars": 2694,
    "systemInstructionUtf8Bytes": 2714,
    "userTurnContentChars": 62733,
    "userTurnContentUtf8Bytes": 62809,
    "contextJsonChars": 59718,
    "contextJsonUtf8Bytes": 59794,
    "outputSchemaJsonChars": 2791,
    "outputSchemaJsonUtf8Bytes": 2791,
    "modelInputChars": 65427,
    "modelInputUtf8Bytes": 65523,
    "wireBodyChars": 73288,
    "wireBodyUtf8Bytes": 73384
  },
  "tokenEstimate": {
    "tokenEstimateMethod": "chars_div_4_estimate",
    "estimatedInputTokens": 16357,
    "estimatedTypicalOutputTokens": 3000,
    "configuredMaxOutputTokens": 4096,
    "estimatedTotalTokens": 19357,
    "note": "Planning value for reconcile_week (fits under the configured max_tokens of 4096). Actual completion length is only known after a live request."
  },
  "contextSummary": {
    "historySessionCount": 1,
    "activeGoalCount": 1,
    "weeklyProgramDayCount": 7,
    "lockedDayCount": 0,
    "plannedSessionCount": 0,
    "overrideCount": 0
  },
  "costProjection": {
    "model": "velona-default",
    "pricingSource": "/path/to/demo-prices.json",
    "inputUsdPerMillionTokens": 3,
    "outputUsdPerMillionTokens": 15,
    "inputCost": 0.049071000000000004,
    "typicalOutputCost": 0.045,
    "typicalTotalCost": 0.094071,
    "maximumOutputCost": 0.061439999999999995,
    "maximumTotalCost": 0.110511,
    "label": "projected_cost"
  }
}
```

(`weekStart` equals `targetDate` here because 2026-09-14 is itself a Monday — the Monday-anchored week containing a Monday starts on that same date.)

## Human-readable summaries

```
AI Token Report
---------------
Mode: generate_session
Target date: 2026-09-14
Model: velona-default
Base URL: https://velona.in/gateway/v1
Request ID: 8a432167-7556-4afe-88d5-d04948828b67
Generated at: 2026-09-13T15:22:57.694Z

Model input:
  System instruction: 2610 chars (2630 UTF-8 bytes)
  User turn content: 59901 chars (59973 UTF-8 bytes)
  Total model input: 62511 chars (62603 UTF-8 bytes)
  Estimated input tokens: 15628 (method: chars_div_4_estimate)

Output:
  Typical estimated tokens: 2000
  Configured max tokens: 4096
  Estimated total tokens (typical): 17628

Wire body (full HTTP JSON — not a token count):
  Characters: 70006 (70098 UTF-8 bytes)

Context/schema:
  Context JSON: 57899 chars (57971 UTF-8 bytes)
  Output schema JSON: 1776 chars (1776 UTF-8 bytes)

Context summary:
  History session dates referenced: 1
  Active goals: 1
  Weekly program days: 7
  Locked days: 0
  Planned sessions: n/a for this mode
  Activity overrides this week: 0

Cost projection (projected_cost; pricing source: /path/to/demo-prices.json):
  Input price: $3 / 1M tokens
  Output price: $15 / 1M tokens
  Typical: $0.076884
  Maximum: $0.108324 (a ceiling, not an expected cost)

No Velona/provider API call was made to produce this report.
```

```
AI Token Report
---------------
Mode: reconcile_week
Target date: 2026-09-14
Week start: 2026-09-14
Model: velona-default
Base URL: https://velona.in/gateway/v1
Request ID: 9c952a51-9b30-449d-83f7-9a07d2c4159e
Generated at: 2026-09-13T15:23:08.202Z

Model input:
  System instruction: 2694 chars (2714 UTF-8 bytes)
  User turn content: 62733 chars (62809 UTF-8 bytes)
  Total model input: 65427 chars (65523 UTF-8 bytes)
  Estimated input tokens: 16357 (method: chars_div_4_estimate)

Output:
  Typical estimated tokens: 3000
  Configured max tokens: 4096
  Estimated total tokens (typical): 19357

Wire body (full HTTP JSON — not a token count):
  Characters: 73288 (73384 UTF-8 bytes)

Context/schema:
  Context JSON: 59718 chars (59794 UTF-8 bytes)
  Output schema JSON: 2791 chars (2791 UTF-8 bytes)

Context summary:
  History session dates referenced: 1
  Active goals: 1
  Weekly program days: 7
  Locked days: 0
  Planned sessions: 0
  Activity overrides this week: 0

Cost projection (projected_cost; pricing source: /path/to/demo-prices.json):
  Input price: $3 / 1M tokens
  Output price: $15 / 1M tokens
  Typical: $0.094071
  Maximum: $0.110511 (a ceiling, not an expected cost)

No Velona/provider API call was made to produce this report.
```

## Configured model and max output-token setting

`model: "velona-default"` (a placeholder value for this dry run — never a real production model choice), `configuredMaxOutputTokens: 4096` (the provider's documented default, `VELONA_MAX_TOKENS` unset).

## Pricing source used

A one-off local pricing file (`{"models": {"velona-default": {"inputUsdPerMillionTokens": 3, "outputUsdPerMillionTokens": 15}}}`), passed via `--pricing-file`, chosen only to demonstrate a non-null cost projection end-to-end — not a recommendation or comparison of real Velona model prices. The checked-in `config/ai-model-prices.example.json` is a template for a real pricing file, not itself authoritative.

## Confirmation no external provider call was made

- `tokenReport.ts` contains no call to `fetch`, `VelonaProvider.generate()`, or any network client — verified by direct code inspection and enforced by tests (`tests/ai-programmer/tokenReport.test.ts`, `tokenReportRoute.test.ts`, and `tokenReportCli.test.ts` all stub global `fetch` to throw immediately if invoked; every test, including the full-mode CLI runs above, passed).
- The live CLI runs above used only a fake `VELONA_API_KEY` (`fake-key-never-used-dry-run-only`) purely to satisfy `loadVelonaConfig()`'s required-field check — no outbound request to `https://velona.in` or anywhere else occurred during any of the four commands run.

## Test commands and results

```
npm run typecheck   → clean
npm run build       → clean
npm test -- --run   → 113 test files passed, 1379 tests passed
npm run verify      → 113 test files passed, 1379 tests passed
```

New/updated test coverage for this iteration, mapped to spec §8:
- **Contract behavior**: unavailable typical-output estimate is `null` (never `0`) for both modes and over HTTP; `estimatedTotalTokens` becomes `null` accordingly; `configuredMaxOutputTokens` remains reported regardless.
- **Serialization**: report measurements match an independently-reconstructed production request byte-for-byte; context/schema are not double-counted in `modelInputChars`; UTF-8 byte counts verified against `Buffer.byteLength` directly, including `modelInputUtf8Bytes` as the sum of its two parts; wire-body measurements are asserted strictly larger than model-input measurements (the envelope superset).
- **CLI**: both modes accepted; invalid mode/date rejected with exit code 1 and a clear stderr message; `--json` output is valid, parseable JSON with nothing else mixed into stdout; pricing is optional (defaults to null costs); a pricing file with no entry for the configured model yields null costs (never guessed); a malformed/missing pricing file is a hard error; `fetch` is never invoked across a full run in either mode; `--help` prints usage without touching the database.
- **Regression**: full existing suite re-run clean (113/113 files, 1379/1379 tests, up from 1354 before this iteration — 25 new: 19 CLI + net 6 across the rewritten unit/route files).

## Limitations / missing database state

- The context summary's `overrideCount` and `historySessionCount` are computed from the exact real database state seeded for this run (one goal, one historical session, no week-activity overrides) — a database with richer history or active overrides would show non-zero values there; this was not exercised live in this report beyond what the seed data produced (already covered by dedicated unit tests with non-trivial fixtures where relevant, e.g. `plannedSessionCount` and `lockedDayCount` in `tests/ai-programmer/weekReconciliationLifecycle.test.ts`'s broader fixtures).
- `tokenEstimateMethod` is always `chars_div_4_estimate` — no tokenizer library is installed in this repository, and none was added solely for this feature, per the spec's own instruction.
- This iteration does not select, recommend, or benchmark any model — the pricing file above is illustrative only, used solely to demonstrate the cost-projection formulas end-to-end.
