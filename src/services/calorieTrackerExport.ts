// Read contract for the Calorie Tracker app (food_and_workout_tracker).
// See docs/CALORIE_TRACKER_INTEGRATION.md for the full contract writeup.
//
// Calorie Tracker's workout_log.csv currently has no way to represent
// actual sets/reps/load/duration — this is the shape it would consume to
// get that. Its own nightly job still owns tdee_final; this contract never
// computes or claims a calorie number itself.
//
// Language rule: actual logged sets/reps/load let Calorie Tracker produce
// a BETTER ESTIMATE of workout expenditure. Never describe this as exact
// calories burned.
//
// Status rule: getCompletedWorkouts() means what it says — only sessions
// whose final status is 'completed'. A planned or in-progress session must
// never be mistaken for activity that already happened, and a skipped one
// never implies expenditure. Use getWorkoutSessions() for a broader,
// all-statuses history view (e.g. for this app's own UI); do not overload
// getCompletedWorkouts() to serve that purpose.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { WorkoutSession, WorkoutSessionStatus } from '../contracts/types.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';

export const EXPENDITURE_NOTE =
  'Logged sets/reps/load support a better ESTIMATE of workout expenditure. This is never an exact calorie count.';

export interface WorkoutSessionExportSet {
  set_number: number;
  weight: number | null;
  reps: number | null;
  completed: boolean;
}

export interface WorkoutSessionExportExercise {
  exercise_id: string;
  /** Resolved through BlueprintAdapter for a human-readable export; the
   * canonical reference stays exercise_id. */
  exercise_name: string | null;
  order: number;
  role: string;
  sets: WorkoutSessionExportSet[];
}

export interface WorkoutSessionExport {
  session_id: string;
  date: string;
  session_type: string;
  duration_minutes: number | null;
  status: WorkoutSessionStatus;
  exercises: WorkoutSessionExportExercise[];
  expenditure_note: string;
}

/** A WorkoutSessionExport whose status is guaranteed 'completed'. */
export type CompletedWorkoutExport = WorkoutSessionExport & { status: 'completed' };

function toExport(repo: WorkoutSessionsRepo, session: WorkoutSession): WorkoutSessionExport {
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
}

/**
 * All workout_sessions recorded for `date`, in any status
 * (planned/in_progress/completed/skipped). For this app's own history
 * views — NOT the contract Calorie Tracker should read (use
 * getCompletedWorkouts for that), since a planned or in-progress session
 * here is not something that has actually happened yet.
 */
export function getWorkoutSessions(db: Database.Database, date: string): WorkoutSessionExport[] {
  const repo = new WorkoutSessionsRepo(db);
  return repo.listSessionsByDate(date).map((session) => toExport(repo, session));
}

/**
 * Calorie Tracker's read contract. Returns only sessions whose final
 * status is 'completed' for `date` — a planned, in-progress, or skipped
 * session is never returned here, so it can never be mistaken for actual
 * activity expenditure.
 */
export function getCompletedWorkouts(db: Database.Database, date: string): CompletedWorkoutExport[] {
  return getWorkoutSessions(db, date).filter((s): s is CompletedWorkoutExport => s.status === 'completed');
}
