// Exercise-variety work (2026-10-09): the profile-default prescription a
// non-package exercise gets in the wide exercise pool must come from the
// same Blueprint rule the development packages' own reps were copied from.

import { describe, expect, it } from 'vitest';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { parseRange } from '../../src/blueprint/developmentPackages.js';
import { DEFAULT_COMPOUND_SETS, DEFAULT_ISOLATION_SETS, defaultPrescriptionFor, resolvePrimaryRepRange } from '../../src/blueprint/programmingProfiles.js';

describe('resolvePrimaryRepRange', () => {
  it('reproduces every authored development-package rep range', () => {
    const mismatches: string[] = [];
    for (const pkg of BlueprintAdapter.getDevelopmentPackages().packages) {
      for (const entry of pkg.exercises) {
        const exercise = BlueprintAdapter.getExercise(entry.exercise_id)!;
        const authored = parseRange(entry.reps);
        const [min, max] = resolvePrimaryRepRange(exercise);
        if (authored.min !== min || authored.max !== max) mismatches.push(`${pkg.id}/${entry.exercise_id}: package ${entry.reps}, profile ${min}-${max}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('classifies a heavy free-weight compound into its 6-12 profile', () => {
    expect(resolvePrimaryRepRange(BlueprintAdapter.getExercise('flat-barbell-bench-press')!)).toEqual([6, 12]);
  });
});

describe('defaultPrescriptionFor', () => {
  it('gives a compound 3 sets and an isolation 2 sets, with the global working RIR range', () => {
    const compound = defaultPrescriptionFor('t-bar-row')!;
    const isolation = defaultPrescriptionFor('preacher-curl')!;
    expect(compound.sets).toBe(DEFAULT_COMPOUND_SETS);
    expect(isolation.sets).toBe(DEFAULT_ISOLATION_SETS);
    const [rirMin, rirMax] = BlueprintAdapter.getGlobalPrinciples().rir.typical_working_range;
    expect(compound.rir).toEqual({ min: rirMin, max: rirMax });
  });

  it('matches the set count of every package compound', () => {
    for (const pkg of BlueprintAdapter.getDevelopmentPackages().packages) {
      for (const entry of pkg.exercises) {
        if (BlueprintAdapter.getExercise(entry.exercise_id)!.exercise_type === 'compound') expect(entry.sets).toBe(DEFAULT_COMPOUND_SETS);
      }
    }
  });

  it('is null for an unknown exercise', () => {
    expect(defaultPrescriptionFor('not-an-exercise')).toBeNull();
  });
});
