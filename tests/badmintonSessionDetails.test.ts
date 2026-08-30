import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import {
  BadmintonSessionDetailsRepo,
  InvalidBadmintonSessionDetailsError,
  NotABadmintonSessionError,
  UnknownWorkoutSessionError,
} from '../src/repositories/badmintonSessionDetailsRepo.js';

let db: Database.Database;
let sessionsRepo: WorkoutSessionsRepo;
let detailsRepo: BadmintonSessionDetailsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  sessionsRepo = new WorkoutSessionsRepo(db);
  detailsRepo = new BadmintonSessionDetailsRepo(db);
});

describe('BadmintonSessionDetailsRepo — spec §15', () => {
  it('records full detail against an existing badminton session', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'badminton' });

    const details = detailsRepo.record({
      workout_session_id: session.session_id,
      intensity: 'high',
      format: 'singles',
      games_count: 3,
      session_quality: 4,
      post_session_fatigue: 5,
      notes: 'Tough match, opponent was faster than expected',
    });

    expect(details).toEqual({
      workout_session_id: session.session_id,
      intensity: 'high',
      format: 'singles',
      games_count: 3,
      session_quality: 4,
      post_session_fatigue: 5,
      notes: 'Tough match, opponent was faster than expected',
    });
    expect(detailsRepo.get(session.session_id)).toEqual(details);
  });

  it('rejects a workout session id that does not exist', () => {
    expect(() => detailsRepo.record({ workout_session_id: 'no-such-session' })).toThrow(UnknownWorkoutSessionError);
  });

  it('rejects a non-badminton session', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'gym' });
    expect(() => detailsRepo.record({ workout_session_id: session.session_id, intensity: 'low' })).toThrow(
      NotABadmintonSessionError
    );
  });

  it('rejects an out-of-range session_quality or post_session_fatigue', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'badminton' });
    expect(() =>
      detailsRepo.record({ workout_session_id: session.session_id, session_quality: 6 as 1 | 2 | 3 | 4 | 5 })
    ).toThrow(InvalidBadmintonSessionDetailsError);
    expect(() =>
      detailsRepo.record({ workout_session_id: session.session_id, post_session_fatigue: 0 as 1 | 2 | 3 | 4 | 5 })
    ).toThrow(InvalidBadmintonSessionDetailsError);
  });

  it('rejects an invalid intensity or format value', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'badminton' });
    // @ts-expect-error deliberately invalid for the test
    expect(() => detailsRepo.record({ workout_session_id: session.session_id, intensity: 'extreme' })).toThrow(
      InvalidBadmintonSessionDetailsError
    );
    // @ts-expect-error deliberately invalid for the test
    expect(() => detailsRepo.record({ workout_session_id: session.session_id, format: 'mixed' })).toThrow(
      InvalidBadmintonSessionDetailsError
    );
  });

  it('upserts — a second record() call for the same session overwrites, not duplicates', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'badminton' });
    detailsRepo.record({ workout_session_id: session.session_id, intensity: 'low', games_count: 1 });
    const updated = detailsRepo.record({ workout_session_id: session.session_id, intensity: 'high', games_count: 3 });

    expect(updated.intensity).toBe('high');
    expect(updated.games_count).toBe(3);
    expect(detailsRepo.get(session.session_id)?.intensity).toBe('high');
  });

  it('get() returns undefined when nothing has been recorded yet', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'badminton' });
    expect(detailsRepo.get(session.session_id)).toBeUndefined();
  });

  it('never converts badminton workload into hypertrophy exposure_units — it is stored as its own distinct shape', () => {
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'badminton' });
    const details = detailsRepo.record({ workout_session_id: session.session_id, intensity: 'medium', format: 'doubles', games_count: 2 });

    expect(details).not.toHaveProperty('exposure_units');
    expect(details).not.toHaveProperty('sets');
  });
});
