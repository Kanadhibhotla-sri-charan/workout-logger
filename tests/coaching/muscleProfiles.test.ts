// Coaching Depth Batch 1 spec §10 "Profiles" required tests.

import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { getProfile, MUSCLE_PROGRAMMING_PROFILES, MUSCLE_PROFILE_MAPPING_GAPS } from '../../src/coaching/profiles/muscleProfiles.js';
import { validateMuscleProgrammingProfile, InvalidMuscleProgrammingProfileError } from '../../src/coaching/profiles/muscleProfileTypes.js';
import {
  getPreferredFrequencyReference,
  getMinimumFrequencyReference,
  getMaximumFrequencyReference,
  getActualScheduledFrequency,
  getActualCompletedFrequency,
  applyRepRangeBias,
  type ScheduledPlanDay,
} from '../../src/coaching/profiles/muscleProfileService.js';

describe('MUSCLE_PROGRAMMING_PROFILES — canonical mapping', () => {
  it('maps all six real target ids (5 named profiles, forearms split into two canonical targets) with no mapping gaps', () => {
    expect(MUSCLE_PROFILE_MAPPING_GAPS).toEqual([]);
    const ids = MUSCLE_PROGRAMMING_PROFILES.map((p) => p.targetId).sort();
    expect(ids).toEqual(['forearm-extensors', 'forearm-flexors', 'gastrocnemius', 'obliques', 'rectus-abdominis', 'soleus']);
  });

  it('every curated profile passes its own validation', () => {
    for (const profile of MUSCLE_PROGRAMMING_PROFILES) {
      expect(() => validateMuscleProgrammingProfile(profile)).not.toThrow();
    }
  });
});

describe('getProfile — unknown vs known targets', () => {
  it('an unknown target uses safe defaults (no invented frequency/bias)', () => {
    const profile = getProfile('some-target-with-no-curated-profile');
    expect(profile.source).toBe('default');
    expect(profile.preferredFrequencyPerWeek).toBeUndefined();
    expect(profile.minimumFrequencyPerWeek).toBeUndefined();
    expect(profile.maximumFrequencyPerWeek).toBeUndefined();
    expect(profile.repRangeBias).toBeUndefined();
  });

  it('a known target returns its real curated profile', () => {
    const profile = getProfile('rectus-abdominis');
    expect(profile.source).toBe('blueprint_profile');
    expect(profile.preferredFrequencyPerWeek).toBe(4);
    expect(profile.minimumFrequencyPerWeek).toBe(2);
    expect(profile.maximumFrequencyPerWeek).toBe(5);
    expect(profile.repRangeBias).toBe('higher');
  });

  it('forearm-flexors and forearm-extensors both get the spec\'s single "Forearms" row', () => {
    expect(getProfile('forearm-flexors')).toMatchObject({ preferredFrequencyPerWeek: 3, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 4, repRangeBias: 'standard' });
    expect(getProfile('forearm-extensors')).toMatchObject({ preferredFrequencyPerWeek: 3, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 4, repRangeBias: 'standard' });
  });
});

describe('validateMuscleProgrammingProfile — invalid frequency ordering is rejected', () => {
  it('rejects minimum > preferred', () => {
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', minimumFrequencyPerWeek: 5, preferredFrequencyPerWeek: 3, source: 'default' })).toThrow(
      InvalidMuscleProgrammingProfileError
    );
  });

  it('rejects preferred > maximum', () => {
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', preferredFrequencyPerWeek: 5, maximumFrequencyPerWeek: 3, source: 'default' })).toThrow(
      InvalidMuscleProgrammingProfileError
    );
  });

  it('rejects minimum > maximum even without a preferred value', () => {
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', minimumFrequencyPerWeek: 5, maximumFrequencyPerWeek: 3, source: 'default' })).toThrow(
      InvalidMuscleProgrammingProfileError
    );
  });

  it('rejects a non-positive-integer frequency', () => {
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', preferredFrequencyPerWeek: 0, source: 'default' })).toThrow(InvalidMuscleProgrammingProfileError);
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', preferredFrequencyPerWeek: 2.5, source: 'default' })).toThrow(InvalidMuscleProgrammingProfileError);
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', preferredFrequencyPerWeek: -1, source: 'default' })).toThrow(InvalidMuscleProgrammingProfileError);
  });

  it('accepts a valid, fully-ordered profile', () => {
    expect(() => validateMuscleProgrammingProfile({ targetId: 'x', minimumFrequencyPerWeek: 2, preferredFrequencyPerWeek: 3, maximumFrequencyPerWeek: 4, source: 'default' })).not.toThrow();
  });
});

