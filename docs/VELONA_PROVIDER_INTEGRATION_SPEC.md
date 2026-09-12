# Velona AI Provider Integration Specification

**File:** `VELONA_PROVIDER_INTEGRATION_SPEC.md`  
**Status:** V1 implementation specification  
**Purpose:** Define the provider adapter that connects Workout Logger’s AI Programmer to Velona without coupling the application’s programming logic to a specific provider.

---

## 1. Scope

This document covers only the provider boundary:

- HTTP request construction
- Authentication
- Model configuration
- Structured JSON output
- Timeout and retry behavior
- Response parsing
- Usage/latency metadata
- Error mapping
- Logging and redaction
- Test strategy

It does not define:

- Workout-programming logic
- Blueprint validation
- Goal interpretation
- Programme persistence
- Lock handling
- Reconciliation decisions

Those remain application responsibilities.

---

## 2. Recommended architecture

```text
AI Programmer Service
        ↓
AIProvider interface
        ↓
VelonaProvider
        ↓
Velona native inference endpoint
        ↓
Raw provider response
        ↓
AI Programmer Service parses and validates output
```

The Velona adapter must not:

- Read or write workout databases
- Load Blueprint data
- Decide exercise selection
- Apply lock rules
- Persist programmes
- Perform autonomous retries beyond the configured bounded policy
- Use Velona memory sessions for programme context

The complete context should be sent explicitly with every request for reproducibility and auditability.

---

## 3. Configuration

Use environment variables or the project’s established configuration mechanism.

Recommended variables:

```env
AI_PROVIDER=velona
VELONA_API_KEY=
VELONA_BASE_URL=https://velona.in/gateway/v1
VELONA_MODEL=
VELONA_TIMEOUT_MS=60000
VELONA_MAX_OUTPUT_CHARS=100000
VELONA_MAX_RETRIES=1
VELONA_TEMPERATURE=0
VELONA_TOP_P=1
VELONA_MAX_TOKENS=
AI_PROGRAMMER_ENABLED=false
AI_PROGRAMMER_DRY_RUN=true
```

### Configuration rules

- `VELONA_API_KEY` is required when the Velona provider is enabled.
- Never commit the API key.
- Never print the API key.
- `VELONA_MODEL` must be explicitly configured after model benchmarking.
- Do not hard-code a model name in source code.
- The provider should fail at startup or request time with a clear configuration error if the model is missing.
- Keep `AI_PROGRAMMER_ENABLED=false` until dry-run validation is complete.
- `AI_PROGRAMMER_DRY_RUN=true` should prevent programme persistence.

The exact environment-variable naming may be adapted to existing project conventions.

---

## 4. Velona endpoint

The recommended V1 integration uses Velona’s native inference endpoint:

```text
POST https://velona.in/gateway/v1/inference/run
```

Expected request structure:

```json
{
  "model": "configured-model-id",
  "turns": [
    {
      "role": "system",
      "content": "Fixed AI Programmer constitution..."
    },
    {
      "role": "user",
      "content": "Request metadata and serialized context..."
    }
  ],
  "stream": false,
  "config": {
    "temperature": 0,
    "max_tokens": 12000,
    "top_p": 1
  },
  "output": {
    "format": "json"
  }
}
```

The exact model ID, maximum output token limit, and supported configuration values must be confirmed against the selected Velona model before production use.

### Request rules

- `stream` must be `false` for V1.
- Use `output.format = "json"` where supported.
- Use temperature `0` or the lowest supported deterministic setting.
- Include the fixed constitution in the system turn.
- Include the request and context envelope in the user turn.
- Do not rely on provider-side memory.
- Do not include secrets or unnecessary personal data.
- Do not include raw database credentials, internal file paths, or SQL statements.
- Do not ask the model to return Markdown or explanatory prose outside the JSON object.

---

## 5. Prompt separation

### System turn

The system turn contains immutable application-owned instructions:

