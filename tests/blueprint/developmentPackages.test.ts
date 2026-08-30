import { describe, expect, it } from 'vitest';
import {
  findMuscleGroupForTarget,
  getPackageForTarget,
  lookupExercisePrescription,
  parseRange,
} from '../../src/blueprint/developmentPackages.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('parseRange', () => {
  it('parses a dash range', () => {
    expect(parseRange('6-12')).toEqual({ min: 6, max: 12 });
  });

  it('parses a bare number as min === max', () => {
    expect(parseRange('10')).toEqual({ min: 10, max: 10 });
  });

  it('throws on an unrecognized format rather than guessing', () => {
    expect(() => parseRange('a lot')).toThrow();
  });

  it('every reps and rir range in every real Blueprint package parses cleanly', () => {
    const { packages } = BlueprintAdapter.getDevelopmentPackages();
    for (const pkg of packages) {
      for (const ex of pkg.exercises) {
        expect(() => parseRange(ex.reps)).not.toThrow();
        expect(() => parseRange(ex.rir)).not.toThrow();
      }
    }
  });
});

describe('findMuscleGroupForTarget / getPackageForTarget', () => {
  it('finds the chest muscle_group for mid-pec', () => {
    const group = findMuscleGroupForTarget('mid-pec');
    expect(group?.id).toBe('chest');
  });

  it('returns null for an id not in any muscle_group', () => {
    expect(findMuscleGroupForTarget('not-a-real-target')).toBeNull();
  });

  it('returns the efficient-level package by default', () => {
    const pkg = getPackageForTarget('mid-pec');
    expect(pkg?.level).toBe('efficient');
    expect(pkg?.muscle_group).toBe('chest');
  });

  it('returns the complete-level package when asked', () => {
    const pkg = getPackageForTarget('mid-pec', 'complete');
    expect(pkg?.level).toBe('complete');
  });

  it('returns null for an unresolvable target', () => {
    expect(getPackageForTarget('not-a-real-target')).toBeNull();
  });
});

describe('lookupExercisePrescription', () => {
  it('finds a real prescription for an exercise that is part of the target chest package', () => {
    const prescription = lookupExercisePrescription('mid-pec', 'flat-barbell-bench-press');
    expect(prescription).not.toBeNull();
    expect(prescription!.sets).toBeGreaterThan(0);
    expect(() => parseRange(prescription!.reps)).not.toThrow();
  });

  it('returns null for an exercise that is not part of that target package', () => {
    // A triceps isolation exercise is not part of the chest package.
    expect(lookupExercisePrescription('mid-pec', 'cable-pushdown')).toBeNull();
  });

  it('returns null for an unresolvable target', () => {
    expect(lookupExercisePrescription('not-a-real-target', 'flat-barbell-bench-press')).toBeNull();
  });

  it('every real Blueprint package exercise_id is a real Blueprint exercise', () => {
    const { packages } = BlueprintAdapter.getDevelopmentPackages();
    for (const pkg of packages) {
      for (const ex of pkg.exercises) {
        expect(BlueprintAdapter.getExercise(ex.exercise_id), `${ex.exercise_id} in package ${pkg.id}`).toBeDefined();
      }
    }
  });
});
