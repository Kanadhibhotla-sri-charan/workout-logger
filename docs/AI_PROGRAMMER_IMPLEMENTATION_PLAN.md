# AI Programmer Integration Implementation Plan

**Project:** Workout Logger  
**Purpose:** Replace deterministic workout programming as the programming authority with an AI-driven Generate/Reconcile workflow while preserving existing workout history, completed sessions, locked sessions, and deterministic application mechanics.

**Status:** Proposed implementation plan  
**Primary reference:** Current `workout-logger` repository and `AI_PROGRAMMER_CONTEXT_SPEC.md`

---

## 1. Executive Summary

The application should treat the AI Programmer as the sole authority responsible for deciding:

- Which exercises are prescribed
- Which Blueprint variations are used
- Weekly exercise distribution
- Session-level exercise selection
- Set, rep, RIR, rest, and progression prescriptions
- How goals influence emphasis
- How actual training history changes future programming
- How an existing future programme should be reconciled after completed training or user changes

The application remains responsible for:

- Loading authoritative data
- Building the AI context
- Supplying fixed instructions
- Calling the AI provider
- Validating the AI response
- Enforcing immutable/locked-session rules
- Persisting approved output
- Serving the programme to the UI
- Recording audit information
- Handling retries, failures, idempotency, and rollback

The desired architecture is **not**:

```text
Deterministic workout builder
    ↓
AI modifies deterministic result
```

It is:

```text
Route
    ↓
Load authoritative application state
    ↓
Build versioned AI context
    ↓
AI Programmer
    ↓
Validate structured response
    ↓
Apply lock/protection rules
    ↓
Persist programme
    ↓
Return programme
```

---

## 2. Repository Areas to Inspect and Modify

The following areas were identified during the repository audit. Exact function names and signatures must be confirmed against the current branch before implementation.

### 2.1 Programming route

**Primary file:**

```text
src/server/routes/programming.ts
```

Responsibilities currently associated with this route include:

- Receiving programming requests
- Loading the relevant user/training-profile state
- Building weekly programme input
- Calling the current deterministic programming path
- Enriching programme days with persisted state
- Persisting the weekly programme
- Returning weekly/today programme data

#### Required change

Convert this route into an orchestration layer. It should not contain programming logic itself.

Target responsibility:

```text
HTTP request
  → resolve target week and mode
  → load context
  → call AI programming service
  → validate proposal
  → apply reconciliation/lock rules
  → persist
  → return response
```

The route should not directly decide exercise selection, volume allocation, frequency, or goal emphasis.

---

### 2.2 Current deterministic programmer

**Primary file:**

```text
src/engine/workoutBuilder.ts
```

The current implementation contains deterministic programming concepts such as:

- Desired weekly volume
- Remaining weekly sets
- Compatible days
- Sessions remaining in the week
- Eligible days
- Development thresholds
- Live need deficits
- Recovery and exercise-selection coordination
- Weekly allocation and progression logic

#### Required change

Do not immediately delete this file.

First classify its contents into three categories:

| Category | Treatment |
|---|---|
| Actual programming decisions | Remove from the active programming path |
| Generic calculation/utilities | Retain only if independently useful |
| Rules that conflict with AI authority | Deprecate or delete after migration |

The AI must not be placed after `workoutBuilder.ts` as a refinement layer. The old builder must no longer generate the canonical prescription when AI mode is active.

Recommended transitional state:

```text
workoutBuilder.ts
  → retained temporarily for legacy mode, comparison, and migration tests
```

Then later:

```text
workoutBuilder.ts
  → removed from production programming path
```

---

### 2.3 Weekly reconciliation

**Primary file:**

```text
src/engine/weekProgramReconciliation.ts
```

The current reconciliation logic appears to compare fresh day inputs against persisted weekly programme state and preserve days with actual sessions in states such as:

- `completed`
- `in_progress`

#### Required change

Reuse the persistence and protection concepts, but do not assume the old deterministic day-input shape is the permanent AI contract.

The new reconciliation layer must:

