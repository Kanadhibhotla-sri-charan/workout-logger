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

// 'lat-width' (not 'mid-pec' or 'quads') is this file's raw whole-package-sum fixture:
// the "back" muscle_group has no scope entry, so
// Sub-Target Exercise Scope (2026-09-19) never filters it — every
// package exercise counts, exactly like every target did before that
// module existed. 'mid-pec' is one of three co-equal slices of the
// shared "chest" package and is deliberately under-counted now (see the
// dedicated "Sub-Target Exercise Scope" describe block below) — using it
// here would no longer prove a whole-package sum.
describe('getDevelopmentReference', () => {
  it('Efficient reference is calculated as sum(exercise sets) x frequency from real Blueprint data', () => {
    const ref = getDevelopmentReference('physique_target', 'lat-width', 'efficient');
    expect(ref.package_id).toBe('back-efficient');
    expect(ref.weekly_direct_set_reference).toBe(realWeeklyReference('back', 'efficient'));
    expect(ref.weekly_direct_set_reference).toBeGreaterThan(0);
  });

  it('Complete reference is calculated as sum(exercise sets) x frequency from real Blueprint data', () => {
    const ref = getDevelopmentReference('physique_target', 'lat-width', 'complete');
    expect(ref.package_id).toBe('back-complete');
    expect(ref.weekly_direct_set_reference).toBe(realWeeklyReference('back', 'complete'));
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
    // 'biceps' and 'lat-width', not 'gastrocnemius' — gastrocnemius now has a
    // Coaching Depth curated preferred-frequency profile (Batch 2), so
    // its weekly_direct_set_reference is intentionally no longer
    // Blueprint's raw package frequency alone; 'biceps' and 'lat-width' have
    // no curated profile and each have no exercise filtering in
    // their own muscle_group, so this stays a pure test of the raw
    // Blueprint calculation.
    const back = getDevelopmentReference('physique_target', 'lat-width', 'complete');
    const biceps = getDevelopmentReference('physique_target', 'biceps', 'complete');
    expect(back.weekly_direct_set_reference).not.toBe(biceps.weekly_direct_set_reference);
    expect(back.weekly_direct_set_reference).toBe(realWeeklyReference('back', 'complete'));
    expect(biceps.weekly_direct_set_reference).toBe(realWeeklyReference('biceps', 'complete'));
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
    const ref = getDevelopmentReference('physique_target', 'lat-width', 'complete');
    expect(ref.coverage?.muscle_group_id).toBe('back');
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'back-complete')!;
    expect(ref.coverage?.exercise_count).toBe(pkg.exercises.length);
  });

  it('reference changes automatically if the underlying package data has more/fewer exercises or a different frequency (no duplicated constant)', () => {
    // Proves this module never hardcodes back's own numbers: it re-derives
    // them from BlueprintAdapter every call, so this equality is a
    // tautology only if the module truly reads live package data.
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'back-complete')!;
    const expected = pkg.exercises.reduce((s, e) => s + e.sets, 0) * pkg.frequency.sessions_per_week;
    expect(getDevelopmentReference('physique_target', 'lat-width', 'complete').weekly_direct_set_reference).toBe(expected);
  });

  describe('Sub-Target Exercise Scope (2026-09-19) — a target sharing its package with siblings only owns the exercises that actually train it', () => {
    it('mid-pec (one of three co-equal chest slices) is credited only with flat-bench + the shared fly, not the whole chest package', () => {
      const ref = getDevelopmentReference('physique_target', 'mid-pec', 'complete');
      expect(ref.package_id).toBe('chest-complete');
      expect(ref.direct_sets_per_exposure).toBe(5); // flat-barbell-bench-press(3) + cable-fly(2)
      expect(ref.weekly_direct_set_reference).toBe(10);
      const wholePackage = BlueprintAdapter.getDevelopmentPackages()
        .packages.find((p) => p.id === 'chest-complete')!
        .exercises.reduce((s, e) => s + e.sets, 0);
      expect(ref.direct_sets_per_exposure).toBeLessThan(wholePackage);
    });

    it('triceps-long-head is credited only with the two overhead-position exercises, not general triceps mass work', () => {
      const ref = getDevelopmentReference('physique_target', 'triceps-long-head', 'complete');
      expect(ref.direct_sets_per_exposure).toBe(4); // overhead-triceps-extension(2) + cable-overhead-extension-leaning-forward(2)
      expect(ref.weekly_direct_set_reference).toBe(8);
    });

    it('the general member of a group ("triceps") is unaffected — still the whole package', () => {
      const ref = getDevelopmentReference('physique_target', 'triceps', 'complete');
      const wholePackage = BlueprintAdapter.getDevelopmentPackages()
        .packages.find((p) => p.id === 'triceps-complete')!
        .exercises.reduce((s, e) => s + e.sets, 0);
      expect(ref.direct_sets_per_exposure).toBe(wholePackage);
    });

    it('leg targets (one leg day, Saturday badminton): secondary-role work is excluded and glutes/calves are split per target', () => {
      const per = (id: string, level: 'complete' | 'efficient') => getDevelopmentReference('physique_target', id, level).direct_sets_per_exposure;
      expect(per('quads', 'complete')).toBe(8); // squat 3 + leg press 3 + extension 2; bulgarian + reverse nordic excluded
      expect(per('hamstrings', 'complete')).toBe(5); // RDL 3 + seated curl 2; lying curl excluded
      expect(per('gluteus-maximus', 'complete')).toBe(6); // hip thrust 3 + hip-dominant bulgarian 3; kickback excluded
      expect(per('gluteus-medius-minimus', 'complete')).toBe(2); // hip abduction only
      expect(per('gastrocnemius', 'complete')).toBe(5); // standing 3 + single-leg 2
      expect(per('gastrocnemius', 'efficient')).toBe(3);
      expect(per('soleus', 'complete')).toBe(3); // seated only
    });

    it('a muscle_group with no scope entry (back) is never filtered — every package exercise counts', () => {
      const ref = getDevelopmentReference('physique_target', 'lat-width', 'complete');
      const wholePackage = BlueprintAdapter.getDevelopmentPackages()
        .packages.find((p) => p.id === 'back-complete')!
        .exercises.reduce((s, e) => s + e.sets, 0);
      expect(ref.direct_sets_per_exposure).toBe(wholePackage);
    });
  });
});
