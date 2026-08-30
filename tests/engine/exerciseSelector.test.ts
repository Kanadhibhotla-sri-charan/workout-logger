import { describe, expect, it } from 'vitest';
import { NoFeasibleExerciseError, selectExercise } from '../../src/engine/exerciseSelector.js';
import { explainExerciseSelection } from '../../src/engine/explanationEngine.js';

// triceps is a primary target for cable-pushdown, and only a secondary
// (mapped-from-free-text) target for cable-chest-press (whose own
// primary role is mid-pec) — see docs/SECONDARY_TARGET_MAPPING.md.
const TRICEPS_PRIMARY = 'cable-pushdown';
const TRICEPS_SECONDARY_ONLY = 'cable-chest-press';

describe('exerciseSelector — spec §5', () => {
  it('prefers a primary-role candidate over a secondary-only one for the same target (Blueprint muscle-role data)', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
    expect(result.reasoning).toContain('primary');
  });

  it('mildly penalizes a recently-used candidate but does not exclude it outright', () => {
    // Only one candidate at all — must still be selected even though recent.
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY],
      recent_exercise_ids: [TRICEPS_PRIMARY],
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
  });

  it('prefers a non-recent primary candidate over a recent primary candidate, all else equal', () => {
    const otherTricepsPrimary = 'close-grip-bench-press';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, otherTricepsPrimary],
      recent_exercise_ids: [TRICEPS_PRIMARY],
    });
    expect(result.exercise_id).toBe(otherTricepsPrimary);
  });

  it('§5: keeps the current exercise when it is tied for best, rather than replacing it for no reason', () => {
    const otherTricepsPrimary = 'close-grip-bench-press';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, otherTricepsPrimary],
      recent_exercise_ids: [],
      current_exercise_id: otherTricepsPrimary,
    });
    expect(result.exercise_id).toBe(otherTricepsPrimary);
    expect(result.reasoning).toContain('kept');
  });

  it('§5: replaces the current exercise when a demonstrably better (primary-role) candidate exists', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY],
      recent_exercise_ids: [],
      current_exercise_id: TRICEPS_SECONDARY_ONLY,
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
    expect(result.reasoning).toContain('replaces');
  });

  it('is deterministic: identical inputs always produce the identical output', () => {
    const input = {
      target_type: 'physique_target' as const,
      target_id: 'triceps',
      target_tier: 'primary' as const,
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY, 'close-grip-bench-press'],
      recent_exercise_ids: [TRICEPS_PRIMARY],
    };
    const a = selectExercise(input);
    const b = selectExercise(input);
    expect(a).toEqual(b);
  });

  it('throws NoFeasibleExerciseError when given no candidates at all', () => {
    expect(() =>
      selectExercise({
        target_type: 'physique_target',
        target_id: 'triceps',
        target_tier: 'primary',
        candidate_exercise_ids: [],
        recent_exercise_ids: [],
      })
    ).toThrow(NoFeasibleExerciseError);
  });

  it('reasoning is a real, non-opaque explanation (spec §20) and matches explainExerciseSelection', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.length).toBeGreaterThan(20);
    expect(explainExerciseSelection(result)).toBe(result.reasoning);
  });
});
