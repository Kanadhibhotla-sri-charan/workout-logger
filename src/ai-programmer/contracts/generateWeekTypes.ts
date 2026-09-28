// AI Weekly Programmer — generate_week: a dedicated, first-class output
// contract for AI-driven FROM-SCRATCH weekly generation. Deliberately a
// SIBLING to both AIWorkoutSessionProposal (programmerTypes.ts, one day)
// and AIWeekReconciliationOutput (weekReconciliationTypes.ts, revising an
// EXISTING week around a locked history) — never a reuse of either. A
// fresh week has no prior week to preserve/diff against (no
// changeType/locked/preservedLockedDates concepts apply), and it covers
// all 7 days as the primary output (never one day). Reuses
// AIWorkoutExerciseProposal's exact per-exercise field set (never a
// second, incompatible exercise shape), the same way
// weekReconciliationTypes.ts already does.

import type { Weekday } from '../../contracts/types.js';
import type { AIWorkoutExerciseProposal } from './programmerTypes.js';

export const AI_GENERATE_WEEK_SCHEMA_VERSION = 'ai-generate-week.v1' as const;

export type GenerateWeekDailyActivity = 'rest' | 'gym' | 'badminton' | 'both' | 'unselected';

/** Same exercise shape every other AI output contract uses, plus the one
 * extra field a whole week genuinely needs: which classification bucket
 * (specialization/normal-development/maintenance) this exercise's volume
 * counts toward — identical in spirit to
 * AIWeekReconciliationExerciseProposal, intentionally not imported from
 * there (that type lives in the reconciliation contract, a different
 * operation this one must not depend on). */
export interface AIGenerateWeekExerciseProposal extends AIWorkoutExerciseProposal {
  classification: 'specialization' | 'normal_development' | 'maintenance';
}

export interface AIGenerateWeekDaySession {
  sessionPurpose: string | null;
  availableMinutes: number;
  estimatedMinutes: number;
  exercises: AIGenerateWeekExerciseProposal[];
  /** Human-readable descriptions of anything considered but not
   * included — mirrors the deterministic engine's own skip-reason
   * concept (never a structured retry queue, just visibility). */
  skipped: string[];
}

export interface AIGenerateWeekDay {
  date: string;
  weekday: Weekday;
  activity: GenerateWeekDailyActivity;
  /** Null for a non-gym day (rest/badminton/unselected) — there is
   * nothing to persist for it beyond its activity, exactly like
   * computeFreshWeek's own FreshDayInput.hasGymComponent === false case. */
  session: AIGenerateWeekDaySession | null;
}

export interface AIGenerateWeekOutput {
  schemaVersion: typeof AI_GENERATE_WEEK_SCHEMA_VERSION;
  proposalId: string;
  mode: 'generate_week';
  weekStart: string;
  /** Always exactly 7 entries, Monday..Sunday — the complete week, never
   * a partial one (there is no existing week to fall back on for the
   * missing days, unlike reconcile_week). */
  days: AIGenerateWeekDay[];
  /** A short, week-level explanation of the overall structure/strategy
   * (e.g. which days carry which emphasis and why) — never per-exercise
   * detail, which belongs in each exercise's own rationale. */
  weekRationale: string;
  warnings: string[];
}
