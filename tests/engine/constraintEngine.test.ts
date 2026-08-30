import { describe, expect, it } from 'vitest';
import {
  filterEquipmentFeasible,
  fitsWithinBudget,
  fitToTimeBudget,
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

describe('fitToTimeBudget — spec §6.2 (required test 4: exceeds time -> preserve higher-priority work, never exceed budget)', () => {
  it('keeps everything when it already fits', () => {
    const items = [
      { id: 'a', priority: 1, estimated_minutes: 10 },
      { id: 'b', priority: 2, estimated_minutes: 10 },
    ];
    const result = fitToTimeBudget(items, 30);
    expect(result.kept.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.dropped).toEqual([]);
    expect(result.total_minutes).toBe(20);
  });

  it('preserves higher-priority work and drops lower-priority work when it does not fit', () => {
    const items = [
      { id: 'low-priority', priority: 2, estimated_minutes: 20 },
      { id: 'high-priority', priority: 1, estimated_minutes: 20 },
    ];
    const result = fitToTimeBudget(items, 25);
    expect(result.kept.map((i) => i.id)).toEqual(['high-priority']);
    expect(result.dropped.map((i) => i.id)).toEqual(['low-priority']);
  });

  it('never exceeds the time limit', () => {
    const items = [
      { id: 'a', priority: 1, estimated_minutes: 15 },
      { id: 'b', priority: 1, estimated_minutes: 15 },
      { id: 'c', priority: 1, estimated_minutes: 15 },
    ];
    const result = fitToTimeBudget(items, 25);
    expect(result.total_minutes).toBeLessThanOrEqual(25);
  });

  it('drops a redundant item before a non-redundant item at the same priority', () => {
    const items = [
      { id: 'redundant', priority: 1, estimated_minutes: 15, redundant: true },
      { id: 'unique', priority: 1, estimated_minutes: 15, redundant: false },
    ];
    const result = fitToTimeBudget(items, 15);
    expect(result.kept.map((i) => i.id)).toEqual(['unique']);
    expect(result.dropped.map((i) => i.id)).toEqual(['redundant']);
  });

  it('does not truncate by original array order — drops are priority-driven, not position-driven', () => {
    // First item in the array is lowest priority; a naive "cut the tail"
    // truncation would keep it and drop the later, higher-priority one.
    const items = [
      { id: 'first-in-array-lowest-priority', priority: 3, estimated_minutes: 20 },
      { id: 'last-in-array-highest-priority', priority: 1, estimated_minutes: 20 },
    ];
    const result = fitToTimeBudget(items, 20);
    expect(result.kept.map((i) => i.id)).toEqual(['last-in-array-highest-priority']);
  });

  it('is deterministic and tie-breaks equal priority/redundancy by id', () => {
    const items = [
      { id: 'zeta', priority: 1, estimated_minutes: 10 },
      { id: 'alpha', priority: 1, estimated_minutes: 10 },
    ];
    const result = fitToTimeBudget(items, 15);
    expect(result.kept.map((i) => i.id)).toEqual(['alpha']);
  });

  it('reasoning names exactly which items were dropped — never an opaque decision', () => {
    const items = [
      { id: 'kept-item', priority: 1, estimated_minutes: 10 },
      { id: 'dropped-item', priority: 2, estimated_minutes: 10 },
    ];
    const result = fitToTimeBudget(items, 10);
    expect(result.reasoning).toContain('dropped-item');
  });
});
