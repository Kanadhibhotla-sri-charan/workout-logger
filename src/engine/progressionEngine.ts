// Progression Engine — Next Phase spec §10 ("volume progression" applies
// at the weekly-target level; this module is the per-exercise load/rep
// analogue the spec's daily-generation pipeline needs at step 20) and
// §12 (repeated decline before any reduction).
//
// Implements Blueprint's OWN progression methodology
// (BlueprintAdapter.getGlobalPrinciples().progression: "double
// progression" — add reps at a fixed load until the top of the target
// rep range is reached at the target RIR, then increase load and let
// reps fall back toward the bottom of the range) rather than inventing a
// new one. The target-RIR band used to judge "reached at the target
// RIR" is Blueprint's own `rir.typical_working_range` — not a number
// this app invented (spec §25: "do not invent coefficients").
//
// 'reduce' is only ever returned from a genuine multi-session pattern
// (RECOVERY_THRESHOLDS.consecutiveDecliningSessions consecutive
// below-range sessions), never from one bad session — spec §12: "do not
// automatically reduce volume," first inspect. A single off session
// returns 'maintain', not 'reduce'.

import type { BlueprintId } from '../contracts/types.js';
import type { Set as LoggedSet } from '../contracts/types.js';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { PROGRESSION_INCREMENTS, RECOVERY_THRESHOLDS } from './config.js';

export type ProgressionRecommendation = 'increase_load' | 'increase_reps' | 'maintain' | 'reduce' | 'unknown';

export interface ProgressionInput {
  exercise_id: BlueprintId;
  /** The prescribed rep range this exercise is currently being
   * programmed at — the "target rep range" Blueprint's double-progression
   * model requires (e.g. 8-12). Not something this module infers. */
  target_reps_min: number;
  target_reps_max: number;
  /**
   * Most-recent-first: index 0 is the last time this exercise was
   * actually performed, index 1 the time before that, etc. Only actual
   * logged sets — never planned/target sets (see this file's original
   * header note, preserved: ExercisePerformance's Set[] is ground truth,
   * ProgramSessionExercise's target_* fields are not). Needs at least
   * RECOVERY_THRESHOLDS.consecutiveDecliningSessions entries to ever
   * conclude 'reduce' — fewer is fine, a decline just can't be
   * *concluded*, only suspected (and this module never acts on a
   * suspicion, only a pattern that actually meets the threshold).
   */
  recent_sessions_actual_sets: ReadonlyArray<ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>>;
}

export interface ProgressionResult {
  exercise_id: BlueprintId;
  recommendation: ProgressionRecommendation;
  reasoning: string;
}

function completedOf(sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>) {
  return sets.filter((s) => s.completed && s.reps !== null);
}

/** True iff every completed set in `sets` reached target_reps_max at or
 * beyond the target RIR band's upper bound (i.e. did not stop with more
 * reserve than Blueprint's own typical working range calls for) — the
 * exact "top of the range at the target RIR" condition Blueprint's
 * progression.explanation describes. A set with no logged rir cannot be
 * judged against the RIR half of the condition, so it counts only on
 * reps (a slightly more permissive fallback, never blocking progression
 * purely because RIR wasn't logged). */
function reachedTopOfRangeAtTargetEffort(
  sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>,
  targetRepsMax: number,
  typicalWorkingRirMax: number
): boolean {
  const completed = completedOf(sets);
  if (completed.length === 0) return false;
  return completed.every((s) => (s.reps ?? 0) >= targetRepsMax && (s.rir === null || s.rir <= typicalWorkingRirMax));
}

/** True iff at least one completed set reached target_reps_min (within
 * the prescribed range, even if not yet at the top). */
function reachedBottomOfRange(
  sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>,
  targetRepsMin: number
): boolean {
  return completedOf(sets).some((s) => (s.reps ?? 0) >= targetRepsMin);
}

/**
 * Blueprint's double-progression model, applied to the most recent
 * actual session, with a conservative, threshold-gated 'reduce' path
 * for a genuine multi-session decline. Never throws — 'unknown' is the
 * honest answer when there isn't enough data to judge (e.g. no
 * completed sets logged yet).
 */
export function computeProgression(input: ProgressionInput): ProgressionResult {
  const { rir } = BlueprintAdapter.getGlobalPrinciples();
  const [, typicalWorkingRirMax] = rir.typical_working_range;

  const mostRecent = input.recent_sessions_actual_sets[0] ?? [];
  const mostRecentCompleted = completedOf(mostRecent);

  if (mostRecentCompleted.length === 0) {
    return {
      exercise_id: input.exercise_id,
      recommendation: 'unknown',
      reasoning: 'No completed sets logged for the most recent session of this exercise — nothing to judge progression against.',
    };
  }

  if (reachedTopOfRangeAtTargetEffort(mostRecent, input.target_reps_max, typicalWorkingRirMax)) {
    return {
      exercise_id: input.exercise_id,
      recommendation: 'increase_load',
      reasoning:
        `Every completed set reached the top of the target rep range (${input.target_reps_max}) at or below ` +
        `Blueprint's typical working RIR (≤${typicalWorkingRirMax}) — per Blueprint's double-progression model, ` +
        `increase load by ${PROGRESSION_INCREMENTS.loadKg}kg; reps are expected to fall back toward the bottom of the range next session.`,
    };
  }

  if (reachedBottomOfRange(mostRecent, input.target_reps_min)) {
    return {
      exercise_id: input.exercise_id,
      recommendation: 'increase_reps',
      reasoning:
        `Completed sets reached at least the bottom of the target rep range (${input.target_reps_min}) but not yet the top ` +
        `(${input.target_reps_max}) at target effort — per Blueprint's double-progression model, add ${PROGRESSION_INCREMENTS.reps} rep(s) ` +
        `at the same load next session before considering a load increase.`,
    };
  }

  // Fell short of even the bottom of the range — a single below-range
  // session is not evidence of decline (§12: do not automatically
  // reduce). Only a genuine run of RECOVERY_THRESHOLDS
  // .consecutiveDecliningSessions consecutive below-range sessions
  // justifies 'reduce'; otherwise this stays 'maintain' and the caller
  // (recoveryEngine / volumeEngine's introspection path) is where a
  // broader modification gets decided, not here.
  const threshold = RECOVERY_THRESHOLDS.consecutiveDecliningSessions;
  const recentWindow = input.recent_sessions_actual_sets.slice(0, threshold);
  const allBelowRange =
    recentWindow.length >= threshold && recentWindow.every((sessionSets) => !reachedBottomOfRange(sessionSets, input.target_reps_min));

  if (allBelowRange) {
    return {
      exercise_id: input.exercise_id,
      recommendation: 'reduce',
      reasoning:
        `The last ${threshold} sessions of this exercise all fell short of the bottom of the target rep range ` +
        `(${input.target_reps_min}) — a genuine repeated-decline pattern (RECOVERY_THRESHOLDS.consecutiveDecliningSessions), ` +
        `not a single off session, so a reduction is warranted (§12).`,
    };
  }

  return {
    exercise_id: input.exercise_id,
    recommendation: 'maintain',
    reasoning:
      `The most recent session fell short of the target rep range's bottom (${input.target_reps_min}), but that alone is not ` +
      `evidence of decline (§12: do not automatically reduce from one session) — maintaining current load/reps until a ` +
      `consistent pattern (or a return to range) is seen.`,
  };
}