1. Load the persisted programme.
2. Identify immutable days and exercises.
3. Provide actual training deviations to the AI.
4. Receive an AI proposal.
5. Reject any attempt to alter immutable records.
6. Apply only changes to unlocked/future records.
7. Preserve manual user modifications according to explicit protection rules.
8. Persist an auditable result.

Potential future name:

```text
src/engine/aiProgramReconciliation.ts
```

Alternatively, retain the existing file and refactor it behind a generic interface if that avoids unnecessary duplication.

---

### 2.4 Programme repositories

Likely relevant files include:

```text
src/repositories/programsRepo.ts
```

and the repository modules associated with:

- Weekly programmes
- Programme days
- Programme exercises
- Training profiles
- Activity overrides

#### Required change

Repositories should remain persistence-focused.

They may expose methods such as:

```ts
getWeeklyProgram(...)
getProgramDays(...)
getProgramExercises(...)
saveWeeklyProgram(...)
updateProgramDay(...)
lockProgramDay(...)
```

The repository layer must not call the AI provider or make programming decisions.

Required additions may include:

- Programme version metadata
- AI generation metadata
- Proposal status
- Reconciliation source
- Context version
- Provider/model metadata
- Request idempotency key
- Audit record reference
- Manual modification/protection markers

Exact schema changes must be determined after inspecting the current migrations/schema.

---

### 2.5 Blueprint loading

Relevant area:

```text
src/blueprint/
```

The Blueprint is an authoritative programming reference and must be transformed into an AI-facing catalogue.

The context builder should expose:

- Exercise ID
- Exercise name
- Variation ID/name
- Primary and secondary target mappings
- Blueprint package references
- Authored prescription
- Authored per-session set cap
- Rep range
- RIR guidance
- Rest guidance
- Any exercise-specific constraints
- Any authored notes relevant to prescription

The AI should receive a normalized representation rather than an uncontrolled raw object dump.

---

### 2.6 Training profiles, goals, and activities

The application already contains data structures associated with:

- Training profiles
- Training profile activities
- Goals
- Weekly activity overrides
- Gym/rest/badminton scheduling

These should be loaded by the context builder and converted into stable, explicit sections.

The AI should not need to understand internal database joins or route-specific DTOs.

---

### 2.7 Actual workout history

Relevant repository/schema areas include the actual workout/session/set records.

The context builder must distinguish:

- Planned programme
- Started session
- Completed session
- Actual exercise performed
- Actual sets completed
- Actual reps/load/RIR where available
- Skips
- Substitutions
- Additions
- Removed exercises
- User-entered notes

Actual training history is the primary evidence used to adjust future programming.

---

## 3. Target Service Architecture

Introduce a dedicated AI programming service layer.

A suggested structure is:

```text
src/ai/
  aiProgrammer.ts
  aiProvider.ts
  aiContextBuilder.ts
  aiOutputSchema.ts
  aiOutputValidator.ts
  aiProgrammerErrors.ts
  aiAudit.ts
```

Names may be adjusted to match existing project conventions.

### 3.1 `aiProvider.ts`

Defines the provider abstraction.

```ts
export interface AIProvider {
  generateProgram(
    request: AIProviderRequest
  ): Promise<AIProviderResponse>;
}
```

The provider interface should be independent of Velona-specific request/response formats.

It should support:

- Model selection
- System instructions
- User/context payload
- Structured JSON output
- Timeout
- Abort/cancellation
- Usage metadata
- Latency metadata
- Provider request ID
- Normalized errors

Example conceptual types:

```ts
export interface AIProviderRequest {
  model: string;
  systemInstruction: string;
  context: unknown;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  requestId: string;
}

export interface AIProviderResponse {
  rawText: string;
  parsedOutput?: unknown;
  model: string;
  providerRequestId?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  latencyMs?: number;
  finishReason?: string;
}
```

The provider should not persist programmes or access the database.

---

### 3.2 `aiProgrammer.ts`

This is the application-facing programming service.

Responsibilities:

1. Accept a Generate or Reconcile request.
2. Load/build the context.
3. Select the fixed constitution and task instructions.
4. Call the provider.
5. Parse the response.
6. Validate the response against the schema and authoritative data.
7. Enforce immutable-session protections.
8. Return a validated proposal to the orchestration layer.

