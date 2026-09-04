import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { UsersRepo } from '../src/repositories/usersRepo.js';
import { InvalidTimezoneError, NoTrainingProfileError, TrainingProfileRepo, UnknownBlueprintEquipmentError } from '../src/repositories/trainingProfileRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';
import { deriveDailyActivity } from '../src/lib/dailyActivity.js';
import type { DailyActivity } from '../src/contracts/types.js';

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
      week_start_day: 'monday',
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
      week_start_day: 'monday',
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
      week_start_day: 'monday',
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
      week_start_day: 'monday',
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
      week_start_day: 'monday',
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
      week_start_day: 'monday',
      training_days: ['monday'],
      default_session_duration_minutes: 45,
      minimum_session_duration_minutes: 20,
      maximum_session_duration_minutes: 60,
      available_equipment: [],
      other_activity_schedule: [],
    });
    const updated = repo.upsert(userId, {
      timezone: 'America/Los_Angeles',
      week_start_day: 'monday',
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

// Blueprint Picker/Daily Activity spec §9/§16: every one of the twelve
// listed transitions, all twelve as one exhaustive table (§9's exact
// list), plus persistence, data-preservation, and no-profile-yet
// behavior for the new setDailyActivity write path.
describe('TrainingProfileRepo.setDailyActivity', () => {
  function baseProfile(repo: TrainingProfileRepo) {
    return repo.upsert(userId, {
      timezone: TZ,
      week_start_day: 'monday',
      training_days: ['monday', 'wednesday'], // monday=gym, wednesday=both, everything else unselected to start
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: [],
      other_activity_schedule: [{ day: 'wednesday', activity_type: 'badminton', notes: 'club night' }],
    });
  }

  const TRANSITIONS: Array<{ from: DailyActivity; to: DailyActivity; day: 'monday' | 'wednesday' | 'friday' }> = [
    { from: 'gym', to: 'badminton', day: 'monday' },
    { from: 'badminton', to: 'gym', day: 'friday' },
    { from: 'gym', to: 'both', day: 'monday' },
    { from: 'both', to: 'gym', day: 'wednesday' },
    { from: 'both', to: 'badminton', day: 'wednesday' },
    { from: 'badminton', to: 'both', day: 'friday' },
    { from: 'unselected', to: 'gym', day: 'friday' },
    { from: 'unselected', to: 'badminton', day: 'friday' },
    { from: 'unselected', to: 'both', day: 'friday' },
    { from: 'gym', to: 'unselected', day: 'monday' },
    { from: 'badminton', to: 'unselected', day: 'friday' },
    { from: 'both', to: 'unselected', day: 'wednesday' },
  ];

  for (const { from, to, day } of TRANSITIONS) {
    it(`${from} -> ${to} (on ${day})`, () => {
      const repo = new TrainingProfileRepo(db);
      let profile = baseProfile(repo);
      // Friday starts unselected in baseProfile; for a badminton/both
      // starting state on friday, seed it first via the same write path.
      if (from !== 'unselected' && day === 'friday') {
        profile = repo.setDailyActivity(userId, 'friday', from);
      }
      expect(deriveDailyActivity(day, profile.training_days, profile.other_activity_schedule)).toBe(from);

      const updated = repo.setDailyActivity(userId, day, to);
      expect(deriveDailyActivity(day, updated.training_days, updated.other_activity_schedule)).toBe(to);
    });
  }

  it('touches only the target day — every other day is unchanged', () => {
    const repo = new TrainingProfileRepo(db);
    baseProfile(repo);
    const updated = repo.setDailyActivity(userId, 'friday', 'gym');
    expect(deriveDailyActivity('monday', updated.training_days, updated.other_activity_schedule)).toBe('gym');
    expect(deriveDailyActivity('wednesday', updated.training_days, updated.other_activity_schedule)).toBe('both');
    expect(deriveDailyActivity('tuesday', updated.training_days, updated.other_activity_schedule)).toBe('unselected');
  });

  it('preserves a non-badminton recurring activity on the same day untouched', () => {
    const repo = new TrainingProfileRepo(db);
    repo.upsert(userId, {
      timezone: TZ,
      week_start_day: 'monday',
      training_days: [],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: [],
      other_activity_schedule: [{ day: 'tuesday', activity_type: 'hiking', notes: 'weekly hike' }],
    });
    const updated = repo.setDailyActivity(userId, 'tuesday', 'gym');
    expect(updated.other_activity_schedule).toContainEqual({ day: 'tuesday', activity_type: 'hiking', notes: 'weekly hike' });
    expect(deriveDailyActivity('tuesday', updated.training_days, updated.other_activity_schedule)).toBe('gym');
  });

  it('preserves existing badminton notes when the day stays badminton/both', () => {
    const repo = new TrainingProfileRepo(db);
    baseProfile(repo); // wednesday = both, badminton notes = 'club night'
    const updated = repo.setDailyActivity(userId, 'wednesday', 'badminton'); // both -> badminton
    expect(updated.other_activity_schedule).toContainEqual({ day: 'wednesday', activity_type: 'badminton', notes: 'club night' });
  });

  it('persists across a fresh repo read (simulating reload/restart)', () => {
    const repo = new TrainingProfileRepo(db);
    baseProfile(repo);
    repo.setDailyActivity(userId, 'friday', 'badminton');

    const reloaded = new TrainingProfileRepo(db).get(userId)!;
    expect(deriveDailyActivity('friday', reloaded.training_days, reloaded.other_activity_schedule)).toBe('badminton');
  });

  it('throws NoTrainingProfileError when no profile exists yet', () => {
    const repo = new TrainingProfileRepo(db);
    expect(() => repo.setDailyActivity(userId, 'monday', 'gym')).toThrow(NoTrainingProfileError);
  });
});
