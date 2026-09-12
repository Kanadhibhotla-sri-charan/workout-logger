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
