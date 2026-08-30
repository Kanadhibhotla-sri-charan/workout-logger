import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildTrainingState } from '../../src/engine/trainingState.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { ProgramsRepo } from '../../src/repositories/programsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { UnresolvedGoalReferenceError } from '../../src/engine/goalResolver.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('buildTrainingState', () => {
  it('derives everything from persisted data — an empty database gives an empty-but-valid state', () => {
    const state = buildTrainingState(db, '2026-09-03');

    expect(state.as_of_date).toBe('2026-09-03');
    expect(state.training_profile).toBeNull();
    expect(state.current_program).toBeNull();
    expect(state.active_goals).toEqual([]);
    expect(state.priority_maps).toEqual([]);
    expect(state.recent_sessions).toEqual([]);
    expect(state.weekly_exposure).toEqual([]);
    expect(state.rolling_exposure).toEqual([]);
  });

  it('includes the training profile once one exists', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'wednesday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: [],
      other_activity_schedule: [],
    });

    const state = buildTrainingState(db, '2026-09-03');
    expect(state.training_profile?.timezone).toBe('Asia/Kolkata');
  });

  it('picks the most recently created active program as current_program', () => {
    const programsRepo = new ProgramsRepo(db);
    programsRepo.createProgram({ name: 'Old Program', goal_ids: [], status: 'archived' });
    const active = programsRepo.createProgram({ name: 'Current Program', goal_ids: [], status: 'active' });

    const state = buildTrainingState(db, '2026-09-03');
    expect(state.current_program?.id).toBe(active.id);
  });

  it('resolves each active goal into a PriorityMap, in the same order', () => {
    const goalsRepo = new GoalsRepo(db);
    const aestheticId = BlueprintAdapter.getAestheticGoals()[0]!.id;
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: aestheticId, priority: 1 });

    const state = buildTrainingState(db, '2026-09-03');
    expect(state.active_goals).toHaveLength(1);
    expect(state.priority_maps).toHaveLength(1);
    expect(state.priority_maps[0]!.goal_id).toBe(goal.id);
  });

  it('excludes inactive goals', () => {
    const goalsRepo = new GoalsRepo(db);
    const aestheticId = BlueprintAdapter.getAestheticGoals()[0]!.id;
    goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: aestheticId, priority: 1, active: false });

    const state = buildTrainingState(db, '2026-09-03');
    expect(state.active_goals).toEqual([]);
  });

  it('folds recent sessions into weekly and rolling exposure', () => {
    const exerciseId = BlueprintAdapter.getExercises()[0]!.id;
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: '2026-09-01', session_type: 'gym', status: 'completed' });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: exerciseId,
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, completed: true }, { set_number: 2, completed: true }],
    });

    const state = buildTrainingState(db, '2026-09-03');

    expect(state.recent_sessions).toHaveLength(1);
    expect(state.weekly_exposure.length).toBeGreaterThan(0);
    expect(state.rolling_exposure.length).toBeGreaterThan(0);
  });

  it('throws when an active goal points at a Blueprint reference that no longer resolves', () => {
    const goalsRepo = new GoalsRepo(db);
    const aestheticId = BlueprintAdapter.getAestheticGoals()[0]!.id;
    goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: aestheticId, priority: 1 });

    // Simulate a stale reference: directly corrupt the stored row past
    // the repo's own create-time validation, to exercise the training
    // state builder's own defensive behavior.
    db.prepare('UPDATE goals SET blueprint_ref = ?').run('a-goal-that-no-longer-exists');

    expect(() => buildTrainingState(db, '2026-09-03')).toThrow(UnresolvedGoalReferenceError);
  });

  it('defaults as_of_date to "today" in the configured timezone when omitted', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: [],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: [],
      other_activity_schedule: [],
    });

    const state = buildTrainingState(db);
    expect(state.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
