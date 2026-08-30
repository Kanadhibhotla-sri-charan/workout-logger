// Fixture F (spec §35, §14): recent high exposure — a target trained
// heavily yesterday. Proves the exact failure mode the spec names is
// avoidable with the tools this app already has: a weekly total can look
// low (if "yesterday" falls just outside the current calendar week) while
// a rolling window correctly still sees it.
//
// Scope: "the engine should avoid blindly adding another large dose" is
// recoveryEngine's job (blocked — docs/TRAINING_ENGINE_DESIGN.md §9).
// This fixture proves the DATA recoveryEngine would need (rolling
// exposure correctly reflecting yesterday's session) is already
// available and correct — not that avoidance behavior exists yet.

import { describe, expect, it } from 'vitest';
import { aggregateRollingExposure, aggregateWeeklyExposure, type SessionExposureInput } from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

const EXERCISE = BlueprintAdapter.getExercises().find((e) => (e.physique_targets ?? []).length === 1)!;
const TARGET_ID = EXERCISE.physique_targets![0]!;

describe('fixture F: recent high exposure (yesterday, just outside this week)', () => {
  // 2026-09-01 is a Tuesday; a Monday-start week for "today" = 2026-09-01
  // starts today, so "yesterday" (2026-08-31, Monday) is actually IN this
  // week. To construct the exact failure mode — heavy volume yesterday
  // that a weekly total misses — put "today" right after a week boundary.
  const heavySessionDate = '2026-08-30'; // Sunday — last day of the prior Mon-start week
  const today = '2026-08-31'; // Monday — first day of the new week

  const sessions: SessionExposureInput[] = [
    {
      date: heavySessionDate,
      exercises: [
        {
          exercise_id: EXERCISE.id,
          sets: [{ completed: true }, { completed: true }, { completed: true }, { completed: true }, { completed: true }],
        },
      ],
    },
  ];

  it("the new week's total looks like zero exposure, even though a heavy session happened yesterday", () => {
    const weekly = aggregateWeeklyExposure(sessions, today, 'monday');
    expect(weekly).toEqual([]); // heavySessionDate (Sunday) is not in the Monday-start week containing `today`
  });

  it('a 7-day rolling window correctly still sees yesterday\'s heavy session', () => {
    const rolling = aggregateRollingExposure(sessions, today, 7);
    expect(rolling).toHaveLength(1);
    expect(rolling[0]).toMatchObject({ target_id: TARGET_ID, total_sets: 5, exposure_units: 5 });
  });

  it('demonstrates the exact failure mode from the spec is avoidable by checking both windows, not just the weekly total', () => {
    const weekly = aggregateWeeklyExposure(sessions, today, 'monday');
    const rolling = aggregateRollingExposure(sessions, today, 7);

    const weeklyLooksLow = weekly.length === 0 || weekly.every((e) => e.exposure_units === 0);
    const rollingShowsRecentWork = rolling.some((e) => e.target_id === TARGET_ID && e.exposure_units > 0);

    expect(weeklyLooksLow).toBe(true);
    expect(rollingShowsRecentWork).toBe(true);
  });
});
