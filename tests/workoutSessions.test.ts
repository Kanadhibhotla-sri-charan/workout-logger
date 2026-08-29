import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { GoalsRepo } from '../src/repositories/goalsRepo.js';
import { UnknownBlueprintExerciseError, WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

const KNOWN_EXERCISE_ID = BlueprintAdapter.getExercises()[0]!.id;

let db: Database.Database;
let repo: WorkoutSessionsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new WorkoutSessionsRepo(db);
});

describe('WorkoutSessionsRepo', () => {
  it('creates a session with a known Blueprint exercise id and stores its sets', () => {
    const session = repo.createSession({ date: '2026-08-29', session_type: 'gym', status: 'in_progress' });

    const performance = repo.addExercisePerformance(session.session_id, {
      exercise_id: KNOWN_EXERCISE_ID,
      order: 1,
      role: 'primary',
      sets: [
        { set_number: 1, weight: 60, reps: 8, completed: true },
        { set_number: 2, weight: 60, reps: 6, completed: false },
      ],
    });

    expect(performance.exercise_id).toBe(KNOWN_EXERCISE_ID);
    expect(performance.sets).toHaveLength(2);

    const loaded = repo.getExercisePerformances(session.session_id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.sets.map((s) => s.completed)).toEqual([true, false]);
  });

  it('rejects an unknown Blueprint exercise id', () => {
    const session = repo.createSession({ date: '2026-08-29', session_type: 'gym' });
    expect(() =>
      repo.addExercisePerformance(session.session_id, {
        exercise_id: 'totally-made-up-exercise',
        order: 1,
        role: 'primary',
        sets: [{ set_number: 1, weight: 10, reps: 10, completed: true }],
      })
    ).toThrow(UnknownBlueprintExerciseError);
  });

  it('represents an incomplete set correctly (null weight/reps, completed = false)', () => {
    const session = repo.createSession({ date: '2026-08-29', session_type: 'gym' });
    const performance = repo.addExercisePerformance(session.session_id, {
      exercise_id: KNOWN_EXERCISE_ID,
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, completed: false }],
    });

    expect(performance.sets[0]).toMatchObject({ set_number: 1, weight: null, reps: null, completed: false });
  });

  it('stores session duration', () => {
    const session = repo.createSession({
      date: '2026-08-29',
      session_type: 'gym',
      start_time: '08:00',
      status: 'in_progress',
    });
    const updated = repo.updateSession(session.session_id, {
      end_time: '08:45',
      duration_minutes: 45,
      status: 'completed',
    });
    expect(updated?.duration_minutes).toBe(45);
    expect(updated?.status).toBe('completed');
  });

  it('persists aesthetic and functional goal context through a full save/load cycle', () => {
    const goalsRepo = new GoalsRepo(db);
    const aestheticGoalId = BlueprintAdapter.getAestheticGoals()[0]!.id;
    const functionalGoalId = BlueprintAdapter.getFunctionalGoals()[0]!.id;

    const aestheticGoal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: aestheticGoalId, priority: 1 });
    const functionalGoal = goalsRepo.create({ goal_type: 'functional', blueprint_ref: functionalGoalId, priority: 2 });

    const aestheticSession = repo.createSession({
      date: '2026-08-29',
      session_type: 'gym',
      goal_context: { goal_type: 'aesthetic', goal_id: aestheticGoal.id, priority: 1, program_phase: 'hypertrophy' },
    });
    const functionalSession = repo.createSession({
      date: '2026-08-30',
      session_type: 'badminton',
      goal_context: { goal_type: 'functional', goal_id: functionalGoal.id, priority: 2, program_phase: null },
    });

    expect(repo.getSession(aestheticSession.session_id)?.goal_context).toEqual({
      goal_type: 'aesthetic',
      goal_id: aestheticGoal.id,
      priority: 1,
      program_phase: 'hypertrophy',
    });
    expect(repo.getSession(functionalSession.session_id)?.goal_context).toEqual({
      goal_type: 'functional',
      goal_id: functionalGoal.id,
      priority: 2,
      program_phase: null,
    });
  });

  it('leaves goal_context null when a session has none', () => {
    const session = repo.createSession({ date: '2026-08-29', session_type: 'other' });
    expect(repo.getSession(session.session_id)?.goal_context).toBeNull();
  });
});
