// Exposure Engine — implements the compound muscle exposure model from
// the Next Phase spec §7-8, §13, and docs/TRAINING_EXPOSURE_MODEL.md's
// rules A (direct exposure), C (set contribution), D (uncompleted sets),
// and G (weekly/rolling aggregation).
//
// §7's primary/secondary role split is now IMPLEMENTED (superseding
// Phase 2's Strategy-A-only, indirect-not-tracked position — see
// docs/TRAINING_EXPOSURE_MODEL.md's revision note and
// docs/open-decisions.md #6 for why this spec's explicit instruction
// takes precedence): every set contributes EXPOSURE_COEFFICIENTS.primary
// (1.00) to each target the exercise's own canonical
// physique_targets/functional_goals lists, and EXPOSURE_COEFFICIENTS
// .secondary (0.33) to each target resolved from the exercise's
// secondary_targets free text via
// src/blueprint/secondaryTargetMapping.ts — an explicit, documented,
// non-fuzzy dictionary (see docs/SECONDARY_TARGET_MAPPING.md), because
// Blueprint itself has no canonical secondary-target field. A
// secondary_targets phrase with no confident mapping contributes zero
// exposure but is surfaced, never silently dropped — see
// `unmapped_secondary_phrases`.
//
// Pure functions throughout (§32 of the Training Engine design): every
// function here takes already-fetched plain data and returns a value —
// none of them touch the database.
//
// Output is in `exposure_units`, never "effective sets" — see
// docs/TRAINING_EXPOSURE_MODEL.md §6 for why that distinction matters.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import { normalizeTargetPhrase, resolveSecondaryTarget } from '../blueprint/secondaryTargetMapping.js';
import type { BlueprintId, TrainingExposure, Weekday } from '../contracts/types.js';
import { EXPOSURE_COEFFICIENTS } from './config.js';
import { isDateInRange, rollingRangeEnding, weekRangeContaining } from './dateMath.js';
import type { TargetType } from './goalResolver.js';

export class UnknownExerciseInExposureCalculationError extends Error {
  constructor(public exerciseId: string) {
    super(`"${exerciseId}" is not a known Blueprint exercise id`);
    this.name = 'UnknownExerciseInExposureCalculationError';
  }
}

export type ExposureRole = 'primary' | 'secondary';

export interface ExposureContribution {
  exercise_id: BlueprintId;
  target_type: TargetType;
  target_id: BlueprintId;
  role: ExposureRole;
  completed_sets: number;
  /** = completed_sets * EXPOSURE_COEFFICIENTS[role]. Spec §7: primary =
   * 1.00/set, secondary = 0.33/set — see docs/TRAINING_EXPOSURE_MODEL.md
   * §6 for why this still isn't "effective hypertrophy sets." */
  exposure_units: number;
}

export interface ExerciseExposureResult {
  contributions: ExposureContribution[];
  /** Normalized secondary_targets phrases Blueprint lists for this
   * exercise that have no entry in secondaryTargetMapping.ts — real
   * information Blueprint provided that this app cannot yet turn into
   * exposure, surfaced for explainability rather than silently dropped.
   * See docs/SECONDARY_TARGET_MAPPING.md. */
  unmapped_secondary_phrases: string[];
}

/**
 * Rule A + C + D + §7's role split, for one exercise performance.
 * Primary targets (exercise.physique_targets / .functional_goals) get
 * `completed_sets * primary_coefficient`; secondary targets (resolved
 * from exercise.secondary_targets via the curated mapping) get
 * `completed_sets * secondary_coefficient`. Uncompleted sets contribute
 * nothing (rule D). Throws UnknownExerciseInExposureCalculationError for
 * an unresolvable exercise id.
 */
export function calculateExerciseExposure(
  exerciseId: BlueprintId,
  sets: ReadonlyArray<{ completed: boolean }>
): ExerciseExposureResult {
  const exercise = BlueprintAdapter.getExercise(exerciseId);
  if (!exercise) throw new UnknownExerciseInExposureCalculationError(exerciseId);

  const completedSets = sets.filter((s) => s.completed).length;
  if (completedSets === 0) return { contributions: [], unmapped_secondary_phrases: [] };

  const primaryTargets: Array<{ target_type: TargetType; target_id: BlueprintId }> = [
    ...(exercise.physique_targets ?? []).map((target_id) => ({ target_type: 'physique_target' as const, target_id })),
    ...(exercise.functional_goals ?? []).map((target_id) => ({ target_type: 'functional_goal' as const, target_id })),
  ];

  const secondaryTargets: Array<{ target_type: TargetType; target_id: BlueprintId }> = [];
  const unmapped: string[] = [];
  const seenSecondaryKeys = new Set<string>();
  for (const phrase of exercise.secondary_targets ?? []) {
    const resolved = resolveSecondaryTarget(phrase);
    if (!resolved) {
      const normalized = normalizeTargetPhrase(phrase);
      if (!unmapped.includes(normalized)) unmapped.push(normalized);
      continue;
    }
    // A secondary target that's already a primary target for this
    // exercise stays primary-only — never double-counted at a lower
    // coefficient too.
    const isAlsoPrimary = primaryTargets.some((p) => p.target_type === resolved.target_type && p.target_id === resolved.target_id);
    const key = `${resolved.target_type}:${resolved.target_id}`;
    if (!isAlsoPrimary && !seenSecondaryKeys.has(key)) {
      seenSecondaryKeys.add(key);
      secondaryTargets.push(resolved);
    }
  }

  const contributions: ExposureContribution[] = [
    ...primaryTargets.map(
      (t): ExposureContribution => ({
        exercise_id: exerciseId,
        target_type: t.target_type,
        target_id: t.target_id,
        role: 'primary',
        completed_sets: completedSets,
        exposure_units: completedSets * EXPOSURE_COEFFICIENTS.primary,
      })
    ),
    ...secondaryTargets.map(
      (t): ExposureContribution => ({
        exercise_id: exerciseId,
        target_type: t.target_type,
        target_id: t.target_id,
        role: 'secondary',
        completed_sets: completedSets,
        exposure_units: completedSets * EXPOSURE_COEFFICIENTS.secondary,
      })
    ),
  ];

  return { contributions, unmapped_secondary_phrases: unmapped };
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
      const { contributions } = calculateExerciseExposure(exercise.exercise_id, exercise.sets);
      for (const c of contributions) {
        const key = `${c.target_type}:${c.target_id}`;
        const existing = byTarget.get(key);
        if (existing) {
          existing.total_sets += c.completed_sets;
          existing.exposure_units += c.exposure_units;
          if (c.role === 'primary') existing.primary_sets += c.completed_sets;
          else existing.secondary_sets += c.completed_sets;
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
            primary_sets: c.role === 'primary' ? c.completed_sets : 0,
            secondary_sets: c.role === 'secondary' ? c.completed_sets : 0,
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
