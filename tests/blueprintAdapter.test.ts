import { describe, expect, it } from 'vitest';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

describe('BlueprintAdapter', () => {
  it('resolves a known exercise id', () => {
    const exercise = BlueprintAdapter.getExercise('ab-wheel-rollout');
    expect(exercise).toBeDefined();
    expect(exercise?.name).toBe('Ab Wheel Rollout');
    expect(BlueprintAdapter.isKnownExercise('ab-wheel-rollout')).toBe(true);
  });

  it('returns undefined for an unknown exercise id', () => {
    expect(BlueprintAdapter.getExercise('not-a-real-exercise-id')).toBeUndefined();
    expect(BlueprintAdapter.isKnownExercise('not-a-real-exercise-id')).toBe(false);
  });

  it('lists all exercises with a non-zero count', () => {
    const exercises = BlueprintAdapter.getExercises();
    expect(exercises.length).toBeGreaterThan(0);
  });

  it('resolves a known aesthetic goal and functional goal, and a known target', () => {
    const aestheticGoals = BlueprintAdapter.getAestheticGoals();
    expect(aestheticGoals.length).toBeGreaterThan(0);
    const known = aestheticGoals[0]!;
    expect(BlueprintAdapter.getAestheticGoal(known.id)?.id).toBe(known.id);

    const functionalGoals = BlueprintAdapter.getFunctionalGoals();
    expect(functionalGoals.length).toBeGreaterThan(0);
    const knownFunctional = functionalGoals[0]!;
    expect(BlueprintAdapter.getFunctionalGoal(knownFunctional.id)?.id).toBe(knownFunctional.id);

    const targets = BlueprintAdapter.getTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(BlueprintAdapter.getTarget(targets[0]!.id)?.id).toBe(targets[0]!.id);
  });

  it('returns undefined for unknown aesthetic/functional/target ids', () => {
    expect(BlueprintAdapter.getAestheticGoal('nope')).toBeUndefined();
    expect(BlueprintAdapter.getFunctionalGoal('nope')).toBeUndefined();
    expect(BlueprintAdapter.getTarget('nope')).toBeUndefined();
  });

  it('derives an equipment list from exercise data', () => {
    const equipment = BlueprintAdapter.getEquipmentList();
    expect(equipment.length).toBeGreaterThan(0);
    const dumbbell = equipment.find((e) => e.id === 'dumbbell');
    expect(dumbbell).toBeDefined();
    expect(dumbbell!.exerciseCount).toBeGreaterThan(0);
  });

  it('never lets this app mutate Blueprint data (immutability)', () => {
    const exercise = BlueprintAdapter.getExercise('ab-wheel-rollout')!;
    expect(() => {
      // @ts-expect-error intentional mutation attempt for the test
      exercise.name = 'Tampered Name';
    }).toThrow();
    expect(BlueprintAdapter.getExercise('ab-wheel-rollout')?.name).toBe('Ab Wheel Rollout');

    const exercises = BlueprintAdapter.getExercises();
    expect(() => {
      // @ts-expect-error intentional mutation attempt for the test
      exercises.push({});
    }).toThrow();
    expect(BlueprintAdapter.getExercises().length).toBe(exercises.length);

    const body_regions = exercise.body_regions;
    expect(() => {
      // @ts-expect-error intentional mutation attempt for the test
      body_regions.push('made-up-region');
    }).toThrow();
  });

  it('carries snapshot provenance in the manifest', () => {
    const manifest = BlueprintAdapter.getManifest();
    expect(manifest.source).toContain('workout-blueprint');
    expect(manifest.exerciseCount).toBe(BlueprintAdapter.getExercises().length);
    expect(typeof manifest.sourceCommit).toBe('string');
  });
});
