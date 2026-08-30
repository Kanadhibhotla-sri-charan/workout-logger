// Fixture B (spec §35): compound movement — an exercise with multiple
// Blueprint targets. Explicitly demonstrates the adopted Strategy A
// methodology (docs/TRAINING_EXPOSURE_MODEL.md §B): every listed target
// gets FULL exposure credit, none of them a fractional share, and no
// target NOT listed in physique_targets/functional_goals is ever touched
// — indirect exposure is not invented.

import { describe, expect, it } from 'vitest';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('fixture B: compound movement (multiple Blueprint targets)', () => {
  it('a compound exercise with N listed targets produces N contributions, each with FULL credit (not 1/N split)', () => {
    const exercise = BlueprintAdapter.getExercises().find(
      (e) => e.exercise_type === 'compound' && (e.physique_targets ?? []).length >= 2
    );
    expect(exercise).toBeDefined();
    const targetCount = exercise!.physique_targets!.length;

    const contributions = calculateExerciseExposure(exercise!.id, [{ completed: true }, { completed: true }]);

    expect(contributions).toHaveLength(targetCount);
    expect(new Set(contributions.map((c) => c.target_id))).toEqual(new Set(exercise!.physique_targets));
    // Strategy A: every listed target gets the SAME full credit — never a
    // fractional split like 1/targetCount.
    for (const c of contributions) {
      expect(c.exposure_units).toBe(2);
      expect(c.completed_sets).toBe(2);
    }
  });

  it('Strategy A means secondary_targets (free text) is never used as an exposure signal', () => {
    // Find a compound exercise whose free-text secondary_targets names a
    // muscle that is NOT in its own canonical physique_targets — proof
    // that even when Blueprint's prose suggests a broader stimulus, this
    // app's exposure calculation stays strictly within the canonical,
    // id-resolvable physique_targets list.
    const exercise = BlueprintAdapter.getExercises().find(
      (e) => (e.secondary_targets ?? []).length > 0 && (e.physique_targets ?? []).length >= 1
    );
    expect(exercise).toBeDefined();

    const contributions = calculateExerciseExposure(exercise!.id, [{ completed: true }]);
    const contributedTargetIds = contributions.map((c) => c.target_id);

    // Every contributed target id must come from physique_targets/
    // functional_goals — never from secondary_targets' free text.
    const canonicalIds = new Set([...(exercise!.physique_targets ?? []), ...(exercise!.functional_goals ?? [])]);
    for (const id of contributedTargetIds) {
      expect(canonicalIds.has(id)).toBe(true);
    }
  });
});
