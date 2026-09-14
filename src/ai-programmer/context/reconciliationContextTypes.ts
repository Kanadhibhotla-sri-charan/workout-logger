// AI-Powered Weekly Reconciliation: the explicit, self-contained context
// for `mode: "reconcile_week"` — deliberately a SIBLING type to
// AIProgrammerContext (programmerContextTypes.ts), not a reuse of it,
// since a whole-week reconciliation needs a 7-day existing-program view
// and an explicit proposed-change description that a single targetDate
// context has no room for. Shares every type it genuinely can
// (AIProgrammerActiveGoalContext, AIProgrammerTargetContext,
// AIProgrammerRoutineDayContext) rather than re-declaring them.

import type { Weekday } from '../../contracts/types.js';
import type { AICrossWeekContext, AIProgrammerActiveGoalContext, AIProgrammerRoutineDayContext, AIProgrammerTargetContext } from './programmerContextTypes.js';

export const AI_RECONCILIATION_CONTEXT_SCHEMA_VERSION = 'ai-reconciliation-context.v1' as const;

export type ReconciliationDailyActivity = 'gym' | 'badminton' | 'both' | 'unselected';

export interface AIReconciliationPlannedWorkItemContext {
  exerciseId: string;
  targetType: string;
  targetId: string;
  classification: string;
  sets: number;
  repsMin: number | null;
  repsMax: number | null;
  rirMin: number | null;
  rirMax: number | null;
}

export interface AIReconciliationRealSessionContext {
  sessionId: string;
  status: 'planned' | 'in_progress' | 'completed' | 'skipped';
  sourceType: string;
}

export interface AIReconciliationExistingDayContext {
  date: string;
  weekday: Weekday;
  activity: ReconciliationDailyActivity;
  /** True for a completed/in-progress real session on this date — the
   * exact same rule weekProgramReconciliation.ts's isDayLocked applies
   * (reused, not re-derived — see reconciliationContextBuilder.ts). A
   * locked day's plan must be preserved exactly by the model. */
  locked: boolean;
  lockReason: string | null;
  programSessionExists: boolean;
  sessionPurpose: string | null;
  plannedWork: readonly AIReconciliationPlannedWorkItemContext[];
  /** The real, actionable `workout_sessions` row for this date, if any
   * (via the shared `resolveSelectedSession` resolver — never a second,
   * independently-derived notion of "the" session for a day). Null when
   * none exists. */
  realSession: AIReconciliationRealSessionContext | null;
}

export interface AIReconciliationContext {
  schemaVersion: typeof AI_RECONCILIATION_CONTEXT_SCHEMA_VERSION;
  contextId: string;
  contextHash: string;
  generatedAt: string;
  mode: 'reconcile_week';

  request: {
    targetDate: string;
    requestedActivity: 'gym';
    reason: string | null;
    swapUnavailableReason: string | null;
  };

  currentDate: string;
  timezone: string;

  reportingBoundary: {
    weekStartsOn: 'monday';
    weekEndsOn: 'sunday';
    weekStart: string;
    weekEnd: string;
  };

  targetWeekday: Weekday;

  profile: {
    trainingDays: readonly Weekday[];
    defaultSessionDurationMinutes: number;
    minimumSessionDurationMinutes: number;
    maximumSessionDurationMinutes: number;
    availableEquipment: readonly string[];
  };

  objectives: {
    primaryObjective: string;
    priorityHierarchy: readonly string[];
  };

  activeGoals: readonly AIProgrammerActiveGoalContext[];

  routine: {
    /** The full week's EFFECTIVE (override-applied) activity, BEFORE
     * this request's own proposed change is applied — the same
     * resolution GET /api/programming/week uses. */
    week: readonly AIProgrammerRoutineDayContext[];
    proposedChange: { date: string; currentActivity: ReconciliationDailyActivity | 'rest'; requestedActivity: 'gym' };
  };

  existingProgram: readonly AIReconciliationExistingDayContext[];

  targets: readonly AIProgrammerTargetContext[];

  /** Cross-Week Programming Intelligence Fix — see AICrossWeekContext's
   * own doc comment (programmerContextTypes.ts). */
  crossWeek: AICrossWeekContext;

  /** Convenience flat list of every date in `existingProgram` with
   * `locked: true` — the model must return `changeType: "unchanged"`
   * for every one of these (domain-validated, never trusted from the
   * model's own claim). */
  lockedDates: readonly string[];

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
