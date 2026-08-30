import { describe, expect, it } from 'vitest';
import { explainEquipmentFeasibility, explainExposureContribution } from '../../src/engine/explanationEngine.js';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('explainExposureContribution — real, deterministic text from real decision inputs', () => {
  it('names the actual exercise and target, and states the set count', () => {
    const exercise = BlueprintAdapter.getExercises().find((e) => (e.physique_targets ?? []).length === 1)!;
    const [contribution] = calculateExerciseExposure(exercise.id, [{ completed: true }, { completed: true }]);

    const text = explainExposureContribution(contribution!);

    expect(text).toContain(exercise.name);
    expect(text).toContain('2 exposure_units');
    expect(text).toContain('2 completed sets');
    expect(text.toLowerCase()).toContain('strategy a');
  });

  it('uses singular "set" for exactly one completed set', () => {
    const exercise = BlueprintAdapter.getExercises().find((e) => (e.physique_targets ?? []).length === 1)!;
    const [contribution] = calculateExerciseExposure(exercise.id, [{ completed: true }]);

    expect(explainExposureContribution(contribution!)).toContain('1 completed set,');
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
