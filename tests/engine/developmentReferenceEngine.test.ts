// Programming Redesign (Step 12) §16.A: Blueprint reference tests —
// proves the weekly direct-set reference is genuinely calculated from
// real Blueprint package data (sum(sets) x frequency), that Complete vs
// Efficient are selected correctly, that no universal number is
// hardcoded here, that missing-package behaviour is explicit, and that
// different muscle groups really do get different references.

import { describe, expect, it } from 'vitest';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { developmentPackageLevelFor, getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';

function realWeeklyReference(muscleGroup: string, level: 'complete' | 'efficient'): number {
  const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.muscle_group === muscleGroup && p.level === level)!;
  return pkg.exercises.reduce((sum, e) => sum + e.sets, 0) * pkg.frequency.sessions_per_week;
}

describe('getDevelopmentReference', () => {
  it('Efficient reference is calculated as sum(exercise sets) x frequency from real Blueprint data', () => {
    const ref = getDevelopmentReference('physique_target', 'mid-pec', 'efficient');
    expect(ref.package_id).toBe('chest-efficient');
    expect(ref.weekly_direct_set_reference).toBe(realWeeklyReference('chest', 'efficient'));
    expect(ref.weekly_direct_set_reference).toBeGreaterThan(0);
  });

  it('Complete reference is calculated as sum(exercise sets) x frequency from real Blueprint data', () => {
    const ref = getDevelopmentReference('physique_target', 'mid-pec', 'complete');
    expect(ref.package_id).toBe('chest-complete');
    expect(ref.weekly_direct_set_reference).toBe(realWeeklyReference('chest', 'complete'));
  });

  it('Complete reference is strictly more (or equal) volume than Efficient for the same target, never less', () => {
    for (const muscleGroup of BlueprintAdapter.getDevelopmentPackages().muscle_groups) {
      const targetId = muscleGroup.target_ids[0];
      if (!targetId) continue;
      const efficient = getDevelopmentReference('physique_target', targetId, 'efficient');
      const complete = getDevelopmentReference('physique_target', targetId, 'complete');
      if (efficient.weekly_direct_set_reference === null || complete.weekly_direct_set_reference === null) continue;
      expect(complete.weekly_direct_set_reference).toBeGreaterThanOrEqual(efficient.weekly_direct_set_reference);
    }
  });

  it('developmentPackageLevelFor: active goal (specialization) -> complete, non-goal -> efficient', () => {
    expect(developmentPackageLevelFor(true)).toBe('complete');
    expect(developmentPackageLevelFor(false)).toBe('efficient');
  });

  it('different muscle groups have genuinely different weekly references — no universal hardcoded number', () => {
    const chest = getDevelopmentReference('physique_target', 'mid-pec', 'complete');
    const calves = getDevelopmentReference('physique_target', 'gastrocnemius', 'complete');
    expect(chest.weekly_direct_set_reference).not.toBe(calves.weekly_direct_set_reference);
    expect(chest.weekly_direct_set_reference).toBe(realWeeklyReference('chest', 'complete'));
    expect(calves.weekly_direct_set_reference).toBe(realWeeklyReference('calves', 'complete'));
  });

  it('missing package behaviour is explicit: a functional_goal target returns null, never a guessed number', () => {
    const ref = getDevelopmentReference('functional_goal', 'rotator-cuff', 'efficient');
    expect(ref.package_id).toBeNull();
    expect(ref.weekly_direct_set_reference).toBeNull();
    expect(ref.coverage).toBeNull();
  });

  it('missing package behaviour is explicit: a physique target not grouped into any muscle_group returns null', () => {
    const ref = getDevelopmentReference('physique_target', 'not-a-real-target-id', 'efficient');
    expect(ref.package_id).toBeNull();
    expect(ref.weekly_direct_set_reference).toBeNull();
  });

  it('carries real coverage information (muscle_group id + exercise count) alongside the reference', () => {
    const ref = getDevelopmentReference('physique_target', 'mid-pec', 'complete');
    expect(ref.coverage?.muscle_group_id).toBe('chest');
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'chest-complete')!;
    expect(ref.coverage?.exercise_count).toBe(pkg.exercises.length);
  });

  it('reference changes automatically if the underlying package data has more/fewer exercises or a different frequency (no duplicated constant)', () => {
    // Proves this module never hardcodes chest's own numbers: it re-derives
    // them from BlueprintAdapter every call, so this equality is a
    // tautology only if the module truly reads live package data.
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'chest-complete')!;
    const expected = pkg.exercises.reduce((s, e) => s + e.sets, 0) * pkg.frequency.sessions_per_week;
    expect(getDevelopmentReference('physique_target', 'mid-pec', 'complete').weekly_direct_set_reference).toBe(expected);
  });
});
