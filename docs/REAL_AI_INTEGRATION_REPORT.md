# Real AI Integration Report — Velona

Spec: `docs/DEV_CORRECTION_REAL_VELONA_AI_INTEGRATION_AND_NPM_AUDIT.md`, Part 2.

Acceptance criterion: *"After deployment, clicking Generate must trigger
a real external Velona API request and display a workout generated from
Velona's response."*

---

## 0. What was already there vs. what this pass changed

**Inspection findings** (per spec §2.2, `git grep` for
`VELONA|OPENAI|ANTHROPIC|CLAUDE|OPENROUTER|GEMINI|API_KEY|BASE_URL|MODEL|fetch`
across the repo, and direct reading of every AI-related file):

1. **A real external HTTP call path already existed**, not a mock: `POST
   /api/ai-programmer/generate-session` → `AIProgrammerService.generateSession`
   → `VelonaProvider.generate()` → `fetch(`${baseUrl}/inference/run`, ...)`.
   This was never a fake `generate()` returning local data — the plumbing
   (context building, structural schema validation, domain validation,
   persistence, error taxonomy) was already real and solid.
2. **The one thing that WAS wrong**: the exact request/response contract
   `VelonaProvider` sent had never been confirmed against Velona's real
   API — it was written to a guessed shape. You confirmed this directly:
   the guessed shape was wrong, but the base URL
   (`https://velona.in/gateway/v1`) was correct.
3. **The frontend Generate button already reached the backend for real**
   (`public/program.html`'s `onGenerate()` → `POST /api/ai-programmer/generate-session`
   → `GET /api/ai-programmer/proposals/:id`), with a loading state, error
   display, and no static-snapshot substitution. No frontend changes were
   needed.
4. **The API key was already server-side only**: read via
   `process.env.VELONA_API_KEY` inside `loadVelonaConfig()`, sent only as
   an `Authorization: Bearer` header in the backend's own outbound
   `fetch` call, never present in any HTML/JS served to the browser.
   Confirmed by the existing `safeLogFields` test asserting the key never
   appears in logged fields.
5. **Missing configuration already failed clearly**: `loadVelonaConfig()`
   throws `AIProviderConfigurationError` (500, `AI_PROVIDER_CONFIGURATION_ERROR`)
   if `VELONA_API_KEY` or `VELONA_MODEL` is unset — no silent fallback to
   deterministic generation existed anywhere in this path.
6. **`.env.example` did not exist** before this pass — created now.

So this pass's real work was narrower than the spec's framing suggests:
**confirm and correct the wire contract**, not build the integration
from scratch. The one hard requirement that legitimately needed new
work — model selection from a live catalogue — is covered in §4 below.

---

## 1. Confirming the real contract (live, unauthenticated probes)

Before writing any code, I made two live HTTP calls to the real Velona
gateway (no API key used or required for either):

```bash
$ curl -sS -i "https://velona.in/gateway/v1/models"
HTTP/2 200
content-type: application/json
{"request_id":"req_babfe1387f38","status":"success","data":{"models":[...445 models...]}}

$ curl -sS -i -X POST "https://velona.in/gateway/v1/inference/run" \
    -H "Content-Type: application/json" \
    -d '{"model":"anthropic/claude-sonnet-5","turns":[{"role":"user","content":"hi"}],"stream":false}'
HTTP/2 401
{"request_id":"req_unknown","status":"error","error":{"code":"INVALID_KEY","message":"Missing Authorization header","docs":"https://velona.in/docs/errors#INVALID_KEY"},"meta":{"timestamp":"2026-09-13T11:29:00.914908Z"}}
```

This confirmed, against the real service (not the spec's example, though
it matches closely):

- `GET /models` is real, reachable, unauthenticated, and returns a live
  445-model catalogue.
- `POST /inference/run` is real and rejects an unauthenticated request
  with exactly the documented error shape: `{request_id, status: "error",
  error: {code, message, docs}}` at HTTP 401.
