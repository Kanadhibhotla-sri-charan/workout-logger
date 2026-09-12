# AI Programmer Integration — Status (First Vertical Slice)

Implements the first milestone of `docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md`: an AI-generated future-session proposal flow with explicit context, Velona provider integration, schema validation, domain validation, and safe non-destructive persistence boundaries.

## What exists today

- A provider-independent AI programmer layer (`src/ai-programmer/`).
- A real context builder that reuses the existing deterministic engine's own data (`assembleWeeklyPlanInput`, `recoveryEngine`, `exerciseSelector`, `BlueprintAdapter`, `developmentPackages`) — it never re-derives exposure/history/recovery calculations.
- A native Velona HTTP provider adapter, feature-flagged off by default.
- Two-layer validation (structural schema, then Blueprint/domain/lock validation) — a proposal must pass both before it is ever returned.
- One endpoint: `POST /api/ai-programmer/generate-session`.

## What does NOT exist yet (explicitly out of scope for this milestone)

- Full-week AI generation or reconciliation.
- Any endpoint that persists an AI proposal into `program_sessions`/`workout_sessions` (a future `POST /api/ai-programmer/commit-session-proposal` is the documented next step — see `docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md` §12).
- Automatic replacement of the deterministic engine (`src/engine/workoutBuilder.ts`) anywhere in the existing `/api/programming/*` routes — those are completely untouched.
- Outside-Blueprint exercises in AI proposals (Blueprint-only for this milestone).
- Streaming responses, provider-side memory/conversation threads, fine-tuning, automatic exercise creation, or automatic outside-Blueprint approval.

**The endpoint returns a validated proposal only. It never silently rewrites an existing program.**

## Required environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AI_PROGRAMMER_ENABLED` | no | unset (disabled) | Must be exactly `"true"` to enable the endpoint at all. Any other value (including unset) makes every request return `503 AI_PROGRAMMER_DISABLED` before the provider is ever called. |
| `VELONA_API_KEY` | yes, when enabled | — | Never logged, never included in any response, never committed. Read server-side only. |
| `VELONA_MODEL` | yes, when enabled | — | No default — a production model must be explicitly chosen and configured, never hard-coded in source. |
| `VELONA_BASE_URL` | no | `https://velona.in/gateway/v1` | Velona's native inference gateway. |
| `VELONA_TIMEOUT_MS` | no | `60000` | Request timeout; a timeout is never retried. |
| `VELONA_MAX_RETRIES` | no | `1` | Bounded retries for transient failures only (network error, HTTP 408/429/5xx) — never for authentication failures or malformed requests. |

## Local development / testing without a real Velona key

Every test in `tests/ai-programmer/` runs without any real API key:

- Context-builder and domain-validator tests use a real in-memory SQLite database and the real Blueprint snapshot, but never call the network.
- Provider tests (`tests/ai-programmer/velonaProvider.test.ts`) mock Node's global `fetch`.
- Route tests (`tests/ai-programmer/aiProgrammerRoute.test.ts`) mock global `fetch` and drive the real Express app via `supertest`.

To exercise the endpoint manually against a mocked provider, set `AI_PROGRAMMER_ENABLED=true`, `VELONA_API_KEY`/`VELONA_MODEL` to any placeholder value, and point `VELONA_BASE_URL` at a local stub server that returns a `data.output` JSON string conforming to the schema in `src/ai-programmer/contracts/programmerTypes.ts`.

## Enabling / disabling AI generation

- **Disabled (default):** omit `AI_PROGRAMMER_ENABLED`, or set it to anything other than `"true"`. Every request to the endpoint returns `503 { ok: false, error: "AI_PROGRAMMER_DISABLED" }` immediately — no context is built, no provider call is made.
- **Enabled:** set `AI_PROGRAMMER_ENABLED=true` and configure `VELONA_API_KEY`/`VELONA_MODEL`. The existing deterministic `/api/programming/*` routes are completely unaffected either way — this is an entirely separate, additive endpoint.

## Endpoint

### `POST /api/ai-programmer/generate-session`

Request:

```json
{
  "targetDate": "2026-09-20"
}
```

`targetDate` is required and must be:

- shaped exactly as `YYYY-MM-DD`;
- a real calendar date (e.g. `2026-02-31` or `2026-04-31` are rejected — not silently normalized into a different date);
- a still-editable date — today or a future date, with no completed/in-progress workout session already logged for it.

**Timezone (correction pass §5, Option A):** there is no request-level `timezone` field. The user's own stored `TrainingProfile.timezone` is the single authoritative timezone for every date-sensitive operation in a request — current-date calculation, weekday derivation, editability, and the context's own `timezone` field. Sending a `timezone` field in the request body is rejected with `400` rather than silently ignored, so a caller never assumes an override took effect that didn't.

Success response (`200`):

