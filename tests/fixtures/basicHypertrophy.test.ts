// Fixture A (spec §35): basic hypertrophy — one target, simple isolation
// exercise. Proves exposureEngine on the simplest real case: a single
// completed exercise, one listed (primary) target, straightforward
// exposure_units counting, no secondary contributions in play.

import { describe, expect, it } from 'vitest';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('fixture A: basic hypertrophy (one target, isolation exercise)', () => {
  it('a single isolation exercise with one listed target and no secondary_targets produces exposure to only that target', () => {
    const exercise = BlueprintAdapter.getExercises().find(
      (e) => e.exercise_type === 'isolation' && (e.physique_targets ?? []).length === 1 && !(e.secondary_targets ?? []).length
    );
    expect(exercise).toBeDefined();

    const { contributions } = calculateExerciseExposure(exercise!.id, [
      { completed: true },
      { completed: true },
      { completed: true },
    ]);

    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      exercise_id: exercise!.id,
      target_type: 'physique_target',
      target_id: exercise!.physique_targets![0],
      role: 'primary',
      completed_sets: 3,
      exposure_units: 3,
    });
  });
});
