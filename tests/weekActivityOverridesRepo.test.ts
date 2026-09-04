// Current-Week Reconciliation Fix §4/§10: WeekActivityOverridesRepo
// stores per-week overrides entirely separately from the recurring
// TrainingProfile — this file proves that separation directly at the
// repo layer (HTTP-level proof lives in
// tests/routes/weekActivityOverride.test.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { UsersRepo } from '../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../src/repositories/trainingProfileRepo.js';
import { WeekActivityOverridesRepo } from '../src/repositories/weekActivityOverridesRepo.js';

let db: Database.Database;
let profileId: string;

const WEEK_1 = '2026-08-31'; // a Monday
const WEEK_2 = '2026-09-07'; // the following Monday

beforeEach(() => {
  db = openDb(':memory:');
  const userId = new UsersRepo(db).getOrCreateDefault().id;
  profileId = new TrainingProfileRepo(db).upsert(userId, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday'],
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: [],
    other_activity_schedule: [],
  }).id;
});

describe('WeekActivityOverridesRepo', () => {
  it('returns an empty map when no overrides exist for a week', () => {
    const repo = new WeekActivityOverridesRepo(db);
    expect(repo.get(profileId, WEEK_1)).toEqual(new Map());
  });

  it('stores and retrieves one override', () => {
    const repo = new WeekActivityOverridesRepo(db);
    repo.setOverride(profileId, WEEK_1, 'saturday', 'badminton');
    expect(repo.get(profileId, WEEK_1)).toEqual(new Map([['saturday', 'badminton']]));
  });

  it('upserts — setting the same (profile, week, day) again replaces the activity, not adds a row', () => {
    const repo = new WeekActivityOverridesRepo(db);
    repo.setOverride(profileId, WEEK_1, 'saturday', 'badminton');
    repo.setOverride(profileId, WEEK_1, 'saturday', 'both');
    expect(repo.get(profileId, WEEK_1)).toEqual(new Map([['saturday', 'both']]));
  });

  it('keeps overrides for different weeks fully separate', () => {
    const repo = new WeekActivityOverridesRepo(db);
    repo.setOverride(profileId, WEEK_1, 'saturday', 'badminton');
    repo.setOverride(profileId, WEEK_2, 'saturday', 'gym');
    expect(repo.get(profileId, WEEK_1)).toEqual(new Map([['saturday', 'badminton']]));
    expect(repo.get(profileId, WEEK_2)).toEqual(new Map([['saturday', 'gym']]));
  });

  it('multiple overrides in the same week are all retrievable, keyed by day', () => {
    const repo = new WeekActivityOverridesRepo(db);
    repo.setOverride(profileId, WEEK_1, 'monday', 'unselected');
    repo.setOverride(profileId, WEEK_1, 'saturday', 'both');
    expect(repo.get(profileId, WEEK_1)).toEqual(
      new Map([
        ['monday', 'unselected'],
        ['saturday', 'both'],
      ])
    );
  });

  it('persists across a fresh repo instance (simulating reload/restart)', () => {
    new WeekActivityOverridesRepo(db).setOverride(profileId, WEEK_1, 'wednesday', 'gym');
    const reloaded = new WeekActivityOverridesRepo(db).get(profileId, WEEK_1);
    expect(reloaded).toEqual(new Map([['wednesday', 'gym']]));
  });

  it('rejects an invalid weekday', () => {
    const repo = new WeekActivityOverridesRepo(db);
    expect(() => repo.setOverride(profileId, WEEK_1, 'someday' as any, 'gym')).toThrow();
  });

  it('never touches the recurring TrainingProfile (separation proof)', () => {
    const before = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id);
    new WeekActivityOverridesRepo(db).setOverride(profileId, WEEK_1, 'saturday', 'badminton');
    const after = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id);
    expect(after).toEqual(before);
  });
});
