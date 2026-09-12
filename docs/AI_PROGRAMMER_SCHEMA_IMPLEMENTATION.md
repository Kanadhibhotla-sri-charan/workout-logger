# AI Programmer Schema Implementation Specification

**File:** `AI_PROGRAMMER_SCHEMA_IMPLEMENTATION.md`  
**Status:** V1 implementation guide  
**Purpose:** Convert `AI_PROGRAMMER_OUTPUT_SCHEMA.md` into repository-ready TypeScript types, runtime validation, semantic validation, normalization, and tests.

---

## 1. Implementation objective

The Workout Logger must never persist raw AI output.

The required pipeline is:

```text
AI provider response
  ↓
JSON parsing
  ↓
Runtime structural schema validation
  ↓
Semantic Blueprint validation
  ↓
Programme/lock/reconciliation validation
  ↓
Normalization into internal proposal
  ↓
Persistence transaction
```

The AI is responsible for programming decisions. The application is responsible for correctness, safety boundaries, referential integrity, immutability, and persistence.

---

## 2. Recommended file layout

Use the repository’s existing conventions if equivalent modules already exist. Do not create duplicate abstractions unnecessarily.

```text
src/
  ai/
    types/
      programmerOutput.ts
      programmerRequest.ts
      programmerErrors.ts
    schemas/
      programmerOutputSchema.ts
    validation/
      validateProgrammerOutput.ts
      validateBlueprintReferences.ts
      validateProgrammeIntegrity.ts
      validateImmutableDays.ts
      validateReconciliation.ts
    normalization/
      normalizeProgrammerOutput.ts
    providers/
      aiProvider.ts
      velonaProvider.ts
    services/
      aiProgrammerService.ts
```

Suggested tests:

```text
tests/
  ai/
    programmerOutputSchema.test.ts
    blueprintValidation.test.ts
    programmeIntegrity.test.ts
    immutableDays.test.ts
    reconciliationValidation.test.ts
    normalization.test.ts
    aiProgrammerService.test.ts
    velonaProvider.test.ts
```

If the repository uses colocated tests, follow that convention instead.

---

## 3. Dependencies

Use the project’s existing validation library if one is already installed.

Preferred V1 choice:

```bash
npm install zod
```

Do not add a second validation framework if the project already has an established equivalent.

Zod should validate external provider data. TypeScript interfaces alone are insufficient because TypeScript types disappear at runtime.

---

## 4. Core TypeScript types

Create `src/ai/types/programmerOutput.ts`.

