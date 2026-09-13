# Dev Instructions: npm Audit Disclosure + Real Velona AI Integration

## Context

Two separate items must be handled:

1. Provide the exact details of all npm audit vulnerabilities.
2. Implement a **real, live Velona AI integration**.

The AI requirement is not satisfied by an abstraction, interface, mock, deterministic generator, static snapshot, seeded response, or future integration point.

### Acceptance criterion

> After deployment, clicking **Generate** must trigger a real external Velona API request and display a workout generated from Velona's response.

---

# Part 1 — npm Audit Vulnerability Disclosure

## 1. Clean installation

From the repository root, run:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
npm ci
```

Use the existing `package-lock.json` for the official locked-install verification.

If `npm ci` fails because the lockfile is inconsistent, document the exact error. Do not silently regenerate or replace the lockfile.

## 2. Run the audit

Run:

```powershell
npm audit
```

Generate a machine-readable report:

```powershell
npm audit --json | Out-File -Encoding utf8 npm-audit-report.json
```

## 3. Individually disclose every finding

For every advisory, provide:

| Field | Required information |
|---|---|
| Advisory/GHSA ID | Exact npm/GitHub advisory ID |
| Package | Vulnerable package name |
| Installed version | Actual installed version |
| Vulnerable range | Exact affected range |
| Fixed version | First fixed version, if available |
| Severity | Low / Moderate / High / Critical |
| Direct/transitive | Direct or transitive dependency |
| Dependency path | Why the package is installed |
| Runtime impact | Whether it affects production runtime |
| Dev-only impact | Whether it is limited to tests/build tooling |
| Fix available | Yes/no |
| Breaking-change risk | Whether fixing requires a major upgrade |
| Recommended action | Fix now, defer, or investigate |

For each affected package, run:

```powershell
npm explain <package-name>
```

## 4. Distinguish the counts

The report must state:

- Number of unique advisories
- Number of affected packages
- Number of direct dependencies
- Number of transitive dependencies
- Severity breakdown
- Production-runtime findings
- Dev/build/test-only findings

Do not report only “8 vulnerabilities” without identifying the actual advisories.

## 5. Check safe fixes

Run:

```powershell
npm audit fix --dry-run
```

Do not run this blindly:

```powershell
npm audit fix --force
```

Do not apply major-version upgrades without approval.

If a safe non-breaking fix exists, identify it. If a fix requires a breaking upgrade, explain the impact and leave it unapplied unless explicitly approved.

## 6. Deliverable

Create or update:

```text
docs/NPM_AUDIT_VULNERABILITY_REPORT.md
```

The report must contain exact findings from the current repository, commands used, relevant results, production impact, and recommended action for each finding.

---

# Part 2 — Implement REAL LIVE Velona AI Integration

## Critical requirement

The application must make a real external AI request when the user clicks **Generate**.

The following do not count as integration:

- AI-related names
- AI-shaped interfaces
- Local deterministic generation
- Mock providers
- Static snapshots
- Seeded AI responses
- Placeholder adapters
- A provider-agnostic abstraction with no real provider behind it
- A fake endpoint
- A fake response
- A local fallback presented as AI output

## Required end-to-end flow

```text
User opens deployed app
    ↓
User clicks Generate
    ↓
Frontend sends request to backend
    ↓
Backend calls Velona API
    ↓
Velona generates the workout/program
    ↓
Backend validates the response
    ↓
Backend persists the generated program/session
    ↓
