# Required Dev Instructions: npm Audit Details + Real Live AI Integration

## Context

Two issues must be addressed before calling the application fully ready:

1. The exact details of the reported npm audit vulnerabilities must be disclosed.
2. The application must use a **real live AI integration**, not merely an abstraction, mock, deterministic generator, static snapshot, or future integration point.

The acceptance criterion for the AI feature is:

> After deployment, clicking **Generate** must trigger a real external AI API request and display a workout generated from the provider's response.

---

# Part 1 — Provide the Exact npm Audit Vulnerability Details

Run the audit from a clean dependency installation.

## 1. Clean install

From the repository root:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
npm ci
```

Use the existing `package-lock.json` for the official locked-install verification.

If `npm ci` cannot run because the lockfile is inconsistent, document the exact error. Do not silently regenerate or replace the lockfile.

If a lockfile regeneration is genuinely required, clearly distinguish that result from the locked-install result and do not commit dependency changes without approval.

## 2. Run npm audit

Run:

```powershell
npm audit
```

Also generate a machine-readable report:

```powershell
npm audit --json | Out-File -Encoding utf8 npm-audit-report.json
```

Preserve the report or include its relevant findings in the final documentation.

## 3. Explain every reported vulnerability

For every advisory, provide a table containing:

| Field | Required information |
|---|---|
| Advisory/GHSA ID | Exact npm/GitHub advisory ID |
| Package | Vulnerable package name |
| Installed version | Actual installed version |
| Vulnerable range | Exact affected version range |
| Fixed version | First fixed version, if available |
| Severity | Low / Moderate / High / Critical |
| Direct/transitive | Whether it is a direct dependency or transitive dependency |
| Dependency path | Why the package is installed |
| Runtime impact | Whether it can affect the deployed production app |
| Dev-only impact | Whether it is only used by tests/build tooling |
| Fix available | Yes/no |
| Breaking-change risk | Whether the fix requires a major upgrade |
| Recommended action | Fix now, defer, or investigate |

For each affected package, run:

```powershell
npm explain <package-name>
```

Use the actual package names returned by the audit.

## 4. Distinguish unique vulnerabilities from affected packages

The report must explicitly state:

- Number of unique advisories
- Number of affected packages
- Number of direct dependencies
- Number of transitive dependencies
- Severity breakdown
- Whether any are production-runtime vulnerabilities
- Whether any are only npm/dev/build/test vulnerabilities

Do not simply report “8 vulnerabilities” without identifying what those eight findings actually are.

## 5. Check whether fixes are safe

Run:

```powershell
npm audit fix --dry-run
```

Do not run this blindly:

```powershell
npm audit fix --force
```

Do not automatically apply major-version upgrades.

If a safe, non-breaking fix exists, identify it. If a fix requires a breaking upgrade, explain the impact and do not apply it without approval.

## 6. Deliverable

Create:

```text
docs/NPM_AUDIT_VULNERABILITY_REPORT.md
```

The report must contain the exact findings from the current repository, not generic npm security advice.

Also include:

- Commands used
- Relevant command results
- Whether each issue affects production
- Recommended next action for each issue

Do not claim the vulnerabilities are harmless without explaining why each one does or does not affect production.

---

# Part 2 — Implement REAL LIVE AI INTEGRATION

## Critical requirement

The application must not merely contain:

- AI-related names
- AI-shaped interfaces
- Local deterministic generation
- Mock providers
- Static snapshots
- Seeded AI responses
- Placeholder adapters
- A future integration point
- A provider-agnostic abstraction with no real provider behind it

The deployed app must actually call an external AI API when the user clicks **Generate**.

## Required end-to-end behavior

```text
User opens deployed app
    ↓
User clicks Generate
    ↓
Frontend sends request to backend
    ↓
Backend calls a real AI provider API
    ↓
AI provider generates a workout/program
    ↓
Backend validates the AI response
    ↓
Backend persists the generated program/session
    ↓
