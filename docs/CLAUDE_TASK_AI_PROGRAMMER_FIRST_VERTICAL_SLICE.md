# Claude Development Task — AI Programmer Integration: First Actual Implementation

**Prepared from snapshot:** `workout-logger-main.zip`  
**Snapshot date:** 2026-09-10  
**Role:** Architecture instruction for Claude, the developer  
**Priority:** High

---

# 1. Executive Summary

The repository is substantially more mature than a blank Phase-1 project. It already contains a real deterministic programming engine, Blueprint snapshot integration, weekly-program persistence, workout logging, training-state/exposure tracking, current-week reconciliation, goals, training profiles, and a working Express/SQLite backend.

However, the snapshot confirms that:

> **There is currently no AI/LLM provider integration or AI Programmer service in the runtime code.**

The next task is therefore not to redesign the deterministic engine or create more conceptual documents. The task is to add the first production-shaped AI integration layer around the existing domain model.

The first milestone is deliberately narrow:

> **Implement an AI-generated future-session proposal flow with explicit context, Velona provider integration, schema validation, domain validation, and safe non-destructive persistence boundaries.**

Do not attempt full-week AI reconciliation, automatic replacement of the deterministic engine, or broad UI redesign in this task.

---

# 2. Snapshot Findings

## 2.1 Confirmed technology stack

From `package.json` and repository structure:

- Node.js >= 20
- TypeScript
- Express 4
- better-sqlite3
- Vitest
- ESM modules
- Static HTML/vanilla JavaScript frontend
- SQLite schema in `src/db/schema.sql`

Existing scripts:

```text
npm run dev
npm run build
npm start
npm test
npm run typecheck
npm run verify
npm run sync-blueprint
```

## 2.2 Existing programming infrastructure

The repository already contains:

```text
src/engine/workoutBuilder.ts
src/engine/weekProgramReconciliation.ts
src/engine/trainingState.ts
src/engine/exposureEngine.ts
src/engine/volumeEngine.ts
src/engine/resourceAllocation.ts
src/engine/exerciseSelector.ts
src/engine/constraintEngine.ts
src/engine/recoveryEngine.ts
src/engine/progressionEngine.ts
src/engine/goalResolver.ts
src/engine/goalPhaseEngine.ts
src/engine/sessionPurpose.ts
```

Important existing entry points:

```ts
assembleAndBuildWorkout(db, date, budgetMinutes)
assembleWeeklyProgrammingPlan(db, date, budgetMinutes)
```

The existing engine is real and tested. Do not duplicate its calculations inside the new AI context builder.

## 2.3 Existing persistence infrastructure

Relevant repositories include:

```text
src/repositories/programsRepo.ts
src/repositories/weeklyProgramRepo.ts
src/repositories/workoutSessionsRepo.ts
src/repositories/goalsRepo.ts
src/repositories/trainingProfileRepo.ts
src/repositories/usersRepo.ts
src/repositories/weekActivityOverridesRepo.ts
src/repositories/outsideBlueprintExercisesRepo.ts
```

The schema includes:

```text
programs
program_goals
program_sessions
program_session_exercises
workout_sessions
workout_exercises
workout_sets
training_profiles
training_profile_activities
week_activity_overrides
goals
goal_events
aesthetic_assessments
measurements
outside_blueprint_exercises
```

`weeklyProgramRepo.ts` already stores a persisted week and per-day snapshots. Reuse this infrastructure where appropriate. Do not create a second competing program persistence model.

## 2.4 Existing Blueprint integration

The only module intended to understand raw Blueprint JSON is:

```text
src/blueprint/adapter.ts
```

It exposes:

```ts
BlueprintAdapter.getExercise(id)
BlueprintAdapter.getExercises()
BlueprintAdapter.getAestheticGoal(id)
BlueprintAdapter.getAestheticGoals()
BlueprintAdapter.getFunctionalGoal(id)
BlueprintAdapter.getFunctionalGoals()
BlueprintAdapter.getTarget(id)
BlueprintAdapter.getTargets()
BlueprintAdapter.getEquipment(id)
BlueprintAdapter.getEquipmentList()
BlueprintAdapter.getManifest()
BlueprintAdapter.getGlobalPrinciples()
BlueprintAdapter.getDevelopmentPackages()
BlueprintAdapter.isKnownExercise(id)
```

