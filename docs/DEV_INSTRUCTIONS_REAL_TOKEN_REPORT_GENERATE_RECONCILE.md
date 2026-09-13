# DEV INSTRUCTIONS — Add a Real Dry-Run Token Report for Generate and Reconcile

## Objective

Implement a **no-provider-call token inspection mode** that builds the exact current Generate and Reconcile request payloads from the application's real database state and reports their serialized sizes.

This is strictly for:

- measuring the actual request payload;
- estimating input tokens;
- estimating output-token capacity;
- comparing projected costs across Velona models.

Do **not** benchmark model quality, alter workout-generation behavior, or call Velona during the dry run.

---

## 1. Scope

Implement a diagnostic command or protected development endpoint that can produce reports for:

1. `generate_session`
2. `reconcile_week`

The report must use the same context builders, system instructions, output schemas, and provider request-body builder used by production.

There must be **one source of truth**. Do not recreate the payload manually in a separate diagnostic implementation.

---

## 2. First inspect and reuse the existing code

Locate the current implementations of:

- `AIProgrammerService.generateSession()`
- weekly reconciliation service/lifecycle
- Generate context builder
- Reconciliation context builder
- Generate output schema
- Reconciliation output schema
- `VelonaProvider`
- `buildVelonaUserTurnContent()`
- `buildVelonaRequestBody()`
- token diagnostics types/helpers
- existing authenticated/protected development routes, if any

Use the repository's actual names and preserve existing architecture.

If the provider request builder is private, extract it into a shared pure function or expose an equivalent internal helper so production calls and dry-run diagnostics use exactly the same serialization path.

---

## 3. Required shared payload-builder design

Create or reuse a pure function equivalent to:

```ts
type VelonaPayloadBuildResult = {
  body: VelonaInferenceRequest;
  systemInstruction: string;
  userTurnContent: string;
  outputSchemaJson: string;
};

function buildVelonaRequestBody(
  request: AIProgrammerProviderRequest,
  config: VelonaConfig
): VelonaPayloadBuildResult;
```

The function must construct the exact body currently sent to Velona:

```ts
{
  model: config.model,
  turns: [
    {
      role: "system",
      content: request.systemInstruction
    },
    {
      role: "user",
      content: JSON.stringify({
        request: {
          mode: request.mode,
          requestId: request.requestId
        },
        context: request.context,
        outputSchema: request.outputSchema,
        instruction:
          "Return exactly one JSON object conforming to outputSchema. No prose outside the JSON object."
      })
    }
  ],
  stream: false,
  config: {
    temperature: config.temperature,
    max_tokens: config.maxTokens
  },
  output: {
    format: "json"
  }
}
```

Do not change field names, nesting, escaping, or serialization semantics without a concrete reason.

The production fetch must call this shared builder.

---

## 4. Dry-run report requirements

For each request type, report all of the following:

### Request identity

- mode
- request ID
- target date, if applicable
- week start, if applicable
- configured model
- configured base URL
- configured `max_tokens`

### Exact serialized measurements

Measure the exact strings actually used in the request:

```text
systemInstructionChars
userTurnContentChars
wireBodyChars
wireBodyBytesUtf8
contextJsonChars
contextJsonBytesUtf8
outputSchemaJsonChars
outputSchemaJsonBytesUtf8
```

Clarification:

- `userTurnContent` is the exact string assigned to the user turn.
- `wireBody` is `JSON.stringify(body)`.
- `contextJson` is `JSON.stringify(request.context)`.
- `outputSchemaJson` is `JSON.stringify(request.outputSchema)`.
- Do not double-count schema or context in the report.

Also report:

```text
estimatedInputTokens
estimatedOutputTokens
estimatedTotalTokens
```

Use the existing heuristic only if no tokenizer is available:

```ts
estimatedInputTokens = Math.ceil(inputCharacterCount / 4);
```

Clearly label this as an estimate, not provider billing usage.

Prefer counting the actual model-facing text:

```text
systemInstruction + userTurnContent
```

Also report wire-body size separately because JSON envelope/configuration bytes are not necessarily counted as model input tokens.

Do not claim that `wireBodyChars / 4` is the provider's billed prompt-token count.

---

## 5. Define the input-token estimate clearly

Use these fields:

```text
modelInputChars
estimatedModelInputTokens
wireBodyChars
wireBodyBytesUtf8
```

Where:

```ts
modelInputChars =
  systemInstruction.length + userTurnContent.length;
```

This represents the text content supplied in the system and user turns.

For transparency, also report component-level values:

```text
systemInstructionChars
userTurnContentChars
```

If a tokenizer library is already installed and supports the configured model, use it and report:

```text
tokenCountMethod: "model_tokenizer"
```

Otherwise:

```text
tokenCountMethod: "chars_div_4_estimate"
```

Do not add a large tokenizer dependency solely for this feature unless there is a clear repository-approved reason.

---

## 6. Output-token sizing

The dry run cannot know the actual completion length without calling a model.

Report both:

```text
configuredMaxOutputTokens
estimatedTypicalOutputTokens
```

For `estimatedTypicalOutputTokens`, use a clearly documented planning value based on the actual schema, or report `null` if no defensible estimate exists.

Do not present `max_tokens` as actual output usage.

Recommended initial planning values:

```text
Generate: 2000
Reconcile: 3000
```

