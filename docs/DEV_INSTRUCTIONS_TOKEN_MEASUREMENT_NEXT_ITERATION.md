# Developer Instructions — Finalize and Execute AI Token Measurement

## Objective

Implement all repository-side work needed to measure the real serialized request sizes and produce cost projections for both AI Programmer modes:

1. `generate_session`
2. `reconcile_week`

This iteration must **not make any real provider/API calls**. It must use the real application/database context and the exact production request serializer.

The goal is to produce reproducible reports that can later be used to choose the cheapest suitable model and plan one controlled real-provider validation.

---

## Scope

### In scope

- Small correction to token-report semantics.
- CLI command for dry-run token reports.
- Reuse of production context builders.
- Reuse of the exact production Velona request-body serializer.
- Real database-backed context generation.
- Context-size metadata.
- Model pricing inputs and cost projections.
- Tests.
- Documentation and example output.

### Out of scope

- Calling Velona or any external AI provider.
- Adding or changing API keys.
- Choosing a final model.
- Production rollout.
- Automatic AI generation.
- Persisting provider usage from real calls.
- Quality benchmarking.
- Changing workout-programming logic.

---

## 1. Correct unavailable output-estimate semantics

Find the existing token-report calculation where an unavailable typical output estimate is represented as `0`.

Change the semantics as follows:

- `estimatedTypicalOutputTokens` must be `number | null`.
- If the typical output assumption exceeds the configured `max_tokens`, return `null`.
- Do not represent “unknown/unavailable” as `0`.
- `estimatedTotalTokens` must also be `number | null` when a typical total cannot be calculated.
- Preserve the configured maximum output-token value separately.

Recommended fields:

```ts
type TokenEstimate = {
  estimatedInputTokens: number;
  estimatedTypicalOutputTokens: number | null;
  estimatedTotalTokens: number | null;
  configuredMaxOutputTokens: number;
};
```

If the project already has a different contract, adapt the names consistently rather than creating duplicate contracts.

### Required interpretation

- `estimatedTypicalOutputTokens`: planning estimate, or `null`.
- `configuredMaxOutputTokens`: hard configured upper limit.
- Never label either field as actual provider usage.

---

## 2. Add a CLI dry-run command

Add a repository command that can generate a token report without making any network/provider call.

Preferred usage:

```bash
npm run ai:token-report -- --mode generate_session --target-date 2026-09-14
npm run ai:token-report -- --mode reconcile_week --target-date 2026-09-14
```

Support the actual project date/database conventions if they differ.

### Required CLI options

- `--mode`
  - `generate_session`
  - `reconcile_week`
- `--target-date`
  - ISO date: `YYYY-MM-DD`
- Optional `--reason` for reconciliation.
- Optional `--swap-unavailable-reason` for reconciliation.
- Optional pricing arguments or a pricing-file argument.

A pricing-file approach is preferred over putting many prices on the command line:

```bash
npm run ai:token-report --   --mode reconcile_week   --target-date 2026-09-14   --pricing-file ./config/ai-model-prices.example.json
```

Do not require real API credentials for this command.

---

## 3. Reuse the production execution path

The CLI must use the same code paths used by real AI requests wherever possible:

1. Load the current application/database state.
2. Build the appropriate context:
   - Generate: existing generation context builder.
   - Reconcile: `buildReconciliationContext`.
3. Build the same system instruction.
4. Build the same output schema.
5. Call the shared production request serializer, currently the equivalent of:
   - `buildVelonaRequestBody(...)`
6. Measure the resulting values.

Do **not** create a second simplified context builder or manually reconstruct the JSON payload.

The dry-run command must not call:

- `provider.generate()`
- `fetch()`
- Any HTTP client.
- Any external network service.

If a shared helper is needed, extract it from the provider layer without changing the serialized production contract.

---

## 4. Required report measurements

For each mode, output machine-readable JSON and a human-readable summary.

At minimum, include:

### Request metadata

```json
{
  "generatedAt": "...",
  "mode": "generate_session",
  "targetDate": "2026-09-14",
  "model": "...",
  "baseUrl": "...",
  "requestId": "..."
}
```

Do not include API keys, Authorization headers, or secrets.

### Exact serialized measurements

Report:

- `systemInstructionChars`
- `systemInstructionUtf8Bytes`
- `userTurnContentChars`
- `userTurnContentUtf8Bytes`
- `contextJsonChars`
- `contextJsonUtf8Bytes`
- `outputSchemaJsonChars`
- `outputSchemaUtf8Bytes`
- `modelInputChars`
- `modelInputUtf8Bytes`
- `wireBodyChars`
- `wireBodyUtf8Bytes`

Clarify in field descriptions that:

- `modelInput*` measures the model-facing system and user content.
- `wireBody*` measures the complete serialized HTTP JSON body.
- Wire-body bytes are not token counts.

### Token estimates

Report:

- `tokenEstimateMethod`
- `estimatedInputTokens`
- `estimatedTypicalOutputTokens`
- `configuredMaxOutputTokens`
- `estimatedTotalTokens`

The current heuristic may remain:

```text
ceil(modelInputChars / 4)
```

but label it explicitly as a heuristic, for example:

```json
"tokenEstimateMethod": "chars_div_4_estimate"
```

Do not call it exact tokenization.

### Context summary

Add a compact summary that helps explain why two reports differ. Use fields supported by the actual context, such as:

- `historySessionCount`
- `activeGoalCount`
- `weeklyProgramDayCount`
- `lockedDayCount`
- `plannedSessionCount`
- `overrideCount`

Do not dump the entire context into ordinary logs. The full context may be included only in an explicitly requested debug artifact, and must not contain secrets.

---

## 5. Add pricing and cost projections

Support optional model pricing input.

Recommended pricing-file format:

```json
{
  "models": {
    "model-name": {
      "inputUsdPerMillionTokens": 0,
      "outputUsdPerMillionTokens": 0
    }
  }
}
```

Requirements:

- Pricing is optional.
- If pricing is absent, report token measurements but set cost values to `null`.
- If the configured model has no pricing entry, do not guess prices.
- Clearly label all costs as estimates/projections.

Calculate:

### Typical projection

Only when `estimatedTypicalOutputTokens` is not `null`:

```text
inputCost =
estimatedInputTokens / 1,000,000
× inputUsdPerMillionTokens

typicalOutputCost =
estimatedTypicalOutputTokens / 1,000,000
× outputUsdPerMillionTokens

typicalTotalCost =
inputCost + typicalOutputCost
```

### Maximum projection

Use `configuredMaxOutputTokens`:

```text
maximumOutputCost =
configuredMaxOutputTokens / 1,000,000
× outputUsdPerMillionTokens

maximumTotalCost =
inputCost + maximumOutputCost
```

Use `null` when the required pricing or token estimate is unavailable.

Do not confuse maximum projected cost with expected cost.

---

## 6. Output formats

Support:

### Human-readable output

Example:

```text
AI Token Report
---------------
Mode: reconcile_week
Target date: 2026-09-14
Model: example-model

Model input:
  Characters: 12345
  UTF-8 bytes: 12410
  Estimated input tokens: 3087

Output:
  Typical estimated tokens: 3000
  Configured max tokens: 4096

Wire body:
  Characters: 15600
  UTF-8 bytes: 15720

Cost projection:
  Typical: $0.00xxxx
  Maximum: $0.00xxxx
```

### JSON output

Provide a flag such as:

```bash
--json
```

The JSON output must be suitable for saving and comparing between runs.

Avoid mixing human-readable logs into stdout when `--json` is used. Send diagnostics to stderr if necessary.

---

## 7. Optional protected HTTP endpoint

Only retain or add the existing protected endpoint if it is already useful. The CLI is the primary interface.

If an HTTP endpoint remains:

- Keep it disabled by default.
- Require the existing opt-in setting.
- Require a strong access token in production.
- Never return secrets.
- Never call the provider.
- Preserve the same report implementation as the CLI rather than duplicating logic.

---

## 8. Tests

Add or update tests for:

### Contract behavior

- Unavailable typical output estimate is `null`, not `0`.
- Total estimate becomes `null` when appropriate.
- Maximum output tokens remain reported.

### Serialization

- Report measurements are based on the shared production serializer.
- Context/schema are not double-counted in `modelInputChars`.
- UTF-8 byte counts are correct for Unicode content.
- Wire-body measurements are distinct from model-input measurements.

### CLI

- Both modes are accepted.
- Invalid mode is rejected.
- Invalid date is rejected.
- JSON output is valid.
- Pricing is optional.
- Missing model pricing yields `null` costs.
- No provider/network call occurs.

### Regression

Run the complete existing verification suite:

```bash
npm run typecheck
npm run build
npm test -- --run
```

Use the repository's established verification command as well, if one exists.

---

## 9. Required developer deliverables

At the end of the implementation, provide:

1. Files changed.
2. Exact CLI commands used.
3. Generate-session JSON report using real database state.
4. Reconcile-week JSON report using real database state.
5. Human-readable summary of both.
6. Configured model and max output-token setting.
7. Pricing source/file used, if any.
8. Confirmation that no external provider call was made.
9. Test commands and results.
10. Any limitations or missing database state.

Do not select or recommend a final model yet unless explicitly asked. This iteration is for collecting measurements.

---

## Acceptance criteria

This iteration is complete only when:

- Both modes can be measured from real application state.
- The exact production serializer is reused.
- No provider/network call occurs.
- Character and UTF-8 byte measurements are exact.
- Token counts are explicitly labelled as estimates.
- Unavailable estimates are represented by `null`.
- Typical and maximum cost projections are separated.
- Reports can be saved as JSON.
- Tests pass.
- The developer provides the two real reports.
