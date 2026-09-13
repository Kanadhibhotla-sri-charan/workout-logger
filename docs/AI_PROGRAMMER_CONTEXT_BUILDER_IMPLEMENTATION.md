# AI Programmer Context Builder — Implementation Specification

**Project:** Workout Logger / Physique Blueprint  
**Purpose:** Define the concrete implementation of the context-building layer that prepares complete, deterministic, auditable input for the AI workout programmer.

---

## 1. Role of the Context Builder

The context builder is the boundary between the application’s authoritative data and the AI provider.

Its responsibilities are:

1. Read the current application state.
2. Resolve the user’s active routine and Blueprint variation.
3. Load the relevant exercise and prescription data.
4. Aggregate recent and historical training evidence.
5. Preserve locked, completed, and in-progress workout state.
6. Include active goals, objective priorities, recovery constraints, and scheduling context.
7. Produce a stable, explicit `ProgrammerContext`.
8. Produce diagnostics explaining what was included, omitted, truncated, or unavailable.
9. Ensure the AI receives no hidden dependency on provider-side memory.

The context builder must **not**:

- Generate exercises.
- Decide final set counts.
- Override Blueprint prescriptions.
- Apply equipment or time filtering during ordinary generation.
- Rewrite completed or locked workouts.
- Create missed-set debt.
- Infer that an exercise is invalid merely because it is not selected.
- Hide missing data silently.

The AI proposes programming decisions. The application remains responsible for validation, persistence, locking, and execution mechanics.

---

## 2. Recommended Module Layout

```text
src/
  ai-programmer/
    context/
      programmer-context.types.ts
      programmer-context.builder.ts
      programmer-context.normalizer.ts
      programmer-context.history.ts
      programmer-context.diagnostics.ts
      programmer-context.hash.ts
      programmer-context.redaction.ts
      programmer-context.test.ts

    contracts/
      programmer-input.contract.ts
      programmer-output.contract.ts

    provider/
      velona.provider.ts

    service/
      ai-programmer.service.ts
```

The exact folder names may be adapted to the repository’s conventions, but the responsibilities should remain separated.

---

## 3. Core Context Types

The following types are implementation-level contracts. They should be adapted to the repository’s actual domain types rather than duplicated as competing database models.

```ts
export type ProgrammerMode =
  | "generate_week"
  | "generate_session"
  | "reconcile_unlocked"
  | "explain_program";

export type TrainingDay =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface ProgrammerContext {
  schemaVersion: string;
  contextId: string;
  contextHash: string;
  generatedAt: string;

  mode: ProgrammerMode;
  reportingBoundary: {
    weekStartsOn: "monday";
    weekEndsOn: "sunday";
    timezone: string;
    weekStart: string;
    weekEnd: string;
  };

  user: UserProgrammingContext;
  objectives: ObjectiveContext;
  routine: RoutineContext;
  blueprint: BlueprintContext;
  exerciseLibrary: ExerciseLibraryContext;
  trainingHistory: TrainingHistoryContext;
  currentProgram: CurrentProgramContext;
  recovery: RecoveryContext;
  constraints: ConstraintContext;
  outputRequirements: OutputRequirementContext;
  diagnostics: ContextDiagnostics;
}
```

### 3.1 User Programming Context

Only include information relevant to programming.

```ts
export interface UserProgrammingContext {
  userId: string;
  experienceLevel?: string;
  trainingAgeMonths?: number;
  preferredTrainingDays: TrainingDay[];
  preferredSessionDurationMinutes?: number;
  knownTrainingPreferences: string[];
  knownAvoidances: string[];
}
```

Do not include unnecessary personal information, credentials, authentication tokens, payment information, or unrelated profile data.

### 3.2 Objectives

```ts
export interface ObjectiveContext {
  primaryObjective: "build_muscle";
  secondaryObjectives: Array<
    "manage_fat" |
    "lose_fat" |
    "athletic_endurance" |
    "athletic_capability"
  >;

  aestheticsPriority: "primary";
  athleticPriority: "supporting" | "equal" | "primary";
  activeGrowthGoals: GrowthGoalContext[];
  maintenanceGoals: MaintenanceGoalContext[];
}
```

