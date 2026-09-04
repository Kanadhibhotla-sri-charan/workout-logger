// Blueprint Picker/Daily Activity spec §6: deriveDailyActivity/
// deriveWeeklyActivities is the single source of truth translating
// existing TrainingProfile storage (training_days +
// other_activity_schedule) into the explicit Gym/Badminton/Both/
// Unselected model — pure function, no I/O.

import { describe, expect, it } from 'vitest';
import { applyWeekOverrides, deriveDailyActivity, deriveWeeklyActivities } from '../src/lib/dailyActivity.js';
import type { DailyActivity, Weekday } from '../src/contracts/types.js';

describe('deriveDailyActivity', () => {
  it('is "gym" when the day is a training day with no badminton entry', () => {
    expect(deriveDailyActivity('monday', ['monday'], [])).toBe('gym');
  });

  it('is "badminton" when the day has a badminton entry but is not a training day', () => {
    expect(deriveDailyActivity('saturday', [], [{ day: 'saturday', activity_type: 'badminton' }])).toBe('badminton');
  });

  it('is "both" when the day is a training day AND has a badminton entry', () => {
    expect(deriveDailyActivity('sunday', ['sunday'], [{ day: 'sunday', activity_type: 'badminton' }])).toBe('both');
  });

  it('is "unselected" when the day is neither a training day nor has a badminton entry', () => {
    expect(deriveDailyActivity('wednesday', ['monday'], [])).toBe('unselected');
  });

  it('ignores a non-badminton recurring activity on the day (e.g. a custom "hiking" entry) — still "unselected"', () => {
    expect(deriveDailyActivity('tuesday', [], [{ day: 'tuesday', activity_type: 'hiking' }])).toBe('unselected');
  });

  it('a non-badminton activity does not turn a gym day into "both"', () => {
    expect(deriveDailyActivity('tuesday', ['tuesday'], [{ day: 'tuesday', activity_type: 'hiking' }])).toBe('gym');
  });
});