It should not directly mutate the database unless the project deliberately chooses a service-level transaction boundary. A safer first design is to return a validated proposal and let the application service persist it.

Conceptual API:

```ts
export type ProgrammingMode = "generate" | "reconcile";

export interface AIProgrammingService {
  generate(request: GenerateProgramRequest): Promise<ValidatedProgramProposal>;
  reconcile(request: ReconcileProgramRequest): Promise<ValidatedProgramProposal>;
}
```

---

### 3.3 `aiContextBuilder.ts`

The context builder is responsible for creating the complete, explicit, versioned AI input.

It should:

- Load only authoritative application data
- Normalize IDs and dates
- Resolve Monday–Sunday week boundaries
- Resolve activities and overrides
- Separate actual history from planned history
- Separate locked data from editable data
- Include all valid Blueprint variations
- Include relevant long-term summaries
- Exclude secrets and irrelevant internal fields
- Produce a stable serialization
- Record context size and section-level token estimates

Conceptual API:

```ts
export interface AIContextBuilder {
  buildGenerateContext(
    request: GenerateContextRequest
  ): Promise<GenerateContext>;

  buildReconcileContext(
    request: ReconcileContextRequest
  ): Promise<ReconcileContext>;
}
```

---

### 3.4 `aiOutputSchema.ts`

This should define the machine-readable response contract.

Use the validation library already present in the repository if one exists. If not, choose one deliberately, such as Zod, rather than relying on TypeScript types alone.

TypeScript interfaces alone are insufficient because model output is untrusted runtime data.

---

### 3.5 `aiOutputValidator.ts`

Validation must happen in multiple layers:

#### Layer A: JSON/schema validation

Check:

- Valid JSON
- Required fields
- Correct primitive types
- Enum values
- Array structure
- No duplicate IDs where prohibited

#### Layer B: authoritative-reference validation

Check:

- Exercise IDs exist
- Variation IDs exist
- Variation belongs to the exercise
- Referenced Blueprint variation is valid
- Target mappings are authoritative
- No fabricated exercise or variation
- No unknown goal IDs

#### Layer C: programming-rule validation

Check:

- Authored prescription is respected
- Authored per-session set cap is not exceeded
- Valid Blueprint variations are never rejected merely because of package membership
- Locked days are unchanged
- Completed/in-progress sessions are unchanged
- Non-gym days are not prescribed as gym sessions
- No exercise is prescribed with impossible or missing authoritative data
- No invalid date/week assignment
- No duplicate exercise prescription unless explicitly allowed

#### Layer D: persistence-safety validation

Check:

- Proposal only targets the requested user/profile/week
- Proposal version matches the context version
- Proposal has not been generated from stale programme state
- Idempotency rules are satisfied
- No destructive operation is implied

---

## 4. Fixed Programming Constitution

The fixed constitution should be stored as versioned application-controlled text, not generated by the model and not editable through ordinary user context.

It should include the following principles.

### 4.1 Primary objective

The user’s broad objective is to:

- Build muscle
- Lose or manage body fat
- Improve athletic endurance and capability

The hierarchy is:

1. Aesthetics and physique development are primary.
2. Athletic and functional capability are important supporting objectives.
3. Explicitly prioritized active goals receive additional emphasis.
4. The rest of the physique and relevant capabilities must be maintained.
5. When objectives conflict, use the stated hierarchy and current active-goal priorities.

### 4.2 AI authority

The AI is the sole workout-programming authority.

It decides:

- Exercise selection
- Weekly distribution
- Frequency
- Volume
- Session composition
- Progression prescriptions
- Goal emphasis
- Reconciliation changes

The application does not run a second deterministic programmer to override the AI’s decisions.

### 4.3 Blueprint rules

- Every Blueprint variation is validly prescribable by definition.
- Package references describe development level and coverage; they are not rigid exercise quotas.
- Package membership is not an eligibility gate.
- Do not output “No valid prescription” merely because a variation is not listed in a package.
- If an exercise is selected, use its authoritative Blueprint prescription.
- Never inflate authored sets to satisfy a calculated weekly target.
- Valid but unselected exercises may be omitted for legitimate programming reasons.
- Reasons for omission should be concrete and evidence-based.