```ts
export interface GrowthGoalContext {
  goalId: string;
  bodyRegion: string;
  displayName: string;
  priorityRank: number;
  status: "active";
  rationale?: string;
}

export interface MaintenanceGoalContext {
  bodyRegion: string;
  displayName: string;
  status: "maintenance";
}
```

The context builder should preserve the user’s explicit ranking. It must not silently reorder goals.

### 3.3 Routine Context

```ts
export interface RoutineContext {
  routineId: string;
  routineName: string;
  splitName?: string;
  activeDays: RoutineDayContext[];
  currentDay?: TrainingDay;
  currentSessionId?: string;
}
```

```ts
export interface RoutineDayContext {
  day: TrainingDay;
  label: string;
  focusAreas: string[];
  planned: boolean;
  completed: boolean;
  locked: boolean;
  sessionId?: string;
}
```

The routine resolver must distinguish:

- A day that is planned.
- A day that is completed.
- A day that is locked.
- A day that is skipped or not scheduled.
- A future day that is still editable.

### 3.4 Blueprint Context

```ts
export interface BlueprintContext {
  blueprintVersion: string;
  variationId: string;
  variationName: string;
  developmentLevel?: string;

  packageReferences: BlueprintPackageReference[];
  exercisePrescriptions: BlueprintExercisePrescription[];
  authoredRules: string[];
  globalRules: string[];
}
```

```ts
export interface BlueprintPackageReference {
  packageId: string;
  packageName: string;
  developmentLevel?: string;
  referenceCoverage?: string;
  purpose: string;
}
```

```ts
export interface BlueprintExercisePrescription {
  exerciseId: string;
  exerciseName: string;
  bodyRegion: string;
  movementPattern?: string;
  primaryTargets: string[];
  secondaryTargets: string[];

  authoredSetCount: number;
  authoredRepRange?: {
    min: number;
    max: number;
  };
  authoredRirRange?: {
    min: number;
    max: number;
  };
  authoredRestSeconds?: {
    min: number;
    max: number;
  };

  authoredSessionCap?: number;
  authoredNotes?: string[];
  sourceVariationId: string;
  eligible: true;
}
```

Important rules:

- Every valid Blueprint variation is valid by definition.
- Package references describe development level and coverage; they are not rigid exercise quotas.
- Package membership is not the same as exercise eligibility.
- The builder must preserve the authoritative prescription belonging to the selected variation.
- Do not replace authored set counts with generic defaults.
- Do not create a “no valid prescription” state merely because a valid variation has unusual coverage.

---

## 4. Exercise Library Context

The AI needs enough information to reason over the complete valid exercise library without confusing library availability with today’s selection.

```ts
export interface ExerciseLibraryContext {
  exercises: LibraryExerciseContext[];
  selectionStatus: {
    selectedExerciseIds: string[];
    omittedExerciseIds: string[];
    omissionReasons?: Record<string, string>;
  };
}
```

```ts
export interface LibraryExerciseContext {
  exerciseId: string;
  name: string;
  aliases?: string[];
  bodyRegion: string;
  movementPattern?: string;
  primaryTargets: string[];
  secondaryTargets: string[];
  equipment?: string[];
  unilateral: boolean;
  compound: boolean;
  stabilityDemand?: "low" | "moderate" | "high";
  fatigueCost?: "low" | "moderate" | "high";
  blueprintEligible: boolean;
  blueprintPrescription?: BlueprintExercisePrescription;
}
```

During ordinary generation:

- Do not remove exercises solely because the user has limited equipment.
- Do not remove exercises solely because the user has limited time.
- Do not assume that every valid exercise must be selected.
- Do not assume that every unselected exercise is invalid.

If the application has an explicit execution constraint, it may be included as a constraint for the AI to solve, but it should not mutate the authoritative library.

---

## 5. Training History Context

History should be split into three layers:

1. Recent detailed sessions.
2. Aggregated longer-term workload.
3. Relevant event flags.

This avoids sending every historical set indefinitely while preserving enough evidence for programming decisions.

```ts
export interface TrainingHistoryContext {
  recentSessions: RecentSessionContext[];
  weeklyAggregates: WeeklyTrainingAggregate[];
  exerciseAggregates: ExerciseTrainingAggregate[];
  bodyRegionAggregates: BodyRegionTrainingAggregate[];
  notableEvents: TrainingHistoryEvent[];
}
```

### 5.1 Recent Sessions

```ts
export interface RecentSessionContext {
  sessionId: string;
  date: string;
  day: TrainingDay;
  focusAreas: string[];
  status: "completed" | "in_progress" | "planned" | "skipped";
  locked: boolean;

  exercises: RecentExercisePerformance[];
  sessionNotes?: string[];
}
```

```ts
export interface RecentExercisePerformance {
  exerciseId: string;
  exerciseName: string;
  plannedSets?: number;
  completedSets: number;
  skippedSets: number;
  sets: PerformanceSetContext[];
  userFeedback?: string[];
}
```

```ts
export interface PerformanceSetContext {
  setNumber: number;
  reps?: number;
  load?: number;
  loadUnit?: string;
  rir?: number;
  rpe?: number;
  durationSeconds?: number;
  completed: boolean;
  notes?: string[];
}
```

### 5.2 Weekly Aggregates

The reporting boundary is Monday through Sunday.

```ts
export interface WeeklyTrainingAggregate {
  weekStart: string;
  weekEnd: string;
  totalCompletedSets: number;
  totalSessionsCompleted: number;
  totalSessionsSkipped: number;
  bodyRegionSetTotals: Record<string, number>;
  movementPatternSetTotals: Record<string, number>;
  exerciseSetTotals: Record<string, number>;
}
```

The aggregate must be based on actual completed training, not merely planned training.

### 5.3 Exercise Aggregates

```ts
export interface ExerciseTrainingAggregate {
  exerciseId: string;
  exerciseName: string;
  lastPerformedAt?: string;
  sessionsInLookback: number;
  completedSetsInLookback: number;
  averageReps?: number;
  averageLoad?: number;
  averageRir?: number;
  bestRecentPerformance?: {
    reps?: number;
    load?: number;
    rir?: number;
    date: string;
  };
  trend?: "improving" | "stable" | "declining" | "insufficient_data";
}
```

### 5.4 Body-Region Aggregates

```ts
export interface BodyRegionTrainingAggregate {
  bodyRegion: string;
  completedSetsLast7Days: number;
  completedSetsLast14Days: number;
  completedSetsLast28Days: number;
  directSetsLast7Days: number;
  indirectSetsLast7Days: number;
  recentExposureDates: string[];
}
```

The distinction between direct and indirect work should be preserved if the repository already models it. Compound exercises can provide meaningful secondary-target exposure; do not treat all secondary exposure as zero.

---

## 6. Current Program and Lock State

The context must explicitly communicate what can and cannot be changed.

```ts
export interface CurrentProgramContext {
  programId?: string;
  weekId?: string;
  sessions: CurrentSessionContext[];
  lockedExerciseIds: string[];
  lockedSessionIds: string[];
  completedSessionIds: string[];
  inProgressSessionIds: string[];
  editableSessionIds: string[];
}
```

```ts
export interface CurrentSessionContext {
  sessionId: string;
  date: string;
  day: TrainingDay;
  status: "planned" | "in_progress" | "completed" | "skipped";
  locked: boolean;
  exercises: CurrentProgramExercise[];
}
```

```ts
export interface CurrentProgramExercise {
  exerciseId: string;
  exerciseName: string;
  plannedSets: number;
  completedSets: number;
  locked: boolean;
  source: "blueprint" | "ai_generated" | "user_added" | "carried_forward";
}
```

Hard rules:

- Completed sessions are immutable.
- Locked sessions are immutable.
- Completed exercises and logged performance are immutable.
- In-progress work must be preserved.
- Reconciliation may only modify future, unlocked, unstarted content.
- The AI must receive enough state to avoid proposing destructive replacement.

---

## 7. Recovery Context

Recovery should be explicit and evidence-based.

```ts
export interface RecoveryContext {
  sleep?: {
    averageHours?: number;
    recentHours?: number[];
    confidence: "high" | "medium" | "low";
  };

  soreness: Array<{
    bodyRegion: string;
    severity: "none" | "mild" | "moderate" | "high";
    reportedAt: string;
  }>;

  painOrInjuryFlags: Array<{
    bodyRegion: string;
    description: string;
    severity?: "mild" | "moderate" | "high";
    active: boolean;
  }>;

  fatigueLevel?: "low" | "moderate" | "high";
  recoveryNotes: string[];
}
```

Do not fabricate recovery data. If a value is unavailable, omit it or mark it unavailable rather than assigning a default.

Pain or injury flags should be passed as constraints and warnings. The AI should not diagnose medical conditions.

---

## 8. Constraint Context

```ts
export interface ConstraintContext {
  userExplicitConstraints: string[];
  scheduleConstraints: string[];
  equipmentConstraints?: string[];
  timeConstraints?: string[];
  exerciseAvoidances: string[];
  safetyConstraints: string[];
  nonNegotiableRules: string[];
}
```

The builder must preserve the difference between:

- A user preference.
- A hard constraint.
- A temporary limitation.
- A safety restriction.
- A programming rule.

For example, “I prefer not to do exercise X” is not equivalent to “exercise X is medically prohibited.”

---

## 9. Output Requirements

The AI should receive the exact expected output contract.

```ts
export interface OutputRequirementContext {
  outputSchemaVersion: string;
  requiredSections: string[];
  requiredSessionFields: string[];
  requiredExerciseFields: string[];
  requiredRationaleFields: string[];
  validationRules: string[];
  forbiddenBehaviors: string[];
}
```

Example forbidden behaviors:

```ts
[
  "Do not rewrite completed or locked sessions.",
  "Do not invent exercises outside the supplied valid library.",
  "Do not inflate authored Blueprint set counts.",
  "Do not treat package references as rigid exercise quotas.",
  "Do not create missed-set debt.",
  "Do not claim that a valid Blueprint variation has no valid prescription.",
  "Do not use provider memory as a substitute for supplied context."
]
```

---

## 10. Builder Interfaces

The builder should depend on repository adapters rather than directly embedding database queries.

```ts
export interface ProgrammerDataSource {
  getUserProgrammingProfile(userId: string): Promise<UserProgrammingContext>;
  getObjectives(userId: string): Promise<ObjectiveContext>;
  getActiveRoutine(userId: string): Promise<RoutineContext>;
  getBlueprintContext(
    userId: string,
    routine: RoutineContext
  ): Promise<BlueprintContext>;
  getExerciseLibrary(
    userId: string,
    blueprint: BlueprintContext
  ): Promise<ExerciseLibraryContext>;
  getTrainingHistory(
    userId: string,
    range: HistoryRange
  ): Promise<RawTrainingHistory>;
  getCurrentProgram(userId: string): Promise<CurrentProgramContext>;
  getRecoveryContext(userId: string): Promise<RecoveryContext>;
  getConstraints(userId: string): Promise<ConstraintContext>;
}
```

```ts
export interface HistoryRange {
  startDate: string;
  endDate: string;
  timezone: string;
  recentSessionLimit: number;
}
```

```ts
export interface ProgrammerContextBuildOptions {
  userId: string;
  mode: ProgrammerMode;
  currentDate: string;
  timezone: string;
  currentSessionId?: string;
  targetWeekStart?: string;
  targetWeekEnd?: string;
  recentSessionLimit?: number;
  historyLookbackDays?: number;
  tokenBudget?: number;
}
```

---

## 11. Context Builder Skeleton