- AI is the sole workout programmer.
- Aesthetics/physique is the primary objective.
- Athletic capability and endurance support the primary objective unless explicitly prioritized.
- Active user goals determine additional emphasis.
- Blueprint variations are valid by definition.
- Package references are not eligibility gates.
- Authored per-session set caps must be respected.
- Equipment and time availability are not normal-generation filters.
- Calendar weeks are reporting boundaries, not automatic volume-reset or debt boundaries.
- No missed-set debt.
- Completed, in-progress, locked, and user-protected sessions are immutable.
- Return only the requested JSON contract.
- Never invent IDs.
- Never output hidden reasoning or chain-of-thought.

### User turn

The user turn contains dynamic data:

- Request mode
- Target week
- Context version
- Goals
- Weekly routine
- Blueprint catalogue
- Training history
- Existing programme
- Immutable day records
- Reconciliation requirements
- Output schema instructions
- Any bounded user notes

Dynamic data must be clearly delimited as data. User-entered notes must not be allowed to override the system constitution.

Recommended structure:

```text
REQUEST:
{...}

AUTHORITATIVE CONTEXT:
{...}

OUTPUT CONTRACT:
Return exactly one JSON object conforming to ai-programmer-output.v1.
```

---

## 6. TypeScript provider interface

```ts
export interface AIProgramRequest {
  requestId: string;
  mode: "generate" | "reconcile";
  model: string;
  systemInstruction: string;
  contextPayload: string;
  timeoutMs: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface AIProviderMetadata {
  provider: "velona";
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  providerRequestId?: string;
  billedUsd?: number;
  finishReason?: string;
}

export interface AIProviderResult {
  rawText: string;
  metadata: AIProviderMetadata;
}

export interface AIProvider {
  generateProgram(
    request: AIProgramRequest
  ): Promise<AIProviderResult>;
}
```

The provider returns raw output. JSON parsing and application validation must remain outside the provider.

---

## 7. Native response mapping

Velona’s native response is expected to expose output and metadata in a structure similar to:

```json
{
  "data": {
    "output": "{...JSON string...}",
    "model": "configured-model-id",
    "finish": "stop",
    "usage": {
      "prompt_tokens": 1000,
      "completion_tokens": 2000,
      "total_tokens": 3000
    }
  },
  "meta": {
    "latency_ms": 1500,
    "billed_usd": 0.01
  }
}
```

The adapter must defensively handle:

- Missing `data`
- Missing `data.output`
- `data.output` being a string or supported structured value
- Missing usage metadata
- Missing latency metadata
- Provider error envelopes
- Non-2xx HTTP responses
- Unexpected response shape

Do not assume every response contains billing or token metadata.

---

## 8. Provider implementation skeleton

Create:

```text
src/ai/providers/velonaProvider.ts
```

Illustrative implementation:

```ts
import type {
  AIProvider,
  AIProgramRequest,
  AIProviderResult,
} from "./aiProvider";

interface VelonaResponse {
  data?: {
    output?: unknown;
    model?: string;
    finish?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  meta?: {
    latency_ms?: number;
    billed_usd?: number;
  };
  error?: unknown;
}

export class VelonaProvider implements AIProvider {
  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      defaultModel: string;
      maxOutputChars: number;
    }
  ) {}

  async generateProgram(
    request: AIProgramRequest
  ): Promise<AIProviderResult> {
    const startedAt = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs
    );

    try {
      const response = await fetch(
        `${this.config.baseUrl}/inference/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model || this.config.defaultModel,
            turns: [
              {
                role: "system",
                content: request.systemInstruction,
              },
              {
                role: "user",
                content: request.contextPayload,
              },
            ],
            stream: false,
            config: {
              temperature: request.temperature ?? 0,
              top_p: request.topP ?? 1,
              ...(request.maxTokens
                ? { max_tokens: request.maxTokens }
                : {}),
            },
            output: {
              format: "json",
            },
          }),
          signal: controller.signal,
        }
      );

      const body = (await response.json()) as VelonaResponse;

      if (!response.ok) {
        throw new VelonaProviderError(
          "AI_PROVIDER_HTTP_ERROR",
          `Velona returned HTTP ${response.status}`,
          {
            status: response.status,
            providerError: sanitizeProviderError(body.error),
          }
        );
      }

      const rawOutput = body.data?.output;

      if (rawOutput === undefined || rawOutput === null) {
        throw new VelonaProviderError(
          "AI_PROVIDER_EMPTY_OUTPUT",
          "Velona response did not contain data.output."
        );
      }

      const rawText =
        typeof rawOutput === "string"
          ? rawOutput
          : JSON.stringify(rawOutput);

      if (rawText.length > this.config.maxOutputChars) {
        throw new VelonaProviderError(
          "AI_PROVIDER_OUTPUT_TOO_LARGE",
          "Velona output exceeded configured size limit."
        );
      }

      return {
        rawText,
        metadata: {
          provider: "velona",
          model:
            body.data?.model ??
            request.model ??
            this.config.defaultModel,
          latencyMs:
            body.meta?.latency_ms ??
            Date.now() - startedAt,
          promptTokens: body.data?.usage?.prompt_tokens,
          completionTokens: body.data?.usage?.completion_tokens,
          totalTokens: body.data?.usage?.total_tokens,
          billedUsd: body.meta?.billed_usd,
          finishReason: body.data?.finish,
        },
      };
    } catch (error) {
      if (error instanceof VelonaProviderError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new VelonaProviderError(
          "AI_PROVIDER_TIMEOUT",
          "Velona request timed out."
        );
      }

      throw new VelonaProviderError(
        "AI_PROVIDER_NETWORK_ERROR",
        "Velona request failed.",
        { cause: sanitizeError(error) }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

This is a starting skeleton. Before merging, adapt it to the repository’s HTTP, configuration, logging, and error conventions.

---

## 9. Authentication

Use:

```http
Authorization: Bearer <VELONA_API_KEY>
```

The API key must be read server-side only.

Never:

- Send the key to the browser
- Include it in programme records
- Include it in error messages
- Include it in request/response logs
- Include it in test fixtures
- Commit it to Git
- Put it into AI context

If the provider uses a different authentication format for the selected endpoint, follow the current provider documentation and update this adapter accordingly.

---

## 10. Retry policy

V1 should use a bounded retry policy.

Recommended behavior:

- No retry for invalid request configuration.
- No retry for authentication failure.
- No retry for schema or semantic output failure at the provider layer.
- One retry for transient network failure, HTTP 408, HTTP 429, or selected 5xx responses.
- Respect `Retry-After` when provided, subject to a maximum delay.
- Do not retry indefinitely.
- Do not duplicate persistence because provider calls are not persistence operations.

Separate provider retries from output-correction retries:

```text
Provider transient failure
  → bounded transport retry

Valid HTTP response but invalid AI JSON
  → optional one-time correction request at service layer

Still invalid
  → fail without persistence
```

Do not combine these into an uncontrolled loop.

---

## 11. Error mapping

Suggested provider errors:

```ts
export class VelonaProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "VelonaProviderError";
  }
}
```

Suggested codes:

| Code | Meaning |
|---|---|
| `AI_PROVIDER_CONFIGURATION_ERROR` | Missing or invalid provider configuration |
| `AI_PROVIDER_AUTH_ERROR` | Authentication rejected |
| `AI_PROVIDER_HTTP_ERROR` | Non-success HTTP response |
| `AI_PROVIDER_RATE_LIMITED` | Rate limit exceeded |
| `AI_PROVIDER_TIMEOUT` | Request timed out |
| `AI_PROVIDER_NETWORK_ERROR` | Network or transport failure |
| `AI_PROVIDER_EMPTY_OUTPUT` | No model output returned |
| `AI_PROVIDER_OUTPUT_TOO_LARGE` | Output exceeds configured limit |
| `AI_PROVIDER_INVALID_RESPONSE` | Unexpected provider response shape |

The service layer should map provider errors to user-safe API responses without exposing provider secrets or raw upstream payloads.

---

## 12. Logging and observability

Log metadata, not sensitive payloads by default.

Recommended fields:

- Request ID
- Provider
- Model
- Mode
- Target week
- Context version
- Programme base version
- HTTP status
- Latency
- Prompt/completion/total tokens
- Billed cost, if supplied
- Finish reason
- Retry count
- Validation result
- Error code

Avoid logging the full context or raw model output in production unless:

- Explicitly enabled for controlled debugging
- Sensitive fields are redacted
- Retention is defined
- Access is restricted

Recommended audit storage:

- Context hash
- Output hash
- Truncated diagnostic sample only when safe
- Full payloads only in a protected debugging store, if needed

---

## 13. Request idempotency and concurrency

The provider call itself does not modify application state, but duplicate generation requests can produce conflicting proposals.

At the application level:

- Generate a unique `requestId`.
- Include a context hash.
- Record the base programme version.
- Do not apply a proposal if the programme version changed after generation.
- Re-read current programme state before persistence.
- Use a transaction for the final apply operation.
- Treat duplicate requests as separate proposals unless an explicit idempotency key is implemented.

For reconciliation, the `base_programme_version` must match the currently persisted version at apply time.

---

## 14. Model selection policy

Do not choose the production model solely by advertised price or context window.

Benchmark candidate models using representative anonymized contexts:

- Small context with limited history
- Normal context with current programme and recent history
- Large context with longer historical aggregates
- Generate mode
- Reconcile mode
- Blueprint variation selection
- Authored set-cap compliance
- Locked-session preservation
- JSON validity
- Latency
- Cost
- Consistency across repeated runs

Score:

1. Structural validity
2. Blueprint referential accuracy
3. Rule compliance
4. Programming quality
5. Reconciliation correctness
6. Latency
7. Cost

Keep the model configurable so switching models does not require code changes.

---

## 15. Testing strategy

### Unit tests

Mock `fetch` and test:

- Correct endpoint
- Correct authorization header
- Correct request body
- System and user turns
- `stream: false`
- JSON output format
- Configured model
- Timeout abort
- Successful output extraction
- Structured output conversion
- Missing output
- Non-2xx response
- Authentication failure
- Rate limit response
- 5xx response
- Oversized output
- Missing usage metadata
- Missing billing metadata
- Error redaction

### Contract tests

Use a recorded or mocked provider response to verify:

- Native response mapping
- Token metadata mapping
- Latency mapping
- Finish reason mapping
- Provider error mapping

Do not place real API keys in tests.

### Integration tests

With a fake provider:

- Valid response reaches schema validation.
- Invalid JSON is rejected.
- Invalid Blueprint IDs are rejected.
- Immutable-day changes are rejected.
- Dry-run produces no persistence.
- Provider failure leaves existing programme unchanged.
- Stale programme version prevents apply.

### Optional live smoke test

Run manually or in a protected environment only:

- Use a real API key from environment configuration.
- Use a small, anonymized context.
- Do not persist the result automatically.
- Record latency and output validity.
- Do not run on every CI build.

---

## 16. Feature-flag rollout

Recommended states:

### State 1: Disabled

```env
AI_PROGRAMMER_ENABLED=false
```

Existing deterministic behavior remains active.

### State 2: Dry-run

```env
AI_PROGRAMMER_ENABLED=true
AI_PROGRAMMER_DRY_RUN=true
```

The system:

- Builds the real context
- Calls Velona
- Validates output
- Records proposal and validation result
- Does not modify the active programme

### State 3: Shadow comparison

If implemented, compare AI proposal against current deterministic output for diagnostics only. Do not make the deterministic builder a prerequisite or post-processor for AI programming.

### State 4: Controlled apply

```env
AI_PROGRAMMER_ENABLED=true
AI_PROGRAMMER_DRY_RUN=false
```

Only after:

- Provider reliability is acceptable
- Schema validation passes
- Semantic validation passes
- Lock tests pass
- Reconciliation tests pass
- Cost and latency are understood
- Rollback is verified

---

## 17. Definition of done

The Velona adapter is complete when:

- Configuration is externalized.
- API keys remain server-side and redacted.
- Native inference requests are correctly constructed.
- JSON output mode is enabled.
- Model selection is configurable.
- Timeouts are enforced.
- Retries are bounded.
- Provider errors are typed and sanitized.
- Output size is limited.
- Usage and latency metadata are captured.
- No provider memory session is used.
- No database access occurs in the provider.
- Unit and integration tests pass.
- Dry-run mode works without persistence.
- The adapter is behind a feature flag.