### 4.4 Calendar and frequency rules

- Monday–Sunday is the reporting boundary.
- A calendar week is not automatically a mandatory volume/reset/debt boundary.
- Missed sets do not create automatic volume debt.
- Frequency should be interpreted through session/exposure logic, not merely calendar-week counting.
- Actual completed training drives future decisions.

### 4.5 Execution constraints

- Do not filter normal programming by equipment availability.
- Do not filter normal programming by available session time.
- The user may manually skip, substitute, or adjust execution.
- Those execution changes become future history/context for reconciliation.

### 4.6 Locking rules

- Completed sessions are immutable.
- In-progress sessions are protected from destructive regeneration.
- Explicitly user-modified/protected future items must not be silently overwritten.
- Only unlocked future programme elements may be regenerated or reconciled.

---

## 5. Generate and Reconcile Boundaries

### 5.1 Generate

Generate is used when there is no accepted programme for the target scope or when the user explicitly requests a fresh programme for editable future scope.

Input includes:

- Target week
- User profile
- Active goals
- Weekly routine
- Blueprint catalogue
- Relevant actual history
- Existing programme, if any
- Lock/protection state
- Fixed constitution

Output includes:

- Full proposed week
- Day-level prescriptions
- Exercise-level prescriptions
- Rationale
- Goal contribution
- Coverage summary
- Warnings
- Programme metadata

Generate must not overwrite locked/completed/in-progress records.

---

### 5.2 Reconcile

Reconcile is used when existing programme state must be updated based on new evidence.

Triggers may include:

- A workout was completed
- A workout was partially completed
- Exercises were skipped
- Exercises were substituted
- Actual sets differed from planned sets
- Goals changed
- Weekly routine changed
- User explicitly requested recalculation
- A future programme needs updating after a protected session

Input includes:

- Existing programme
- Actual deviations since generation
- Locked/protected scope
- Current goals
- Current routine
- Relevant history
- Blueprint catalogue
- Reconciliation reason

Output includes:

- Unchanged locked items
- Updated future items
- Explicit change list
- Reason for each meaningful change
- Any unresolved warning
- New programme version

---

## 6. Proposed AI Context Contract

The exact implementation should follow `AI_PROGRAMMER_CONTEXT_SPEC.md`.

At a high level:

```json
{
  "context_version": "1.0",
  "request": {
    "mode": "generate",
    "target_week_start": "2026-09-14",
    "target_week_end": "2026-09-20",
    "timezone": "Asia/Kolkata",
    "request_id": "..."
  },
  "user_profile": {},
  "objectives": {},
  "active_goals": [],
  "weekly_routine": [],
  "blueprint": {
    "version": "...",
    "exercises": [],
    "variations": []
  },
  "training_history": {
    "recent_sessions": [],
    "aggregates": {}
  },
  "current_program": {},
  "lock_state": {},
  "constraints": {},
  "reconciliation": null
}
```

The context must be a data payload, not a replacement for the fixed constitution.

Recommended prompt layering:

```text
System message:
  Fixed programming constitution
  Output requirements
  Safety and authority rules

User message:
  Task instructions
  Versioned JSON context
```

User-provided notes and historical text must be treated as data, not as instructions capable of overriding the constitution.

---

## 7. Blueprint Normalization Requirements

The AI-facing Blueprint catalogue should not simply expose package names and expect the model to infer the rest.

Each exercise/variation record should include fields equivalent to:

```json
{
  "exercise_id": "exercise-123",
  "exercise_name": "Example Exercise",
  "variation_id": "variation-456",
  "variation_name": "Example Variation",
  "primary_targets": ["..."],
  "secondary_targets": ["..."],
  "package_references": [
    {
      "package_id": "...",
      "package_name": "...",
      "reference_role": "efficient"
    }
  ],
  "authored_prescription": {
    "sets": 3,
    "rep_range": {
      "min": 8,
      "max": 12
    },
    "rir": {
      "min": 1,
      "max": 3
    },
    "rest_seconds": 120
  },
  "authored_session_set_cap": 3,
  "programming_notes": []
}
```