```ts
export class ProgrammerContextBuilder {
  constructor(
    private readonly dataSource: ProgrammerDataSource,
    private readonly normalizer: ProgrammerContextNormalizer,
    private readonly historyBuilder: TrainingHistoryBuilder,
    private readonly diagnostics: ContextDiagnosticsBuilder,
    private readonly hasher: ContextHasher,
  ) {}

  async build(
    options: ProgrammerContextBuildOptions
  ): Promise<ProgrammerContext> {
    const reportingBoundary = resolveReportingBoundary(
      options.currentDate,
      options.timezone,
      options.targetWeekStart,
      options.targetWeekEnd,
    );

    const user = await this.dataSource.getUserProgrammingProfile(
      options.userId,
    );

    const objectives = await this.dataSource.getObjectives(options.userId);
    const routine = await this.dataSource.getActiveRoutine(options.userId);

    const blueprint = await this.dataSource.getBlueprintContext(
      options.userId,
      routine,
    );

    const exerciseLibrary = await this.dataSource.getExerciseLibrary(
      options.userId,
      blueprint,
    );

    const rawHistory = await this.dataSource.getTrainingHistory(
      options.userId,
      {
        startDate: subtractDays(
          reportingBoundary.weekStart,
          options.historyLookbackDays ?? 28,
        ),
        endDate: reportingBoundary.weekEnd,
        timezone: options.timezone,
        recentSessionLimit: options.recentSessionLimit ?? 12,
      },
    );

    const trainingHistory = this.historyBuilder.build(
      rawHistory,
      reportingBoundary,
    );

    const currentProgram = await this.dataSource.getCurrentProgram(
      options.userId,
    );

    const recovery = await this.dataSource.getRecoveryContext(options.userId);
    const constraints = await this.dataSource.getConstraints(options.userId);

    const outputRequirements = buildOutputRequirements(options.mode);

    const partialContext = {
      schemaVersion: PROGRAMMER_CONTEXT_SCHEMA_VERSION,
      contextId: createContextId(),
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      reportingBoundary,
      user: this.normalizer.normalizeUser(user),
      objectives: this.normalizer.normalizeObjectives(objectives),
      routine: this.normalizer.normalizeRoutine(routine),
      blueprint: this.normalizer.normalizeBlueprint(blueprint),
      exerciseLibrary: this.normalizer.normalizeExerciseLibrary(
        exerciseLibrary,
      ),
      trainingHistory,
      currentProgram,
      recovery,
      constraints,
      outputRequirements,
    };

    const diagnostics = this.diagnostics.build(
      partialContext,
      options.tokenBudget,
    );

    const contextWithoutDiagnostics = {
      ...partialContext,
      diagnostics,
    };

    const contextHash = this.hasher.hash(contextWithoutDiagnostics);

    return {
      ...contextWithoutDiagnostics,
      contextHash,
    };
  }
}
```

The exact implementation should use the repository’s date, ID, logging, and validation utilities where available.

---

## 12. Normalization Rules

Normalization is necessary because database models often contain internal fields that should not be sent to the AI.

### Include

- Stable domain IDs.
- Human-readable names.
- Authoritative Blueprint prescriptions.
- Actual completed performance.
- Session and exercise lock state.
- User objectives and ranked goals.
- Explicit constraints.
- Relevant recovery data.
- Source/version metadata.
- Dates in ISO format.
- Units for load and measurements.

### Exclude

- Passwords.
- Access tokens.
- Session cookies.
- Payment data.
- Internal database credentials.
- Unrelated personal profile data.
- Raw stack traces.
- Private provider credentials.
- Redundant internal ORM metadata.
- Duplicate copies of the same exercise or session.

### Normalize

- Dates to ISO-8601.
- Training days to lowercase enum values.
- Body-region names to canonical Blueprint names.
- Exercise IDs to stable IDs.
- Load units to an explicit unit.
- Missing numeric values to `undefined`, not `0`.
- Unknown status values to a diagnostic error rather than silently coercing them.

---

## 13. History Builder

