# DEV INSTRUCTIONS — Fix AI Weekly Reconciliation Review Findings

## Objective

Fix the three findings from the 13 September 2026 review of the AI weekly-reconciliation implementation without rebuilding the feature.

The intended behavior remains:

1. A simple day swap uses no AI/API call.
2. If swapping is unsuitable, the user requests AI reconciliation.
3. AI receives the relevant weekly program/context and returns a revised weekly plan.
4. The result is persisted as a pending reconciliation proposal.
5. The user reviews and explicitly approves it.
6. Commit applies it safely, preserving locked/completed sessions and avoiding duplicate sessions.

Do not weaken existing session-selection, lock, approval, or persistence safety rules.

---

## Finding 1 — Make target-session conflict protection transactional and race-safe

### Problem

The current reconciliation commit performs an active-session conflict check before the transaction, then creates the target-day AI session. That is insufficient under concurrent requests because another request could create a conflicting session between the pre-check and the insert.

### Files to inspect

- `src/ai-programmer/service/weekReconciliationLifecycle.ts`
- Session repository implementation used by that service
- Database transaction helpers
- Existing authoritative session resolver and conflict tests
- Existing reconciliation commit tests

### Required implementation

Update `commitWeekReconciliation()` so that all target-day conflict checks and the target-session creation occur inside the same database transaction.

Use the repository's existing transaction abstraction. Do not invent a second transaction mechanism.

Inside the transaction:

1. Reload the reconciliation record by ID.
2. Confirm it is still in an approvable/approved state.
3. Reload the persisted reconciliation output.
4. Re-read all sessions for `output.targetDate`.
5. Re-run the active-session/duplicate planned-Gym conflict check using the same authoritative rules used elsewhere.
6. Re-check that the target program day is still eligible for replacement.
7. If a conflicting actionable Gym session now exists, abort the transaction with a typed conflict error.
8. Only after all checks pass:
   - update the relevant weekly-program records;
   - create the target-day AI planned session;
   - record the superseded program-session relationship;
   - mark the reconciliation committed.
9. Ensure the transaction rolls back completely if any step fails.

### Duplicate-prevention requirements

The commit must guarantee that a successful reconciliation does not leave multiple actionable planned Gym sessions for the same target date.

Use the strongest mechanism already supported by the schema:

- transaction-level recheck;
- unique constraint/index if appropriate;
- or an atomic insert/check operation.

Do not silently delete an existing active/completed session.

### Idempotency

A second commit request for the same reconciliation must not create another session.

Expected behavior:

- already committed → return the existing committed result or a clear idempotent response;
- approved but another conflicting session appeared → return a conflict;
- invalid/expired/rejected → return the existing lifecycle error.

### Tests required

Add or update tests for:

- existing active Gym session blocks commit;
- existing planned actionable Gym session blocks commit;
- completed/in-progress session is never replaced;
- duplicate commit does not create a second session;
- concurrent commit attempts result in one successful commit and one safe conflict/idempotent result;
- transaction failure leaves the reconciliation and week unchanged;
- target-day session is the only new actionable AI session.

---

## Finding 2 — Measure the exact serialized Velona request

### Problem

Current token diagnostics sum partial character counts. The actual provider sends a wrapped request containing the system turn, user-turn JSON, request metadata, context, output schema, and instruction. The diagnostic must measure the exact strings actually sent.

### Files to inspect

- `src/ai-programmer/provider/velonaProvider.ts`
- `src/ai-programmer/service/tokenDiagnostics.ts`
- Any provider request/response types
- Existing token-diagnostic tests

### Required implementation

Create one shared pure request-builder function in `velonaProvider.ts` (or a nearby provider utility), used both by the real fetch path and diagnostics.

Suggested shape:

```ts
function buildVelonaRequestBody(
  request: AIProgrammerProviderRequest,
  config: VelonaConfig,
) {
  const userTurnContent = JSON.stringify({
    request: {
      mode: request.mode,
      requestId: request.requestId,
    },
    context: request.context,
    outputSchema: request.outputSchema,
    instruction:
      'Return exactly one JSON object conforming to outputSchema. No prose outside the JSON object.',
  });

  return {
    model: config.model,
    turns: [
      {
        role: 'system',
        content: request.systemInstruction,
      },
      {
        role: 'user',
        content: userTurnContent,
      },
    ],
    stream: false,
    config: {
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    },
    output: { format: 'json' },
  };
}
```

Use the actual project types and preserve any existing fields. Do not duplicate the request-building logic.

### Diagnostic fields

Expose clearly named fields such as:

```ts
{
  systemInstructionChars,
  userTurnChars,
  wirePayloadChars,
  estimatedInputTokens,
  configuredMaxOutputTokens,
}
```

Definitions:

- `systemInstructionChars`: length of the exact system-turn content.
- `userTurnChars`: length of the exact user-turn content.
- `wirePayloadChars`: length of `JSON.stringify(body)`.
- `estimatedInputTokens`: heuristic estimate based on the exact text sent, not partial components.
- `configuredMaxOutputTokens`: provider `config.max_tokens`; this is a limit, not actual output usage.

Do not count `outputSchema` separately when it is already included in `userTurnContent`.

### Token estimation

Keep the heuristic clearly labeled as an estimate. If no provider tokenizer is available, use the project's existing heuristic, but document its limitation.

Prefer calculating the estimate from the actual textual content:

```ts
const inputText = [
  systemInstruction,
  userTurnContent,
].join('
');

const estimatedInputTokens = estimateTokens(inputText);
```

If the project has a tokenizer package already installed and appropriate for the selected model, use it. Do not add a large dependency solely for this unless explicitly justified.

### Actual usage metadata

If Velona's authenticated response includes input/output token usage in `meta`, parse it and expose it as authoritative usage:

```ts
actualInputTokens
actualOutputTokens
actualTotalTokens
```

If usage is absent, leave these fields null/undefined. Never fabricate actual usage from the heuristic.

### Tests required

Add tests proving:

- request builder output is exactly what fetch receives;
- diagnostics include the complete system and user-turn content;
- `outputSchema` is not double-counted;
- wrapper fields and instruction are included;
- estimated tokens are deterministic;
- actual provider usage is parsed when present;
- absent usage remains absent rather than being reported as actual.

---

## Finding 3 — Rehydrate the latest reconciliation proposal in the UI

### Problem

The backend exposes latest reconciliation retrieval, but reopening the day modal can reset the UI instead of restoring an existing pending/approved/committed reconciliation.

### Files to inspect

- `public/program.html`
- Reconciliation UI state/functions
- Existing endpoint client helpers
- Backend route for latest reconciliation:
  - `/api/ai-programmer/week-reconciliations/latest`
  - or the exact route currently implemented

### Required implementation

When the reconciliation section is initialized or the day modal is opened:

1. Determine the selected target date and relevant week.
2. Request the latest reconciliation for that target date/week.
3. If no record exists, show the initial “Ask AI to reorganize this week” state.
4. If a record exists, hydrate the UI from the persisted record:
   - reconciliation ID;
   - status;
   - target date;
   - original weekly plan;
   - proposed weekly plan;
   - validation findings;
   - approval/commit state;
   - error state, if any.
5. Render the correct controls by lifecycle state:
   - pending/generated → Review / Approve;
   - approved → Commit / Apply;
   - committed → Completed/read-only;
   - rejected/expired/failed → appropriate retry state.
6. Do not automatically call Generate merely because the modal was reopened.
7. Prevent duplicate Generate clicks while a request is active.
8. After Generate, Approve, or Commit, refresh state from the backend rather than relying only on local optimistic state.

### API contract

Use the existing backend response shape if available. Do not create a second incompatible shape.

If filtering by target date is not currently supported, add it explicitly and test it. The lookup must not accidentally return a reconciliation for another date or week.

### Tests required

Add or update frontend/API tests for:

- reopening a day with no reconciliation;
- reopening with a pending proposal;
- reopening with an approved proposal;
- reopening after commit;
- reopening a different target date does not hydrate the wrong record;
- modal reopen does not trigger a new AI call;
- failed/expired records render a retry state.

---

## Scope boundaries

Do not:

- replace the deterministic swap logic;
- make simple swaps call Velona;
- bypass approval;
- auto-commit AI output;
- overwrite locked or completed sessions;
- delete existing sessions to resolve conflicts;
- change the Velona endpoint or authentication contract;
- add an AI correction loop unrelated to weekly schedule reconciliation;
- redesign the entire workout-programming engine.

---

## Verification requirements

Run the project's standard checks:

```bash
npm run typecheck
npm run build
npm test -- --run
```

Also run any project-specific lint or verification command already documented in `package.json`.

Confirm:

1. Existing tests remain green.
2. New race/idempotency tests pass.
3. Generate still makes one real Velona request.
4. Reconciliation makes one real Velona request only when explicitly requested.
5. Simple swap makes zero AI requests.
6. Exact request diagnostics are present and do not expose API keys or sensitive credentials.
7. No secrets appear in logs.
8. A failed reconciliation never partially changes the week.
9. A successful commit creates no duplicate target-day actionable session.

---

## Final report required from Dev

Report:

- files changed;
- functions changed;
- exact reconciliation API call and provider mode;
- transaction/idempotency strategy;
- token diagnostic fields and whether they are estimated or provider-authoritative;
- UI rehydration behavior;
- tests added and total test count;
- typecheck/build/test results;
- any remaining limitations.

This is a targeted correction iteration, not a feature rewrite.
