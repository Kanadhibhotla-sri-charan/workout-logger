# DEV TASK — Implement AI-Powered Weekly Reconciliation
## Goal: Complete in ONE iteration

### Context

In this application, **reconciliation** means:

> When the user changes a day’s activity (for example, Rest → Gym), and a simple day swap is not an appropriate solution, call the AI provider to generate the workout for the changed day and reorganize the affected week accordingly.

A simple swap remains deterministic and must not call AI.

Examples:

- Rest Monday + Push Tuesday → swap Monday/Tuesday: **no API call**.
- Rest Monday → Gym Monday, but swapping is unsuitable: **AI reconciliation API call required**.

The current snapshot has deterministic week reconciliation in `src/engine/weekProgramReconciliation.ts`, but the activity-override route currently calls the deterministic planner directly. That is insufficient for the intended product behavior.

---

# 1. Required final behavior

## A. Simple swap path — preserve

If the requested change can be satisfied by swapping two days:

```text
User requests day change
→ swapDayActivities(...)
→ persist swap
→ no AI provider call
```

Do not send a Velona request for this path.

## B. AI reconciliation path — implement

When the caller explicitly selects `regenerate` / reconciliation:

```text
User requests Rest/Badminton → Gym
        ↓
Validate request and target-day safety
        ↓
Build complete reconciliation context
        ↓
Call Velona with mode = reconcile_week
        ↓
Validate returned weekly reconciliation JSON
        ↓
Apply deterministic safety/domain validation
        ↓
Persist the revised week atomically
        ↓
Return revised week + reconciliation metadata
```

Do not silently fall back to deterministic-only regeneration when the AI call fails.

If AI is disabled, unavailable, times out, returns invalid JSON, or fails validation, return a clear error and leave the existing week unchanged.

---

# 2. Do not confuse the two meanings of reconciliation

There are two separate concepts in the codebase:

1. `weekProgramReconciliation.ts` currently reconciles freshly calculated deterministic plans with persisted program rows.
2. Product-level **AI weekly reconciliation** is the user-triggered operation described in this task.

The existing deterministic reconciliation helper may still be reused for persistence/diff mechanics, but it must not replace the required AI call.

---

# 3. Inspect and modify these areas

Start by reading the current implementations rather than creating duplicate logic:

```text
src/server/routes/programming.ts
src/server/routes/aiProgrammer.ts
src/ai-programmer/service/aiProgrammerService.ts
src/ai-programmer/context/programmerContextBuilder.ts
src/ai-programmer/context/programmerContextTypes.ts
src/ai-programmer/contracts/programmerTypes.ts
src/ai-programmer/contracts/programmerOutputSchema.ts
src/ai-programmer/provider/providerTypes.ts
src/ai-programmer/provider/velonaProvider.ts
src/ai-programmer/service/aiProposalLifecycle.ts
src/engine/weekProgramReconciliation.ts
src/engine/scheduleOperations.ts
src/repositories/weeklyProgramRepo.ts
src/repositories/weekActivityOverridesRepo.ts
src/repositories/workoutSessionsRepo.ts
src/db/schema.sql
public/
tests/
```

Also inspect the existing docs:

```text
docs/CURRENT_WEEK_RECONCILIATION_SPEC.md
docs/FINAL_CURRENT_WEEK_RECONCILIATION_SPEC.md
docs/AI_PROGRAMMER_CONTEXT_SPEC.md
docs/AI_PROGRAMMER_OUTPUT_SCHEMA.md
docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md
```

Use existing naming, repository conventions, error classes, transactions, and response serialization. Do not create a parallel programming architecture.

---

# 4. Add a distinct AI provider mode

## 4.1 Extend the provider request mode

Add:

```ts
type AIProgrammerMode =
  | 'generate_session'
  | 'reconcile_week';
```

Use the existing provider abstraction. Do not create a separate Velona client.

The Velona request must continue to use:

```text
POST {VELONA_BASE_URL}/inference/run
Authorization: Bearer {VELONA_API_KEY}
```

The reconciliation request must be sent through the same `VelonaProvider.generate()` method with:

```ts
mode: 'reconcile_week'
```

The provider should not need special endpoint logic for reconciliation.

---

# 5. Define the reconciliation request

Add a service input similar to:

