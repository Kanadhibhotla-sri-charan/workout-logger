// Recovery+Fallback Fix §2: a physique target with no resolved
// Blueprint development package must never silently receive the
// universal weekly_volume guidance (starting_point/practical_range/
// higher_recovery_dependent) as if it were that target's own
// target-specific development reference. The numeric bands are the
// only guidance this module has for that degraded case (no redesign of
// the volume system), but the result is explicitly labeled
// 'missing_physique_package' rather than being indistinguishable from
// either a real Blueprint package reference or the legitimate
// functional-goal / no-context fallback.

import { describe, expect, it } from 'vitest';
import { decideVolume, type VolumeDecisionInput } from '../../src/engine/volumeEngine.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';
import type { DevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

const BASE: VolumeDecisionInput = {
  target_type: 'physique_target',
  target_id: 'triceps',
  goal_priority: 1,
  current_weekly_primary_sets: 12,
  aesthetic_progress_trend: 'improving',
  recovery_ok: true,
};

describe('Test A — a missing physique package never silently uses global weekly_volume as its own reference', () => {
  it('is labeled missing_physique_package, never one of the generic global-guidance labels', () => {
    const missingPackage: DevelopmentReference = {
      target_type: 'physique_target',
      target_id: 'an-ungrouped-physique-target',
      level: 'efficient',
      package_id: null,
      weekly_direct_set_reference: null,
      coverage: null,
    };
    const result = decideVolume({ ...BASE, target_id: 'an-ungrouped-physique-target', development_reference: missingPackage });

    expect(result.blueprint_reference_range.label).toBe('missing_physique_package');
    expect(result.blueprint_reference_range.label).not.toBe('practical_range');
    expect(result.blueprint_reference_range.label).not.toBe('starting_point');
    expect(result.blueprint_reference_range.label).not.toBe('higher_recovery_dependent');
    expect(result.blueprint_reference_range.label).not.toBe('blueprint_package_reference');
  });

  it('this would fail if the guard were removed and global weekly_volume silently stood in as the reference', () => {
    const { practical_range_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;
    const missingPackage: DevelopmentReference = {
      target_type: 'physique_target',
      target_id: 'an-ungrouped-physique-target',
      level: 'efficient',
      package_id: null,
      weekly_direct_set_reference: null,
      coverage: null,
    };
    // current_weekly_primary_sets deliberately inside the practical_range
    // band, so a pre-fix implementation would have returned label
    // 'practical_range' with these exact min/max numbers.
    const result = decideVolume({
      ...BASE,
      target_id: 'an-ungrouped-physique-target',
      current_weekly_primary_sets: practical_range_sets[0],
      development_reference: missingPackage,
    });
    expect(result.blueprint_reference_range.label).not.toBe('practical_range');
  });
});

describe('Test B — a real, resolved Blueprint package still wins over any global guidance', () => {
  it('a physique target with a real Efficient package uses that exact target-specific reference, never a global band', () => {
    const realReference = getDevelopmentReference('physique_target', 'triceps', 'efficient');
    expect(realReference.weekly_direct_set_reference).not.toBeNull(); // sanity: triceps really does have a package

    const result = decideVolume({ ...BASE, development_reference: realReference });

    expect(result.blueprint_reference_range.label).toBe('blueprint_package_reference');
    expect(result.blueprint_reference_range.min).toBe(realReference.weekly_direct_set_reference);
    expect(result.blueprint_reference_range.max).toBe(realReference.weekly_direct_set_reference);
  });
});

describe('Test C — functional-goal behavior is unaffected by the physique-package guard', () => {
  it('a functional_goal with no package (by design) still gets the legitimate universal fallback, never mislabeled as a missing physique package', () => {
    const functionalReference: DevelopmentReference = {
      target_type: 'functional_goal',
      target_id: 'some-functional-goal',
      level: 'efficient',
      package_id: null,
      weekly_direct_set_reference: null,
      coverage: null,
    };
    const result = decideVolume({ ...BASE, target_type: 'functional_goal', target_id: 'some-functional-goal', development_reference: functionalReference });

    expect(result.blueprint_reference_range.label).not.toBe('missing_physique_package');
    expect(['starting_point', 'practical_range', 'higher_recovery_dependent']).toContain(result.blueprint_reference_range.label);
  });

  it('no development_reference at all (no target-resolution context) also falls back to the legitimate universal bands, unaffected', () => {
    const result = decideVolume({ ...BASE });
    expect(result.blueprint_reference_range.label).not.toBe('missing_physique_package');
  });
});

describe('Test D — non-goal Efficient-package programming is unaffected by the guard', () => {
  it('a real non-goal physique target still resolves its own Efficient package reference exactly as before', () => {
    const efficientReference = getDevelopmentReference('physique_target', 'triceps', 'efficient');
    const result = decideVolume({ ...BASE, current_weekly_primary_sets: 0, development_reference: efficientReference });

    expect(result.action).toBe('increase');
    expect(result.blueprint_reference_range.label).toBe('blueprint_package_reference');
    expect(result.recommended_weekly_primary_sets).toBeLessThanOrEqual(efficientReference.weekly_direct_set_reference!);
  });
});
