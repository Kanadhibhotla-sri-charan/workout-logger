import { describe, expect, it } from 'vitest';
import {
  filterEquipmentFeasible,
  fitsWithinBudget,
  isExerciseEquipmentFeasible,
  remainingBudgetMinutes,
} from '../../src/engine/constraintEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('isExerciseEquipmentFeasible — §18', () => {
  it('is feasible when every required item is available', () => {
    const exercise = { equipment: ['barbell', 'bench'] };
    expect(isExerciseEquipmentFeasible(exercise, ['barbell', 'bench', 'dumbbell'])).toBe(true);
  });

  it('is infeasible when any required item is missing', () => {
    const exercise = { equipment: ['barbell', 'bench'] };
    expect(isExerciseEquipmentFeasible(exercise, ['barbell'])).toBe(false);
  });

  it('a bodyweight-only exercise (no equipment) is always feasible', () => {
    expect(isExerciseEquipmentFeasible({ equipment: [] }, [])).toBe(true);
  });

  it('never recommends unavailable equipment for a real Blueprint exercise', () => {
    const barbellOnly = BlueprintAdapter.getExercises().find((e) => e.equipment.length === 1 && e.equipment[0] === 'barbell');
    expect(barbellOnly).toBeDefined();
    expect(isExerciseEquipmentFeasible(barbellOnly!, [])).toBe(false);
    expect(isExerciseEquipmentFeasible(barbellOnly!, ['barbell'])).toBe(true);
  });
});

describe('filterEquipmentFeasible', () => {
  it('keeps only exercises whose full equipment list is available', () => {
    const exercises = [{ equipment: ['barbell'] }, { equipment: ['dumbbell', 'bench'] }, { equipment: [] }];
    expect(filterEquipmentFeasible(exercises, ['barbell'])).toEqual([{ equipment: ['barbell'] }, { equipment: [] }]);
  });
});

describe('time budget primitives — §17', () => {
  it('computes remaining budget', () => {
    expect(remainingBudgetMinutes(60, 20)).toBe(40);
    expect(remainingBudgetMinutes(60, 60)).toBe(0);
    expect(remainingBudgetMinutes(60, 70)).toBe(-10); // already over — callers must not clamp this away
  });

  it('fitsWithinBudget treats the budget as a hard constraint, not a suggestion', () => {
    expect(fitsWithinBudget(60, 20, 30)).toBe(true); // 50 <= 60
    expect(fitsWithinBudget(60, 20, 45)).toBe(false); // 65 > 60
    expect(fitsWithinBudget(60, 60, 1)).toBe(false); // no room left at all
  });

  it('exactly filling the budget is allowed (inclusive boundary)', () => {
    expect(fitsWithinBudget(60, 30, 30)).toBe(true);
  });
});