Important distinctions:

- `package_references` are reference metadata.
- `authored_prescription` is authoritative prescription data.
- `authored_session_set_cap` is a hard authored cap when present.
- No generated `eligible: false` field should be derived solely from package membership.
- Missing authoritative fields must be represented as missing and surfaced for implementation review rather than invented.

---

## 8. History Context Strategy

Sending the entire raw database to the model is undesirable.

Use two levels of history:

### 8.1 Detailed recent history

Include a bounded recent window containing:

- Session date
- Session status
- Activity type
- Planned exercises
- Actual exercises
- Actual sets
- Reps
- Load
- RIR, if available
- Skips
- Substitutions
- Additions
- User notes
- Completion metadata

The exact retention window should be configurable after measuring context size. A reasonable initial candidate is a recent multi-week window, but the implementation must confirm the resulting token cost and usefulness.

### 8.2 Long-term aggregates

Include compact summaries such as:

- Exposure frequency by muscle/target
- Recent and longer-term set exposure
- Exercise usage frequency
- Last exposure date
- Recent performance trend
- Repeated skips/substitutions
- Goal progress
- Programme adherence
- Recent fatigue or recovery signals if actually stored

Do not fabricate metrics that the database cannot support.

---

## 9. Velona Provider Integration

### 9.1 Initial provider choice

Use Velona’s native HTTP endpoint for the first adapter rather than coupling the application to an OpenAI-compatible abstraction prematurely.

The native endpoint documented for inference is:

```text
POST https://velona.in/gateway/v1/inference/run
```

The adapter should use:

- Configurable API key
- Configurable model
- Configurable timeout
- Configurable generation parameters
- JSON output mode
- Explicit system/user turns
- Normalized response parsing
- Usage and latency capture

The model must remain configurable. Do not hard-code a final model until context size, quality, latency, and cost have been benchmarked.

### 9.2 No provider memory sessions

Do not use Velona memory sessions for V1.

Reasons:

- Reproducibility
- Auditability
- Explicit context control
- Avoiding hidden state
- Easier debugging
- Easier provider/model switching

Every request should carry the relevant context explicitly.

### 9.3 Environment configuration

Use environment variables or the project’s existing configuration system.

Conceptual values:

```text
AI_PROGRAMMER_ENABLED=false
AI_PROGRAMMER_PROVIDER=velona
AI_PROGRAMMER_MODEL=<configured-model>
AI_PROGRAMMER_API_KEY=<secret>
AI_PROGRAMMER_TIMEOUT_MS=<configured-timeout>
AI_PROGRAMMER_TEMPERATURE=<configured-value>
AI_PROGRAMMER_MAX_TOKENS=<configured-value>
AI_PROGRAMMER_DRY_RUN=true
```

Never commit API keys.

Never log:

- API keys
- Authorization headers
- Full sensitive user context
- Raw provider payloads containing private data

---

## 10. Persistence and Schema Changes

Before implementation, inspect the current schema and migrations for the exact weekly programme tables.

Potential additions:

### 10.1 Programme-level metadata

- `program_version`
- `source` (`deterministic`, `ai`, `manual`, etc.)
- `context_version`
- `constitution_version`
- `provider`
- `model`
- `generation_request_id`
- `generated_at`
- `reconciled_at`
- `parent_program_version`
- `status`

### 10.2 Day-level protection

- `day_status`
- `locked_at`
- `lock_reason`
- `user_modified_at`
- `user_modified_by`
- `protection_scope`

### 10.3 AI audit record

Potential table or equivalent storage:

```text
ai_program_runs
```

Fields may include:

- Run ID
- User/profile ID
- Mode
- Target week
- Request ID
- Context version
- Constitution version
- Provider
- Model
- Started timestamp
- Completed timestamp
- Latency
- Prompt token count
- Completion token count
- Total token count
- Status
- Validation status
- Error category
- Proposal hash
- Persisted programme version
- Safe diagnostic metadata