describe('deriveWeeklyActivities', () => {
  it('returns all seven weekdays in canonical Monday-first order, regardless of storage order', () => {
    const result = deriveWeeklyActivities(
      ['friday', 'monday'],
      [{ day: 'sunday', activity_type: 'badminton' }, { day: 'saturday', activity_type: 'badminton' }]
    );
    expect(result.map((r) => r.weekday)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(result.map((r) => r.activity)).toEqual(['gym', 'unselected', 'unselected', 'unselected', 'gym', 'badminton', 'badminton']);
  });

  it('the exact example from the spec: Mon/Tue/Thu/Fri gym, Wed rest, Sat/Sun badminton -> 4 gym, 1 unselected, 2 badminton', () => {
    const trainingDays = ['monday', 'tuesday', 'thursday', 'friday'] as const;
    const otherActivitySchedule = [
      { day: 'saturday', activity_type: 'badminton' },
      { day: 'sunday', activity_type: 'badminton' },
    ] as const;
    const result = deriveWeeklyActivities(trainingDays, otherActivitySchedule);
    expect(result).toEqual([
      { weekday: 'monday', activity: 'gym' },
      { weekday: 'tuesday', activity: 'gym' },
      { weekday: 'wednesday', activity: 'unselected' },
      { weekday: 'thursday', activity: 'gym' },
      { weekday: 'friday', activity: 'gym' },
      { weekday: 'saturday', activity: 'badminton' },
      { weekday: 'sunday', activity: 'badminton' },
    ]);
  });
});

// Current-Week Reconciliation Fix §4/§6/§7: applyWeekOverrides is the one
// pure function both the recurring-profile write path
// (TrainingProfileRepo.setDailyActivity) and the current-week override
// read path (assembleWeeklyPlanInput, GET/PUT .../week) share — pure, no
// I/O, never mutates its inputs.
describe('applyWeekOverrides', () => {
  const ALL_TRANSITIONS: Array<{ from: DailyActivity; to: DailyActivity }> = [
    { from: 'gym', to: 'badminton' },
    { from: 'badminton', to: 'gym' },
    { from: 'gym', to: 'both' },
    { from: 'both', to: 'gym' },
    { from: 'badminton', to: 'both' },
    { from: 'both', to: 'badminton' },
    { from: 'unselected', to: 'gym' },
    { from: 'unselected', to: 'badminton' },
    { from: 'unselected', to: 'both' },
    { from: 'gym', to: 'unselected' },
    { from: 'badminton', to: 'unselected' },
    { from: 'both', to: 'unselected' },
  ];

  function baseArraysFor(activity: DailyActivity, day: Weekday) {
    const trainingDays = activity === 'gym' || activity === 'both' ? [day] : [];
    const otherActivitySchedule = activity === 'badminton' || activity === 'both' ? [{ day, activity_type: 'badminton' as const, notes: null }] : [];
    return { trainingDays, otherActivitySchedule };
  }

  for (const { from, to } of ALL_TRANSITIONS) {
    it(`${from} -> ${to}`, () => {
      const day: Weekday = 'saturday';
      const { trainingDays, otherActivitySchedule } = baseArraysFor(from, day);
      expect(deriveDailyActivity(day, trainingDays, otherActivitySchedule)).toBe(from);

      const result = applyWeekOverrides(trainingDays, otherActivitySchedule, new Map([[day, to]]));
      expect(deriveDailyActivity(day, result.trainingDays, result.otherActivitySchedule)).toBe(to);
    });
  }

  it('touches only the overridden day — every other day is untouched', () => {
    const result = applyWeekOverrides(
      ['monday', 'wednesday'],
      [{ day: 'friday', activity_type: 'badminton', notes: null }],
      new Map([['monday', 'unselected']])
    );
    expect(deriveDailyActivity('monday', result.trainingDays, result.otherActivitySchedule)).toBe('unselected');
    expect(deriveDailyActivity('wednesday', result.trainingDays, result.otherActivitySchedule)).toBe('gym');
    expect(deriveDailyActivity('friday', result.trainingDays, result.otherActivitySchedule)).toBe('badminton');
  });

  it('preserves a non-badminton recurring activity on the overridden day (spec §5/§7: do not delete old data)', () => {
    const result = applyWeekOverrides(
      [],
      [{ day: 'tuesday', activity_type: 'hiking', notes: 'weekly hike' }],
      new Map([['tuesday', 'gym']])
    );
    expect(result.otherActivitySchedule).toContainEqual({ day: 'tuesday', activity_type: 'hiking', notes: 'weekly hike' });
    expect(deriveDailyActivity('tuesday', result.trainingDays, result.otherActivitySchedule)).toBe('gym');
  });

  it('preserves existing badminton notes when the day stays badminton/both', () => {
    const result = applyWeekOverrides(
      ['wednesday'],
      [{ day: 'wednesday', activity_type: 'badminton', notes: 'club night' }],
      new Map([['wednesday', 'badminton']]) // both -> badminton
    );
    expect(result.otherActivitySchedule).toContainEqual({ day: 'wednesday', activity_type: 'badminton', notes: 'club night' });
  });

  it('does not mutate its input arrays', () => {
    const trainingDays: Weekday[] = ['monday'];
    const otherActivitySchedule = [{ day: 'saturday' as Weekday, activity_type: 'badminton', notes: null }];
    applyWeekOverrides(trainingDays, otherActivitySchedule, new Map([['monday', 'unselected']]));
    expect(trainingDays).toEqual(['monday']);
    expect(otherActivitySchedule).toEqual([{ day: 'saturday', activity_type: 'badminton', notes: null }]);
  });

  it('accepts overrides as a plain array of {day, activity} as well as a Map', () => {
    const result = applyWeekOverrides([], [], [{ day: 'monday', activity: 'gym' }]);
    expect(deriveDailyActivity('monday', result.trainingDays, result.otherActivitySchedule)).toBe('gym');
  });
});
