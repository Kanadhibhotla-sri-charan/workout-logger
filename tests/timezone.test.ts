import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { DEFAULT_TIMEZONE, isValidTimezone, todayInTimezone } from '../src/lib/timezone.js';
import { resolveUserTimezone, todayForUser } from '../src/lib/userTimezone.js';
import { UsersRepo } from '../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../src/repositories/trainingProfileRepo.js';

describe('src/lib/timezone.ts — the timezone contract', () => {
  it('validates real IANA timezone names', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects a bogus timezone name', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });

  it('computes "today" relative to the given timezone, not the process timezone', () => {
    // A moment that is 2026-01-01 00:30 UTC — 06:00 in Kolkata (UTC+5:30,
    // same calendar day) but still 2025-12-31 16:30 in Los Angeles
    // (UTC-8, previous calendar day). If this were computed from raw
    // UTC/process time, both would incorrectly agree.
    const moment = new Date('2026-01-01T00:30:00Z');
    expect(todayInTimezone('UTC', moment)).toBe('2026-01-01');
    expect(todayInTimezone('Asia/Kolkata', moment)).toBe('2026-01-01');
    expect(todayInTimezone('America/Los_Angeles', moment)).toBe('2025-12-31');
  });
});

describe('src/lib/userTimezone.ts — resolving the app-wide user timezone', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('falls back to DEFAULT_TIMEZONE when no TrainingProfile exists yet', () => {
    expect(resolveUserTimezone(db)).toBe(DEFAULT_TIMEZONE);
  });

  it('uses the TrainingProfile timezone once one is set', () => {
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

    expect(resolveUserTimezone(db)).toBe('Asia/Kolkata');
  });

  it('todayForUser reflects the configured timezone', () => {
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

    expect(todayForUser(db)).toBe(todayInTimezone('Asia/Kolkata'));
  });
});
