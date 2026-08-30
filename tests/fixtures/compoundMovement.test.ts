// Fixture B (spec §35): compound movement — an exercise with multiple
// Blueprint targets. Demonstrates the primary/secondary exposure model
// (spec §7, docs/TRAINING_EXPOSURE_MODEL.md §6): every PRIMARY
// (physique_targets/functional_goals) target gets full 1.00/set credit —
// never a fractional split among multiple primary targets — and any
// SECONDARY target is resolved only through the explicit, documented,
// non-fuzzy mapping (docs/SECONDARY_TARGET_MAPPING.md), never invented
// from free text on the fly.

import { describe, expect, it } from 'vitest';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { EXPOSURE_COEFFICIENTS } from '../../src/engine/config.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('fixture B: compound movement (multiple Blueprint targets)', () => {
  it('a compound exercise with N listed PRIMARY targets produces N primary contributions, each with FULL credit (not 1/N split)', () => {
    const exercise = BlueprintAdapter.getExercises().find(
      (e) => e.exercise_type === 'compound' && (e.physique_targets ?? []).length >= 2
    );
    expect(exercise).toBeDefined();
    const targetCount = exercise!.physique_targets!.length;

    const { contributions } = calculateExerciseExposure(exercise!.id, [{ completed: true }, { completed: true }]);
    const primaryContributions = contributions.filter((c) => c.role === 'primary');

    expect(primaryContributions).toHaveLength(targetCount);
    expect(new Set(primaryContributions.map((c) => c.target_id))).toEqual(new Set(exercise!.physique_targets));
    for (const c of primaryContributions) {
      expect(c.exposure_units).toBe(2 * EXPOSURE_COEFFICIENTS.primary);
      expect(c.completed_sets).toBe(2);
    }
  });

  it('secondary exposure is resolved only through the explicit mapping — never a target Blueprint free text merely mentions in passing', () => {
    // flat-barbell-bench-press: secondary_targets = ['anterior deltoids', 'triceps'],
    // both mapped (docs/SECONDARY_TARGET_MAPPING.md) to real canonical ids.
    const { contributions } = calculateExerciseExposure('flat-barbell-bench-press', [{ completed: true }]);
    const secondary = contributions.filter((c) => c.role === 'secondary');

    expect(secondary.map((c) => c.target_id).sort()).toEqual(['front-delt', 'triceps']);
    for (const c of secondary) {
      expect(c.exposure_units).toBe(1 * EXPOSURE_COEFFICIENTS.secondary);
      expect(c.target_type).toBe('physique_target');
    }
  });

  it('a secondary_targets phrase with no confident canonical mapping contributes nothing, silently guessed at nothing', () => {
    // close-grip-bench-press: secondary_targets includes 'chest', which is
    // deliberately left unmapped (ambiguous among upper/mid/lower-pec).
    const { contributions, unmapped_secondary_phrases } = calculateExerciseExposure('close-grip-bench-press', [{ completed: true }]);

    expect(unmapped_secondary_phrases).toContain('chest');
    expect(contributions.some((c) => c.target_id === 'chest')).toBe(false);
    // upper-pec/mid-pec/lower-pec are all real canonical ids — none of
    // them were guessed at either.
    expect(contributions.some((c) => ['upper-pec', 'mid-pec', 'lower-pec'].includes(c.target_id))).toBe(false);
  });
});
