// Explicit week generation (2026-10-01): planned-but-not-yet-trained days
// from earlier in the SAME week-generation run, layered onto the real
// per-target history as projected exposure, so a later day's SessionPlan
// knows what the earlier days already plan to do (e.g. Friday's Upper
// sees Monday's planned triceps volume). Real training history is never
// touched — this returns adjusted COPIES of the target records.
//
// It uses the engine's own exposure model (calculateExerciseExposure, the
// same function real logged sessions go through), treating every planned
// set as completed. It is a pure function: absent or empty projections
// leave the targets exactly as they were.

import type { BlueprintId } from '../../contracts/types.js';
import { calculateExerciseExposure } from '../../engine/exposureEngine.js';
import type { ExerciseSessionHistory, TargetBuildContext } from '../../engine/workoutBuilder.js';

export interface ProjectedSession {
  /** The planned day's date; only sessions BEFORE the context's target date are applied. */
  date: string;
  exercises: ReadonlyArray<{ exerciseId: BlueprintId; sets: number }>;
}

export function applyProjectedSessions(
  targets: readonly TargetBuildContext[],
  projectedSessions: readonly ProjectedSession[],
  targetDate: string
): TargetBuildContext[] {
  const applicable = projectedSessions.filter((s) => s.date < targetDate).sort((a, b) => a.date.localeCompare(b.date));
  if (applicable.length === 0) return [...targets];

  type Mutable = Omit<TargetBuildContext, 'exercise_history'> & { exercise_history: Record<BlueprintId, readonly ExerciseSessionHistory[]> };
  const byKey = new Map<string, Mutable>(targets.map((t) => [`${t.target_type}:${t.target_id}`, { ...t, exercise_history: { ...t.exercise_history } }]));
  for (const session of applicable) {
    for (const exercise of session.exercises) {
      const plannedSets = Array.from({ length: Math.max(0, exercise.sets) }, () => ({ weight: null, reps: null, completed: true, rir: null }));
      const { contributions } = calculateExerciseExposure(exercise.exerciseId, plannedSets);
      for (const c of contributions) {
        const t = byKey.get(`${c.target_type}:${c.target_id}`);
        if (!t) continue;
        if (c.role === 'primary') t.current_weekly_primary_sets += c.completed_sets;
        else t.weekly_secondary_sets += c.completed_sets;
        t.weekly_exposure_units += c.exposure_units;
        t.rolling_exposure_units += c.exposure_units;
        if (!t.last_trained_date || session.date > t.last_trained_date) {
          t.last_trained_date = session.date;
          t.current_exercise_id = exercise.exerciseId;
        }
        const direct = t.recent_direct_exposure_dates ?? [];
        if (c.role === 'primary' && !direct.includes(session.date)) t.recent_direct_exposure_dates = [session.date, ...direct];
        if (!t.recent_exercise_ids.includes(exercise.exerciseId)) t.recent_exercise_ids = [exercise.exerciseId, ...t.recent_exercise_ids];
        t.exercise_history[exercise.exerciseId] = [{ date: session.date, sets: plannedSets }, ...(t.exercise_history[exercise.exerciseId] ?? [])];
      }
    }
  }
  return targets.map((t) => byKey.get(`${t.target_type}:${t.target_id}`)! as TargetBuildContext);
}
