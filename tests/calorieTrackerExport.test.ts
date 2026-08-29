import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';
import { EXPENDITURE_NOTE, getCompletedWorkouts } from '../src/services/calorieTrackerExport.js';

const KNOWN_EXERCISE_ID = BlueprintAdapter.getExercises()[0]!.id;

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('getCompletedWorkouts (Calorie Tracker export contract)', () => {
  it('exports a completed workout in the expected shape', () => {
    const repo = new WorkoutSessionsRepo(db);
    const session = repo.createSession({
      date: '2026-08-29',
      session_type: 'gym',
      start_time: '07:00',
      status: 'in_progress',
    });
    repo.addExercisePerformance(session.session_id, {
      exercise_id: KNOWN_EXERCISE_ID,
      order: 1,
      role: 'primary',
      sets: [
        { set_number: 1, weight: 100, reps: 5, completed: true },
        { set_number: 2, weight: 100, reps: 4, completed: false },
      ],
    });
    repo.updateSession(session.session_id, { status: 'completed', duration_minutes: 50, end_time: '07:50' });

    const [exported] = getCompletedWorkouts(db, '2026-08-29');

    expect(exported).toBeDefined();
    expect(exported).toMatchObject({
      date: '2026-08-29',
      session_type: 'gym',
      duration_minutes: 50,
      status: 'completed',
    });
    expect(exported!.exercises).toHaveLength(1);
    expect(exported!.exercises[0]).toMatchObject({
      exercise_id: KNOWN_EXERCISE_ID,
      exercise_name: BlueprintAdapter.getExercise(KNOWN_EXERCISE_ID)!.name,
    });
    expect(exported!.exercises[0]!.sets).toEqual([
      { set_number: 1, weight: 100, reps: 5, completed: true },
      { set_number: 2, weight: 100, reps: 4, completed: false },
    ]);
  });

  it('never claims an exact calorie figure — always frames the number as an estimate', () => {
    const repo = new WorkoutSessionsRepo(db);
    repo.createSession({ date: '2026-08-29', session_type: 'gym', status: 'completed' });

    const [exported] = getCompletedWorkouts(db, '2026-08-29');

    expect(exported!.expenditure_note).toBe(EXPENDITURE_NOTE);
    expect(exported!.expenditure_note.toLowerCase()).toContain('estimate');
    expect(exported!.expenditure_note.toLowerCase()).not.toContain('exact calories');
    // The export never has an "exact calorie" numeric field of its own.
    expect(exported).not.toHaveProperty('calories');
    expect(exported).not.toHaveProperty('calories_burned');
  });

  it('returns an empty array for a date with no sessions', () => {
    expect(getCompletedWorkouts(db, '1999-01-01')).toEqual([]);
  });
});