Blueprint data is vendored in:

```text
src/blueprint/snapshot/exercises.json
src/blueprint/snapshot/programming.json
src/blueprint/snapshot/manifest.json
```

Do not bypass `BlueprintAdapter` by importing raw snapshot JSON into unrelated modules.

## 2.5 Existing server structure

The server already has routes such as:

```text
src/server/routes/programming.ts
src/server/routes/programs.ts
src/server/routes/workouts.ts
src/server/routes/goals.ts
src/server/routes/blueprint.ts
src/server/routes/trainingProfile.ts
```

The new AI route should follow the existing Express/router conventions and should be registered through the existing server app rather than creating a separate server.

## 2.6 Confirmed absence

The snapshot contains no obvious runtime implementation for:

- Velona client/provider
- AI programmer service
- AI context builder
- AI output schema validator
- AI generation request persistence
- AI-generated proposal endpoint
- Provider API configuration
- AI-specific tests

The README explicitly says the current app has no AI/LLM layer. Treat that as accurate for this snapshot.

---

# 3. Scope of This Task

Implement the following:

1. AI programmer domain contracts.
2. Context builder backed by existing repositories and BlueprintAdapter.
3. Velona provider adapter.
4. Provider-independent AI programmer service.
5. Structured output parsing and validation.
6. Domain validation for generated future-session proposals.
7. A non-destructive generation endpoint.
8. Tests with mocked provider responses.
9. Environment/configuration documentation.
10. Clear audit logging without exposing secrets.

Do not implement the following yet:

- Full-week AI generation.
- Current-week AI reconciliation.
- Automatic replacement of the deterministic engine everywhere.
- Automatic rewriting of completed sessions.
- Automatic rewriting of locked sessions.
- New frontend UI beyond what is necessary to expose or test the endpoint.
- Provider-side memory or conversation-thread dependence.
- Streaming responses.
- Fine-tuning or model training.
- Automatic exercise creation.
- Automatic approval of outside-Blueprint exercises.
- Medical diagnosis or injury programming decisions.

---

# 4. Architectural Boundary

The intended flow is:

```text
Existing repositories + BlueprintAdapter
                  ↓
        AI Context Builder
                  ↓
       Explicit request envelope
                  ↓
           Velona Provider
                  ↓
       JSON parse + schema validation
                  ↓
        Domain/programming validation
                  ↓
       Proposal response / safe commit
```

The provider must never write directly to SQLite.

The AI must not be allowed to mutate the domain through arbitrary tool calls.

The application must retain control over:

- Exercise ID validity.
- Blueprint eligibility.
- Authored prescription limits.
- Program/session identity.
- Lock and completion state.
- Persistence.
- Conflict detection.
- Transaction boundaries.

---

# 5. Required Files

Use the repository’s existing conventions, but the recommended structure is:

```text
src/
  ai-programmer/
    contracts/
      programmerTypes.ts
      programmerOutputSchema.ts

    context/
      programmerContextBuilder.ts
      programmerContextTypes.ts
      programmerContextDiagnostics.ts

    provider/
      aiProgrammerProvider.ts
      velonaProvider.ts

    validation/
      programmerOutputValidator.ts
      programmerDomainValidator.ts

    service/
      aiProgrammerService.ts

    errors.ts
```

Tests should be colocated or placed according to the existing Vitest convention:

```text
src/ai-programmer/**/*.test.ts
```

If the repository already has a preferred `src/services` convention for external integrations, it is acceptable to place the provider/service there. Do not create duplicate implementations under both locations.

---

# 6. Context Builder Requirements

## 6.1 Principle

The AI must receive complete explicit context. It must not depend on Velona conversation memory.

Every request must contain the relevant programming state.

## 6.2 Required context sections

The generated context must include, where available:

```text
schema version
context ID
generation mode
current date
timezone
Monday-Sunday reporting boundary
user programming profile
active goals and user priority
active routine
selected Blueprint variation
Blueprint package references
authoritative Blueprint exercise prescriptions
valid exercise library
recent actual training sessions
weekly workload aggregates
exercise-level recent performance
body-region exposure
current program state
locked/completed/in-progress state
recovery information
user constraints
output requirements
diagnostics
```

Do not invent missing values. Represent unavailable information as absent/unknown and record it in diagnostics.

## 6.3 Use existing data sources

The context builder must reuse existing code rather than reimplementing domain logic.

Likely sources:

- `GoalsRepo`
- `TrainingProfileRepo`
- `UsersRepo`
- `WorkoutSessionsRepo`
- `ProgramsRepo`
- `WeeklyProgramRepo`
- `OutsideBlueprintExercisesRepo`
- `BlueprintAdapter`
- Existing training-state/exposure functions
- Existing weekly programming input assembly where appropriate

Before implementing, inspect the exact public methods and types of these modules. Adapt to the real APIs; do not assume the signatures from a generic specification.

## 6.4 Important Blueprint rules

The context builder must preserve these distinctions:

- A valid Blueprint variation is valid by definition.
- Package references are development/coverage references, not rigid exercise quotas.
- Package membership is not equivalent to exercise eligibility.
- Authoritative exercise prescriptions must be retained.
- Do not inflate authored set counts.
- Do not replace Blueprint prescriptions with generic defaults.
- Do not remove exercises from the valid library merely because of equipment or time constraints during ordinary generation.
- Unselected exercises are not automatically invalid.
- Compound exercises may provide meaningful secondary-target exposure.

## 6.5 History rules

Use actual logged performance for actual workload.

- Completed sets count toward actual workload.
- Planned-but-uncompleted sets do not count as completed workload.
- Skipped sets must not become automatic future debt.
- Preserve recent detailed sessions.
- Use aggregates for older history.
- Use Monday-Sunday week boundaries.
- Do not silently use the plan as a substitute for actual training.
- Preserve insufficient-data states.

## 6.6 Immutable state

The context must explicitly identify:

- Completed sessions.
- Locked sessions.
- In-progress sessions.
- Future unlocked sessions.
- Completed exercises.
- Locked exercises.

The AI may only propose changes within the editable scope.

---

# 7. First Output Contract: Future Session Proposal

Do not begin with an unconstrained “generate anything” response.

Implement a narrow structured output contract for a future-session proposal.

Recommended shape:

```ts
export interface AIWorkoutSessionProposal {
  schemaVersion: string;
  proposalId: string;
  mode: "generate_session";

  targetDate: string;
  weekday: string;
  sessionFocus: string[];

  exercises: AIWorkoutExerciseProposal[];

  programmingRationale: string[];
  goalAlignment: string[];
  recoveryConsiderations: string[];
  warnings: string[];
}
```

```ts
export interface AIWorkoutExerciseProposal {
  exerciseId: string;
  role:
    | "primary"
    | "secondary"
    | "accessory"
    | "isolation"
    | "conditioning";

  targetType: "physique_target" | "functional_goal";
  targetId: string;

  sets: number;
  repsMin: number;
  repsMax: number;
  rirMin: number;
  rirMax: number;
  restSeconds?: number;

  rationale: string[];
  source: "blueprint";
}
```

The final shape may be adjusted to match existing domain contracts, but it must remain:

- JSON-serializable.
- Strictly validated.
- ID-based rather than name-based.
- Explicit about source.
- Explicit about target.
- Explicit about prescription.
- Free of arbitrary SQL or persistence instructions.

Do not allow the AI to return raw HTML, executable code, SQL, or arbitrary database operations.

---

# 8. Provider Interface

Create a provider-independent interface:

```ts
export interface AIProgrammerProvider {
  generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse>;
}
```

```ts
export interface AIProgrammerProviderRequest {
  mode: "generate_session";
  systemInstruction: string;
  context: unknown;
  outputSchema: unknown;
  requestId: string;
}
```

