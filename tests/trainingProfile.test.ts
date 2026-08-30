import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { UsersRepo } from '../src/repositories/usersRepo.js';
import { InvalidTimezoneError, TrainingProfileRepo, UnknownBlueprintEquipmentError } from '../src/repositories/trainingProfileRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

let db: Database.Database;
let userId: string;

const KNOWN_EQUIPMENT = BlueprintAdapter.getEquipmentList()[0]!.id;
const TZ = 'Asia/Kolkata';

beforeEach(() => {
  db = openDb(':memory:');
  userId = new UsersRepo(db).getOrCreateDefault().id;
});

describe('TrainingProfileRepo', () => {
  it('creates and reads back a profile with training days and equipment as plain data', () => {
    const repo = new TrainingProfileRepo(db);
    const created = repo.upsert(userId, {
      timezone: TZ,
      training_days: ['monday', 'wednesday', 'friday'],
      preferred_split: 'push-pull-legs',
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: [KNOWN_EQUIPMENT],
      other_activity_schedule: [{ day: 'tuesday', activity_type: 'badminton', notes: 'evening league' }],
    });

    expect(created.timezone).toBe(TZ);
    expect(created.training_days).toEqual(['monday', 'wednesday', 'friday']);
    expect(created.available_equipment).toEqual([KNOWN_EQUIPMENT]);

    const loaded = repo.get(userId);
    expect(loaded).toEqual(created);
    expect(loaded!.other_activity_schedule).toEqual([{ day: 'tuesday', activity_type: 'badminton', notes: 'evening league' }]);
  });

  it('represents gym/badminton/rest/other activity types, and stays open to a new one', () => {
    const repo = new TrainingProfileRepo(db);
    const profile = repo.upsert(userId, {
      timezone: TZ,
      training_days: ['monday'],
      default_session_duration_minutes: 45,
      minimum_session_duration_minutes: 20,
      maximum_session_duration_minutes: 60,
      available_equipment: [],
      other_activity_schedule: [
        { day: 'monday', activity_type: 'gym' },
        { day: 'tuesday', activity_type: 'badminton' },
        { day: 'sunday', activity_type: 'rest' },
        { day: 'saturday', activity_type: 'hiking' }, // not one of the known values — still accepted
      ],
    });

    expect(profile.other_activity_schedule.map((a) => a.activity_type)).toEqual(['gym', 'badminton', 'rest', 'hiking']);
  });

  it('rejects an available_equipment id that is not a known Blueprint equipment id', () => {
    const repo = new TrainingProfileRepo(db);
    expect(() =>
      repo.upsert(userId, {
        timezone: TZ,
        training_days: [],
        default_session_duration_minutes: 45,
        minimum_session_duration_minutes: 20,
        maximum_session_duration_minutes: 60,
        available_equipment: ['a-piece-of-equipment-that-does-not-exist'],
        other_activity_schedule: [],
      })
    ).toThrow(UnknownBlueprintEquipmentError);
  });

  it('rejects an inverted session duration range', () => {
    const repo = new TrainingProfileRepo(db);
    expect(() =>
      repo.upsert(userId, {
        timezone: TZ,
        training_days: [],
        default_session_duration_minutes: 45,
        minimum_session_duration_minutes: 90,
        maximum_session_duration_minutes: 30,
        available_equipment: [],
        other_activity_schedule: [],
      })
    ).toThrow(/minimum_session_duration_minutes cannot exceed/);
  });

  it('rejects an invalid IANA timezone name', () => {
    const repo = new TrainingProfileRepo(db);
    expect(() =>
      repo.upsert(userId, {
        timezone: 'Not/AZone',
        training_days: [],
        default_session_duration_minutes: 45,
        minimum_session_duration_minutes: 20,
        maximum_session_duration_minutes: 60,
        available_equipment: [],
        other_activity_schedule: [],
      })
    ).toThrow(InvalidTimezoneError);
  });

  it('updates an existing profile in place (one profile per user)', () => {
    const repo = new TrainingProfileRepo(db);
    repo.upsert(userId, {
      timezone: TZ,
      training_days: ['monday'],
      default_session_duration_minutes: 45,
      minimum_session_duration_minutes: 20,
      maximum_session_duration_minutes: 60,
      available_equipment: [],
      other_activity_schedule: [],
    });
    const updated = repo.upsert(userId, {
      timezone: 'America/Los_Angeles',
      training_days: ['tuesday', 'thursday'],
      default_session_duration_minutes: 50,
      minimum_session_duration_minutes: 25,
      maximum_session_duration_minutes: 70,
      available_equipment: [],
      other_activity_schedule: [],
    });

    expect(updated.training_days).toEqual(['tuesday', 'thursday']);
    expect(updated.timezone).toBe('America/Los_Angeles');
    expect(repo.get(userId)!.id).toBe(updated.id);
  });

  it('returns undefined when no profile exists yet', () => {
    expect(new TrainingProfileRepo(db).get(userId)).toBeUndefined();
  });
});
