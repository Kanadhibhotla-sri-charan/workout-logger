// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §6,
// docs/AI_PROGRAMMER_CONTEXT_BUILDER_IMPLEMENTATION.md): the explicit,
// self-contained context sent to the AI provider on every request. The
// AI must never depend on provider-side memory — every fact it needs
// for THIS request is in this object (spec §6.1).

import type { BlueprintId, GoalType, Weekday } from '../../contracts/types.js';
import type { TargetType } from '../../engine/goalResolver.js';
import type { RecoveryConstraintResult } from '../../engine/recoveryEngine.js';

export const AI_PROGRAMMER_CONTEXT_SCHEMA_VERSION = 'ai-programmer-context.v1' as const;

export interface AIProgrammerActiveGoalContext {
  goalId: string;
  goalType: GoalType;
  blueprintRef: BlueprintId;
  displayName: string;
  /** User-controlled rank — lower means higher priority. Preserved
   * exactly as stored; this context never reorders it (spec §6.2/§16
   * rule 3: "the user's ranking preserved"). */
  priority: number;
  reviewCadenceDays: number;
  mostRecentAssessment: { rating: 1 | 2 | 3 | 4 | 5; date: string } | null;
}

export interface AIProgrammerValidExerciseContext {
  exerciseId: BlueprintId;
  name: string;
  /** Blueprint's own primary/secondary muscle-role resolution for this
   * exercise against this exact target (roleFor) — a factual claim
   * about Blueprint data, never an eligibility judgment the AI must
   * accept or reject a candidate over (rule 10: "unselected exercises
   * are not automatically invalid"). */
  role: 'primary' | 'secondary';
  equipment: readonly string[];
  /** The authoritative Blueprint development-package prescription for
   * this (target, exercise) pair, when one exists — null means
   * genuinely absent (never fabricated; rule 8/9: authored prescriptions
   * are authoritative, never inflated, never invented). */
  authoredPrescription: {
    sets: number;
    repsMin: number;
    repsMax: number;
    rirMin: number;
    rirMax: number;
  } | null;
}

export interface AIProgrammerTargetContext {
  targetType: TargetType;
  targetId: BlueprintId;
  displayName: string;
  parentRegion: string | null;
  /** True when this target is tied to one of the user's own active
   * goals; false when it is covered only because the whole physique
   * must stay programmed (rule 4: "maintenance remains part of the
   * program"). */
  isSpecialization: boolean;
  goalId: string | null;
  currentWeeklyPrimarySets: number;
  weeklySecondarySets: number;
  weeklyExposureUnits: number;
  rollingExposureUnits: number;
  rollingWindowDays: number;
  lastTrainedDate: string | null;
  /** Real calendar days between `lastTrainedDate` and THIS request's
   * `targetDate` (not "today") — recomputed here because a future-
   * session proposal's recovery/frequency reasoning must be evaluated
   * against the day actually being proposed, not the day the request
   * was made. Null when never trained. */
  daysSinceLastTrainedAsOfTargetDate: number | null;
  /** Up to the 3 most recent real logged uses of each exercise touching
   * this target, most-recent-first — bounded detail, never the
   * unlimited raw history (context spec §5/§9.3). */
  exerciseHistory: Readonly<Record<BlueprintId, ReadonlyArray<{ date: string; completedSets: number }>>>;
  /** The real recoveryEngine.applyRecoveryConstraint result for this
   * target evaluated as of `targetDate` — reuses the exact same engine
   * function workoutBuilder.ts itself calls (never a re-implementation
   * of recovery logic). */
  recovery: RecoveryConstraintResult;
  /** Every valid Blueprint exercise that trains this target at all
   * (primary or secondary), via the same exerciseSelector.
   * exercisesTrainingTarget the deterministic engine's own candidate
   * gathering uses — the complete valid exercise library for this
   * target, never pre-filtered by equipment/time (rule 11), never
   * implying an unselected one is invalid (rule 10). */
  validExercises: readonly AIProgrammerValidExerciseContext[];
}

