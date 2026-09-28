// AI Weekly Programmer — generate_week: the explicit, self-contained
// context for a FROM-SCRATCH week. A sibling to AIReconciliationContext
// (reconciliationContextTypes.ts), never a reuse of it: there is no
// existing persisted week to preserve/diff against here (no
// existingProgram/lockedDates/request/proposedChange fields), because
// this only ever runs when no such week exists yet
// (ensureWeekProgramGenerated's own "no valid persisted week" branch).
// Shares every type it genuinely can (AIProgrammerActiveGoalContext,
// AIProgrammerTargetContext, AIProgrammerRoutineDayContext) rather than
// re-declaring them.

import type { AICrossWeekContext, AIProgrammerActiveGoalContext, AIProgrammerContext, AIProgrammerRoutineDayContext, AIProgrammerTargetContext } from './programmerContextTypes.js';
import type { CoachingFoundationContext } from '../../coaching/foundationContext.js';

export const AI_GENERATE_WEEK_CONTEXT_SCHEMA_VERSION = 'ai-generate-week-context.v1' as const;

export interface AIGenerateWeekContext {
  schemaVersion: typeof AI_GENERATE_WEEK_CONTEXT_SCHEMA_VERSION;
  contextId: string;
  contextHash: string;
  generatedAt: string;
  mode: 'generate_week';

  weekStart: string;
  currentDate: string;
  timezone: string;

  reportingBoundary: {
    weekStartsOn: 'monday';
    weekEndsOn: 'sunday';
    weekStart: string;
    weekEnd: string;
  };

  profile: {
    trainingDays: readonly string[];
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

  /** This week's own effective (override-applied) activity for every
   * day — the same resolution GET /api/programming/week uses. There is
   * no `proposedChange` here (unlike reconciliation): nothing is being
   * changed, the whole week is being created for the first time. */
  routine: {
    week: readonly AIProgrammerRoutineDayContext[];
  };

  targets: readonly AIProgrammerTargetContext[];

  /** Context-bloat fix (2026-09-18) — see AIProgrammerContext's own doc
   * comment on this identical field. */
  intensityTechniqueCatalogue: AIProgrammerContext['intensityTechniqueCatalogue'];

  /** Cross-Week Programming Intelligence — see AICrossWeekContext's own
   * doc comment. `persistedProgram` is always undefined for this
   * context (no week exists yet), an already-supported case this
   * builder shares with reconciliation's own "no persisted week"
   * branch. */
  crossWeek: AICrossWeekContext;

  /** Coaching Depth Batch 1 §7 — see AIProgrammerContext's own doc
   * comment on this identical field. `persistedWeekSessions` is always
   * empty for this context. */
  coachingFoundation: CoachingFoundationContext;

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