```ts
export const AI_PROGRAMMER_OUTPUT_SCHEMA_VERSION =
  "ai-programmer-output.v1" as const;

export type AIProgrammerMode = "generate" | "reconcile";

export type ActivityType =
  | "gym"
  | "badminton"
  | "rest"
  | "other"
  | "unavailable";

export type DayStatus =
  | "proposed"
  | "preserved_locked"
  | "preserved_completed"
  | "preserved_in_progress"
  | "preserved_user_modified"
  | "not_programmed";

export type ExerciseRole =
  | "primary_compound"
  | "secondary_compound"
  | "isolation"
  | "accessory"
  | "prehab"
  | "skill"
  | "conditioning"
  | "carry"
  | "core";

export type MuscleRelationship =
  | "primary"
  | "secondary"
  | "stabilizer"
  | "indirect";

export type Emphasis = "low" | "moderate" | "high";

export type GoalContribution =
  | "direct"
  | "secondary"
  | "supporting"
  | "maintenance"
  | "none";

export type SetCapSource =
  | "blueprint_authored"
  | "blueprint_default"
  | "application_config";

export type SubstitutionPolicy = "user_managed";

export interface RepRange {
  min: number;
  max: number;
}

export interface RIRRange {
  min: number;
  max: number;
}

export interface MuscleTarget {
  muscle_id: string;
  relationship: MuscleRelationship;
  emphasis: Emphasis;
}

export interface GoalContributionRecord {
  goal_id: string;
  contribution: GoalContribution;
  reason: string;
}

export interface ExercisePrescription {
  prescription_id: string;
  exercise_id: string;
  variation_id: string;
  display_name: string;
  order: number;
  role: ExerciseRole;
  target_muscles: MuscleTarget[];
  sets: number;
  rep_range: RepRange;
  rir: RIRRange;
  rest_seconds: number;
  tempo: string | null;
  set_cap_source: SetCapSource;
  goal_contributions: GoalContributionRecord[];
  rationale: string;
  substitution_policy: SubstitutionPolicy;
}

export interface ProgrammeDay {
  day_id: string;
  date: string;
  day_of_week: string;
  activity_type: ActivityType;
  status: DayStatus;
  session_title: string | null;
  focus: string[];
  exercises: ExercisePrescription[];
  day_rationale: string;
  preserved_from_existing: boolean;
  change_reason: string | null;
}

export interface MuscleExposureSummary {
  muscle_id: string;
  direct_sets: number;
  secondary_sets: number;
  exposure_sessions: number;
  classification:
    | "growth"
    | "maintenance"
    | "support"
    | "not_emphasized";
}

export interface GoalEmphasisSummary {
  goal_id: string;
  priority_rank: number;
  emphasis_level: "low" | "moderate" | "high";
  summary: string;
}

export interface WeeklySummary {
  intended_muscle_exposure: MuscleExposureSummary[];
  goal_emphasis: GoalEmphasisSummary[];
  recovery_notes: string[];
  tradeoffs: string[];
}

export interface Programme {
  programme_id: string | null;
  programme_version: number;
  week_start: string;
  week_end: string;
  timezone: string;
  objective_summary: string;
  days: ProgrammeDay[];
  weekly_summary: WeeklySummary;
}

export type DecisionCategory =
  | "weekly_split"
  | "frequency"
  | "exercise_selection"
  | "volume"
  | "intensity"
  | "exercise_order"
  | "recovery"
  | "goal_emphasis"
  | "maintenance"
  | "reconciliation"
  | "preservation"
  | "warning";

export type Confidence = "high" | "medium" | "low";

export interface DecisionScope {
  day_id: string | null;
  exercise_id: string | null;
  goal_id: string | null;
}

export interface ProgrammingDecision {
  decision_id: string;
  category: DecisionCategory;
  scope: DecisionScope;
  decision: string;
  reason: string;
  confidence: Confidence;
}

export type WarningSeverity = "info" | "warning" | "critical";

export interface ProgrammingWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
  affected_scope: DecisionScope;
}

export interface ValidationHints {
  referenced_exercise_count: number;
  referenced_variation_count: number;
  preserved_day_count: number;
  editable_day_count: number;
  claimed_total_sets: number;
  requires_reconciliation_apply: boolean;
  contains_uncertainty: boolean;
}

export interface PreserveDayRecord {
  day_id: string;
  reason: string;
}

export type ReconciliationChangeAction =
  | "keep"
  | "replace"
  | "add"
  | "remove"
  | "modify_prescription";

export interface EditableDayChange {
  day_id: string;
  action: ReconciliationChangeAction;
  reason: string;
  replacement_day: ProgrammeDay | null;
}

export interface NoChangeDay {
  day_id: string;
  reason: string;
}

export interface DeviationConsidered {
  type: string;
  day_id: string;
  exercise_id: string | null;
  effect_on_future_programming: string;
}

export type ReconciliationStatus =
  | "no_changes"
  | "changes_proposed"
  | "blocked"
  | "insufficient_context";

export interface Reconciliation {
  base_programme_version: number;
  reconciliation_status: ReconciliationStatus;
  preserve_days: PreserveDayRecord[];
  editable_day_changes: EditableDayChange[];
  no_change_days: NoChangeDay[];
  deviations_considered: DeviationConsidered[];
}

export interface AIProgrammerOutput {
  schema_version: typeof AI_PROGRAMMER_OUTPUT_SCHEMA_VERSION;
  response_id: string;
  mode: AIProgrammerMode;
  programme: Programme;
  decisions: ProgrammingDecision[];
  warnings: ProgrammingWarning[];
  validation_hints: ValidationHints;
  reconciliation?: Reconciliation;
}
```

### Type design note

The types describe the external contract. Persistence should use a separate internal type, such as `ValidatedProgrammeProposal`, so downstream code cannot accidentally accept unvalidated provider data.

---

## 5. Zod structural schema

Create `src/ai/schemas/programmerOutputSchema.ts`.

