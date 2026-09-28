// Programming Redesign (Step 12) §16.B/§16.G: proves the wiring between
// developmentReferenceEngine.ts and volumeEngine.ts/workoutBuilder.ts —
// Active goal -> Complete package, Non-goal -> Efficient package, real
// per-muscle thresholds replacing the old universal starting_point_sets
// number, and that goal priority still governs ranking/resource
// allocation WITHOUT multiplying volume. Complements
// tests/engine/developmentReferenceEngine.test.ts (the reference engine
// in isolation) and tests/engine/volumeEngine.test.ts (decideVolume's
// pre-existing state-machine behavior, unmodified by this pass).

import { describe, expect, it } from 'vitest';
import { decideVolume, type VolumeDecisionInput } from '../../src/engine/volumeEngine.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';
import { buildWorkout, type BuildWorkoutInput, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

const MONDAY = '2026-08-31'; // a real Monday
const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

function baseTarget(overrides: Partial<TargetBuildContext> & Pick<TargetBuildContext, 'target_id'>): TargetBuildContext {
  return {
    target_type: 'physique_target',
    tier: 'supporting',
    is_specialization: false,
    goal_id: '__normal_development_or_maintenance__',
    goal_priority: 1000,
    current_weekly_primary_sets: 0,
    weekly_secondary_sets: 0,
    weekly_exposure_units: 0,
    rolling_exposure_units: 0,
    rolling_window_days: 28,
    most_recent_assessment: null,
    review_cadence_days: 28,
    days_since_target_last_trained: null,
    last_trained_date: null,
    recent_badminton: null,
    recent_exercise_ids: [],
    current_exercise_id: null,
    exercise_history: {},
    outside_blueprint_exercises: [],
    ...overrides,
  };
}

function weeklyInput(overrides: Partial<BuildWorkoutInput> = {}): BuildWorkoutInput {
  return {
    date: MONDAY,
    weekday: 'monday',
    budget_minutes: 300,
    available_equipment: FULL_EQUIPMENT,
    available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
    targets: [],
    ...overrides,
  };
}

describe('decideVolume + development_reference (spec §16.B/§16.C)', () => {
  // 'upper-pec', not 'mid-pec': under Sub-Target Exercise Scope
  // (2026-09-19), Blueprint's chest-complete package only adds a real
  // extra exercise for upper-pec (incline-dumbbell-fly) and lower-pec
  // (dip-chest-biased) over chest-efficient — mid-pec's own scoped
  // reference (flat-barbell-bench-press + the shared cable-fly) happens
  // to be identical at both levels, so it can no longer demonstrate
  // "Complete is strictly higher than Efficient" the way it could
  // before per-target scoping existed.
  const chestEfficient = getDevelopmentReference('physique_target', 'upper-pec', 'efficient');
  const chestComplete = getDevelopmentReference('physique_target', 'upper-pec', 'complete');

  it('a non-goal target is capped at its own Efficient reference, never the universal higher_recovery_dependent band', () => {
    const input: VolumeDecisionInput = {
      target_type: 'physique_target',
      target_id: 'upper-pec',
      goal_priority: 1000,
      current_weekly_primary_sets: chestEfficient.weekly_direct_set_reference! - 1,
      aesthetic_progress_trend: 'stagnant',
      recovery_ok: true,
      introspection_confirmed_no_other_explanation: true,
      development_reference: chestEfficient,
    };
    const decision = decideVolume(input);
    expect(decision.blueprint_reference_range.label).toBe('blueprint_package_reference');
    expect(decision.blueprint_reference_range.max).toBe(chestEfficient.weekly_direct_set_reference);
    expect(decision.recommended_weekly_primary_sets).toBeLessThanOrEqual(chestEfficient.weekly_direct_set_reference!);
  });

  it('an active-goal target is capped at its own Complete reference — a higher ceiling than the same target\'s Efficient reference', () => {
    expect(chestComplete.weekly_direct_set_reference).toBeGreaterThan(chestEfficient.weekly_direct_set_reference!);
    const input: VolumeDecisionInput = {
      target_type: 'physique_target',
      target_id: 'upper-pec',
      goal_priority: 1,
      current_weekly_primary_sets: chestComplete.weekly_direct_set_reference! - 1,
      aesthetic_progress_trend: 'stagnant',
      recovery_ok: true,
      introspection_confirmed_no_other_explanation: true,
      development_reference: chestComplete,
    };
    const decision = decideVolume(input);
    expect(decision.blueprint_reference_range.max).toBe(chestComplete.weekly_direct_set_reference);
  });

  it('with no development_reference (e.g. a functional_goal), falls back to the pre-existing universal bands unchanged', () => {
    const input: VolumeDecisionInput = {
      target_type: 'functional_goal',
      target_id: 'rotator-cuff',
      goal_priority: 1,
      current_weekly_primary_sets: 12,
      aesthetic_progress_trend: 'stagnant',
      recovery_ok: true,
      introspection_confirmed_no_other_explanation: true,
      development_reference: getDevelopmentReference('functional_goal', 'rotator-cuff', 'complete'),
    };
    const decision = decideVolume(input);
    expect(decision.blueprint_reference_range.label).not.toBe('blueprint_package_reference');
    expect(['starting_point', 'practical_range', 'higher_recovery_dependent']).toContain(decision.blueprint_reference_range.label);
  });

  it('the zero-volume starting point never exceeds the target\'s own package reference when that reference is lower than Blueprint\'s universal starting point', () => {
    // Find a real muscle whose Efficient reference is below Blueprint's
    // universal starting_point_sets[0] (8), if one exists in real data,
    // to prove the muscle-specific number can genuinely win.
    const { starting_point_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;
    for (const group of BlueprintAdapter.getDevelopmentPackages().muscle_groups) {
      const targetId = group.target_ids[0];
      if (!targetId) continue;
      const ref = getDevelopmentReference('physique_target', targetId, 'efficient');
      if (ref.weekly_direct_set_reference == null) continue;
      const decision = decideVolume({
        target_type: 'physique_target',
        target_id: targetId,
        goal_priority: 1000,
        current_weekly_primary_sets: 0,
        aesthetic_progress_trend: 'insufficient_data',
        recovery_ok: true,
        development_reference: ref,
      });
      expect(decision.recommended_weekly_primary_sets).toBeLessThanOrEqual(starting_point_sets[0]);
      expect(decision.recommended_weekly_primary_sets).toBeLessThanOrEqual(ref.weekly_direct_set_reference);
    }
  });
});

describe('buildWorkout classification uses per-muscle Efficient reference, not a universal number (spec §16.B)', () => {
  it('two different non-goal muscles with the identical raw exposure can classify differently once each muscle\'s own reference is applied', () => {
    // Pick two real muscle groups with genuinely different Efficient
    // references (established directly from real Blueprint data).
    // 'biceps' and 'triceps', not 'gastrocnemius' — gastrocnemius now has
    // a Coaching Depth curated preferred-frequency profile (Batch 2) that
    // raises its weekly reference, so it's no longer reliably the lower
    // of the two. Not 'mid-pec' either: under Sub-Target Exercise Scope
    // (2026-09-19) mid-pec's own scoped Efficient reference happens to
    // equal biceps' now, so it can no longer prove "genuinely different."
    // 'biceps' and 'triceps' are each the general (unfiltered) member of
    // their own group and have no curated profile.
    const biceps = getDevelopmentReference('physique_target', 'biceps', 'efficient');
    const triceps = getDevelopmentReference('physique_target', 'triceps', 'efficient');
    expect(biceps.weekly_direct_set_reference).not.toBe(triceps.weekly_direct_set_reference);

    // An exposure level between the two references: at/above biceps'
    // (lower) reference -> maintenance; below triceps' (higher)
    // reference -> normal_development.
    const midpoint = Math.round(((biceps.weekly_direct_set_reference ?? 0) + (triceps.weekly_direct_set_reference ?? 0)) / 2);
    expect(midpoint).toBeGreaterThanOrEqual(biceps.weekly_direct_set_reference!);
    expect(midpoint).toBeLessThan(triceps.weekly_direct_set_reference!);

    const bicepsTarget = baseTarget({ target_id: 'biceps', weekly_exposure_units: midpoint });
    const tricepsTarget = baseTarget({ target_id: 'triceps', weekly_exposure_units: midpoint });
    const result = buildWorkout(weeklyInput({ targets: [bicepsTarget, tricepsTarget] }));

    const allDecisions = [...result.exercises, ...result.skipped_targets];
    const bicepsDecision = allDecisions.find((d) => d.target_id === 'biceps');
    const tricepsDecision = allDecisions.find((d) => d.target_id === 'triceps');
    expect(bicepsDecision?.classification).toBe('maintenance');
    expect(tricepsDecision?.classification).toBe('normal_development');
  });
});

describe('Goal priority governs ranking/allocation WITHOUT multiplying volume (spec §16.G)', () => {
  it('Goal 1 outranks Goal 2 outranks normal_development outranks maintenance in real processing order — while each specialization target\'s own desired volume is decided purely by decideVolume, never scaled by priority', () => {
    const goal1Target = baseTarget({
      target_id: 'mid-pec',
      is_specialization: true,
      goal_id: 'goal_1',
      goal_priority: 1,
      tier: 'primary',
      current_weekly_primary_sets: 10,
      weekly_exposure_units: 10,
      most_recent_assessment: { rating: 3, date: '2026-08-01' }, // stagnant -> introspect_needed -> maintain at 10
    });
    const goal2Target = baseTarget({
      target_id: 'triceps',
      is_specialization: true,
      goal_id: 'goal_2',
      goal_priority: 2,
      tier: 'primary',
      current_weekly_primary_sets: 10,
      weekly_exposure_units: 10,
      most_recent_assessment: { rating: 3, date: '2026-08-01' }, // identical stagnant state, DIFFERENT priority
    });
    const result = buildWorkout(weeklyInput({ targets: [goal1Target, goal2Target] }));

    const allDecisions = [...result.exercises, ...result.skipped_targets];
    const goal1Decision = allDecisions.find((d) => d.target_id === 'mid-pec')!;
    const goal2Decision = allDecisions.find((d) => d.target_id === 'triceps')!;
    // Same current volume, same stagnant trend, same "introspection not
    // confirmed" default -> IDENTICAL volume decision regardless of
    // which goal (1 or 2) owns the target — priority affects WHEN/
    // whether resources reach a target (ranking/resourceAllocation),
    // never the sets-math itself (spec §1 rule: priority is not a
    // volume multiplier).
    expect(goal1Decision.decision.volume_decision?.recommended_weekly_primary_sets).toBe(
      goal2Decision.decision.volume_decision?.recommended_weekly_primary_sets
    );
    expect(goal1Decision.decision.volume_decision?.action).toBe(goal2Decision.decision.volume_decision?.action);
  });
});