export interface AIProgrammerRoutineDayContext {
  date: string;
  weekday: Weekday;
  /** The EFFECTIVE Gym/Badminton/Both/Unselected activity for this day
   * — the recurring TrainingProfile default with this week's own
   * overrides applied (the same resolution assembleWeeklyPlanInput and
   * GET /api/programming/week use), never the raw recurring default
   * alone. */
  activity: 'gym' | 'badminton' | 'both' | 'unselected';
}

/** Repair: AI generation path was independently inventing muscle
 * allocation and set counts from raw exposure data, never reusing the
 * deterministic engine's own "how much" logic
 * (developmentReferenceEngine.ts / volumeEngine.ts) or its session-
 * identity assignment (sessionPurpose.ts). This is the deterministic
 * pre-AI programming brief that closes that gap — every field here is
 * computed by calling the EXISTING deterministic functions (never a
 * second, independently-derived volume system), and is authoritative
 * guidance the AI must follow, not merely descriptive context. See
 * programmerContextBuilder.ts's buildProgrammingBrief(). */
export interface AIProgrammerMuscleGuidance {
  targetType: TargetType;
  targetId: BlueprintId;
  /** 'complete' for an active-goal (specialization) target, 'efficient'
   * for a non-goal target — developmentReferenceEngine.ts's
   * developmentPackageLevelFor(isSpecialization), verbatim. null only
   * when this target has no Blueprint development package at all (e.g.
   * every functional_goal). */
  developmentLevel: 'complete' | 'efficient' | null;
  isGoalOriented: boolean;
  /** getDevelopmentReference().weekly_direct_set_reference — this
   * target's own Blueprint package weekly objective at its assigned
   * level. null when no package exists (see developmentLevel). */
  weeklyDevelopmentReference: number | null;
  /** getDevelopmentReference().direct_sets_per_exposure — a HARD
   * per-session ceiling when present (Blueprint-authored, never
   * invented); null when no package exists. */
  directSetsPerExposureCap: number | null;
  currentWeeklyDirectSets: number;
  /** Meaningful indirect/secondary exposure already contributed by
   * compound work this week — current_weekly_primary_sets's sibling
   * figure, never omitted (exposureEngine.ts, reused via
   * assembleWeeklyPlanInput/TargetBuildContext, never re-derived). */
  currentWeeklySecondarySets: number;
  /** volumeEngine.decideVolume()'s own recommendation — 'increase' to
   * this many weekly sets, or 'maintain' at current, or
   * 'introspect_needed' (never authorizes an increase from stagnation
   * alone). */
  volumeAction: 'maintain' | 'increase' | 'introspect_needed';
  recommendedWeeklyPrimarySets: number;
  /** This session's own share of the weekly recommendation — a RANGE
   * (floor = a conservative fraction, ceiling = directSetsPerExposureCap
   * when present, else the recommended weekly figure itself), never a
   * single rigid number and never requiring an exact match (spec:
   * "Efficient/Complete are volume/reference guidance, not fixed
   * exercise lists" — the same non-rigidity applies to the derived
   * session number). */
  recommendedSessionSets: { min: number; max: number };
  /** recoveryEngine.applyRecoveryConstraint's own priority_adjustment
   * for this target, evaluated as of targetDate — reused verbatim,
   * never re-derived. */
  recoveryAdjustment: 'none' | 'reduce' | 'avoid';
  /** Whether this target is compatible with the session's own purpose
   * (sessionPurpose.isTargetCompatibleWithPurpose) — false means this
   * target should not receive dedicated direct work THIS session
   * (e.g. an arm goal on a Push day), regardless of how large its
   * exposure gap looks; it is still listed here (never hidden) so the
   * AI understands why it's excluded rather than inventing its own
   * inclusion. Always true when the session has no identity
   * (badminton/rest/unselected days, or a functional_goal target). */
  eligibleForThisSession: boolean;
  /** decideVolume().reasoning, verbatim — full traceability from a
   * recommendation back to the deterministic decision that produced
   * it. */
  reasoning: string;
}