```ts
import { z } from "zod";

const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Expected ISO date YYYY-MM-DD"
);

const nonEmptyText = z.string().trim().min(1);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const nonNegativeNumber = z.number().nonnegative();

const repRangeSchema = z
  .object({
    min: positiveInt,
    max: positiveInt,
  })
  .strict()
  .refine((value) => value.min <= value.max, {
    message: "rep_range.min must be <= rep_range.max",
  });

const rirRangeSchema = z
  .object({
    min: nonNegativeNumber,
    max: nonNegativeNumber,
  })
  .strict()
  .refine((value) => value.min <= value.max, {
    message: "rir.min must be <= rir.max",
  });

const muscleTargetSchema = z
  .object({
    muscle_id: nonEmptyText,
    relationship: z.enum([
      "primary",
      "secondary",
      "stabilizer",
      "indirect",
    ]),
    emphasis: z.enum(["low", "moderate", "high"]),
  })
  .strict();

const goalContributionSchema = z
  .object({
    goal_id: nonEmptyText,
    contribution: z.enum([
      "direct",
      "secondary",
      "supporting",
      "maintenance",
      "none",
    ]),
    reason: nonEmptyText,
  })
  .strict();

export const exercisePrescriptionSchema = z
  .object({
    prescription_id: nonEmptyText,
    exercise_id: nonEmptyText,
    variation_id: nonEmptyText,
    display_name: nonEmptyText,
    order: positiveInt,
    role: z.enum([
      "primary_compound",
      "secondary_compound",
      "isolation",
      "accessory",
      "prehab",
      "skill",
      "conditioning",
      "carry",
      "core",
    ]),
    target_muscles: z.array(muscleTargetSchema).min(1),
    sets: positiveInt,
    rep_range: repRangeSchema,
    rir: rirRangeSchema,
    rest_seconds: nonNegativeInt,
    tempo: z.string().trim().nullable(),
    set_cap_source: z.enum([
      "blueprint_authored",
      "blueprint_default",
      "application_config",
    ]),
    goal_contributions: z.array(goalContributionSchema),
    rationale: nonEmptyText,
    substitution_policy: z.literal("user_managed"),
  })
  .strict();

export const programmeDaySchema = z
  .object({
    day_id: nonEmptyText,
    date: isoDate,
    day_of_week: nonEmptyText,
    activity_type: z.enum([
      "gym",
      "badminton",
      "rest",
      "other",
      "unavailable",
    ]),
    status: z.enum([
      "proposed",
      "preserved_locked",
      "preserved_completed",
      "preserved_in_progress",
      "preserved_user_modified",
      "not_programmed",
    ]),
    session_title: z.string().trim().nullable(),
    focus: z.array(nonEmptyText),
    exercises: z.array(exercisePrescriptionSchema),
    day_rationale: nonEmptyText,
    preserved_from_existing: z.boolean(),
    change_reason: z.string().trim().nullable(),
  })
  .strict();

const weeklySummarySchema = z
  .object({
    intended_muscle_exposure: z.array(
      z
        .object({
          muscle_id: nonEmptyText,
          direct_sets: nonNegativeInt,
          secondary_sets: nonNegativeInt,
          exposure_sessions: nonNegativeInt,
          classification: z.enum([
            "growth",
            "maintenance",
            "support",
            "not_emphasized",
          ]),
        })
        .strict()
    ),
    goal_emphasis: z.array(
      z
        .object({
          goal_id: nonEmptyText,
          priority_rank: positiveInt,
          emphasis_level: z.enum(["low", "moderate", "high"]),
          summary: nonEmptyText,
        })
        .strict()
    ),
    recovery_notes: z.array(nonEmptyText),
    tradeoffs: z.array(nonEmptyText),
  })
  .strict();

export const programmeSchema = z
  .object({
    programme_id: z.string().trim().nullable(),
    programme_version: nonNegativeInt,
    week_start: isoDate,
    week_end: isoDate,
    timezone: nonEmptyText,
    objective_summary: nonEmptyText,
    days: z.array(programmeDaySchema).min(1),
    weekly_summary: weeklySummarySchema,
  })
  .strict()
  .refine((value) => value.week_start <= value.week_end, {
    message: "week_start must be <= week_end",
  });

const decisionScopeSchema = z
  .object({
    day_id: z.string().trim().nullable(),
    exercise_id: z.string().trim().nullable(),
    goal_id: z.string().trim().nullable(),
  })
  .strict();

const decisionSchema = z
  .object({
    decision_id: nonEmptyText,
    category: z.enum([
      "weekly_split",
      "frequency",
      "exercise_selection",
      "volume",
      "intensity",
      "exercise_order",
      "recovery",
      "goal_emphasis",
      "maintenance",
      "reconciliation",
      "preservation",
      "warning",
    ]),
    scope: decisionScopeSchema,
    decision: nonEmptyText,
    reason: nonEmptyText,
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const warningSchema = z
  .object({
    code: nonEmptyText,
    severity: z.enum(["info", "warning", "critical"]),
    message: nonEmptyText,
    affected_scope: decisionScopeSchema,
  })
  .strict();

const validationHintsSchema = z
  .object({
    referenced_exercise_count: nonNegativeInt,
    referenced_variation_count: nonNegativeInt,
    preserved_day_count: nonNegativeInt,
    editable_day_count: nonNegativeInt,
    claimed_total_sets: nonNegativeInt,
    requires_reconciliation_apply: z.boolean(),
    contains_uncertainty: z.boolean(),
  })
  .strict();

const preserveDaySchema = z
  .object({
    day_id: nonEmptyText,
    reason: nonEmptyText,
  })
  .strict();

const editableDayChangeSchema = z
  .object({
    day_id: nonEmptyText,
    action: z.enum([
      "keep",
      "replace",
      "add",
      "remove",
      "modify_prescription",
    ]),
    reason: nonEmptyText,
    replacement_day: programmeDaySchema.nullable(),
  })
  .strict();

const reconciliationSchema = z
  .object({
    base_programme_version: nonNegativeInt,
    reconciliation_status: z.enum([
      "no_changes",
      "changes_proposed",
      "blocked",
      "insufficient_context",
    ]),
    preserve_days: z.array(preserveDaySchema),
    editable_day_changes: z.array(editableDayChangeSchema),
    no_change_days: z.array(
      z
        .object({
          day_id: nonEmptyText,
          reason: nonEmptyText,
        })
        .strict()
    ),
    deviations_considered: z.array(
      z
        .object({
          type: nonEmptyText,
          day_id: nonEmptyText,
          exercise_id: z.string().trim().nullable(),
          effect_on_future_programming: nonEmptyText,
        })
        .strict()
    ),
  })
  .strict();

export const aiProgrammerOutputSchema = z
  .object({
    schema_version: z.literal("ai-programmer-output.v1"),
    response_id: nonEmptyText,
    mode: z.enum(["generate", "reconcile"]),
    programme: programmeSchema,
    decisions: z.array(decisionSchema),
    warnings: z.array(warningSchema),
    validation_hints: validationHintsSchema,
    reconciliation: reconciliationSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "reconcile" && !value.reconciliation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reconciliation"],
        message: "reconciliation is required in reconcile mode",
      });
    }

    if (value.mode === "generate" && value.reconciliation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reconciliation"],
        message: "reconciliation is not allowed in generate mode",
      });
    }
  });

export type ParsedAIProgrammerOutput = z.infer<
  typeof aiProgrammerOutputSchema
>;
```

