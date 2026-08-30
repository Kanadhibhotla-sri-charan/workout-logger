// Fixture C (spec §35, §24): the "arms look thin from side" goal combined
// with a realistic schedule (4 gym days, 2 recurring badminton sessions).
// This is a CONFIGURABLE test scenario, not this app's permanent user
// config (see docs/architecture.md's single-user-scope note) — every
// value below is passed explicitly into the fixture, nothing is read from
// hard-coded defaults.
//
// Scope, stated explicitly per the spec: this fixture proves the goal +
// schedule DATA can be represented and resolved together via
// TrainingState. It does NOT require or assert a generated workout —
// that's workoutBuilder's job, and workoutBuilder is intentionally not
// implemented yet (see docs/TRAINING_ENGINE_DESIGN.md §16).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { buildTrainingState } from '../../src/engine/trainingState.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('fixture C: arm-side-thickness goal + 4-gym-day/2-badminton schedule', () => {
  it('represents the schedule as configurable data (not hard-coded) and resolves the goal alongside it', () => {
    const user = new UsersRepo(db).getOrCreateDefault();

    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'], // 4 gym days — this fixture's choice, not a default
      preferred_split: 'push-pull-legs-upper',
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: [],
      other_activity_schedule: [
        { day: 'wednesday', activity_type: 'badminton', notes: 'league night' },
        { day: 'saturday', activity_type: 'badminton', notes: 'casual' },
      ],
    });

    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });

    const state = buildTrainingState(db, '2026-09-03');

    // Goal resolution:
    expect(state.priority_maps).toHaveLength(1);
    expect(state.priority_maps[0]).toMatchObject({
      goal_id: goal.id,
      blueprint_ref: 'arm-side-thickness',
      targets: [
        { target_type: 'physique_target', target_id: 'brachialis-arm-thickness', tier: 'primary' },
        { target_type: 'physique_target', target_id: 'triceps', tier: 'supporting' },
      ],
    });

    // Schedule representation:
    expect(state.training_profile!.training_days).toEqual(['monday', 'tuesday', 'thursday', 'friday']);
    expect(state.training_profile!.training_days).toHaveLength(4);
    const badmintonDays = state.training_profile!.other_activity_schedule.filter((a) => a.activity_type === 'badminton');
    expect(badmintonDays).toHaveLength(2);

    // Explicitly NOT asserting anything about a generated workout — see
    // this file's header comment.
    expect(state).not.toHaveProperty('generated_workout');
  });

  it('the same fixture works with a different schedule, proving nothing is hard-coded to "4 and 2"', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'UTC',
      week_start_day: 'sunday',
      training_days: ['monday', 'wednesday', 'friday'], // 3 gym days this time
      default_session_duration_minutes: 45,
      minimum_session_duration_minutes: 20,
      maximum_session_duration_minutes: 60,
      available_equipment: [],
      other_activity_schedule: [{ day: 'tuesday', activity_type: 'badminton' }], // 1 badminton day
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });

    const state = buildTrainingState(db, '2026-09-03');

    expect(state.training_profile!.training_days).toHaveLength(3);
    expect(state.training_profile!.other_activity_schedule).toHaveLength(1);
    expect(state.priority_maps[0]!.blueprint_ref).toBe('arm-side-thickness');
  });
});
