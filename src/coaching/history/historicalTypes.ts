// Coaching Depth Batch 1 spec §6: a READ-ONLY observation layer over
// completed training data. Nothing in this module (or anything that
// consumes it in this batch) automatically changes programming — see
// trendCalculations.ts's own doc comment for the exact non-goal list.

/** One real, normalized exercise exposure — built from a real
 * `workout_sessions`/`workout_exercises`/`workout_sets` row combination
 * (historicalService.ts's own adapter), never fabricated. A field is
 * `undefined` — never a fabricated `0`/false value — whenever the
 * underlying data genuinely was not recorded (spec §6.3: "missing data
 * is not zero"). */
export interface HistoricalExerciseExposure {
  date: string;
  programId?: string;
  targetId: string;
  exerciseId: string;
  prescribedSets?: number;
  completedSets?: number;
  prescribedRepsMin?: number;
  prescribedRepsMax?: number;
  /** Only the reps of sets that were actually logged as completed with a
   * real numeric rep count — never zero-filled for a set that was never
   * logged. */
  completedReps?: number[];
  /** `weight * (1 + reps / 30)` averaged over this exposure's own
   * completed sets that have BOTH a real weight and a real rep count —
   * the exact existing precedent `goalPhaseEngine.ts`'s
   * `gatherReviewEvidence` already uses for aesthetic-goal load trends,
   * reused here rather than re-invented. `undefined` when no set in
   * this exposure has both values. */
  load?: number;
  /** Average of this exposure's own completed sets' real (non-null) RIR
   * values. `undefined` when none were recorded — never defaulted to 0
   * (spec §6.3: "missing RIR != RIR 0"). */
  rir?: number;
  completionStatus: 'completed' | 'partial' | 'missed' | 'unknown';
}

export type TrendDataQuality = 'insufficient' | 'limited' | 'sufficient';
export type BasicTrendDirection = 'up' | 'down' | 'stable' | 'unknown';

export interface TargetHistoricalSummary {
  targetId: string;
  windowStart: string;
  windowEnd: string;
  /** Total exposures in the window regardless of status (completed,
   * partial, missed, or unknown). */
  exposureCount: number;
  completedExposureCount: number;
  /** Exposures that were at least SCHEDULED (had a real
   * workout_sessions/workout_exercises row prescribing them) whatever
   * their eventual status — distinct from `exposureCount`, which also
   * counts a genuinely unplanned/ad hoc logged exposure with no prior
   * prescription. */
  scheduledExposureCount: number;
  prescribedSets?: number;
  completedSets?: number;
  /** `completedSets / prescribedSets` — computed ONLY when both values
   * are known and `prescribedSets > 0` (spec §6.4); `undefined`
   * otherwise, never a fabricated 0 or 1. */
  completionRatio?: number;
  averageLoad?: number;
  latestExposureDate?: string;
  /** Spec §6.5: computed and reported here for a future consumer to
   * read, but never acted on anywhere in this batch — see
   * trendCalculations.ts's own doc comment. */
  trend: BasicTrendDirection;
  dataQuality: TrendDataQuality;
}