```ts
export interface AIProgrammerProviderResponse {
  provider: string;
  model: string;
  requestId: string;
  rawText: string;
  parsedJson?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}
```

The application service should depend on `AIProgrammerProvider`, not directly on Velona.

This allows mocked tests and future provider replacement.

---

# 9. Velona Provider Requirements

Implement the native Velona integration according to the approved provider specification.

The provider must:

- Read endpoint and credentials from environment variables.
- Never hard-code API keys.
- Never log API keys or authorization headers.
- Send the full context in the request.
- Include the output schema/instructions.
- Support configurable model selection.
- Use timeout handling.
- Use bounded retries only for retryable failures.
- Avoid retrying malformed requests or authentication failures.
- Return a normalized provider response.
- Preserve provider request IDs where available.
- Surface provider errors using typed application errors.

Recommended configuration names:

```text
VELONA_API_KEY
VELONA_BASE_URL
VELONA_MODEL
VELONA_TIMEOUT_MS
VELONA_MAX_RETRIES
AI_PROGRAMMER_ENABLED
```

Use the exact names already established in `VELONA_PROVIDER_INTEGRATION_SPEC.md` if that specification has been copied into the repository. Do not create conflicting names.

The provider must not assume that a prior Velona conversation contains user context.

Every generation request must be self-contained.

---

# 10. Validation Requirements

Implement two distinct validation layers.

## 10.1 Schema validation

Check:

- Required fields exist.
- Types are correct.
- Enum values are valid.
- Numeric ranges are valid.
- No unexpected dangerous fields are accepted.
- JSON is parseable.
- The output matches the declared schema version.

## 10.2 Domain validation

Check:

- Every exercise ID resolves through `BlueprintAdapter` or an explicitly approved outside-Blueprint repository entry.
- For this first milestone, prefer Blueprint exercises only.
- Every target ID resolves to the declared target type.
- The exercise is eligible for the selected Blueprint variation.
- Set counts do not exceed the authoritative authored prescription or authored session cap.
- Reps, RIR, rest, and sets are within allowed domain ranges.
- No duplicate exercise IDs unless the existing domain explicitly permits them.
- The target date is a future/editable date.
- The proposal does not target a completed or locked session.
- The proposal does not claim to modify historical performance.
- No exercise is created merely because the AI named it.
- No outside-Blueprint exercise is silently approved.

A proposal failing validation must not be persisted.

Return structured validation errors suitable for logs and API responses, but do not expose internal stack traces to clients.

---

# 11. Service Requirements

Implement an application service similar to:

```ts
export class AIProgrammerService {
  constructor(
    private readonly contextBuilder: ProgrammerContextBuilder,
    private readonly provider: AIProgrammerProvider,
    private readonly outputValidator: ProgrammerOutputValidator,
  ) {}

  async generateSession(input: GenerateSessionInput): Promise<GenerateSessionResult> {
    const context = await this.contextBuilder.build({
      userId: input.userId,
      mode: "generate_session",
      targetDate: input.targetDate,
      timezone: input.timezone,
    });

    const providerResponse = await this.provider.generate({
      mode: "generate_session",
      systemInstruction: buildProgrammerSystemInstruction(),
      context,
      outputSchema: getProgrammerOutputSchema(),
      requestId: createRequestId(),
    });

    const validated = this.outputValidator.validate(
      providerResponse.parsedJson ?? parseJson(providerResponse.rawText),
      context,
    );

    if (!validated.ok) {
      throw new ProgrammerOutputValidationError(validated.errors);
    }

    return {
      proposal: validated.value,
      contextHash: context.contextHash,
      provider: providerResponse.provider,
      model: providerResponse.model,
      requestId: providerResponse.requestId,
    };
  }
}
```

The actual implementation must follow repository conventions and avoid unsafe `any` leakage.

---

# 12. Endpoint Requirements

Add a protected/controlled endpoint following existing route conventions.

Suggested endpoint:

```text
POST /api/ai-programmer/generate-session
```

Request example:

```json
{
  "targetDate": "2026-09-15",
  "timezone": "Asia/Kolkata"
}
```