Frontend displays the generated workout
```

A local deterministic fallback must not silently make the feature appear AI-powered.

---

## 2.1 First inspect what is actually present

Search the entire repository:

```powershell
git grep -n -i -E "VELONA|OPENAI|ANTHROPIC|CLAUDE|OPENROUTER|GEMINI|API_KEY|BASE_URL|MODEL|fetch|axios|chat.completions|messages.create"
```

Inspect at least:

- `package.json`
- `.env.example`
- All AI/provider/service files
- Backend routes
- Frontend Generate button handler
- Program-generation service
- Persistence layer
- Deployment configuration
- Cloud Run configuration
- Existing documentation

Report explicitly:

1. Is there a real external HTTP/API call today?
2. Which provider is called?
3. Which endpoint is called?
4. Which model is used?
5. Where does the API key come from?
6. Is the key server-side only?
7. Does clicking Generate actually reach that provider?
8. Is the current response real provider output or local/mock output?

Do not infer integration from filenames or function names.

---

## 2.2 Select one real provider

No Velona API key, endpoint, or confirmed API contract has been supplied.

Therefore:

- Do not invent a Velona API.
- Do not claim Velona is integrated unless a real Velona API contract and credentials are provided.
- Do not hard-code fake credentials.
- Do not create a fake endpoint.
- Do not label a local implementation as Velona or live AI.

If Velona is not a real documented provider available to this project, use one supported provider with a real API, such as:

- OpenAI
- Anthropic
- OpenRouter

Use one concrete provider for the first live implementation rather than building a multi-provider abstraction.

Before implementation, state which provider will be used and why.

The selected provider must be confirmed before deployment if the choice affects credentials or billing.

---

## 2.3 Required secrets and configuration

Implement server-side environment configuration.

Use only the variables needed by the selected provider. A possible pattern is:

```text
AI_PROVIDER=
AI_API_KEY=
AI_MODEL=
AI_BASE_URL=
```

Do not add unnecessary variables if the provider SDK does not need them.

Requirements:

- API key must never be exposed to frontend JavaScript.
- API key must never be embedded in HTML.
- API key must never be committed to Git.
- API key must never be logged.
- `.env.example` may contain placeholders only.
- Production secrets must be configured through Cloud Run's secure environment/secret mechanism.
- Missing credentials must produce a clear server error, for example:
  `AI provider is not configured`
- The app must not silently fall back to deterministic generation and pretend that AI generated the result.

---

## 2.4 Implement the actual provider call

Implement a real backend service that:

1. Receives the workout-programming request.
2. Builds the actual prompt from the user's profile, blueprint, goals, constraints, training history, and relevant program state.
3. Calls the selected AI provider over HTTPS.
4. Sends the model and prompt in the provider's actual request format.
5. Receives the provider response.
6. Parses the returned content.
7. Validates it against a strict schema.
8. Rejects malformed or unsafe output.
9. Persists only validated output.
10. Returns the generated program to the frontend.

The implementation must use the provider's actual SDK or documented HTTPS API.

Do not implement a fake `generate()` function that returns local data while calling it AI.

---

## 2.5 Require structured AI output

The model must return structured JSON matching a defined schema.

At minimum, the generated result should include:

- Program/session identity
- Workout date or target session
- Training objective
- Exercises
- Exercise IDs or canonical exercise references
- Sets
- Repetitions or rep ranges
- RIR/RPE or intensity guidance
- Rest periods
- Ordering
- Target muscles
- Rationale or programming notes, if part of the UI
- Warnings or unresolved constraints, if applicable

Use runtime validation with the project's existing validation library or a properly implemented schema validator.

Do not trust arbitrary model text as application data.

If the model returns Markdown-wrapped JSON, either configure structured output correctly or parse and validate it robustly. Prefer native structured output/function calling where supported.

---

## 2.6 Preserve the Physique Blueprint rules

The AI must not freely invent exercises or violate existing application rules.

The prompt and validation layer must enforce:

- Existing canonical exercise library
- Existing exercise IDs
- Aesthetics as the primary objective
- Functional capability as secondary support
- User's active growth goals
- Maximum two active growth goals, where that is an existing product rule
- Existing injury and constraint information
- Existing session conflict rules
- No duplicate active planned sessions
- No same-day replacement when a completed or in-progress session already exists
- Existing completed/in-progress/historical session semantics
- Existing deterministic conflict safety behavior

The AI may choose and arrange exercises from the approved exercise library, but it must not invent arbitrary exercise IDs or bypass the resolver's safety rules.

If an AI response conflicts with application rules, reject it or repair it deterministically before persistence. Do not persist invalid output.

---

## 2.7 Connect the actual Generate button

Trace the real frontend Generate button.

When the user clicks Generate:

- It must send an HTTP request to the backend.
- The backend must execute the actual provider API call.
- The UI must show a loading state.
- The UI must show a meaningful error if the provider call fails.
- The UI must display the actual generated result after success.
- The UI must not show a pre-existing static snapshot as if it were newly generated.
- The UI must not silently substitute deterministic output when the AI call fails.

The response may expose safe metadata for debugging, for example:

```json
{
  "success": true,
  "source": "ai",
  "provider": "actual-provider-name",
  "model": "actual-model-name",
  "program": {}
}
```

Do not expose API keys, raw authorization headers, or sensitive prompt data.

If the provider fails, return a safe error such as:

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

## 2.8 Add explicit integration tests

Add tests proving the integration path.

### Configuration tests

- Missing API key fails clearly.
- API key is not sent to frontend.
- API key is not logged.
- Model configuration is loaded correctly.

### Provider client tests

- Correct provider endpoint is called.
- Correct HTTP method is used.
- Authorization header is correctly formed.
- Request body contains the expected model and prompt.
- Provider errors are handled.
- Timeout errors are handled.
- Malformed provider output is rejected.

### Generate route tests

- Frontend request reaches backend route.
- Backend calls provider client.
- Provider response is parsed and validated.
- Valid response is persisted.
- Invalid response is not persisted.
- Response identifies the source as `ai`.
- No deterministic fallback is used when AI is configured but fails.

### Real-provider smoke test

With a real API key configured securely:

1. Open the deployed app.
2. Click Generate.
3. Confirm a backend request occurs.
4. Confirm the backend makes an external provider request.
5. Confirm the provider returns a response.
6. Confirm the workout shown in the UI comes from that response.
7. Confirm the generated program/session is persisted.
8. Confirm logs do not expose the API key.

Mocks are acceptable for unit tests, but a real-provider smoke test is also required.

Do not call a mock-only test a live integration test.

---

## 2.9 Deployment requirements

Update deployment documentation with exact instructions for configuring the real secret.

For Cloud Run, use a secure secret/environment mechanism. Do not put the API key in source code or frontend environment variables.

Document:

- Required environment variables
- Secret names
- Deployment command
- How to verify configuration without printing the secret
- How to test the Generate button
- How to inspect Cloud Run logs for provider-call success/failure
- How to rotate the key
- How to disable the integration safely

Do not claim the deployment is AI-integrated until the deployed service has successfully made a real provider call.

---

## 2.10 Required final report

Create:

```text
docs/REAL_AI_INTEGRATION_REPORT.md
```

The report must answer concretely:

1. Which provider is integrated?
2. What exact API/SDK is used?
3. What model is used?
4. What backend route calls it?
5. What service/function makes the external request?
6. What environment variables are required?
7. Where is the API key configured?
8. Is the key server-side only?
9. What happens when the key is missing?
10. What happens when the provider fails?
11. What schema validates the AI response?
12. How does the Generate button reach the provider?
13. How is the generated workout persisted?
14. What tests prove the integration?
15. What exact manual smoke test was completed?
16. Was the test performed with a real API key and real provider response?
17. What remains incomplete?

Do not write “AI-ready,” “AI-compatible,” “provider-agnostic,” or “abstracted integration” as a substitute for actual integration.

---

# Final Acceptance Criteria

The work is not complete until all of the following are true:

- The eight npm audit findings are individually identified and explained.
- A vulnerability report is committed under `docs/`.
- A real AI provider is selected.
- A real provider SDK or documented API call is implemented.
- The API key is configured securely on the backend.
- The Generate button reaches the backend.
- The backend makes a real external AI request.
- The provider's response is validated.
- The generated workout is persisted.
- The generated workout is displayed in the app.
- Provider failures are visible and do not silently become fake AI output.
- Automated tests cover the integration path.
- A real-provider smoke test has been completed.
- The final report documents the actual provider, model, endpoint, configuration, and evidence.
