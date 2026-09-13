// AI-Powered Weekly Reconciliation: a distinct, dedicated output
// contract for `mode: "reconcile_week"` — deliberately NOT the
// single-session `AIWorkoutSessionProposal` shape (programmerTypes.ts),
// which cannot represent a full week of days plus per-day change intent
// and lock preservation. Reuses `AIWorkoutExerciseProposal`'s exact
// field set (never a second, incompatible exercise shape) via
// intersection, only adding the one field (`classification`) a
// per-exercise entry needs here that the single-session shape doesn't.

import type { Weekday } from '../../contracts/types.js';
import type { AIWorkoutExerciseProposal } from './programmerTypes.js';

export const AI_WEEK_RECONCILIATION_SCHEMA_VERSION = 'ai-week-reconciliation.v1' as const;

export type ReconciliationDailyActivity = 'rest' | 'gym' | 'badminton' | 'both' | 'unselected';

export type ReconciliationDayChangeType = 'unchanged' | 'modified' | 'new' | 'removed';

/** Same exercise shape `AIWorkoutSessionProposal` already uses (never a
 * second, incompatible one), plus the one extra field a whole-week
 * reconciliation genuinely needs: which classification bucket
 * (specialization/normal-development/maintenance) this exercise's
 * volume counts toward — the same taxonomy
 * developmentReferenceEngine.ts's classification already uses
 * elsewhere in this codebase. */
export interface AIWeekReconciliationExerciseProposal extends AIWorkoutExerciseProposal {
  classification: 'specialization' | 'normal_development' | 'maintenance';
}

export interface AIWeekReconciliationDaySession {
  sessionPurpose: string | null;
  availableMinutes: number;
  estimatedMinutes: number;
  exercises: AIWeekReconciliationExerciseProposal[];
  /** Human-readable descriptions of anything considered but not
   * included (mirrors the deterministic engine's own skip-reason
   * concept — never a structured retry queue, just visibility). */
  skipped: string[];
}

export interface AIWeekReconciliationDay {
  date: string;
  weekday: Weekday;
  activity: ReconciliationDailyActivity;
  /** Whether this day's plan differs from what was persisted before
   * this reconciliation. `locked` days are always `'unchanged'` — the
   * model is never allowed to change what a locked day's response
   * reports (domain validation enforces this; see
   * weekReconciliationDomainValidator.ts). */
  changeType: ReconciliationDayChangeType;
  /** True for a day the model must preserve exactly (completed/
   * in-progress workout, or outside this reconciliation's own target
   * week) — informational for validation, not itself re-derived from
   * the model's own claim (domain validation re-checks this against the
   * context's own lockedDates, never trusts this field at face value
   * for anything the model could get away with lying about). */
  locked: boolean;
  session: AIWeekReconciliationDaySession | null;
}

export interface AIWeekReconciliationOutput {
  schemaVersion: typeof AI_WEEK_RECONCILIATION_SCHEMA_VERSION;
  proposalId: string;
  mode: 'reconcile_week';
  targetDate: string;
  requestedActivity: 'gym';
  /** Always exactly 7 entries, Monday..Sunday, covering the full week
   * containing `targetDate` — never a partial week (spec §7 "return all
   * seven days"). */
  days: AIWeekReconciliationDay[];
  reconciliation: {
    changedDates: string[];
    preservedLockedDates: string[];
    rationale: string;
    warnings: string[];
  };
}
