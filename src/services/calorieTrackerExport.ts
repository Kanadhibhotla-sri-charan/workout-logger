// Read contract for the Calorie Tracker app (food_and_workout_tracker).
//
// Calorie Tracker's workout_log.csv currently has no way to represent
// actual sets/reps/load/duration — this is the shape it would consume to
// get that. Its own nightly job still owns tdee_final; this contract never
// computes or claims a calorie number itself.
//
// Language rule: actual logged sets/reps/load let Calorie Tracker produce
// a BETTER ESTIMATE of workout expenditure. Never describe this as exact
// calories burned.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { WorkoutSessionStatus } from '../contracts/types.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';

export const EXPENDITURE_NOTE =
  'Logged sets/reps/load support a better ESTIMATE of workout expenditure. This is never an exact calorie count.';

export interface CompletedWorkoutExportSet {
  set_number: number;
  weight: number | null;
  reps: number | null;
  completed: boolean;
}

export interface CompletedWorkoutExportExercise {
  exercise_id: string;
  /** Resolved through BlueprintAdapter for a human-readable export; the
   * canonical reference stays exercise_id. */
  exercise_name: string | null;
  order: number;
  role: string;
  sets: CompletedWorkoutExportSet[];
}

export interface CompletedWorkoutExport {
  session_id: string;
  date: string;
  session_type: string;
  duration_minutes: number | null;
  status: WorkoutSessionStatus;
  exercises: CompletedWorkoutExportExercise[];
  expenditure_note: string;
}

/**
 * Returns every workout_session recorded for `date`, in the shape Calorie
 * Tracker needs for its own estimated-expenditure calculation. Includes
 * sessions in any status (planned/in_progress/completed/skipped) with
 * their actual logged data — Calorie Tracker decides how to weight
 * incomplete sessions, this contract just reports what happened.
 */
export function getCompletedWorkouts(db: Database.Database, date: string): CompletedWorkoutExport[] {
  const repo = new WorkoutSessionsRepo(db);
  const sessions = repo.listSessionsByDate(date);

  return sessions.map((session) => {
    const performances = repo.getExercisePerformances(session.session_id);
    return {
      session_id: session.session_id,
      date: session.date,
      session_type: session.session_type,
      duration_minutes: session.duration_minutes,
      status: session.status,
      exercises: performances.map((p) => ({
        exercise_id: p.exercise_id,
        exercise_name: BlueprintAdapter.getExercise(p.exercise_id)?.name ?? null,
        order: p.order,
        role: p.role,
        sets: p.sets.map((s) => ({
          set_number: s.set_number,
          weight: s.weight,
          reps: s.reps,
          completed: s.completed,
        })),
      })),
      expenditure_note: EXPENDITURE_NOTE,
    };
  });
}