```ts
export interface ReconcileWeekInput {
  targetDate: string;
  requestedActivity: 'gym';
  reason?: string;
  swapUnavailableReason?: string;
}
```

If the existing route already has a better request shape, preserve its public contract and adapt internally. The important fields are:

- exact target date;
- requested resulting activity;
- reason/context for the change;
- explicit indication that simple swap was not used;
- current week state.

The operation must only support the intended use case in this iteration:

```text
requestedActivity = gym
```

Do not broaden this into arbitrary activity programming unless already supported.

---

# 6. Build a dedicated reconciliation context

## 6.1 Do not reuse `buildProgrammerContext()` unchanged

The existing builder is designed for:

```text
generate_session
```

It is target-date-centric and returns a single-session context.

Create a dedicated builder, preferably:

```text
src/ai-programmer/context/reconciliationContextBuilder.ts
```

Suggested API:

```ts
export interface BuildReconciliationContextInput {
  targetDate: string;
  requestedActivity: 'gym';
  reason?: string;
  swapUnavailableReason?: string;
}

export function buildReconciliationContext(
  db: Database.Database,
  input: BuildReconciliationContextInput
): AIReconciliationContext;
```

Reuse existing deterministic functions and repositories. Do not duplicate exposure, history, recovery, goal, or Blueprint calculations.

## 6.2 Required context contents

The context must be self-contained and contain enough information for the model to revise the week without relying on conversation memory.

Include:

### Request metadata

```json
{
  "mode": "reconcile_week",
  "targetDate": "YYYY-MM-DD",
  "requestedActivity": "gym",
  "reason": "...",
  "swapUnavailableReason": "..."
}
```

### Date and timezone

- current date;
- user timezone;
- Monday–Sunday week boundaries;
- target weekday;
- target date;
- exact week being revised.

### Training profile

- recurring training days;
- other activity schedule;
- session duration limits;
- available equipment;
- relevant programming preferences.

### Goals and priorities

- active goals;
- exact user priority order;
- assessments where available;
- primary objective hierarchy.

### Effective weekly activity

Include all seven days after existing overrides are applied:

```json
{
  "date": "YYYY-MM-DD",
  "weekday": "monday",
  "activity": "rest|gym|badminton|both|unselected"
}
```

Also include the proposed change explicitly:

```json
{
  "date": "YYYY-MM-DD",
  "currentActivity": "rest",
  "requestedActivity": "gym"
}
```

### Existing persisted weekly program

Include every day of the target week:

- date;
- activity;
- whether a deterministic program snapshot exists;
- session purpose;
- planned exercises;
- target IDs;
- exercise IDs;
- classification;
- sets;
- reps;
- RIR;
- skipped targets;
- resource allocation;
- estimated duration;
- locked/completed/in-progress status where relevant.

Do not include sensitive or unnecessary database fields.

### Real training state

Include the same authoritative real training facts used by the existing engine:

- current weekly primary sets;
- secondary sets;
- weekly exposure;
- rolling exposure;
- last-trained dates;
- recent exercise history;
- recovery decisions;
- recent badminton signal.

Use `assembleWeeklyPlanInput()` and existing engine outputs instead of reimplementing these calculations.

### Valid exercise catalogue

Include valid Blueprint exercises relevant to targets that may be trained in the revised week:

- canonical exercise ID;
- name;
- role;
- equipment;
- authored prescription;
- target association.

Do not permit the model to invent exercise IDs.

### Locked-day constraints

Explicitly identify days that must not be changed:

- completed workout days;
- in-progress workout days;
- locked program days;
- dates outside the requested week;
- historical dates.

The model must preserve these days exactly.

### Output rules

Include the non-negotiable programming hierarchy and reconciliation rules.

---

# 7. Define a dedicated reconciliation output schema

Do not force a weekly reconciliation response into the existing single-session proposal schema.

Add a distinct schema/version, for example:

```text
ai-week-reconciliation.v1
```

Suggested output shape:

```ts
interface AIWeekReconciliationProposal {
  schemaVersion: 'ai-week-reconciliation.v1';
  targetDate: string;
  requestedActivity: 'gym';

  days: Array<{
    date: string;
    activity: 'rest' | 'gym' | 'badminton' | 'both' | 'unselected';
    changeType: 'unchanged' | 'modified' | 'new' | 'removed';
    locked: boolean;
    session: {
      sessionPurpose: string | null;
      availableMinutes: number;
      estimatedMinutes: number;
      exercises: Array<{
        exerciseId: string;
        targetType: string;
        targetId: string;
        classification: 'specialization' | 'normal_development' | 'maintenance';
        role: 'primary' | 'secondary';
        sets: number;
        repsMin: number;
        repsMax: number;
        rirMin: number;
        rirMax: number;
      }>;
      skipped: unknown[];
    } | null;
  }>;

  reconciliation: {
    changedDates: string[];
    preservedLockedDates: string[];
    rationale: string;
    warnings: string[];
  };
}
```

Adapt exact field names to existing contracts. Do not duplicate incompatible exercise types if reusable types already exist.

## Important output constraints

The model must:

- return exactly one JSON object;
- return all seven days;
- preserve locked/completed/in-progress days;
- use only valid exercise IDs from the supplied catalogue;
- use only supplied target IDs;
- not change dates outside the requested week;
- not fabricate historical performance;
- not create future training debt from missed sets;
- not inflate authored sets beyond allowed prescriptions;
- not filter exercises based on equipment/time if that is still prohibited by the current milestone;
- not return prose outside JSON.

---

# 8. Add reconciliation service method

Extend `AIProgrammerService` with a method such as:

```ts
async reconcileWeek(
  input: ReconcileWeekInput
): Promise<ReconcileWeekResult>
```

Required sequence:

```text
1. Check AI_PROGRAMMER_ENABLED.
2. Validate target date.
3. Build reconciliation context.
4. Create request ID.
5. Call provider with mode = reconcile_week.
6. Parse provider JSON.
7. Validate structural schema.
8. Validate domain rules against fresh/current context.
9. Persist the reconciliation proposal or result.
10. Apply it only through an explicit, atomic commit step.
11. Return result and metadata.
```

Do not bypass existing proposal safety patterns.

If the existing proposal lifecycle is only designed for single-session proposals, either:

- extend it cleanly for a weekly reconciliation proposal, or
- create a separate clearly named reconciliation persistence model/repository.

Do not store a weekly object inside a single-session row while pretending it is a normal session proposal.

---

# 9. Decide and implement persistence correctly

The reconciliation operation must not partially mutate the week.

Use one SQLite transaction for all changes:

```text
BEGIN
  validate current state
  apply activity override for target date
  update/create affected weekly program snapshots
  create/update the newly generated target-day planned session if required
  record reconciliation metadata
COMMIT
```

On any error:

```text
ROLLBACK
```

Do not:

- write the activity override first and call AI afterward;
- persist some revised days and then fail;
- delete the old program before the new response is validated;
- overwrite completed/in-progress sessions;
- create duplicate active planned sessions.

## Existing session safety

Reuse the authoritative resolver and conflict checks:

```text
src/engine/selectedSessionResolver.ts
```

Before commit:

- reject completed/in-progress target dates;
- reject ambiguous active-session conflicts;
- reject duplicate planned-session creation;
- revalidate current Blueprint commit;
- revalidate all exercise IDs and prescriptions;
- revalidate locked-day preservation.

---

# 10. Route behavior

Add or extend a route explicitly for AI reconciliation.

Preferred shape:

```text
POST /api/ai-programmer/reconcile-week
```

Request:

```json
{
  "targetDate": "YYYY-MM-DD",
  "requestedActivity": "gym",
  "reason": "I want to train on my usual rest day",
  "swapUnavailableReason": "Swapping with the next workout would disrupt the intended weekly distribution"
}
```

Response on success:

```json
{
  "ok": true,
  "mode": "reconcile_week",
  "proposalId": "...",
  "targetDate": "...",
  "changedDates": ["..."],
  "week": { "...": "..." },
  "provider": "velona",
  "model": "...",
  "requestId": "..."
}
```

If the application requires explicit review/approval for AI-generated changes, preserve that lifecycle:

```text
reconcile request
→ pending reconciliation proposal
→ user approval
→ atomic commit
```

If the existing product design explicitly treats this operation as immediately actionable, still validate everything before committing and use one transaction.

Do not silently auto-commit if the existing AI proposal policy requires explicit approval.

---

# 11. Frontend integration

Find the current activity-change UI and distinguish:

### Swap option