### Important implementation note

The schema above validates shape and primitive values. It does not know:

- Whether IDs exist
- Whether a variation belongs to an exercise
- Whether authored set caps are respected
- Whether a day is immutable
- Whether a programme version is stale
- Whether the weekly routine permits a gym session

Those checks belong in semantic validators.

---

## 6. Semantic validation interfaces

Create `src/ai/validation/validateProgrammerOutput.ts`.

Use repository-specific types once the actual schema and repository models are mapped.

```ts
export interface BlueprintVariationRecord {
  variationId: string;
  exerciseId: string;
  canonicalName: string;
  valid: boolean;
  authoredSetCap: number | null;
  authoredRepRange: {
    min: number;
    max: number;
  } | null;
  authoredRir: {
    min: number;
    max: number;
  } | null;
  targetMuscles: Set<string>;
  packageReferences: string[];
}

export interface BlueprintCatalogue {
  exercises: Map<string, {
    exerciseId: string;
    canonicalName: string;
  }>;
  variations: Map<string, BlueprintVariationRecord>;
  muscles: Set<string>;
}

export interface GoalContext {
  goalId: string;
  active: boolean;
  priorityRank: number | null;
}

export interface RoutineDayContext {
  dayId: string;
  date: string;
  activityType: "gym" | "badminton" | "rest" | "other" | "unavailable";
}

export type ImmutableDayState =
  | "completed"
  | "in_progress"
  | "locked"
  | "user_modified"
  | "protected";

export interface ImmutableDayContext {
  dayId: string;
  state: ImmutableDayState;
  canonicalDay: unknown;
}

export interface ValidationContext {
  requestedMode: "generate" | "reconcile";
  requestedWeekStart: string;
  requestedWeekEnd: string;
  currentProgrammeVersion: number | null;
  blueprint: BlueprintCatalogue;
  goals: Map<string, GoalContext>;
  routineDays: Map<string, RoutineDayContext>;
  immutableDays: Map<string, ImmutableDayContext>;
  editableDayIds: Set<string>;
}
```

The exact types should be adapted to the existing repository models rather than duplicating domain entities permanently.

---

## 7. Semantic validator behavior

The main validator should return a normalized result or a list of typed errors.