Frontend displays the generated workout
```

If Velona fails, the app must show an error. It must not silently substitute deterministic output and claim that AI generation succeeded.

---

## 2.1 Confirmed Velona API contract

The native Velona API contract is documented at:

```text
https://www.velona.in/docs
```

### Base URL

```text
https://velona.in/gateway/v1
```

### Inference endpoint

```http
POST https://velona.in/gateway/v1/inference/run
```

### Authentication

```http
Authorization: Bearer <VELONA_API_KEY>
Content-Type: application/json
```

### Request body

Use Velona's documented native request format:

```json
{
  "model": "MODEL_ID",
  "turns": [
    {
      "role": "system",
      "content": "SYSTEM_PROMPT"
    },
    {
      "role": "user",
      "content": "USER_PROMPT"
    }
  ],
  "stream": false,
  "config": {
    "temperature": 0.2,
    "max_tokens": 4096
  },
  "output": {
    "format": "json"
  }
}
```

The exact configuration values may be adjusted based on the selected model, but the request must match Velona's actual documented contract.

Important fields:

- `model`
- `turns`
- `stream`
- `config`
- `output.format`

Use structured JSON output for workout generation.

### Response shape

The successful response is documented with generated content under:

```text
response.data.output
```

A representative shape is:

```json
{
  "request_id": "req_...",
  "status": "success",
  "data": {
    "run_id": "run_...",
    "model": "MODEL_ID",
    "output": "...generated output...",
    "finish": "complete",
    "usage": {
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "total_tokens": 0
    }
  },
  "meta": {
    "latency_ms": 0,
    "billed_usd": 0,
    "timestamp": "..."
  }
}
```

Do not assume the OpenAI-compatible response path:

```text
choices[0].message.content
```

Use the native Velona response path unless the implementation intentionally uses a different documented Velona-compatible endpoint.

### Error shape

Handle documented error responses such as:

```json
{
  "request_id": "req_...",
  "status": "error",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

Handle errors including, where applicable:

- Invalid API key
- Insufficient credits
- Rate limiting
- Upstream provider failure
- Upstream timeout
- Malformed response
- Request timeout
- Network failure

Do not expose raw secrets or sensitive provider details to the frontend.

---

## 2.2 Inspect the current repository before modifying it

Search the repository:

```powershell
git grep -n -i -E "VELONA|OPENAI|ANTHROPIC|CLAUDE|OPENROUTER|GEMINI|API_KEY|BASE_URL|MODEL|fetch|axios|chat.completions|messages.create"
```

Inspect:

- `package.json`
- `.env.example`
- AI/provider/service files
- Backend routes
- Frontend Generate button handler
- Program-generation service
- Persistence layer
- Deployment configuration
- Cloud Run or Oracle VM configuration
- Existing AI documentation

Report explicitly:

1. Whether a real external API call already exists
2. Which provider is currently called
3. Which endpoint is called
4. Which model is used
5. Where the API key is loaded from
6. Whether the key is server-side only
7. Whether clicking Generate reaches the provider
8. Whether the current output is real provider output, local output, mock output, or a persisted snapshot

Do not infer integration from filenames or function names.

---

## 2.3 Implement server-side configuration

Use server-side environment variables:

```text
VELONA_API_KEY=
VELONA_BASE_URL=https://velona.in/gateway/v1
VELONA_MODEL=
```

Requirements:

- `VELONA_API_KEY` must never be exposed to frontend JavaScript.
- The key must never be embedded in HTML.
- The key must never be committed to Git.
- The key must never be logged.
- `.env.example` may contain placeholders only.
- Production secrets must be configured securely on the backend.
- Missing configuration must produce a clear server error:
  `Velona AI provider is not configured`
- Do not silently fall back to deterministic generation.

Do not ask me to paste the API key into chat. I will configure it securely in the deployment environment.

---

## 2.4 Discover and select a real model

Use Velona's documented model discovery endpoint:

```http
GET https://velona.in/gateway/v1/models
```

Do not invent a model identifier.

Inspect the actual returned model list and select a model based on:

- Availability
- Context length
- Structured JSON output support
- Cost
- Latency
- Workout-programming quality

Document the exact selected model in the final report.

---

## 2.5 Implement the actual Velona HTTP call

Implement a real backend provider service using the project's actual framework and conventions.

The resulting request must be equivalent to:

```javascript
const response = await fetch(
  `${VELONA_BASE_URL}/inference/run`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VELONA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: VELONA_MODEL,
      turns: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      stream: false,
      config: {
        temperature: 0.2,
        max_tokens: 4096
      },
      output: {
        format: "json"
      }
    })
  }
);
```

Adapt this to the repository's language/framework or HTTP client, but the final request must match the documented Velona contract.

The backend must:

1. Receive the programming request.
2. Build the system and user prompts from the actual user profile, blueprint, goals, constraints, training history, and relevant program state.
3. Call Velona over HTTPS.
4. Receive the actual response.
5. Read `response.data.output`.
6. Parse the generated JSON.
7. Validate the JSON against a strict schema.
8. Validate exercise IDs against the canonical exercise library.
9. Reject malformed or unsafe output.
10. Apply existing programming/session safety rules.
11. Persist only validated output.
12. Return the generated program to the frontend.

Do not implement a fake `generate()` function that returns local data while calling it AI.

---

## 2.6 Require structured output and validation

The AI response must contain structured JSON.

At minimum, validate:

- Program/session identity
- Workout date or target session
- Training objective
- Exercises
- Canonical exercise IDs
- Sets
- Repetitions or rep ranges
- RIR/RPE or intensity guidance
- Rest periods
- Exercise ordering
- Target muscles
- Rationale/programming notes, if displayed
- Warnings or unresolved constraints, if applicable

Use runtime validation with the project's existing validation library or a strict schema validator.

Do not trust arbitrary model text as application data.

If Velona returns JSON as a string in `data.output`, parse it and validate it. Do not persist it before validation.

---

## 2.7 Preserve the Physique Blueprint and session-safety rules

The AI must not bypass existing application rules.

Enforce:

- Existing canonical exercise library
- Existing exercise IDs
- Aesthetics as the primary objective
- Functional capability as secondary support
- User's active growth goals
- Maximum two active growth goals, where that is an existing product rule
- Injury and exercise constraints
- Existing session conflict rules
- No duplicate active planned sessions
- No same-day replacement when a completed or in-progress session exists
- Existing completed/in-progress/historical session semantics
- Existing deterministic conflict safety behavior

The AI may select and arrange exercises from the approved library, but it must not invent arbitrary exercise IDs.

If AI output violates application rules, reject it or repair it deterministically before persistence. Never persist invalid output.

---

## 2.8 Wire the actual Generate button

Trace and connect the real frontend Generate button.

When clicked:

- Frontend sends an HTTP request to the backend.
- Backend executes the real Velona API call.
- UI shows a loading state.
- UI shows a meaningful error if Velona fails.
- UI displays the actual generated workout after success.
- UI does not display a pre-existing static snapshot as if it were newly generated.
- UI does not silently substitute deterministic output when the AI call fails.

A safe response may include:

```json
{
  "success": true,
  "source": "ai",
  "provider": "velona",
  "model": "actual-model-name",
  "program": {}
}
```

Do not expose:

- API keys
- Authorization headers
- Sensitive prompt data
- Raw secrets
- Unnecessary provider response metadata

For failures, use a safe response such as:

```json
{
  "success": false,
  "source": "ai",
  "error": {
    "code": "AI_PROVIDER_ERROR",
    "message": "Workout generation failed. Please try again."
  }
}
```

---

## 2.9 Add integration tests

### Configuration tests

- Missing API key fails clearly.
- Missing model fails clearly.
- API key is not sent to the frontend.
- API key is not logged.
- Model configuration is loaded correctly.

### Provider client tests

- Correct Velona endpoint is called.
- Correct HTTP method is used.
- Authorization header is correctly formed.
- Request body contains the expected model and prompt.
- `stream` is false.
- JSON output is requested.
- Successful response is read from `data.output`.
- Provider errors are handled.
- Timeout errors are handled.
- Network failures are handled.
- Malformed provider output is rejected.

### Generate route tests

- Frontend request reaches the backend route.
- Backend calls the Velona provider client.
- Provider response is parsed and validated.
- Valid response is persisted.
- Invalid response is not persisted.
- Response identifies the source as `ai`.
- Deterministic output is not silently used when Velona is configured but fails.

### Real-provider smoke test

With a real Velona API key configured securely:

1. Open the deployed app.
2. Click Generate.
3. Confirm a backend request occurs.
4. Confirm the backend makes an external request to Velona.
5. Confirm Velona returns a response.
6. Confirm the workout displayed in the UI comes from that response.
7. Confirm the generated program/session is persisted.
8. Confirm logs do not expose the API key.

Mocks are acceptable for unit tests, but a real-provider smoke test is also required.

Do not call a mock-only test a live integration test.

---

## 2.10 Deployment requirements

Update deployment documentation with exact instructions for configuring the real secret.

For the deployment environment, configure:

```text
VELONA_API_KEY=<actual secret>
VELONA_MODEL=<selected real model>
VELONA_BASE_URL=https://velona.in/gateway/v1
```

The key must be configured server-side only.

Document:

- Required environment variables
- Secret names
- Deployment command
- How to verify configuration without printing the secret
- How to test the Generate button
- How to inspect logs for provider-call success/failure
- How to rotate the key
- How to disable the integration safely

Do not claim the deployment is AI-integrated until the deployed service has successfully made a real provider call.

---

## 2.11 Required final report

Create or update:

```text
docs/REAL_AI_INTEGRATION_REPORT.md
```

The report must answer concretely:

1. Which provider is integrated?
2. What exact API/SDK is used?
3. What exact endpoint is called?
4. What model is used?
5. What backend route calls it?
6. What service/function makes the external request?
7. What environment variables are required?
8. Where is the API key configured?
9. Is the key server-side only?
10. What happens when the key is missing?
11. What happens when Velona fails?
12. What response path is parsed?
13. What schema validates the AI response?
14. How are exercise IDs validated?
15. How does the Generate button reach Velona?
16. How is the generated workout persisted?
17. What tests prove the integration?
18. What exact manual smoke test was completed?
19. Was the test performed with a real API key and real provider response?
20. What remains incomplete?

Do not write “AI-ready,” “AI-compatible,” “provider-agnostic,” or “abstracted integration” as a substitute for actual integration.

---

# Final Acceptance Criteria

The work is not complete until:

- All npm audit findings are individually identified and explained.
- The npm vulnerability report is committed under `docs/`.
- Velona is the actual provider.
- The real Velona endpoint is implemented.
- A real Velona model is selected.
- The API key is configured securely on the backend.
- The Generate button reaches the backend.
- The backend makes a real external Velona request.
- Velona's response is parsed from the correct response path.
- The response is validated.
- The generated workout is persisted.
- The generated workout is displayed in the app.
- Provider failures are visible and do not silently become fake AI output.
- Automated tests cover the integration path.
- A real-provider smoke test has been completed.
- The final report documents the actual provider, model, endpoint, configuration, and evidence.