Only use these defaults if they match the current provider configuration and schema complexity. Otherwise report the configured values and explain that actual completion usage requires a live request.

---

## 7. Build the real contexts

### Generate

Use the exact production Generate service/context path with a representative current database state.

The dry run must not use a simplified fake context.

Support selecting a real target date and any required request parameters. If the service requires a proposal/request object, construct it through the same validated pathway used by production.

### Reconcile

Use the exact production reconciliation context path.

The report must include:

- target date;
- current weekly program;
- activity override/request;
- seven-day context;
- locked/completed-day information;
- relevant exercise/history data;
- reconciliation output schema.

Do not manually approximate the reconciliation context.

---

## 8. Safe execution interface

Implement one of the following, preferably the existing project convention:

### Preferred: protected development endpoint

Example shape:

```text
GET /api/ai-programmer/token-report?mode=generate&date=YYYY-MM-DD
GET /api/ai-programmer/token-report?mode=reconcile_week&date=YYYY-MM-DD
```

Requirements:

- development/admin protection;
- never available anonymously in production;
- never calls Velona;
- never logs API keys;
- never returns API keys;
- never persists the full context by default;
- return measurements and metadata only, unless explicitly requested in a local development mode.

### Alternative: CLI/script

A repository script is acceptable if it can load the real application/database configuration and invoke the same production builders.

Example:

```text
npm run ai:token-report -- --mode=generate --date=YYYY-MM-DD
npm run ai:token-report -- --mode=reconcile_week --date=YYYY-MM-DD
```

Use whichever approach fits the repository better. Do not implement both unless inexpensive and useful.

---

## 9. Cost calculation

Do not hardcode model prices into the core request builder.

Add a separate calculation layer or report section that accepts pricing inputs:

```text
inputPricePerMillionTokens
outputPricePerMillionTokens
```

Calculate:

```ts
estimatedInputCost =
  estimatedInputTokens / 1_000_000 * inputPricePerMillionTokens;

estimatedOutputCost =
  estimatedOutputTokens / 1_000_000 * outputPricePerMillionTokens;

estimatedTotalCost =
  estimatedInputCost + estimatedOutputCost;
```

If actual provider usage is unavailable, label all costs as:

```text
projected_cost
```

Do not call it actual billed cost.

Support comparing multiple candidate models using the same measured token counts, because the payload is identical apart from the configured model and potentially tokenizer differences.

---

## 10. Required output format

Return a concise JSON report similar to:

```json
{
  "generatedAt": "2026-09-13T...",
  "mode": "generate_session",
  "requestId": "...",
  "targetDate": "YYYY-MM-DD",
  "model": "...",
  "maxOutputTokens": 2000,
  "tokenCountMethod": "chars_div_4_estimate",
  "measurements": {
    "systemInstructionChars": 0,
    "userTurnContentChars": 0,
    "modelInputChars": 0,
    "estimatedInputTokens": 0,
    "contextJsonChars": 0,
    "outputSchemaJsonChars": 0,
    "wireBodyChars": 0,
    "wireBodyBytesUtf8": 0
  },
  "output": {
    "configuredMaxOutputTokens": 2000,
    "estimatedTypicalOutputTokens": null
  },
  "costProjection": {
    "inputPricePerMillionTokens": null,
    "outputPricePerMillionTokens": null,
    "estimatedInputCost": null,
    "estimatedOutputCost": null,
    "estimatedTotalCost": null
  }
}
```

Use the repository's existing response conventions.

---

## 11. Required tests

Add tests for:

1. Shared builder output equals the payload shape used by the production provider.
2. Dry-run mode never invokes `fetch`.
3. Generate report uses the real Generate context builder.
4. Reconcile report uses the real Reconcile context builder.
5. `userTurnContentChars` equals the exact serialized user-turn content length.
6. `wireBodyChars` equals `JSON.stringify(body).length`.
7. UTF-8 byte count is calculated correctly.
8. Context/schema are not double-counted.
9. Missing target date or invalid mode returns a clear validation error.
10. API keys and authorization headers never appear in reports or logs.
11. Cost formulas are correct.
12. Existing Generate and Reconcile tests remain passing.

---

## 12. Verification

Run:

```bash
npm run typecheck
npm run build
npm test -- --run
```

Then execute both dry runs against a representative real database state:

```text
Generate report
Reconcile report
```

Save the resulting measurements in the final developer report.

The final report must include:

- files changed;
- exact commands/endpoints used;
- Generate measurements;
- Reconcile measurements;
- token-count method;
- whether counts are estimated or provider-reported;
- sample projected cost calculation;
- confirmation that no Velona API call occurred;
- test totals and verification results.

---

## Acceptance criteria

This task is complete only when:

- [ ] Both Generate and Reconcile contexts are built through production code paths.
- [ ] Both use the exact shared Velona serialization builder.
- [ ] The dry run makes zero external API calls.
- [ ] Exact character and UTF-8 byte counts are reported.
- [ ] Model-input token estimates are clearly labelled.
- [ ] Output limits are clearly separated from actual output usage.
- [ ] Cost projection accepts model-specific pricing.
- [ ] No secrets are exposed.
- [ ] Tests pass.
- [ ] Dev provides actual measured reports for both request types.

Do not implement model-quality benchmarking. This task is exclusively for request-size and cost estimation.