```ts
export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
  metadata?: Record<string, unknown>;
}

export interface ValidatedProgrammeProposal {
  output: ParsedAIProgrammerOutput;
  computedTotals: {
    totalSets: number;
    exerciseCount: number;
    variationCount: number;
  };
}

export interface ValidationResult {
  ok: boolean;
  proposal?: ValidatedProgrammeProposal;
  issues: ValidationIssue[];
}
```

Suggested function:

```ts
export function validateProgrammerOutput(
  output: ParsedAIProgrammerOutput,
  context: ValidationContext
): ValidationResult {
  const issues: ValidationIssue[] = [];

  validateRequestAlignment(output, context, issues);
  validateDays(output, context, issues);
  validateBlueprintReferences(output, context, issues);
  validateGoals(output, context, issues);
  validateImmutableDays(output, context, issues);
  validateReconciliation(output, context, issues);

  const computedTotals = computeProgrammeTotals(output);

  validateSummaryConsistency(output, computedTotals, issues);

  if (issues.some((issue) => issue.severity === "error")) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    proposal: {
      output,
      computedTotals,
    },
    issues,
  };
}
```

---

## 8. Blueprint reference validator

Required checks for every exercise prescription:

```ts
function validateBlueprintReferences(
  output: ParsedAIProgrammerOutput,
  context: ValidationContext,
  issues: ValidationIssue[]
): void {
  for (const day of output.programme.days) {
    for (const prescription of day.exercises) {
      const exercise = context.blueprint.exercises.get(
        prescription.exercise_id
      );

      if (!exercise) {
        issues.push({
          code: "AI_UNKNOWN_EXERCISE",
          path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}].exercise_id`,
          message: `Unknown Blueprint exercise: ${prescription.exercise_id}`,
          severity: "error",
        });
        continue;
      }

      const variation = context.blueprint.variations.get(
        prescription.variation_id
      );

      if (!variation) {
        issues.push({
          code: "AI_UNKNOWN_VARIATION",
          path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}].variation_id`,
          message: `Unknown Blueprint variation: ${prescription.variation_id}`,
          severity: "error",
        });
        continue;
      }

      if (variation.exerciseId !== exercise.exerciseId) {
        issues.push({
          code: "AI_VARIATION_OWNERSHIP_MISMATCH",
          path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}]`,
          message: "Variation does not belong to referenced exercise.",
          severity: "error",
        });
      }

      if (!variation.valid) {
        issues.push({
          code: "AI_INVALID_VARIATION",
          path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}].variation_id`,
          message: "Referenced Blueprint variation is not valid.",
          severity: "error",
        });
      }

      if (
        variation.authoredSetCap !== null &&
        prescription.sets > variation.authoredSetCap
      ) {
        issues.push({
          code: "AI_AUTHORED_SET_CAP_EXCEEDED",
          path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}].sets`,
          message: `Requested sets exceed authored cap of ${variation.authoredSetCap}.`,
          severity: "error",
          metadata: {
            authoredSetCap: variation.authoredSetCap,
            requestedSets: prescription.sets,
          },
        });
      }

      for (const target of prescription.target_muscles) {
        if (!context.blueprint.muscles.has(target.muscle_id)) {
          issues.push({
            code: "AI_INVALID_MUSCLE_REFERENCE",
            path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}].target_muscles`,
            message: `Unknown muscle ID: ${target.muscle_id}`,
            severity: "error",
          });
        }
      }

      for (const contribution of prescription.goal_contributions) {
        if (!context.goals.has(contribution.goal_id)) {
          issues.push({
            code: "AI_INVALID_GOAL_REFERENCE",
            path: `programme.days[${day.day_id}].exercises[${prescription.prescription_id}].goal_contributions`,
            message: `Unknown goal ID: ${contribution.goal_id}`,
            severity: "error",
          });
        }
      }
    }
  }
}
```

### Critical rule

Do not add a validator that rejects a valid variation because it is absent from a package reference. Package references are programming guidance, not eligibility gates.

---

## 9. Routine and day validation

The validator must verify:

- Every output day belongs to the requested week.
- No duplicate `day_id`.
- Dates and day IDs agree.
- Gym days align with the resolved routine.
- Rest/badminton days do not contain resistance exercises unless explicitly authorized.
- A day cannot be silently omitted when the contract requires a complete week.
- A non-gym day cannot be converted into a gym day by the AI.
- Equipment and time availability are not used as normal-generation eligibility filters.

Suggested checks:

```ts
function validateDays(
  output: ParsedAIProgrammerOutput,
  context: ValidationContext,
  issues: ValidationIssue[]
): void {
  const seenDays = new Set<string>();

  for (const day of output.programme.days) {
    if (seenDays.has(day.day_id)) {
      issues.push({
        code: "AI_DUPLICATE_DAY",
        path: "programme.days",
        message: `Duplicate day ID: ${day.day_id}`,
        severity: "error",
      });
    }

    seenDays.add(day.day_id);

    const routineDay = context.routineDays.get(day.day_id);

    if (!routineDay) {
      issues.push({
        code: "AI_UNKNOWN_ROUTINE_DAY",
        path: `programme.days[${day.day_id}]`,
        message: "Output day is not present in resolved routine.",
        severity: "error",
      });
      continue;
    }

    if (day.activity_type !== routineDay.activityType) {
      issues.push({
        code: "AI_ROUTINE_CONFLICT",
        path: `programme.days[${day.day_id}].activity_type`,
        message: "AI activity type conflicts with resolved routine.",
        severity: "error",
      });
    }

    if (
      day.activity_type !== "gym" &&
      day.exercises.length > 0
    ) {
      issues.push({
        code: "AI_NON_GYM_EXERCISES",
        path: `programme.days[${day.day_id}].exercises`,
        message: "Non-gym day contains resistance-training prescriptions.",
        severity: "error",
      });
    }

    const orders = day.exercises.map((exercise) => exercise.order);
    const uniqueOrders = new Set(orders);

    if (orders.length !== uniqueOrders.size) {
      issues.push({
        code: "AI_DUPLICATE_EXERCISE_ORDER",
        path: `programme.days[${day.day_id}].exercises`,
        message: "Exercise order values must be unique.",
        severity: "error",
      });
    }
  }
}
```

The exact routine semantics should be adapted to the repository’s actual activity and override model.

---

## 10. Immutable-day validator

The AI must not alter any immutable day.

The safest implementation is to compare a canonical projection of the persisted day with the AI’s returned day.

```ts
function validateImmutableDays(
  output: ParsedAIProgrammerOutput,
  context: ValidationContext,
  issues: ValidationIssue[]
): void {
  for (const [dayId, immutableContext] of context.immutableDays) {
    const returnedDay = output.programme.days.find(
      (day) => day.day_id === dayId
    );

    if (!returnedDay) {
      issues.push({
        code: "AI_IMMUTABLE_DAY_MISSING",
        path: "programme.days",
        message: `Immutable day ${dayId} is missing from output.`,
        severity: "error",
      });
      continue;
    }

    const expected = canonicalizeImmutableDay(
      immutableContext.canonicalDay
    );
    const actual = canonicalizeImmutableDay(returnedDay);

    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      issues.push({
        code: "AI_IMMUTABLE_DAY_CHANGED",
        path: `programme.days[${dayId}]`,
        message: `Immutable day ${dayId} differs from persisted canonical data.`,
        severity: "error",
      });
    }
  }
}
```

`canonicalizeImmutableDay` must compare all persistence-relevant fields, including:

- Date
- Activity type
- Exercise IDs
- Variation IDs
- Order
- Sets
- Rep range
- RIR
- Rest
- User modifications
- Lock/completion state where represented

Do not compare only display names or rationale.

---

## 11. Reconciliation validator

For reconcile mode:

```ts
function validateReconciliation(
  output: ParsedAIProgrammerOutput,
  context: ValidationContext,
  issues: ValidationIssue[]
): void {
  if (output.mode !== "reconcile") return;

  const reconciliation = output.reconciliation;

  if (!reconciliation) {
    issues.push({
      code: "AI_RECONCILIATION_MISSING",
      path: "reconciliation",
      message: "Reconciliation object is required.",
      severity: "error",
    });
    return;
  }

  if (
    context.currentProgrammeVersion !== null &&
    reconciliation.base_programme_version !==
      context.currentProgrammeVersion
  ) {
    issues.push({
      code: "AI_STALE_PROGRAMME_VERSION",
      path: "reconciliation.base_programme_version",
      message: "AI reconciled against a stale programme version.",
      severity: "error",
    });
  }

  for (const change of reconciliation.editable_day_changes) {
    if (!context.editableDayIds.has(change.day_id)) {
      issues.push({
        code: "AI_IMMUTABLE_DAY_CHANGED",
        path: `reconciliation.editable_day_changes[${change.day_id}]`,
        message: "Reconciliation change targets a non-editable day.",
        severity: "error",
      });
    }

    if (
      ["replace", "add", "modify_prescription"].includes(change.action) &&
      !change.replacement_day
    ) {
      issues.push({
        code: "AI_REPLACEMENT_DAY_MISSING",
        path: `reconciliation.editable_day_changes[${change.day_id}].replacement_day`,
        message: "A replacement action requires a complete replacement day.",
        severity: "error",
      });
    }

    if (
      ["keep", "remove"].includes(change.action) &&
      change.replacement_day
    ) {
      issues.push({
        code: "AI_UNEXPECTED_REPLACEMENT_DAY",
        path: `reconciliation.editable_day_changes[${change.day_id}].replacement_day`,
        message: "This reconciliation action must not include a replacement day.",
        severity: "error",
      });
    }
  }
}
```

The validator must also verify that the output does not:

- Modify actual historical sessions
- Convert skipped work into completed work
- Unlock protected days
- Create automatic missed-set debt
- Treat the calendar week as a mandatory volume-reset boundary

---

## 12. Summary recomputation

Never trust AI-reported totals.

```ts
export function computeProgrammeTotals(
  output: ParsedAIProgrammerOutput
): {
  totalSets: number;
  exerciseCount: number;
  variationCount: number;
} {
  const exercises = output.programme.days.flatMap(
    (day) => day.exercises
  );

  return {
    totalSets: exercises.reduce(
      (total, exercise) => total + exercise.sets,
      0
    ),
    exerciseCount: exercises.length,
    variationCount: new Set(
      exercises.map((exercise) => exercise.variation_id)
    ).size,
  };
}
```

Compare computed values with `validation_hints`. A mismatch should be an error or warning according to policy, but the computed values must be used for persistence and audit.

For `weekly_summary`, recompute direct sets, secondary sets, and exposure sessions from the authoritative target mappings rather than trusting the model’s summary.

---

## 13. Normalization boundary

Create `src/ai/normalization/normalizeProgrammerOutput.ts`.

Normalization may:

- Replace display names with canonical Blueprint names
- Normalize exercise ordering
- Normalize optional null values
- Normalize date/time formatting
- Recompute summaries
- Remove provider-only metadata not needed downstream

Normalization must not silently:

- Change exercise IDs
- Change variation IDs
- Increase/decrease sets
- Change rep ranges
- Change RIR
- Move sessions
- Alter immutable days
- Convert invalid output into valid output by guessing

Suggested signature:

```ts
export function normalizeValidatedOutput(
  validated: ValidatedProgrammeProposal,
  context: ValidationContext
): ValidatedProgrammeProposal {
  // Only non-substantive normalization belongs here.
  return validated;
}
```

If substantive repair is required, reject the response or use one bounded correction request before validation.

---

## 14. Provider interface

Create `src/ai/providers/aiProvider.ts`.

```ts
import type { AIProgrammerOutput } from "../types/programmerOutput";

export interface AIProgramRequest {
  requestId: string;
  mode: "generate" | "reconcile";
  model: string;
  systemInstruction: string;
  contextPayload: string;
  timeoutMs: number;
}

export interface AIProviderMetadata {
  provider: string;
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  providerRequestId?: string;
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

The provider should return raw text plus metadata. Parsing and validation belong to the application service, not the provider.

---

## 15. AI programmer service

Create `src/ai/services/aiProgrammerService.ts`.

```ts
export async function generateValidatedProgramme(
  request: AIProgramRequest,
  provider: AIProvider,
  validationContext: ValidationContext
): Promise<ValidatedProgrammeProposal> {
  const providerResult = await provider.generateProgram(request);

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(providerResult.rawText);
  } catch {
    throw new AIProgrammerError(
      "AI_INVALID_JSON",
      "AI provider returned invalid JSON."
    );
  }

  const parsed = aiProgrammerOutputSchema.safeParse(parsedJson);

  if (!parsed.success) {
    throw new AIProgrammerError(
      "AI_SCHEMA_MISMATCH",
      "AI response failed structural schema validation.",
      parsed.error.flatten()
    );
  }

  const semanticResult = validateProgrammerOutput(
    parsed.data,
    validationContext
  );

  if (!semanticResult.ok || !semanticResult.proposal) {
    throw new AIProgrammerError(
      "AI_SEMANTIC_VALIDATION_FAILED",
      "AI response failed semantic validation.",
      semanticResult.issues
    );
  }

  return semanticResult.proposal;
}
```

The actual implementation should include:

- Request/response audit metadata
- Response-size limits
- Timeout handling
- Optional one-time bounded correction retry
- No persistence inside the provider
- No direct database access from the AI layer

---

## 16. Error type

```ts
export class AIProgrammerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AIProgrammerError";
  }
}
```

Recommended error codes:

- `AI_INVALID_JSON`
- `AI_SCHEMA_MISMATCH`
- `AI_SEMANTIC_VALIDATION_FAILED`
- `AI_UNKNOWN_EXERCISE`
- `AI_UNKNOWN_VARIATION`
- `AI_VARIATION_OWNERSHIP_MISMATCH`
- `AI_INVALID_VARIATION`
- `AI_AUTHORED_SET_CAP_EXCEEDED`
- `AI_INVALID_MUSCLE_REFERENCE`
- `AI_INVALID_GOAL_REFERENCE`
- `AI_ROUTINE_CONFLICT`
- `AI_IMMUTABLE_DAY_CHANGED`
- `AI_STALE_PROGRAMME_VERSION`
- `AI_SUMMARY_MISMATCH`
- `AI_PROVIDER_TIMEOUT`
- `AI_PROVIDER_FAILURE`

---

## 17. Persistence boundary

Repository persistence functions must accept only validated internal proposals.

Bad:

```ts
await programsRepo.saveAIResponse(rawProviderJson);
```

Good:

```ts
const proposal = await aiProgrammerService.generateValidatedProgramme(...);

