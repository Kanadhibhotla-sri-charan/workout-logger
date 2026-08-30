import { describe, expect, it } from 'vitest';
import {
  aggregateExposure,
  aggregateRollingExposure,
  aggregateWeeklyExposure,
  calculateExerciseExposure,
  UnknownExerciseInExposureCalculationError,
  type SessionExposureInput,
} from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

// A real exercise whose physique_targets is a single, known target —
// picked deterministically rather than assuming an id.
const SINGLE_TARGET_EXERCISE = BlueprintAdapter.getExercises().find((e) => (e.physique_targets ?? []).length === 1)!;
const TARGET_ID = SINGLE_TARGET_EXERCISE.physique_targets![0]!;

describe('calculateExerciseExposure — rules A, C, D', () => {
  it('gives full exposure_units credit to every listed target per completed set (rule C)', () => {
    const contributions = calculateExerciseExposure(SINGLE_TARGET_EXERCISE.id, [
      { completed: true },
      { completed: true },
      { completed: true },
    ]);

    expect(contributions).toEqual([
      {
        exercise_id: SINGLE_TARGET_EXERCISE.id,
        target_type: 'physique_target',
        target_id: TARGET_ID,
        completed_sets: 3,
        exposure_units: 3,
      },
    ]);
  });

  it('excludes uncompleted sets entirely (rule D)', () => {
    const contributions = calculateExerciseExposure(SINGLE_TARGET_EXERCISE.id, [
      { completed: true },
      { completed: false },
      { completed: false },
    ]);

    expect(contributions[0]!.completed_sets).toBe(1);
    expect(contributions[0]!.exposure_units).toBe(1);
  });

  it('returns no contributions when every set is uncompleted', () => {
    expect(calculateExerciseExposure(SINGLE_TARGET_EXERCISE.id, [{ completed: false }])).toEqual([]);
  });

  it('produces one contribution per listed target, each getting full (not divided) credit — no indirect exposure invented', () => {
    const multiTarget = BlueprintAdapter.getExercises().find((e) => (e.physique_targets ?? []).length > 1)!;
    const contributions = calculateExerciseExposure(multiTarget.id, [{ completed: true }, { completed: true }]);

    expect(contributions).toHaveLength(multiTarget.physique_targets!.length);
    for (const c of contributions) {
      expect(c.exposure_units).toBe(2); // full credit, not split across targets
    }
  });

  it('throws for an unknown exercise id rather than silently computing zero exposure', () => {
    expect(() => calculateExerciseExposure('not-a-real-exercise', [{ completed: true }])).toThrow(
      UnknownExerciseInExposureCalculationError
    );
  });
});

describe('aggregateExposure — rule G, date-range aggregation', () => {
  const sessions: SessionExposureInput[] = [
    { date: '2026-08-31', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }, { completed: true }] }] },
    { date: '2026-09-02', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] },
    { date: '2026-09-10', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] }, // outside range
  ];

  it('sums exposure across sessions within [periodStart, periodEnd], excluding out-of-range sessions', () => {
    const result = aggregateExposure(sessions, '2026-08-31', '2026-09-06');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target_type: 'physique_target', target_id: TARGET_ID, total_sets: 3, exposure_units: 3 });
  });

  it('accumulates exercise_ids without duplicates', () => {
    const twoSessionsSameExercise: SessionExposureInput[] = [
      { date: '2026-08-31', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] },
      { date: '2026-09-01', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] },
    ];
    const result = aggregateExposure(twoSessionsSameExercise, '2026-08-31', '2026-09-06');
    expect(result[0]!.exercise_ids).toEqual([SINGLE_TARGET_EXERCISE.id]);
  });

  it('returns an empty array when no sessions fall in range', () => {
    expect(aggregateExposure(sessions, '2099-01-01', '2099-01-07')).toEqual([]);
  });
});

describe('aggregateWeeklyExposure — explicit, configurable week boundary', () => {
  const sessions: SessionExposureInput[] = [
    // Sunday 2026-08-30 and Monday 2026-08-31 straddle a Mon-start/Sun-start boundary.
    { date: '2026-08-30', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] },
    { date: '2026-08-31', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] },
  ];

  it('a Monday-start week does NOT include the preceding Sunday', () => {
    const result = aggregateWeeklyExposure(sessions, '2026-09-01', 'monday');
    expect(result[0]!.total_sets).toBe(1); // only 08-31 (Monday) counts
    expect(result[0]!.period_start).toBe('2026-08-31');
  });

  it('a Sunday-start week DOES include both days — proves the boundary is configurable, not hard-coded', () => {
    const result = aggregateWeeklyExposure(sessions, '2026-09-01', 'sunday');
    expect(result[0]!.total_sets).toBe(2);
    expect(result[0]!.period_start).toBe('2026-08-30');
  });
});

describe('aggregateRollingExposure — no silent default window', () => {
  const sessions: SessionExposureInput[] = [
    { date: '2026-08-24', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] }, // 13 days before 09-06
    { date: '2026-09-05', exercises: [{ exercise_id: SINGLE_TARGET_EXERCISE.id, sets: [{ completed: true }] }] }, // yesterday
  ];

  it('a 7-day window only picks up the recent session', () => {
    const result = aggregateRollingExposure(sessions, '2026-09-06', 7);
    expect(result[0]!.total_sets).toBe(1);
  });

  it('a 14-day window picks up both — demonstrating the exact failure mode the spec warns about is avoidable by choosing the window explicitly', () => {
    const result = aggregateRollingExposure(sessions, '2026-09-06', 14);
    expect(result[0]!.total_sets).toBe(2);
  });
});
