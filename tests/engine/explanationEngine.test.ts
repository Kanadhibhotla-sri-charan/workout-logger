import { describe, expect, it } from 'vitest';
import { explainEquipmentFeasibility, explainExposureContribution } from '../../src/engine/explanationEngine.js';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

const SINGLE_TARGET_EXERCISE = BlueprintAdapter.getExercises().find(
  (e) => (e.physique_targets ?? []).length === 1 && !(e.secondary_targets ?? []).length
)!;

describe('explainExposureContribution — real, deterministic text from real decision inputs', () => {
  it('names the actual exercise and target, states the set count and role/coefficient', () => {
    const { contributions } = calculateExerciseExposure(SINGLE_TARGET_EXERCISE.id, [{ completed: true }, { completed: true }]);
    const [contribution] = contributions;

    const text = explainExposureContribution(contribution!);

    expect(text).toContain(SINGLE_TARGET_EXERCISE.name);
    expect(text).toContain('2 exposure_units');
    expect(text).toContain('2 completed sets');
    expect(text).toContain('primary');
    expect(text).toContain('1 primary coefficient');
  });

  it('uses singular "set" for exactly one completed set', () => {
    const { contributions } = calculateExerciseExposure(SINGLE_TARGET_EXERCISE.id, [{ completed: true }]);
    expect(explainExposureContribution(contributions[0]!)).toContain('1 completed set ');
  });

  it('explains a secondary contribution with its 0.33 coefficient and the curated-mapping note', () => {
    const { contributions } = calculateExerciseExposure('flat-barbell-bench-press', [{ completed: true }]);
    const secondary = contributions.find((c) => c.role === 'secondary')!;

    const text = explainExposureContribution(secondary);
    expect(text).toContain('0.33 secondary coefficient');
    expect(text).toContain('SECONDARY_TARGET_MAPPING.md');
  });
});

describe('explainEquipmentFeasibility', () => {
  it('explains a feasible exercise', () => {
    const text = explainEquipmentFeasibility('bench-press', ['barbell', 'bench'], ['barbell', 'bench', 'dumbbell']);
    expect(text).toContain('is equipment-feasible');
  });

  it('names exactly what is missing for an infeasible exercise', () => {
    const text = explainEquipmentFeasibility('bench-press', ['barbell', 'bench'], ['dumbbell']);
    expect(text).toContain('NOT equipment-feasible');
    expect(text).toContain('missing barbell, bench');
  });
});