```json
{
  "ok": true,
  "proposal": {
    "schemaVersion": "ai-workout-session-proposal.v1",
    "proposalId": "...",
    "mode": "generate_session",
    "targetDate": "2026-09-20",
    "weekday": "sunday",
    "sessionFocus": ["chest"],
    "exercises": [
      {
        "exerciseId": "flat-barbell-bench-press",
        "role": "primary",
        "targetType": "physique_target",
        "targetId": "mid-pec",
        "sets": 3,
        "repsMin": 6,
        "repsMax": 12,
        "rirMin": 1,
        "rirMax": 3,
        "rationale": ["Direct mid-pec exposure."],
        "source": "blueprint"
      }
    ],
    "programmingRationale": ["..."],
    "goalAlignment": [],
    "recoveryConsiderations": [],
    "warnings": []
  },
  "contextHash": "sha256-hex...",
  "provider": "velona",
  "model": "resolved-model-id",
  "requestId": "..."
}
```

Nothing here is persisted. Re-requesting the same date does not create or reuse a stored program row. `proposal.proposalId` is always generated by the application (a fresh UUID per request) — a `proposalId` the model itself returns is discarded, never trusted or echoed back.

### Error responses

| HTTP status | `error` code | Meaning |
|---|---|---|
| 400 | — | `targetDate` missing, not shaped as `YYYY-MM-DD`, or not a real calendar date (e.g. `2026-02-31`) |
| 400 | — | A `timezone` field was included in the request body (not accepted — see Timezone above) |
| 503 | `AI_PROGRAMMER_DISABLED` | `AI_PROGRAMMER_ENABLED` is not `"true"` |
| 500 | `AI_PROVIDER_CONFIGURATION_ERROR` | `VELONA_API_KEY`/`VELONA_MODEL` missing or invalid, or the training profile doesn't exist yet |
| 502 | `AI_PROVIDER_AUTHENTICATION_ERROR` | Velona rejected the configured API key |
| 504 | `AI_PROVIDER_TIMEOUT` | Velona did not respond within `VELONA_TIMEOUT_MS` |
| 429 | `AI_PROVIDER_RATE_LIMITED` | Velona is rate-limiting requests (retries already exhausted) |
| 502 | `AI_PROVIDER_UNAVAILABLE` | Velona returned a transient failure (network error / 5xx / 408) after exhausting retries |
| 502 | `AI_PROVIDER_INVALID_RESPONSE` | Velona's response shape was unexpected (non-2xx other than the above, missing `data.output`, unparsable body) |
| 502 | `AI_OUTPUT_SCHEMA_INVALID` | The model's JSON output failed structural validation |
| 502 | `AI_OUTPUT_DOMAIN_INVALID` | The model's output failed Blueprint/domain validation — unknown exercise/target, a `targetDate`/`weekday` that doesn't match the request, an authored-prescription field (sets/repsMin/repsMax/rirMin/rirMax) that doesn't match Blueprint exactly, role mismatch, etc. |
| 409 | `AI_TARGET_NOT_EDITABLE` | `targetDate` is in the past or already locked by a completed/in-progress workout session |
| 500 | `AI_CONTEXT_INCOMPLETE` | Required application state (e.g. no `TrainingProfile`) is missing |

`AI_OUTPUT_SCHEMA_INVALID`/`AI_OUTPUT_DOMAIN_INVALID`'s `details.issues` array is bounded (correction pass §6): at most 20 issues, each at most 500 characters, and the combined length of every returned string — including any trailing `[truncated]`/omission marker — at most 8,000 characters, a hard cap (the marker is fit within the remaining budget, never appended past it). Bounding only affects what is returned/logged — it never changes whether the underlying proposal was accepted or rejected.

No response ever includes the Velona API key, an authorization header, or a raw upstream payload.

## Provider error troubleshooting

- **"AI_PROGRAMMER_DISABLED"** — set `AI_PROGRAMMER_ENABLED=true`.
- **"AI_PROVIDER_CONFIGURATION_ERROR"** — `VELONA_API_KEY` or `VELONA_MODEL` is not set. Both are required with no default; the model is deliberately never hard-coded.
- **"AI_PROVIDER_AUTHENTICATION_ERROR"** — the configured `VELONA_API_KEY` was rejected (HTTP 401/403). Not retried.
- **"AI_PROVIDER_TIMEOUT"** — increase `VELONA_TIMEOUT_MS` if the configured model is genuinely slow, or check Velona's own status.
- **"AI_PROVIDER_RATE_LIMITED" / "AI_PROVIDER_UNAVAILABLE"** — transient; the provider already retried up to `VELONA_MAX_RETRIES` times before surfacing this.
- **"AI_OUTPUT_SCHEMA_INVALID" / "AI_OUTPUT_DOMAIN_INVALID"** — for debugging prompt/model quality issues, the error's `details.issues` array contains only structured, application-authored validation messages (bounded per §6 above), each naming the specific field and value that failed (e.g. `"exercises[0].sets must equal Blueprint-authored value 3; received 8"`). The raw provider response body/payload is never included — only these derived, size-bounded messages.

## Security

- `VELONA_API_KEY` must never be committed to git, never logged, never included in the AI context sent to the model, and never returned in any API response.
- The AI provider never receives database credentials, and never has direct database access — it receives only the explicit, serialized `AIProgrammerContext` object.
- AI output is treated as untrusted external data end-to-end: it is never executed, never used to construct SQL, and cannot bypass domain/lock validation to modify a completed or locked session.
