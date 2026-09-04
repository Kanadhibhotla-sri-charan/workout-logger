// Blueprint Picker/Daily Activity spec §6: deriveDailyActivity/
// deriveWeeklyActivities is the single source of truth translating
// existing TrainingProfile storage (training_days +
// other_activity_schedule) into the explicit Gym/Badminton/Both/
// Unselected model — pure function, no I/O.

import { describe, expect, it } from 'vitest';
import { deriveDailyActivity, deriveWeeklyActivities } from '../src/lib/dailyActivity.js';

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