export interface AIProgrammerSessionIdentityContext {
  /** The session's own already-decided purpose for targetDate, read
   * from the persisted WeeklyProgramRepo program_sessions row (the
   * exact sessionPurpose value weekProgramReconciliation.ts already
   * wrote — never recomputed independently here). null on a
   * badminton/rest/unselected day, or when no program row exists yet
   * for this week. */
  purpose: 'push' | 'pull' | 'legs' | 'upper' | null;
  /** SESSION_PURPOSE_TARGETS[purpose] plus the universal targets
   * (abs/neck) — the Blueprint-defined physique_target ids this
   * session's identity expects meaningful direct coverage of. Empty
   * when purpose is null. */
  expectedCoverageTargetIds: readonly BlueprintId[];
}

export interface AIProgrammerProgrammingBrief {
  session: AIProgrammerSessionIdentityContext;
  /** One entry per target in `targets` — same order, same targetId/
   * targetType keys, so a consumer can zip the two arrays positionally
   * or join by (targetType,targetId). */
  muscles: readonly AIProgrammerMuscleGuidance[];
  /** A rough total-session set ceiling derived from
   * profile.defaultSessionDurationMinutes via workoutBuilder.ts's own
   * estimateMinutes(sets) — reused, never re-derived — the same
   * per-set time cost the deterministic engine itself budgets against.
   * Guidance, not a hard cap: the AI may reasonably exceed it only when
   * every eligible priority target's own floor still requires more
   * time than this budget suggests. */
  approxSessionSetBudget: number;
}

export interface AIProgrammerCurrentProgramContext {
  /** Whether a persisted week program row exists at all for the week
   * containing `targetDate` — informational only; this milestone never
   * reads or writes its per-day snapshots as the source of truth for
   * the proposal (spec §12: "do not automatically overwrite the
   * existing program"). */
  weekProgramExists: boolean;
  /** True when `targetDate` already has a real WorkoutSession with
   * status 'completed' or 'in_progress' — the exact same rule
   * weekProgramReconciliation.ts's isDayLocked applies. A locked date
   * can never be the target of a new AI proposal. */
  targetDateLocked: boolean;
  lockReason: string | null;
}

export interface AIProgrammerContext {
  schemaVersion: typeof AI_PROGRAMMER_CONTEXT_SCHEMA_VERSION;
  contextId: string;
  /** Stable SHA-256 hex hash over the context with `contextId`/
   * `generatedAt` excluded — semantically identical requests (same
   * user state, same targetDate) hash identically, per
   * docs/AI_PROGRAMMER_CONTEXT_BUILDER_IMPLEMENTATION.md §15. */
  contextHash: string;
  generatedAt: string;
  mode: 'generate_session';

  /** Real current date (todayForUser), never assumed from the request. */
  currentDate: string;
  timezone: string;

  reportingBoundary: {
    weekStartsOn: 'monday';
    weekEndsOn: 'sunday';
    weekStart: string;
    weekEnd: string;
  };

  targetDate: string;
  targetWeekday: Weekday;

  profile: {
    trainingDays: readonly Weekday[];
    defaultSessionDurationMinutes: number;
    minimumSessionDurationMinutes: number;
    maximumSessionDurationMinutes: number;
    /** Informational only — see executionContext below; never a
     * normal-generation eligibility filter (rule 11). */
    availableEquipment: readonly string[];
  };

  objectives: {
    primaryObjective: string;
    priorityHierarchy: readonly string[];
  };

  /** In the user's own priority order — never reordered. */
  activeGoals: readonly AIProgrammerActiveGoalContext[];

  routine: {
    targetDateActivity: 'gym' | 'badminton' | 'both' | 'unselected';
    week: readonly AIProgrammerRoutineDayContext[];
  };

  targets: readonly AIProgrammerTargetContext[];

  /** Deterministic pre-AI programming guidance — see
   * AIProgrammerProgrammingBrief's own doc comment. Authoritative: the
   * AI must follow this, not independently invent muscle allocation or
   * set counts from the raw exposure facts in `targets` above. */
  programmingBrief: AIProgrammerProgrammingBrief;

  currentProgram: AIProgrammerCurrentProgramContext;

  executionContext: {
    programmingFilteringAllowed: false;
    note: string;
  };

  outputRequirements: {
    outputSchemaVersion: string;
    forbiddenBehaviors: readonly string[];
  };

  diagnostics: {
    warnings: string[];
    missingData: string[];
    approxContextSizeChars: number;
  };
}