await programsRepo.applyValidatedProposal({
  proposal,
  expectedProgrammeVersion,
});
```

The persistence adapter must:

1. Verify the programme version again inside the transaction.
2. Re-read immutable/locked day state before writing.
3. Apply only editable future-day changes.
4. Preserve completed and in-progress actual sessions.
5. Write the new programme version atomically.
6. Record an audit event.
7. Roll back all writes if any invariant fails.

Validation before persistence is necessary but not sufficient. Concurrency checks must occur at the persistence boundary too.

---

## 18. Test matrix

### Structural schema tests

- Valid Generate response parses.
- Valid Reconcile response parses.
- Reconcile without reconciliation object fails.
- Generate with reconciliation object fails.
- Missing required field fails.
- Unknown enum fails.
- Negative sets fail.
- Invalid rep range fails.
- Invalid RIR range fails.
- Duplicate unsupported fields fail if strict mode is used.
- Invalid date fails.

### Blueprint tests

- Unknown exercise ID fails.
- Unknown variation ID fails.
- Variation/exercise mismatch fails.
- Invalid variation fails.
- Authored set cap exceeded fails.
- Valid variation outside package references succeeds.
- Unknown muscle fails.
- Unknown goal fails.
- Canonical display name normalization works.

### Routine tests

- Gym day with valid exercises succeeds.
- Rest day with exercises fails.
- Badminton day with resistance exercises fails.
- Wrong week fails.
- Duplicate day fails.
- Duplicate exercise order fails.
- Routine activity mismatch fails.

### Immutable-session tests

- Completed day changed fails.
- In-progress day changed fails.
- Locked day changed fails.
- User-modified day changed fails.
- Protected day omitted fails.
- Immutable day rationale changed but prescription remains identical: define whether accepted; recommended to ignore rationale for canonical equality.
- Future editable day changed succeeds.

### Reconciliation tests

- Correct base programme version succeeds.
- Stale programme version fails.
- Change targeting immutable day fails.
- Replacement without replacement day fails.
- Keep with replacement day fails.
- Actual completed session is never altered.
- Skipped exercise does not create debt.
- Calendar-week boundary does not force reset.

### Provider/service tests

- Provider timeout maps to provider timeout error.
- Provider returns invalid JSON.
- Provider returns structurally invalid JSON.
- Provider returns semantically invalid JSON.
- One bounded correction retry works.
- Second failure leaves persistence untouched.
- Provider metadata is recorded.
- Secrets are not logged.

---

## 19. Suggested implementation order

1. Add external output types.
2. Add Zod schema.
3. Add typed validation errors.
4. Build Blueprint catalogue adapter.
5. Build routine and immutable-state adapters.
6. Implement semantic validators.
7. Implement normalization.
8. Add provider interface.
9. Add mocked provider service tests.
10. Integrate persistence only after validation tests pass.
11. Add Velona provider.
12. Run dry-run generation against real historical context.
13. Enable behind a feature flag.

---

## 20. Definition of done

This implementation is complete when:

- Raw AI output cannot reach persistence.
- Runtime schema validation is active.
- Semantic Blueprint validation is active.
- Authored set caps are enforced.
- Package membership is not an eligibility gate.
- Routine conflicts are rejected.
- Immutable sessions are preserved.
- Reconciliation is version-checked.
- Summaries are independently recomputed.
- Provider failures are handled safely.
- Tests cover all critical rejection cases.
- A validated internal proposal is the only input accepted by persistence.
