// Fixture E (spec §35, §18): equipment constrained — remove the preferred
// exercise's equipment, verify the engine correctly identifies it as
// infeasible and that a compatible alternative for the same target
// exists among the feasible set.
//
// Scope: "choose an acceptable alternative" is exerciseSelector's ranking
// job (blocked — docs/TRAINING_ENGINE_DESIGN.md §13). This fixture proves
// the feasibility filter itself is correct and that Blueprint's data
// actually supports finding *a* compatible alternative — not that this
// app currently auto-selects the best one.

import { describe, expect, it } from 'vitest';
import { filterEquipmentFeasible, isExerciseEquipmentFeasible } from '../../src/engine/constraintEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('fixture E: equipment constrained', () => {
  it('removing an exercise\'s required equipment makes it infeasible', () => {
    const barbellExercise = BlueprintAdapter.getExercises().find((e) => e.equipment.includes('barbell'))!;
    expect(barbellExercise).toBeDefined();

    const withoutBarbell = BlueprintAdapter.getEquipmentList().map((e) => e.id).filter((id) => id !== 'barbell');

    expect(isExerciseEquipmentFeasible(barbellExercise, withoutBarbell)).toBe(false);
  });

  it('a compatible alternative training the same target remains feasible once the preferred exercise is not', () => {
    const barbellExercise = BlueprintAdapter.getExercises().find(
      (e) => e.equipment.length === 1 && e.equipment[0] === 'barbell' && (e.physique_targets ?? []).length > 0
    )!;
    expect(barbellExercise).toBeDefined();
    const target = barbellExercise.physique_targets![0]!;

    // An alternative exercise for the same target that does NOT require a barbell.
    const alternative = BlueprintAdapter.getExercises().find(
      (e) => e.id !== barbellExercise.id && (e.physique_targets ?? []).includes(target) && !e.equipment.includes('barbell')
    );
    expect(alternative).toBeDefined();

    const availableEquipment = alternative!.equipment; // exactly what's needed for the alternative, nothing else
    expect(isExerciseEquipmentFeasible(barbellExercise, availableEquipment)).toBe(false);
    expect(isExerciseEquipmentFeasible(alternative!, availableEquipment)).toBe(true);
  });

  it('filterEquipmentFeasible over the full catalog never returns an infeasible exercise', () => {
    const availableEquipment = ['dumbbell', 'bench'];
    const feasible = filterEquipmentFeasible(BlueprintAdapter.getExercises(), availableEquipment);

    expect(feasible.length).toBeGreaterThan(0);
    for (const e of feasible) {
      expect(e.equipment.every((item) => availableEquipment.includes(item))).toBe(true);
    }
  });
});