If the current application is single-user and has no authentication layer, follow the existing single-user request conventions. Do not invent a full authentication system in this task.

Response on success should include:

```json
{
  "ok": true,
  "proposal": {},
  "contextHash": "...",
  "provider": "velona",
  "model": "...",
  "requestId": "..."
}
```

Important:

- The endpoint should initially return a validated proposal.
- Do not automatically overwrite the existing program in the first implementation unless the repository’s existing persistence model and transaction boundary make this safe and the behavior is explicitly implemented.
- Prefer a proposal-only mode first.
- If persistence is implemented, it must be a separate explicit operation or clearly separated service method.
- Existing completed/locked state must remain untouched.

Suggested future separation:

```text
POST /api/ai-programmer/generate-session
  → generate and validate proposal

POST /api/ai-programmer/commit-session-proposal
  → explicit validation + transaction + persistence
```

For this task, implementing only the first endpoint is acceptable and preferred.

---

# 13. Error Handling

Create typed errors for at least:

```text
AI_PROGRAMMER_DISABLED
AI_PROVIDER_CONFIGURATION_ERROR
AI_PROVIDER_AUTHENTICATION_ERROR
AI_PROVIDER_TIMEOUT
AI_PROVIDER_RATE_LIMITED
AI_PROVIDER_UNAVAILABLE
AI_PROVIDER_INVALID_RESPONSE
AI_OUTPUT_SCHEMA_INVALID
AI_OUTPUT_DOMAIN_INVALID
AI_TARGET_NOT_EDITABLE
AI_CONTEXT_INCOMPLETE
```

Map them to appropriate HTTP responses without leaking secrets.

Do not return raw provider responses containing sensitive headers or credentials.

---

# 14. Tests Required

## 14.1 Context tests

Add tests proving:

- Context includes active goals in user priority order.
- Context includes the selected routine.
- Context includes Blueprint variation identity.
- Context includes authoritative Blueprint prescriptions.
- Context includes recent actual sessions.
- Completed sets are distinguished from planned sets.
- Monday-Sunday boundaries are correct.
- Locked/completed/in-progress state is included.
- Missing data is represented explicitly.
- Sensitive fields are excluded.
- Context hash is stable for equivalent semantic input.

## 14.2 Provider tests

Use a fake/mock provider or mocked `fetch`.

Test:

- Successful provider response.
- Timeout.
- Authentication failure.
- Rate limiting.
- Retryable 5xx response.
- Non-retryable 4xx response.
- Malformed JSON.
- Provider response normalization.
- No secret values appear in logs.

Tests must not require a real Velona API key.

## 14.3 Domain-validation tests

Test rejection of:

- Unknown exercise ID.
- Unknown target ID.
- Wrong target type.
- Exercise outside the selected valid Blueprint variation.
- Set count above authored cap.
- Invalid rep range.
- Invalid RIR range.
- Duplicate exercises where disallowed.
- Targeting a completed session.
- Targeting a locked session.
- Outside-Blueprint exercise without explicit approval.

Test acceptance of:

- A valid future-session proposal using valid Blueprint exercises.
- A proposal omitting valid but unselected exercises.
- A proposal using authored set counts without inflation.

## 14.4 Route/service tests

Test:

- AI disabled behavior.
- Successful generation with mocked provider.
- Invalid provider output.
- Provider failure.
- No persistence on validation failure.
- No mutation of completed or locked sessions.
- Request ID and context hash are returned.

---

# 15. Documentation Requirements

Update the repository documentation with:

1. AI programmer integration status.
2. Required environment variables.
3. Local development setup for mocked provider tests.
4. How to enable/disable AI generation.
5. Endpoint request/response examples.
6. Explicit statement that the first milestone returns a proposal and does not silently rewrite existing programs.
7. Provider error troubleshooting.
8. Security note: never commit Velona credentials.

Do not incorrectly update the README to claim that AI is fully integrated until the endpoint and tests actually work.

---

# 16. Non-Negotiable Programming Rules

The implementation and system instruction must preserve these rules:

1. Aesthetics is the primary objective.
2. Athletic capability/endurance supports aesthetics unless explicitly prioritized otherwise.
3. Active growth goals receive extra emphasis, with the user’s ranking preserved.
4. Maintenance remains part of the program.
5. Blueprint package references are not rigid exercise quotas.
6. Package membership is not the same as exercise eligibility.
7. A valid Blueprint variation must not be rejected as invalid because of its coverage structure.
8. Authored Blueprint prescriptions are authoritative.
9. Never inflate authored set counts.
10. Valid exercises may be omitted for legitimate programming reasons.
11. Ordinary generation must not filter the exercise library merely due to equipment or time.
12. Actual completed training drives future programming.
13. Missed sets do not automatically create debt.
14. Completed sessions are immutable.
15. Locked sessions are immutable.
16. In-progress work must be preserved.
17. The AI must receive explicit full context.
18. Provider memory must never be required for correctness.
19. AI output must be validated before persistence.
20. The provider must never write directly to the database.

---

# 17. Explicit Implementation Order

Follow this order:

### Step 1 — Inspect exact repository APIs

Before coding, inspect:

```text
src/contracts/types.ts
src/repositories/goalsRepo.ts
src/repositories/trainingProfileRepo.ts
src/repositories/workoutSessionsRepo.ts
src/repositories/programsRepo.ts
src/repositories/weeklyProgramRepo.ts
src/blueprint/adapter.ts
src/engine/workoutBuilder.ts
src/server/app.ts
src/server/routes/programming.ts
src/db/schema.sql
```

Do not guess method signatures.

### Step 2 — Add contracts and errors

Create the AI programmer types, provider interface, output contract, and typed errors.

### Step 3 — Implement context builder

Use existing repositories and engine helpers. Avoid duplicating workload/exposure calculations.

### Step 4 — Implement Velona adapter

Use native HTTP/fetch integration with configuration, timeout, retry, and normalized errors.

### Step 5 — Implement validation

Separate schema validation from domain validation.

### Step 6 — Implement service

Wire context → provider → parse → validate.

### Step 7 — Implement proposal endpoint

Return validated proposal only.

### Step 8 — Add tests

All tests must run without a real provider key.

### Step 9 — Update documentation

Document setup, environment, endpoint, limitations, and safety boundary.

### Step 10 — Run verification

Run:

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

If an existing test fails, distinguish new failures from pre-existing failures and report exact output.

---

# 18. Acceptance Criteria

This task is complete only when all of the following are true:

- [ ] The repository contains an AI programmer provider interface.
- [ ] A Velona provider implementation exists.
- [ ] Provider configuration is environment-based.
- [ ] A context builder reads real repository/Blueprint data.
- [ ] The context is self-contained and does not depend on provider memory.
- [ ] Context includes actual history and immutable program state.
- [ ] AI output has a strict schema.
- [ ] AI output passes domain validation before being returned or persisted.
- [ ] Unknown/fabricated exercises are rejected.
- [ ] Authored Blueprint caps are enforced.
- [ ] Completed/locked sessions cannot be targeted for modification.
- [ ] A generation endpoint exists.
- [ ] The endpoint works with a mocked provider.
- [ ] Provider failures are handled safely.
- [ ] No credentials appear in logs or source.
- [ ] Tests cover the critical safety and Blueprint-fidelity rules.
- [ ] `npm run verify` passes, or any pre-existing failure is explicitly documented.

---

# 19. Final Instruction to Claude

> Implement the first actual AI Programmer vertical slice in the existing Workout Logger repository. Do not create another design-only document. Inspect the real repository APIs first, then add the provider-independent AI layer, real context builder, Velona adapter, strict output/domain validation, and proposal-only generation endpoint described above. Reuse the existing BlueprintAdapter, repositories, training engine, weekly program model, and Express conventions. Do not rewrite the deterministic engine, do not introduce provider memory dependence, do not mutate completed or locked sessions, and do not persist unvalidated AI output. Finish with tests, verification results, a list of changed files, and a list of any remaining limitations.