Do not store raw context or raw model output by default if it contains sensitive data. If raw payload retention is needed for debugging, make it explicit, access-controlled, and redacted.

---

## 11. Lock and Protection Model

The implementation needs a precise distinction between these states:

| State | AI may modify? |
|---|---|
| Future, untouched | Yes |
| Future, explicitly user-protected | No, unless user explicitly unlocks |
| In progress | No destructive replacement |
| Completed | No |
| Cancelled/abandoned with no actual work | Usually yes, subject to product rules |
| Non-gym day | AI may classify/schedule only according to routine semantics |
| Manual substitution recorded | Preserve as actual history; future plan may adapt |

The AI output should not be trusted to decide whether a record is locked. Lock state comes from the application/database.

The application must compare the AI proposal against the immutable baseline and reject or strip unauthorized changes before persistence.

---

## 12. Route-Level Flow

### 12.1 Generate flow

```text
POST /programming/generate
  ↓
Authenticate user
  ↓
Resolve profile and target week
  ↓
Load current programme and lock state
  ↓
Build Generate context
  ↓
Create AI run record
  ↓
Call AI provider
  ↓
Parse JSON
  ↓
Schema validation
  ↓
Authoritative Blueprint validation
  ↓
Programming-rule validation
  ↓
Immutable-scope validation
  ↓
Persist only approved editable scope
  ↓
Mark AI run successful
  ↓
Return programme
```

### 12.2 Reconcile flow

```text
POST /programming/reconcile
  ↓
Authenticate user
  ↓
Resolve profile/week/reconciliation reason
  ↓
Load existing programme
  ↓
Load actual sessions and deviations
  ↓
Resolve lock/protection state
  ↓
Build Reconcile context
  ↓
Call AI provider
  ↓
Validate response
  ↓
Compare proposal with locked baseline
  ↓
Apply future/unlocked changes only
  ↓
Persist new programme version
  ↓
Record change summary
  ↓
Return updated programme
```

---

## 13. Failure Handling

The AI path must fail safely.

### Provider failures

Handle:

- Timeout
- Connection failure
- HTTP 4xx
- HTTP 429
- HTTP 5xx
- Invalid provider response
- Empty response
- Unsupported model
- Authentication failure

### Model-output failures

Handle:

- Invalid JSON
- JSON wrapped in Markdown fences
- Missing required fields
- Unknown IDs
- Invalid prescription values
- Duplicate exercises
- Locked-session modifications
- Contradictory day assignments
- Unsupported activity types
- Hallucinated Blueprint records

### Required behavior

- Do not partially persist an invalid proposal.
- Do not delete the existing valid programme.
- Do not unlock completed sessions.
- Do not silently fall back to a different programming authority.
- Return a useful error category to the UI.
- Record a safe audit entry.
- Allow retry with a new request ID.
- Preserve the previous accepted programme.

A deterministic fallback may be retained temporarily for development or emergency operation, but it must be explicitly configured and clearly labeled. It must not silently override the AI in normal AI mode.

---

## 14. Idempotency and Concurrency

The same generation request should not create duplicate competing programmes.

Use an idempotency key derived from or supplied with:

- User/profile ID
- Target week
- Mode
- Source programme version
- Request ID

Before persistence:

1. Confirm the source programme version is still current.
2. Confirm lock state has not changed.
3. Confirm no newer accepted programme supersedes the proposal.
4. Use a transaction where possible.
5. Reject stale proposals rather than overwriting newer state.

This is especially important when:

- Two browser tabs generate simultaneously.
- A workout is completed while reconciliation is running.
- A user edits a future day while AI generation is in progress.
- A retry occurs after an uncertain network response.

---

## 15. Feature Flags and Rollout

Use staged activation.

### Stage 0: Context-only

- Build context.
- Validate completeness.
- Log section sizes and missing fields.
- Do not call AI.

### Stage 1: Provider dry run

- Call AI.
- Validate output.
- Store proposal/audit metadata.
- Do not persist it as the active programme.

### Stage 2: Shadow comparison

