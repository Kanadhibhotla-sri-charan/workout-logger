// Exposure Engine — implements docs/TRAINING_EXPOSURE_MODEL.md's rules A
// (direct exposure) and D (uncompleted sets), both plain facts, plus C
// (set contribution) and the Strategy A indirect-exposure choice (§B),
// both IMPLEMENTED — PROVISIONAL: real, tested code, but a conservative
// engineering representation of exposure, not an approved final
// training/physiology methodology. Indirect exposure is not tracked at
// all under Strategy A — only an exercise's own listed
// physique_targets/functional_goals produce exposure. G (weekly/rolling
// aggregation) is implemented and is not itself a physiology claim, but
// it aggregates C's provisional numbers.
//
// Pure functions throughout (§32): every function here takes already-
// fetched plain data and returns a value — none of them touch the
// database. Callers (routes, fixtures) fetch WorkoutSession/
// ExercisePerformance data via the repositories and pass it in.
//
// Output is in `exposure_units`, never "effective sets" — see
// docs/TRAINING_EXPOSURE_MODEL.md §6 for why that distinction matters.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { BlueprintId, TrainingExposure, Weekday } from '../contracts/types.js';
import { isDateInRange, rollingRangeEnding, weekRangeContaining } from './dateMath.js';
import type { TargetType } from './goalResolver.js';

export class UnknownExerciseInExposureCalculationError extends Error {
  constructor(public exerciseId: string) {
    super(`"${exerciseId}" is not a known Blueprint exercise id`);
    this.name = 'UnknownExerciseInExposureCalculationError';
  }
}

export interface ExposureContribution {
  exercise_id: BlueprintId;
  target_type: TargetType;
  target_id: BlueprintId;
  completed_sets: number;
  /** = completed_sets under the provisional rule (C): full credit per
   * listed target, no fractional split. NOT a claim of physiological
   * precision — see docs/TRAINING_EXPOSURE_MODEL.md §C, §6. */
  exposure_units: number;
}

/**
 * Rule A + C + D for one exercise performance: every target the exercise
 * directly lists gets `completed_sets` exposure_units (uncompleted sets
 * contribute nothing — rule D). Throws
 * UnknownExerciseInExposureCalculationError for an unresolvable exercise
 * id — exposure must never be silently computed against a phantom
 * exercise.
 */
export function calculateExerciseExposure(
  exerciseId: BlueprintId,
  sets: ReadonlyArray<{ completed: boolean }>
): ExposureContribution[] {
  const exercise = BlueprintAdapter.getExercise(exerciseId);
  if (!exercise) throw new UnknownExerciseInExposureCalculationError(exerciseId);

  const completedSets = sets.filter((s) => s.completed).length;
  if (completedSets === 0) return [];

  const targets: Array<{ target_type: TargetType; target_id: BlueprintId }> = [
    ...(exercise.physique_targets ?? []).map((target_id) => ({ target_type: 'physique_target' as const, target_id })),
    ...(exercise.functional_goals ?? []).map((target_id) => ({ target_type: 'functional_goal' as const, target_id })),
  ];

  return targets.map((t) => ({
    exercise_id: exerciseId,
    target_type: t.target_type,
    target_id: t.target_id,
    completed_sets: completedSets,
    exposure_units: completedSets,
  }));
}

/** Shape exposureEngine consumes for a single day's exercises — deliberately
 * narrower than the full ExercisePerformance/Set contracts, since exposure
 * only needs exercise_id and each set's completed flag. */
export interface SessionExposureInput {
  date: string;
  exercises: ReadonlyArray<{ exercise_id: BlueprintId; sets: ReadonlyArray<{ completed: boolean }> }>;
}

/**
 * Rule G: sums exposure_units per (target_type, target_id) across every
 * session in `sessions` whose date falls within [periodStart, periodEnd]
 * (inclusive) — a pure aggregation, no query of its own. `sessions`
 * should already be the caller's fetched, relevant date range (or a
 * superset of it); this function filters again defensively so callers
 * don't have to get date-boundary math exactly right upstream.
 */
export function aggregateExposure(
  sessions: ReadonlyArray<SessionExposureInput>,
  periodStart: string,
  periodEnd: string
): TrainingExposure[] {
  const byTarget = new Map<string, TrainingExposure>();

  for (const session of sessions) {
    if (!isDateInRange(session.date, periodStart, periodEnd)) continue;

    for (const exercise of session.exercises) {
      const contributions = calculateExerciseExposure(exercise.exercise_id, exercise.sets);
      for (const c of contributions) {
        const key = `${c.target_type}:${c.target_id}`;
        const existing = byTarget.get(key);
        if (existing) {
          existing.total_sets += c.completed_sets;
          existing.exposure_units += c.exposure_units;
          if (!existing.exercise_ids.includes(c.exercise_id)) existing.exercise_ids.push(c.exercise_id);
        } else {
          byTarget.set(key, {
            target_type: c.target_type,
            target_id: c.target_id,
            period_start: periodStart,
            period_end: periodEnd,
            exercise_ids: [c.exercise_id],
            total_sets: c.completed_sets,
            exposure_units: c.exposure_units,
          });
        }
      }
    }
  }

  return [...byTarget.values()];
}

/** Rule G, weekly: the 7-day window containing `date`, per the configured
 * (never hard-coded) week_start_day. */
export function aggregateWeeklyExposure(
  sessions: ReadonlyArray<SessionExposureInput>,
  date: string,
  weekStartDay: Weekday
): TrainingExposure[] {
  const { start, end } = weekRangeContaining(date, weekStartDay);
  return aggregateExposure(sessions, start, end);
}

/** Rule G, rolling: an explicit `windowDays`-length window ending on
 * `asOfDate` — no silent default, callers choose 7/14/whatever fits the
 * question being asked. See docs/TRAINING_EXPOSURE_MODEL.md §G. */
export function aggregateRollingExposure(
  sessions: ReadonlyArray<SessionExposureInput>,
  asOfDate: string,
  windowDays: number
): TrainingExposure[] {
  const { start, end } = rollingRangeEnding(asOfDate, windowDays);
  return aggregateExposure(sessions, start, end);
}