- The base URL `https://velona.in/gateway/v1` is correct.

No inference call with a real result was possible without a real key —
see §9 (live smoke test) for why that step is explicitly deferred to you.

---

## 2. Files changed

| File | Change |
|---|---|
| `src/ai-programmer/provider/config.ts` | Added `temperature`/`maxTokens` to `VelonaConfig`, loaded from `VELONA_TEMPERATURE`/`VELONA_MAX_TOKENS` (defaults 0.2/4096, matching Velona's own documented example), each independently validated with a clear config error. `VELONA_BASE_URL` default unchanged (confirmed real). |
| `src/ai-programmer/provider/velonaProvider.ts` | Corrected `VelonaResponseBody` to the confirmed real shape (`request_id`, `status`, `data.run_id`, `meta.timestamp`, `error.{code,message,docs}`). Request `config` now sends `{temperature, max_tokens}` (was `{temperature: 0, top_p: 1}` — a guessed field Velona doesn't document). Added `describeVelonaError()` to surface the real upstream `error.code`/`message` in thrown errors (never a secret) instead of a bare HTTP status. Added explicit `402` (insufficient credits) handling. Added a check for `payload.status === 'error'` even under an HTTP 200 (a gateway can report an application-level failure that way). **Wired `safeLogFields` into actual logging** (`console.log`/`warn`/`error` on request success/retry/final-failure) — this helper existed and was tested but was dead code before this pass; it is now how you inspect provider-call success/failure in production logs (§8). |
| `.env.example` | Created (did not exist before). Documents all variables including the full `VELONA_*` set, with the feature defaulting to off. |
| `ops/workout-logger.env.example` | Removed the now-false "No API keys or LLM secrets exist in this application" claim; added the real `AI_PROGRAMMER_ENABLED`/`VELONA_*` block, defaulting to off. |
| `docs/deployment.md` | Removed the now-false "no API keys or third-party secrets" claim; added the full variable table and a pointer to this report. |
| `docs/PRODUCTION_DEPLOYMENT.md` | Added the real production configuration snippet (env file addition) and a pointer to this report's operational reference. |
| `tests/ai-programmer/velonaProvider.test.ts` | Updated `VelonaConfig` fixture; added tests for the corrected request config, the real documented error body (401/402/422), an application-level error under HTTP 200, and log-based API-key-safety. |
| `tests/ai-programmer/velonaConfig.test.ts` | **New** — `loadVelonaConfig`/`isAiProgrammerEnabled` had zero test coverage before this pass. 11 tests: missing-key/model/invalid-numeric-var failures, defaults, and full override behavior. |

**Not changed**: `src/ai-programmer/contracts/*`, `src/ai-programmer/validation/*`,
`src/ai-programmer/service/*`, `src/server/routes/aiProgrammer.ts`,
`public/program.html`. These were already real, already correct, and
already provider-agnostic in exactly the way that let this pass be a
provider-contract correction rather than a rebuild.

---

## 3. Answers to the required questions

1. **Which provider is integrated?** Velona (`https://velona.in`), a
   multi-model inference gateway — confirmed real via live HTTP probes
   above, not invented.
2. **What exact API/SDK is used?** No SDK — native `fetch` over HTTPS
   against Velona's own documented REST contract, consistent with this
   codebase's existing convention (no other HTTP client library is used
   anywhere in this repo).
3. **What exact endpoint is called?** `POST {VELONA_BASE_URL}/inference/run`
   (default `https://velona.in/gateway/v1/inference/run`). Model
   discovery (`GET {VELONA_BASE_URL}/models`) was called live during
   implementation to select a model (§4) but is not called at request
   time — the selected model is configured once via `VELONA_MODEL`.
4. **What model is used?** `VELONA_MODEL` is a required, explicit
   environment variable with **no hard-coded default** — see §4 for the
   recommended value and why.
5. **What backend route calls it?** `POST /api/ai-programmer/generate-session`
   (`src/server/routes/aiProgrammer.ts`).
6. **What service/function makes the external request?**
   `VelonaProvider.generate()` (`src/ai-programmer/provider/velonaProvider.ts`),
   invoked from `AIProgrammerService.generateSession()` via
   `createDefaultAIProgrammerService()`'s default wiring.
7. **What environment variables are required?** `AI_PROGRAMMER_ENABLED=true`
   to turn the feature on at all; then `VELONA_API_KEY` and `VELONA_MODEL`
   (both required, no default, clear config error if missing). Optional:
   `VELONA_BASE_URL` (defaults to the real gateway), `VELONA_TIMEOUT_MS`,
   `VELONA_MAX_RETRIES`, `VELONA_TEMPERATURE`, `VELONA_MAX_TOKENS`.
8. **Where is the API key configured?** Server-side only, via
   `process.env.VELONA_API_KEY` — in production, in the VM's systemd
   `EnvironmentFile` (see §7); never in the Git checkout, `.env.example`
   (placeholders only), or any file this repo tracks.
9. **Is the key server-side only?** Yes — read once in
   `loadVelonaConfig()`, used once as an outbound `Authorization: Bearer`
   header inside the backend's own `fetch` call. It is never part of any
   response sent to the frontend and never appears in a log line
   (`safeLogFields` + a dedicated test asserting this).
10. **What happens when the key is missing?** `AIProviderConfigurationError`
    (500, code `AI_PROVIDER_CONFIGURATION_ERROR`, message "VELONA_API_KEY
    is not set.") — thrown before any network call is attempted.
11. **What happens when Velona fails?** Mapped by failure type, all
    typed `AIProgrammerError` subclasses the route already converts to a
    safe JSON error (no raw provider payload, no stack trace, no
    secret):
    - `401`/`403` → `AIProviderAuthenticationError` (502), never retried.
    - `402` → `AIProviderUnavailableError` (502) with the real
      `error.code`/`message` surfaced (e.g. insufficient credits), never
      retried.
    - `429` → `AIProviderRateLimitedError` (429), retried up to
      `VELONA_MAX_RETRIES` times honoring `Retry-After`.
    - `408`/`5xx` → `AIProviderUnavailableError` (502), retried.
    - Any other non-2xx, or an HTTP-200 body with `status: "error"` → `AIProviderInvalidResponseError`
      (502) with the upstream code/message surfaced.
    - Network failure → retried, then `AIProviderUnavailableError`.
    - Timeout (`VELONA_TIMEOUT_MS`) → `AIProviderTimeoutError` (504),
      never retried.
    - None of these paths fall back to deterministic generation or
      fabricate an "AI" result — the route returns the error to the
      frontend, which shows it and does not substitute anything.
12. **What response path is parsed?** `response.data.output` (a string
    or, if the gateway returns structured JSON directly, stringified
    then re-parsed) — never the OpenAI-shaped `choices[0].message.content`.
13. **What schema validates the AI response?** The pre-existing,
    unchanged pipeline: `validateProposalSchema()` (structural — every
    required field, type, and enum in `getProgrammerOutputSchema()`) then
    `validateProposalDomain()` (domain — exercise IDs must exist in the
    real Blueprint catalogue for the request's own targets, authored
    prescriptions are fidelity-checked, target/goal IDs must exist in the
    supplied context). Both were already real (not new to this pass);
    neither trusts raw provider text as data.
14. **How are exercise IDs validated?** `validateProposalDomain()` cross-
    checks every `exerciseId` in the response against
    `context.targets[].validExercises` built from the real Blueprint
    snapshot for this request — an id the model invents that isn't in
    that set fails domain validation and the whole proposal is rejected
    (`AIOutputDomainInvalidError`, 502), never partially persisted.
15. **How does the Generate button reach Velona?** `program.html`'s
    `onGenerate()` → `POST /api/ai-programmer/generate-session` → the
    chain in Q5/Q6 → the real `fetch` in `VelonaProvider.attemptOnce()`.
    Confirmed by reading the actual button handler (`public/program.html:582`),
    not inferred from naming.
16. **How is the generated workout persisted?** Unchanged, pre-existing
    flow: a validated proposal is written to `ai_program_proposals` by
    `AIProposalRepo.create()` inside `generateSession()` — only after
    both schema and domain validation pass. It becomes an actual planned
    `workout_sessions` row only on a separate, explicit
    `POST /api/ai-programmer/proposals/:id/commit` (approve → commit),
    which this pass did not touch.
17. **What tests prove the integration?** See §5.
18. **What exact manual smoke test was completed?** The two live,
    unauthenticated HTTP probes in §1 (confirmed the endpoints, base URL,
    and exact error contract are real) plus the full mocked test suite in
    §5. **No authenticated inference call was made** — see §9.
19. **Was the test performed with a real API key and real provider
    response?** **No.** Per your explicit instruction, I do not have and
    should not use a real `VELONA_API_KEY` for your application's own
    Velona account — this coding session's own credentials (if any) are
    for an unrelated product and would be the wrong account/billing
    entirely. This is flagged, not silently skipped — see §9 for exactly
    what remains and how to complete it yourself.
20. **What remains incomplete?** Only the authenticated, end-to-end live
    smoke test (§9) — everything else in the required acceptance
    criteria is implemented, tested with mocks, and verified.

---

## 4. Model selection (from the live catalogue, not invented)

Per spec §2.4, I called the real `GET https://velona.in/gateway/v1/models`
endpoint (no auth required) and inspected the actual response — 445
models across 60+ providers, each with `id`, `name`, `provider`, `type`,
`context_window`, `pricing`, and `capabilities` (`streaming`/`text`/`moderated`
only — the catalogue does not separately flag structured-JSON support;
Velona's `output.format: "json"` request field is presumably applied at
the gateway level across models).

**Recommended: `anthropic/claude-sonnet-5`**

| Criterion | Value |
|---|---|
| Context window | 1,000,000 tokens — far more than this app's context payload needs |
| Pricing | $2.00 / $10.00 per 1M input/output tokens — mid-tier, not the cheapest or most expensive in the catalogue |
| Capabilities | `streaming`, `text`, `moderated` |
| Why this one | Strong instruction-following for a task with many hard constraints (exact exercise-ID matching, authored-prescription fidelity, JSON-only output, no invented IDs) at a reasonable cost; ample context headroom for this app's full training-context payload |

This is a **recommendation set via `.env.example`, not a hard-coded
default** — `loadVelonaConfig()` still throws if `VELONA_MODEL` is unset,
exactly as before this pass. You (or a future session) can point
`VELONA_MODEL` at any other id from the live catalogue — e.g.
`anthropic/claude-opus-5` (higher quality, $5/$25) or
`anthropic/claude-haiku-4.5` ($1/$5, cheaper, likely lower programming
quality) — with no code change.

---

## 5. Tests

```bash
npm test -- velonaProvider velonaConfig aiProgrammer aiProposalRoutes
```

**102 tests, 5 files, all passing.**

- **Configuration tests** (`tests/ai-programmer/velonaConfig.test.ts`,
  new, 11 tests): missing `VELONA_API_KEY` fails clearly; missing
  `VELONA_MODEL` fails clearly; invalid `VELONA_TIMEOUT_MS`/`MAX_RETRIES`/
  `TEMPERATURE`/`MAX_TOKENS` each fail clearly; `isAiProgrammerEnabled()`
  is `true` only for the exact string `"true"`; every value (including
  the new temperature/maxTokens) is independently overridable via its
  own env var with correct documented defaults otherwise.
- **Provider client tests** (`tests/ai-programmer/velonaProvider.test.ts`,
  20 tests, 6 new/updated for this pass): correct endpoint, **HTTP
  method** (now explicitly asserted), Authorization header, request body
  (`model`, `turns`, `stream: false`, `output.format: "json"`, and now
  `config.temperature`/`config.max_tokens` matching the confirmed real
  contract); successful response read from `data.output`; the real
  documented error body (`{status:"error", error:{code,message}}`)
  surfaced correctly at 401/402/422 and even under an HTTP 200; provider
  errors (401/403/429/5xx/402/other 4xx), timeouts, and network failures
  each mapped to the correct typed error; malformed (non-JSON) output
  rejected; **API key never appears in any `console.log`/`warn`/`error`
  call** (new test, exercising the newly-wired logging).
- **Generate route tests** (`tests/ai-programmer/aiProgrammerRoute.test.ts`,
  `aiProgrammerService.test.ts`, `aiProposalRoutes.test.ts` — pre-existing,
  unmodified, 71 tests, all still passing after this pass's provider/config
  changes): the frontend request reaches the backend route; the backend
  calls the provider client; the response is parsed/validated; a valid
  response is persisted, an invalid one is not; the response identifies
  `provider: "velona"`; a provider failure never falls back to
  deterministic output — it returns the typed error and creates no
  proposal record (`POST /api/ai-programmer/generate-session — persistence
  > a provider failure creates no proposal record`, pre-existing and
  still enforced).

**Full regression suite**: `npm run verify` (build + typecheck + test) —
**103 test files, 1189 tests, all passing**, 0 regressions from this
pass's changes.

---

## 6. Preserving Blueprint/session-safety rules (§2.7)

Unchanged in this pass, and already real: exercise selection is
constrained to `context.targets[].validExercises` from the actual
Blueprint snapshot (domain validation rejects any invented id); the
context always carries the user's real active goals in their real
priority order; the pre-existing write-time guard
(`findActiveGymSessionConflict`) and the `resolveSelectedSession`
resolver (from this session's earlier phases) are untouched and still
enforce no-duplicate-active-planned-session and no-same-day-replacement-
over-completed/in-progress exactly as before — this pass touches only the
provider's HTTP contract and its own configuration, never the scheduling/
conflict/session-identity logic.

---

## 7. Deployment (Oracle VM, not Cloud Run)

This repository's actual, documented production target is an Oracle
Cloud Always Free VM running the app as a systemd service
(`docs/PRODUCTION_DEPLOYMENT.md`, `docs/POST_DEPLOYMENT_COMPLETION_REPORT.md`)
— **not** Cloud Run (Cloud Run was explicitly rejected earlier in this
project for this app's SQLite-on-persistent-disk requirement; see
`docs/deployment.md`'s "SQLite caveat" section). Everything below is
written for the real target.

**To enable the integration on the production VM:**

```bash
# On the VM, edit the real EnvironmentFile (see docs/PRODUCTION_DEPLOYMENT.md
# §17 for its exact path in your deployment; ops/workout-logger.env.example
# is the template):
sudo nano /etc/workout-logger.env
```

Add:

```
AI_PROGRAMMER_ENABLED=true
VELONA_API_KEY=<your real Velona API key — never in Git, never in chat>
VELONA_MODEL=anthropic/claude-sonnet-5
```

Then restart the service so it picks up the new environment:

```bash
sudo systemctl restart workout-logger
sudo systemctl status workout-logger
```

**How to verify configuration without printing the secret:**

```bash
# Confirms the key is SET without ever displaying its value:
sudo grep -q '^VELONA_API_KEY=.\+' /etc/workout-logger.env && echo "VELONA_API_KEY is set" || echo "MISSING"
sudo grep '^VELONA_MODEL=' /etc/workout-logger.env   # safe to print — not a secret
```

**How to test the Generate button** (after restart): open the deployed
app → Program → a future gym day → "Generate AI Workout Proposal". A
missing/invalid key surfaces immediately as a visible error in that same
UI (via the existing error handling in `onGenerate()`) — it will never
silently show a deterministic plan and call it AI-generated.

**How to inspect logs for provider-call success/failure**: this pass
wired `safeLogFields` (previously dead code) into real logging inside
`VelonaProvider.generate()`. On the VM:

```bash
sudo journalctl -u workout-logger -f | grep '\[velona\]'
```

- Success: `[velona] request succeeded {requestId, provider: "velona", model, baseUrl, attempt, resolvedModel}`
- Retry: `[velona] request failed, retrying {..., reason}`
- Final failure: `[velona] request failed {..., reason}`

None of these lines ever contain `VELONA_API_KEY` — enforced by a
dedicated test (§5) that inspects every `console.*` call made during a
success and a failure run.

**How to rotate the key**: generate a new key in your Velona account
dashboard, replace `VELONA_API_KEY` in `/etc/workout-logger.env`,
`sudo systemctl restart workout-logger`. The old key can then be revoked
in the Velona dashboard — the app never caches or persists the key
anywhere outside that one environment variable read at request time.

**How to disable the integration safely**: set `AI_PROGRAMMER_ENABLED=false`
(or remove the line) in `/etc/workout-logger.env` and restart the
service. `isAiProgrammerEnabled()` gates every AI-programmer route
(`generate-session`, and — per the existing Phase 2 `requireEnabled()`
guard — proposal retrieval/approve/commit too), so this fully and
immediately turns the feature off without touching `VELONA_API_KEY` at
all.

---

## 8. What "done" actually means here vs. what's left

Per the final acceptance criteria list, everything is satisfied **except**
the authenticated live smoke test:

- ✅ Velona is the actual, confirmed-real provider (not invented).
- ✅ The real endpoint (`/inference/run`) and the real error/response
  contract are implemented, corrected from the original guess.
- ✅ A real model was selected from Velona's own live catalogue and
  documented (§4), not invented.
- ✅ The API key is configured securely, server-side only, with a clear
  error when missing.
- ✅ The Generate button reaches the backend, which makes a real
  external Velona request when configured.
- ✅ The response is parsed from the correct path (`data.output`) and
  validated (structural + domain, pre-existing and unchanged).
- ✅ Persistence only happens after validation passes.
- ✅ Provider failures are visible, typed, and never silently become
  fake AI output.
- ✅ Automated tests cover the full integration path (102 tests across
  config/provider/route/service, all mocked — no real key used or
  needed for these).

## 9. Explicitly flagged: the live smoke test was NOT run

Per your own instruction ("flag this issue and don't run the test"),
**no authenticated call to Velona was made**, and none of this report's
claims should be read as implying one was. Specifically NOT done:

1. An actual `POST /inference/run` with a real `VELONA_API_KEY` and real
   `VELONA_MODEL`.
2. Confirming a real generated workout renders correctly in the deployed
   UI end-to-end.
3. Confirming the persisted proposal round-trips correctly against a
   real (not mocked) Velona response shape in the wild — the mocked
   tests assert against the *documented* shape confirmed live in §1, but
   a real inference response's exact `data.output` JSON content (as
   opposed to its envelope) has not been observed.

This is deliberate, not an oversight: I do not have a Velona API key for
your application's account, and using this coding session's own
Anthropic credentials (if any exist in this environment) would be the
wrong account entirely — unrelated product, unrelated billing, and not
something you asked for or should want. **You should run this smoke test
yourself** once `VELONA_API_KEY`/`VELONA_MODEL` are set on the production
VM (§7), following the 8 steps in the spec's §2.9 "Real-provider smoke
test" section (open the app, click Generate, confirm the backend
request, confirm the external Velona request, confirm Velona's response,
confirm the UI shows that response, confirm persistence, confirm logs
don't expose the key — the last of which §7's log-inspection command
covers).