- Run AI beside the existing programmer.
- Compare outputs for diagnostics only.
- Do not let deterministic output rewrite the AI proposal.
- Use this only to identify data/quality issues.

### Stage 3: AI-generated future programmes

- Enable AI for new, unlocked weeks.
- Preserve all existing locked data.
- Keep rollback available.

### Stage 4: AI reconciliation

- Enable reconciliation after actual sessions and user changes.
- Add stale-state and concurrency protection.

### Stage 5: Retire deterministic programming authority

- Remove old builder from production programming path.
- Keep only reusable utilities or archive legacy code after confidence is established.

---

## 16. Testing Strategy

### 16.1 Context-builder tests

Test:

- Correct Monday–Sunday boundaries
- Correct timezone handling
- Gym/rest/badminton resolution
- Weekly overrides
- Active-goal ordering
- Blueprint completeness
- Authored set caps
- Actual vs planned history separation
- Locked vs editable state
- Null/missing data behavior
- Stable serialization
- Context version metadata
- Token-size reporting

### 16.2 Provider tests

Use a mocked HTTP server or provider mock.

Test:

- Correct request body
- Correct authorization handling
- JSON output configuration
- Timeout
- 429 response
- 5xx response
- Invalid response body
- Usage parsing
- Latency parsing
- No secret leakage in logs

### 16.3 Schema tests

Test:

- Minimal valid response
- Missing fields
- Wrong primitive types
- Unknown enum
- Duplicate exercise IDs
- Invalid set count
- Invalid rep range
- Invalid RIR
- Unknown exercise ID
- Unknown variation ID
- Variation/exercise mismatch

### 16.4 Programming-rule tests

Test:

- Every Blueprint variation is accepted when authoritative data is valid
- Package membership is not treated as an eligibility gate
- Authored set caps cannot be exceeded
- Authored prescriptions are not inflated
- Unknown exercises are rejected
- Non-gym days are protected
- Equipment does not silently filter valid exercises
- Time availability does not silently filter valid exercises
- No missed-set debt is automatically created
- Calendar week is not treated as a mandatory volume reset

### 16.5 Lock/reconciliation tests

Test:

- Completed day remains unchanged
- In-progress day remains unchanged
- Protected future day remains unchanged
- Unlocked future day can change
- Manual substitutions are preserved as actual history
- AI cannot delete completed sets
- AI cannot alter locked exercise prescriptions
- Stale proposals are rejected
- Concurrent updates do not overwrite newer state

### 16.6 Route integration tests

Test:

- Generate request
- Reconcile request
- Provider failure
- Invalid AI response
- Persistence transaction failure
- Retry behavior
- Feature flag off
- Dry-run mode
- Existing programme preservation

---

## 17. Implementation Sequence

### Phase 1 — Confirm repository contracts

1. Inspect exact schema/migrations.
2. Inspect all programming route endpoints.
3. Inspect weekly programme repository methods.
4. Inspect actual workout/session/set repositories.
5. Inspect Blueprint types and serialization.
6. Inspect goal/profile/activity DTOs.
7. Identify existing validation library and configuration conventions.
8. Identify current programme status/lock semantics.

**Deliverable:** confirmed file/function/schema map.

---

### Phase 2 — Build normalized context

1. Implement `aiContextBuilder.ts`.
2. Implement Blueprint normalization.
3. Implement goal normalization.
4. Implement weekly routine normalization.
5. Implement history detail and aggregate sections.
6. Implement current programme and lock-state sections.
7. Add context versioning.
8. Add token/size diagnostics.
9. Add context snapshot tests.

**Deliverable:** valid Generate and Reconcile context payloads with no AI dependency.

---

### Phase 3 — Define output contract

1. Design the canonical AI output JSON.
2. Define TypeScript types.
3. Define runtime schema.
4. Define authoritative-reference validation.
5. Define lock-scope validation.
6. Define normalized validation errors.
7. Create fixture responses.

**Deliverable:** schema and validator that can reject unsafe proposals before persistence.

---

### Phase 4 — Implement provider adapter