```ts
export class TrainingHistoryBuilder {
  build(
    raw: RawTrainingHistory,
    boundary: ReportingBoundary,
  ): TrainingHistoryContext {
    const recentSessions = selectRecentSessions(raw.sessions, 12);

    const weeklyAggregates = aggregateByMondaySundayWeek(
      raw.sessions,
      boundary.timezone,
    );

    const exerciseAggregates = aggregateExercisePerformance(raw.sessions);

    const bodyRegionAggregates = aggregateBodyRegionExposure(
      raw.sessions,
      raw.exerciseMetadata,
    );

    const notableEvents = detectNotableHistoryEvents(raw);

    return {
      recentSessions,
      weeklyAggregates,
      exerciseAggregates,
      bodyRegionAggregates,
      notableEvents,
    };
  }
}
```

### History Rules

- Count completed sets, not merely planned sets, for actual workload.
- Preserve skipped-set information for interpretation.
- Do not convert skipped work into future debt automatically.
- Keep recent detailed sessions separate from long-term aggregates.
- Do not include unlimited history by default.
- Expand the lookback window only when the mode or diagnostic policy requires it.
- Do not infer progression from one noisy performance point.
- Mark insufficient data explicitly.

---

## 14. Context Size and Token Diagnostics

The builder should estimate payload size before provider submission.

```ts
export interface ContextDiagnostics {
  warnings: string[];
  errors: string[];
  omittedSections: string[];
  truncatedSections: string[];
  estimatedInputTokens?: number;
  tokenBudget?: number;
  sourceRecordCounts: Record<string, number>;
  missingData: string[];
  normalizationWarnings: string[];
}
```

Recommended behavior:

1. Build the complete context.
2. Estimate serialized size.
3. If within budget, send unchanged.
4. If over budget, compact in a deterministic order:
   - Remove redundant aliases.
   - Reduce old detailed sessions while retaining aggregates.
   - Reduce low-value notes.
   - Retain all current program state.
   - Retain all Blueprint prescriptions.
   - Retain all active goals and constraints.
5. If required information would be removed, fail explicitly rather than sending an incomplete context.

Never compact away:

- Blueprint authored prescriptions.
- Selected variation identity.
- Active growth goals.
- Current locked/completed state.
- Recent actual performance required for reconciliation.
- Safety constraints.
- Output schema requirements.

---

## 15. Stable Hashing

A context hash makes provider calls auditable and helps detect accidental context drift.

```ts
export interface ContextHasher {
  hash(context: unknown): string;
}
```

Hashing requirements:

- Sort object keys recursively.
- Preserve array order where order is semantically meaningful.
- Normalize dates and numeric representations before hashing.
- Exclude volatile fields such as `generatedAt` if the hash is intended to represent semantic content.
- Use a documented algorithm such as SHA-256.
- Store the hash with the generation request and resulting program.

Recommended separate values:

```ts
semanticContextHash: string;
requestEnvelopeHash: string;
responseHash: string;
```

---

## 16. Generate vs. Reconcile Context

### Generate Week

Include:

- Full routine.
- Full selected Blueprint variation.
- Complete valid exercise library.
- Active goals.
- Recent history and aggregates.
- Current program state.
- Recovery and constraints.
- Empty or explicitly marked future-program target.

### Generate Session

Include:

- Current day and session focus.
- Relevant routine day.
- Full variation prescriptions relevant to the session.
- Recent exposure to the session’s body regions and exercises.
- Existing session state.
- Locked/in-progress details.
- Current week workload.

### Reconcile Unlocked

Include:

- Existing generated program.
- Completed and locked sessions.
- In-progress session details.
- Actual deviations from plan.
- Future unlocked sessions.
- Week-to-date actual workload.
- Remaining editable scope.
- Explicit instruction to preserve immutable content.

Reconciliation must not regenerate the entire week blindly.

---

## 17. Service Integration

