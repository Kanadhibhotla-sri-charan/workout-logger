import { describe, expect, it } from 'vitest';
import { computeProgression } from '../../src/engine/progressionEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { PROGRESSION_INCREMENTS, RECOVERY_THRESHOLDS } from '../../src/engine/config.js';

const EXERCISE_ID = 'flat-barbell-bench-press';

describe('progressionEngine — Blueprint double-progression + RIR model', () => {
  it('recommends increase_load when every completed set reaches the top of the range at/below the typical working RIR', () => {
    const [, rirMax] = BlueprintAdapter.getGlobalPrinciples().rir.typical_working_range;

    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [
        [
          { weight: 60, reps: 12, completed: true, rir: rirMax },
          { weight: 60, reps: 12, completed: true, rir: rirMax },
          { weight: 60, reps: 13, completed: true, rir: rirMax - 1 },
        ],
      ],
    });

    expect(result.recommendation).toBe('increase_load');
    expect(result.reasoning).toContain(String(PROGRESSION_INCREMENTS.loadKg));
  });

  it('recommends increase_reps when sets are within range but not yet at the top', () => {
    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [
        [
          { weight: 60, reps: 9, completed: true, rir: 2 },
          { weight: 60, reps: 8, completed: true, rir: 2 },
        ],
      ],
    });

    expect(result.recommendation).toBe('increase_reps');
    expect(result.reasoning).toContain(String(PROGRESSION_INCREMENTS.reps));
  });

  it('does not treat a top-of-range set at a much harder-than-typical RIR as the increase_load trigger being blocked — RIR at or below the typical max still counts', () => {
    const [, rirMax] = BlueprintAdapter.getGlobalPrinciples().rir.typical_working_range;
    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [[{ weight: 60, reps: 12, completed: true, rir: 0 }]],
    });
    expect(rirMax).toBeGreaterThanOrEqual(0);
    expect(result.recommendation).toBe('increase_load');
  });

  it('recommends maintain (not reduce) after a single below-range session', () => {
    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [[{ weight: 60, reps: 5, completed: true, rir: 0 }]],
    });

    expect(result.recommendation).toBe('maintain');
  });

  it('recommends reduce only after a genuine multi-session decline pattern (RECOVERY_THRESHOLDS.consecutiveDecliningSessions)', () => {
    const belowRangeSession = [{ weight: 60, reps: 5, completed: true, rir: 0 }];
    const recentSessions = Array.from({ length: RECOVERY_THRESHOLDS.consecutiveDecliningSessions }, () => belowRangeSession);

    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: recentSessions,
    });

    expect(result.recommendation).toBe('reduce');
  });

  it('does not reduce when the decline pattern is one session short of the threshold', () => {
    const belowRangeSession = [{ weight: 60, reps: 5, completed: true, rir: 0 }];
    const recentSessions = Array.from({ length: RECOVERY_THRESHOLDS.consecutiveDecliningSessions - 1 }, () => belowRangeSession);

    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: recentSessions,
    });

    expect(result.recommendation).toBe('maintain');
  });

  it('returns unknown when no sets were completed', () => {
    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [[{ weight: 60, reps: null, completed: false, rir: null }]],
    });

    expect(result.recommendation).toBe('unknown');
  });

  it('returns unknown when there is no session history at all', () => {
    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [],
    });

    expect(result.recommendation).toBe('unknown');
  });

  it('treats a set with no logged rir as judgeable on reps alone (never blocks progression purely for missing rir)', () => {
    const result = computeProgression({
      exercise_id: EXERCISE_ID,
      target_reps_min: 8,
      target_reps_max: 12,
      recent_sessions_actual_sets: [[{ weight: 60, reps: 12, completed: true, rir: null }]],
    });

    expect(result.recommendation).toBe('increase_load');
  });
});