1. Add provider interface.
2. Add Velona native HTTP adapter.
3. Add environment configuration.
4. Add timeout and retry policy.
5. Add response parsing.
6. Add usage/latency metadata.
7. Add mocked provider tests.
8. Add redacted diagnostic logging.

**Deliverable:** provider can return a normalized structured response.

---

### Phase 5 — Implement AI programming service

1. Implement Generate orchestration.
2. Implement Reconcile orchestration.
3. Attach fixed constitution.
4. Attach task-specific instructions.
5. Call context builder.
6. Call provider.
7. Parse and validate output.
8. Return validated proposal without persistence.

**Deliverable:** dry-run AI proposal service.

---

### Phase 6 — Integrate persistence safely

1. Add AI run/audit metadata.
2. Add programme versioning if missing.
3. Add explicit lock/protection markers if missing.
4. Implement immutable-scope comparison.
5. Implement transactional persistence.
6. Implement stale-version checks.
7. Implement idempotency.
8. Add rollback-safe behavior.

**Deliverable:** validated AI proposals can safely update only editable programme scope.

---

### Phase 7 — Integrate routes and UI

1. Add feature flag.
2. Add Generate endpoint behavior.
3. Add Reconcile endpoint behavior.
4. Preserve existing read endpoints.
5. Expose generation status/errors.
6. Expose change summaries.
7. Add dry-run/admin diagnostics if appropriate.

**Deliverable:** application can use AI programming behind a flag.

---

### Phase 8 — Validate with real historical data

1. Build context from the real database.
2. Measure token sizes.
3. Run dry-run generations.
4. Inspect Blueprint references.
5. Inspect set-cap compliance.
6. Test completed/in-progress protection.
7. Test manual substitutions and skips.
8. Compare AI output against the programming constitution.
9. Tune prompts and context—not hidden deterministic overrides.

**Deliverable:** evidence-based readiness decision.

---

## 18. Open Decisions That Must Be Resolved Before Coding

These should be confirmed from the repository rather than guessed.

1. What exact table/field represents a completed session?
2. What exact table/field represents an in-progress session?
3. Are future manual edits currently persisted distinctly from generated content?
4. Is there already a programme version or revision number?
5. Are actual substitutions represented explicitly or only as free-text notes?
6. Are actual RIR values stored?
7. Are planned and actual sets linked by stable IDs?
8. Does the Blueprint contain authored set caps for every variation?
9. Are any Blueprint variations missing authoritative prescriptions?
10. Which existing validation library is installed?
11. Which configuration system is used?
12. Which route currently triggers reconciliation after workout completion?
13. Can programme persistence be performed transactionally?
14. What is the current database migration process?
15. What is the desired behavior for abandoned/incomplete sessions?
16. Should AI proposals be retained for audit, and for how long?
17. What context size and latency are acceptable for production?
18. Which Velona model passes the quality/cost benchmark?

---

## 19. Definition of Done

The integration is ready for production only when:

- AI is the sole programming authority in AI mode.
- The fixed constitution is versioned and application-controlled.
- Generate and Reconcile have distinct semantics.
- Context is explicit, versioned, normalized, and reproducible.
- Blueprint variations are not incorrectly rejected due to package membership.
- Authored prescriptions and set caps are enforced.
- Equipment and time do not silently filter normal programming.
- Actual history is distinguished from planned history.
- Completed and in-progress sessions are immutable.
- User-protected future changes are preserved.
- AI output is runtime-validated.
- Unknown IDs and unsafe changes are rejected.
- Provider failures do not damage the existing programme.
- Stale proposals cannot overwrite newer state.
- AI runs are auditable without leaking secrets.
- Dry-run and rollback paths have been tested.
- Real historical data has been used to validate context completeness.
- The old deterministic builder is no longer secretly overriding AI decisions.

---

## 20. Final Architectural Principle

The central design rule is:

> **The AI decides what the training programme should be. The application decides whether the proposal is structurally valid, authoritative, safe to apply, and allowed to modify the requested records.**

This preserves the flexibility and reasoning capability of an AI programmer while keeping the system deterministic where determinism is essential: data integrity, validation, locking, persistence, identity, and safety.
