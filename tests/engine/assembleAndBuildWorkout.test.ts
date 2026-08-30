import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { assembleAndBuildWorkout } from '../../src/engine/workoutBuilder.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

// 2026-08-31 is a Monday.
const MONDAY = '2026-08-31';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('assembleAndBuildWorkout — the impure DB-reading boundary, wired to buildWorkout', () => {
  it('generates a real, Blueprint-grounded workout end-to-end for an active aesthetic goal', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: ['barbell', 'bench', 'rack', 'cable'],
      other_activity_schedule: [],
    });

    // "Chest looks flat from the side" -> primary_targets: ['mid-pec']
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.includes('mid-pec'))!;
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);

    expect(result.date).toBe(MONDAY);
    expect(result.exercises.length).toBeGreaterThan(0);
    const planned = result.exercises[0]!;
    expect(BlueprintAdapter.getExercise(planned.exercise_id)).toBeDefined();
    expect(planned.target_sets).toBeGreaterThan(0);
    expect(result.estimated_minutes).toBeLessThanOrEqual(60);
  });

  it('produces no exercises (only skipped_targets) when there are no active goals at all', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: ['barbell', 'bench', 'rack'],
      other_activity_schedule: [],
    });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    expect(result.exercises).toEqual([]);
    expect(result.skipped_targets).toEqual([]);
  });

  it('works with no TrainingProfile at all (falls back to empty equipment/training days, so nothing is scheduled)', () => {
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.includes('mid-pec'))!;
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    expect(result.exercises).toEqual([]);
  });
});