describe('preferred frequency is never actual frequency', () => {
  it('getPreferredFrequencyReference/getMinimumFrequencyReference/getMaximumFrequencyReference are pure references, independent of any plan/history', () => {
    expect(getPreferredFrequencyReference('rectus-abdominis')).toBe(4);
    expect(getMinimumFrequencyReference('rectus-abdominis')).toBe(2);
    expect(getMaximumFrequencyReference('rectus-abdominis')).toBe(5);
    // A reference is a static property of the profile — it does not
    // change based on what actually happened, unlike actual frequency
    // below.
    expect(getPreferredFrequencyReference('rectus-abdominis')).not.toBe(
      getActualScheduledFrequency('rectus-abdominis', [])
    );
  });

  it('returns null for a target with no curated reference', () => {
    expect(getPreferredFrequencyReference('unknown-target')).toBeNull();
    expect(getMinimumFrequencyReference('unknown-target')).toBeNull();
    expect(getMaximumFrequencyReference('unknown-target')).toBeNull();
  });
});

describe('getActualScheduledFrequency — calculated from generated plan sessions', () => {
  it('counts only the real days the plan gives the target direct work', () => {
    const plan: ScheduledPlanDay[] = [
      { date: '2026-12-14', targetIds: ['rectus-abdominis', 'gastrocnemius'] },
      { date: '2026-12-15', targetIds: ['gastrocnemius'] },
      { date: '2026-12-16', targetIds: [] },
      { date: '2026-12-17', targetIds: ['rectus-abdominis'] },
    ];
    expect(getActualScheduledFrequency('rectus-abdominis', plan)).toBe(2);
    expect(getActualScheduledFrequency('gastrocnemius', plan)).toBe(2);
    expect(getActualScheduledFrequency('soleus', plan)).toBe(0);
  });

  it('never claims more exposures than the plan actually contains, even for a target with a higher preferred frequency', () => {
    const plan: ScheduledPlanDay[] = [{ date: '2026-12-14', targetIds: ['rectus-abdominis'] }];
    // rectus-abdominis prefers 4/week, but the real plan only has 1.
    expect(getActualScheduledFrequency('rectus-abdominis', plan)).toBe(1);
    expect(getPreferredFrequencyReference('rectus-abdominis')).toBe(4);
  });
});

describe('getActualCompletedFrequency — completed records only, no history returns null', () => {
  it('returns null when no history is available (never 0)', () => {
    expect(getActualCompletedFrequency('rectus-abdominis', null)).toBeNull();
  });

  it('returns 0 for a real, checked history that legitimately has zero completed exposures — distinct from null', () => {
    expect(getActualCompletedFrequency('rectus-abdominis', [])).toBe(0);
  });

  it('counts only completed records, ignoring partial/missed/unknown ones', () => {
    const history = [
      { date: '2026-12-01', targetId: 'rectus-abdominis', completionStatus: 'completed' as const },
      { date: '2026-12-03', targetId: 'rectus-abdominis', completionStatus: 'partial' as const },
      { date: '2026-12-05', targetId: 'rectus-abdominis', completionStatus: 'missed' as const },
      { date: '2026-12-07', targetId: 'rectus-abdominis', completionStatus: 'unknown' as const },
      { date: '2026-12-08', targetId: 'rectus-abdominis', completionStatus: 'completed' as const },
      { date: '2026-12-09', targetId: 'gastrocnemius', completionStatus: 'completed' as const },
    ];
    expect(getActualCompletedFrequency('rectus-abdominis', history)).toBe(2);
    expect(getActualCompletedFrequency('gastrocnemius', history)).toBe(1);
  });
});

