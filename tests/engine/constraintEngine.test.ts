import { describe, expect, it } from 'vitest';
import {
  filterEquipmentFeasible,
  fitsWithinBudget,
  isBodyFocusAllowedOnDay,
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

describe('isBodyFocusAllowedOnDay — §16 (required test 12: Monday never lower-body)', () => {
  it('forbids a quads target on Monday', () => {
    expect(isBodyFocusAllowedOnDay('quads', 'monday')).toBe(false);
  });

  it('forbids a hamstrings target on Monday', () => {
    expect(isBodyFocusAllowedOnDay('hamstrings', 'monday')).toBe(false);
  });

  it('forbids a calves target (gastrocnemius, parent_region "calves") on Monday', () => {
    expect(isBodyFocusAllowedOnDay('gastrocnemius', 'monday')).toBe(false);
  });

  it('forbids a hips target (gluteus-maximus, parent_region "hips") on Monday', () => {
    expect(isBodyFocusAllowedOnDay('gluteus-maximus', 'monday')).toBe(false);
  });

  it('allows an upper-body target (chest) on Monday', () => {
    expect(isBodyFocusAllowedOnDay('upper-pec', 'monday')).toBe(true);
  });

  it('allows a lower-body target on any other day — the rule is Monday-specific', () => {
    for (const day of ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const) {
      expect(isBodyFocusAllowedOnDay('quads', day)).toBe(true);
    }
  });

  it('is permissive (true) for an unresolvable target id — this function gates known lower-body regions, it does not validate ids', () => {
    expect(isBodyFocusAllowedOnDay('not-a-real-target', 'monday')).toBe(true);
  });

  it('every real Blueprint lower-body physique target is forbidden on Monday', () => {
    const lowerBodyTargets = BlueprintAdapter.getTargets().filter((t) =>
      ['quads', 'hamstrings', 'calves', 'hips'].includes(t.parent_region)
    );
    expect(lowerBodyTargets.length).toBeGreaterThan(0);
    for (const target of lowerBodyTargets) {
      expect(isBodyFocusAllowedOnDay(target.id, 'monday')).toBe(false);
    }
  });
});