```ts
export class AIProgrammerService {
  constructor(
    private readonly contextBuilder: ProgrammerContextBuilder,
    private readonly provider: AIProgrammerProvider,
    private readonly validator: ProgrammerOutputValidator,
    private readonly repository: ProgrammerProgramRepository,
  ) {}

  async generate(
    options: ProgrammerContextBuildOptions,
  ): Promise<ValidatedProgramResult> {
    const context = await this.contextBuilder.build(options);

    const providerResponse = await this.provider.generate({
      mode: options.mode,
      context,
    });

    const validated = this.validator.validate(
      providerResponse,
      context,
    );

    if (!validated.ok) {
      throw new ProgrammerValidationError(validated.errors);
    }

    return this.repository.persistValidatedProgram({
      context,
      output: validated.value,
    });
  }
}
```

The service should not let the provider write directly to the database.

The required flow is:

```text
Domain data
  → Context Builder
  → Provider
  → Output Parser
  → Schema Validation
  → Domain Validation
  → Lock/Conflict Validation
  → Persistence
```

---

## 18. Required Tests

### Unit Tests

- Monday-Sunday boundary calculation.
- Correct timezone handling.
- Current week vs. previous week separation.
- Completed sets counted correctly.
- Skipped sets not converted into debt.
- Direct and indirect exposure aggregation.
- Blueprint prescription preservation.
- Package references not converted into rigid quotas.
- Valid variation never marked invalid because of package coverage.
- Locked sessions retained.
- Completed sessions retained.
- In-progress sessions retained.
- Future unlocked sessions identified correctly.
- Missing values remain missing rather than becoming zero.
- Sensitive fields removed.
- Stable context hash for semantically identical contexts.
- Diagnostics report missing or truncated data.

### Integration Tests

- Build context from a realistic database fixture.
- Build context for each supported Blueprint variation.
- Build context with no prior training history.
- Build context with skipped sessions.
- Build context with a partially completed current session.
- Build context with locked historical sessions.
- Build context with active growth goals.
- Build context with recovery warnings.
- Build context above the token budget.
- Confirm provider receives complete context and no provider-memory dependency.

### Regression Tests

Create fixtures for previously identified failure modes:

1. AI inflates authored set counts.
2. AI copies package exercise lists rigidly.
3. AI rejects a valid variation.
4. AI rewrites completed sessions.
5. AI creates missed-set debt.
6. AI filters out exercises because of equipment during ordinary generation.
7. AI loses indirect compound exposure.
8. AI ignores user-ranked active goals.
9. AI uses stale week totals instead of actual completed work.
10. AI assumes a previous provider conversation contains missing context.

---

## 19. Acceptance Criteria

The implementation is ready when:

- A single context object fully describes the programming situation.
- The same domain state produces a stable semantic context hash.
- All valid Blueprint variations can be represented without special-case invalidation.
- Authored prescriptions remain authoritative.
- Current program lock state is explicit.
- Actual training history is distinguished from planned training.
- The AI does not need provider-side memory.
- Context compaction is deterministic and observable.
- Missing information produces diagnostics.
- The provider cannot persist unvalidated output directly.
- Generate and reconcile modes receive different, appropriate context scopes.
- Tests cover immutable state, workload accounting, Blueprint fidelity, and context completeness.

---

## 20. Implementation Order

1. Add the context types and schema version.
2. Implement repository/data-source adapters.
3. Implement date boundary and routine resolution.
4. Implement Blueprint normalization.
5. Implement exercise-library normalization.
6. Implement recent-history and aggregate builders.
7. Implement current-program lock-state extraction.
8. Implement recovery and constraint extraction.
9. Implement redaction and stable hashing.
10. Implement token diagnostics and deterministic compaction.
11. Wire the context builder into the AI programmer service.
12. Add fixtures and regression tests.
13. Run provider integration only after context tests pass.

---

## 21. Final Design Principle

The context builder is not a convenience serializer. It is the system’s **truth boundary**.

If the context is incomplete, ambiguous, or internally inconsistent, the AI may produce a plausible-looking but incorrect program. Therefore:

> The application must explicitly provide every fact the AI needs to make a programming decision, and must preserve the distinction between authoritative data, user preferences, actual training, editable state, and AI-generated proposals.