```text
Swap days
→ existing deterministic swap endpoint
→ no AI
```

### Reconcile/regenerate option

```text
Regenerate/reconcile week
→ POST /api/ai-programmer/reconcile-week
→ loading state
→ display revised week/proposal
→ approval/commit if required
```

The UI must not claim that a deterministic override regenerated the week through AI.

Display useful metadata:

- target day changed;
- days modified;
- preserved locked days;
- generated workout for the target day;
- warnings;
- provider/model only if appropriate for the existing UI.

Handle:

- AI disabled;
- provider timeout;
- invalid output;
- stale state;
- active-session conflict;
- validation failure.

---

# 12. Token diagnostics — required in this iteration

Because model selection depends on actual request size, add token-budget diagnostics for both modes.

At minimum, record:

```ts
{
  mode,
  requestId,
  systemInstructionChars,
  userPayloadChars,
  totalSerializedInputChars,
  estimatedInputTokens,
  outputSchemaChars,
  estimatedOutputTokens
}
```

Do not log API keys, authorization headers, full user data, or full workout history in production logs.

## Token estimation

If the provider returns actual usage metadata, use it as authoritative.

If Velona does not return usage metadata, implement a clearly labelled estimate. Do not claim it is exact.

Use a tokenizer compatible with the selected model if available. Otherwise use a documented approximation and expose the character count separately.

The diagnostics must be available for:

```text
generate_session
reconcile_week
```

This is necessary for final model selection.

---

# 13. Tests required

Add tests for all of the following.

## Provider/service tests

- `reconcile_week` is passed to the provider.
- Correct request body contains reconciliation context and schema.
- Provider failure produces no database mutation.
- Invalid JSON produces no mutation.
- Structural schema failure produces no mutation.
- Domain validation failure produces no mutation.
- AI disabled produces no provider call.
- Request ID and model metadata are returned.

## Context tests

- Seven days are included.
- Current effective activity is included.
- Requested target activity is explicit.
- Existing weekly program is included.
- Real training history/exposure/recovery are included.
- Locked/completed/in-progress dates are identified.
- Valid exercise catalogue is included.
- Context is self-contained.
- Context diagnostics report serialized size.

## Domain/safety tests

- Invalid exercise ID rejected.
- Invalid target ID rejected.
- Target date mismatch rejected.
- Locked day modification rejected.
- Completed/in-progress target rejected.
- Duplicate active planned session rejected.
- Authored set inflation rejected.
- Dates outside target week rejected.
- Existing sessions are not overwritten.

## Route tests

- Correct request accepted.
- Missing/invalid target date rejected.
- Missing `requestedActivity` rejected.
- Reconciliation route calls AI service.
- Swap route does not call AI.
- Provider failure leaves week unchanged.
- Successful reconciliation returns revised week/proposal.
- Approval/commit behavior follows existing proposal policy.

## Regression tests

Run the complete suite, not only new tests.

---

# 14. Verification commands

Run:

```bash
npm run typecheck
npm run build
npm test
```

If available, also run the production verification command already used by the repository.

Report:

- files changed;
- new route;
- new service method;
- new context builder;
- new schema/types;
- persistence/transaction behavior;
- number of tests added;
- complete test count;
- typecheck/build results;
- whether an authenticated Velona smoke test was run.

---

# 15. Acceptance criteria

This task is complete only when all are true:

- [ ] Simple swaps remain deterministic and make no AI call.
- [ ] Explicit reconciliation makes a real Velona API call.
- [ ] Reconciliation uses a dedicated `reconcile_week` mode.
- [ ] The context contains the full affected week and current state.
- [ ] The model returns a dedicated weekly reconciliation schema.
- [ ] The response is structurally and domain validated.
- [ ] Locked/completed/in-progress days are protected.
- [ ] No partial database mutation is possible.
- [ ] No deterministic-only fallback disguises itself as AI reconciliation.
- [ ] The frontend invokes the actual reconciliation path.
- [ ] Token diagnostics exist for Generate and Reconcile.
- [ ] All tests pass.
- [ ] Typecheck and build pass.
- [ ] Documentation is updated.

## Final instruction

Implement this as one cohesive vertical slice. Do not merely add a placeholder route or an unused provider mode. Trace the real UI → route → service → context → Velona → validation → persistence path and make the reconciliation feature genuinely operational.
