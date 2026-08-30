import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isDateInRange, rollingRangeEnding, weekRangeContaining } from '../../src/engine/dateMath.js';

describe('addDays', () => {
  it('adds and subtracts days across month/year boundaries', () => {
    expect(addDays('2026-01-01', 1)).toBe('2026-01-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // 2024 is
  });
});

describe('daysBetween', () => {
  it('counts calendar days between two dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
    expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });
});

describe('isDateInRange', () => {
  it('is inclusive on both ends', () => {
    expect(isDateInRange('2026-01-01', '2026-01-01', '2026-01-07')).toBe(true);
    expect(isDateInRange('2026-01-07', '2026-01-01', '2026-01-07')).toBe(true);
    expect(isDateInRange('2026-01-08', '2026-01-01', '2026-01-07')).toBe(false);
  });
});

describe('weekRangeContaining', () => {
  // 2026-08-31 is a Monday, 2026-09-06 is a Sunday.
  it('computes a Monday-start week when configured', () => {
    expect(weekRangeContaining('2026-09-03', 'monday')).toEqual({ start: '2026-08-31', end: '2026-09-06' });
    // the boundary day itself
    expect(weekRangeContaining('2026-08-31', 'monday')).toEqual({ start: '2026-08-31', end: '2026-09-06' });
    expect(weekRangeContaining('2026-09-06', 'monday')).toEqual({ start: '2026-08-31', end: '2026-09-06' });
  });

  it('computes a Sunday-start week when configured — never silently assumes Monday', () => {
    // With Sunday as the start, 2026-09-03 (Thursday) falls in the week
    // starting 2026-08-30 (Sunday) through 2026-09-05 (Saturday).
    expect(weekRangeContaining('2026-09-03', 'sunday')).toEqual({ start: '2026-08-30', end: '2026-09-05' });
  });

  it('supports every configured start day, always producing a 7-day window', () => {
    const days: Array<Parameters<typeof weekRangeContaining>[1]> = [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ];
    for (const start of days) {
      const { start: s, end: e } = weekRangeContaining('2026-09-03', start);
      expect(daysBetween(s, e)).toBe(6);
    }
  });
});

describe('rollingRangeEnding', () => {
  it('produces an explicit-length window with no silent default', () => {
    expect(rollingRangeEnding('2026-09-06', 7)).toEqual({ start: '2026-08-31', end: '2026-09-06' });
    expect(rollingRangeEnding('2026-09-06', 14)).toEqual({ start: '2026-08-24', end: '2026-09-06' });
    expect(rollingRangeEnding('2026-09-06', 1)).toEqual({ start: '2026-09-06', end: '2026-09-06' });
  });

  it('rejects a non-positive window', () => {
    expect(() => rollingRangeEnding('2026-09-06', 0)).toThrow();
  });
});