describe('applyRepRangeBias — the spec\'s own worked example (8-15)', () => {
  it('lower: 8-12', () => {
    expect(applyRepRangeBias(8, 15, 'lower')).toEqual({ min: 8, max: 12 });
  });
  it('standard: 8-15 unchanged', () => {
    expect(applyRepRangeBias(8, 15, 'standard')).toEqual({ min: 8, max: 15 });
  });
  it('higher: 11-15', () => {
    expect(applyRepRangeBias(8, 15, 'higher')).toEqual({ min: 11, max: 15 });
  });
});

describe('applyRepRangeBias — never outside the authored range, deterministic', () => {
  it('lower/higher never produce a value outside [authoredMin, authoredMax]', () => {
    for (const [min, max] of [
      [1, 5],
      [6, 12],
      [10, 30],
      [3, 3],
    ] as const) {
      for (const bias of ['lower', 'standard', 'higher'] as const) {
        const result = applyRepRangeBias(min, max, bias);
        expect(result.min).toBeGreaterThanOrEqual(min);
        expect(result.max).toBeLessThanOrEqual(max);
        expect(result.min).toBeLessThanOrEqual(result.max);
      }
    }
  });

  it('is deterministic — repeated calls with the same input give the same output', () => {
    const a = applyRepRangeBias(6, 12, 'lower');
    const b = applyRepRangeBias(6, 12, 'lower');
    expect(a).toEqual(b);
    const c = applyRepRangeBias(6, 12, 'higher');
    const d = applyRepRangeBias(6, 12, 'higher');
    expect(c).toEqual(d);
  });

  it('rejects authoredMin > authoredMax', () => {
    expect(() => applyRepRangeBias(10, 5, 'standard')).toThrow(RangeError);
  });
});

describe('applyRepRangeBias — small ranges (fewer than 3 integer values) remain unchanged', () => {
  it('a 1-value range (min === max) is unchanged regardless of bias', () => {
    expect(applyRepRangeBias(8, 8, 'lower')).toEqual({ min: 8, max: 8 });
    expect(applyRepRangeBias(8, 8, 'higher')).toEqual({ min: 8, max: 8 });
  });

  it('a 2-value range is unchanged regardless of bias', () => {
    expect(applyRepRangeBias(8, 9, 'lower')).toEqual({ min: 8, max: 9 });
    expect(applyRepRangeBias(8, 9, 'higher')).toEqual({ min: 8, max: 9 });
  });

  it('a 3-value range (the boundary) still shifts under lower/higher bias', () => {
    // span = 2, shift = floor(2 * 2/3) = 1
    expect(applyRepRangeBias(8, 10, 'lower')).toEqual({ min: 8, max: 9 });
    expect(applyRepRangeBias(8, 10, 'higher')).toEqual({ min: 9, max: 10 });
  });
});

describe('applyRepRangeBias — exercise-level authored constraint precedence (spec §4.6)', () => {
  it('the function always operates on whatever authored range it is given — a caller passing a narrower, exercise-specific range gets that range biased, never a wider generic muscle default substituted in', () => {
    const genericMuscleRange = { min: 6, max: 20 };
    const exerciseSpecificAuthoredRange = { min: 8, max: 12 }; // this exercise's own, narrower authored range takes precedence
    const biasedForThisExercise = applyRepRangeBias(exerciseSpecificAuthoredRange.min, exerciseSpecificAuthoredRange.max, 'higher');
    // Result respects the EXERCISE's own range, not the generic muscle range.
    expect(biasedForThisExercise.min).toBeGreaterThanOrEqual(exerciseSpecificAuthoredRange.min);
    expect(biasedForThisExercise.max).toBeLessThanOrEqual(exerciseSpecificAuthoredRange.max);
    expect(biasedForThisExercise.max).not.toBe(genericMuscleRange.max);
  });
});

describe('WorkoutSessionsRepo integration sanity for getActualScheduledFrequency inputs', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('a fresh database has no workout sessions, so a caller-built plan is legitimately empty (0 scheduled), never fabricated', () => {
    expect(new WorkoutSessionsRepo(db).listSessions()).toHaveLength(0);
    expect(getActualScheduledFrequency('rectus-abdominis', [])).toBe(0);
  });
});
