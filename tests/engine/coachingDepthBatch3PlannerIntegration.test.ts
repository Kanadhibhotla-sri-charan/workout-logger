// Coaching Depth Batch 3 spec §15.2 "Deload prescription tests": proves
// the periodization context, once threaded through buildWorkout's own
// WeeklyPlanInput, actually changes the REAL generated PlannedWorkItem
// (not just the pure applyDeloadSetVolumeReduction/applyRepRangeBias
// functions in isolation) — set-count reduction and low-end rep bias,
// applied exactly once, with Blueprint's own authored rep range never
// exceeded.

import { describe, expect, it } from 'vitest';
import { lookupExercisePrescriptionAnyLevel, parseRange } from '../../src/blueprint/developmentPackages.js';
import { buildWorkout, type BuildWorkoutInput, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';
import { applyRepRangeBias } from '../../src/coaching/profiles/muscleProfileService.js';

const MONDAY = '2026-08-31';
const LEGS_DAY = '2026-09-03'; // same week's Thursday — calves' only eligible session-purpose day
const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

function baseTarget(overrides: Partial<TargetBuildContext> & Pick<TargetBuildContext, 'target_id'>): TargetBuildContext {
  return {
    target_type: 'physique_target',
    tier: 'supporting',
    is_specialization: false,
    goal_id: '__normal_development_or_maintenance__',
    goal_priority: 1000,
    current_weekly_primary_sets: 8,
    weekly_secondary_sets: 0,
    weekly_exposure_units: 8,
    rolling_exposure_units: 8,
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
    date: LEGS_DAY,
    weekday: 'thursday',
    budget_minutes: 300,
    available_equipment: FULL_EQUIPMENT,
    available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
    targets: [],
    ...overrides,
  };
}

describe('Coaching Depth Batch 3 — periodization context reaches the real generated workout', () => {
  it('an active deload reduces the real generated total sets for a target relative to the same target with no deload', () => {
    const target = baseTarget({ target_id: 'gastrocnemius' });

    const normal = buildWorkout(weeklyInput({ targets: [target] }));
    const normalSets = normal.exercises.filter((e) => e.target_id === 'gastrocnemius').reduce((sum, e) => sum + (e.target_sets ?? 0), 0);
    expect(normalSets).toBeGreaterThan(0);

    const deloaded = buildWorkout(
      weeklyInput({ targets: [target], periodizationContext: { deloadActive: true, setVolumeMultiplier: 0.5, deloadRepRangeBias: 'lower' } })
    );
    const deloadedSets = deloaded.exercises.filter((e) => e.target_id === 'gastrocnemius').reduce((sum, e) => sum + (e.target_sets ?? 0), 0);

    expect(deloadedSets).toBeLessThan(normalSets);
    expect(deloadedSets).toBeGreaterThan(0); // never eliminated entirely
  });

  it('an active deload overrides the curated profile bias with the deload\'s own low-end bias, never exceeding Blueprint\'s authored range', () => {
    // gastrocnemius is curated 'higher' (Batch 1) — a deload must
    // override that to 'lower' for the duration of the deload.
    const target = baseTarget({ target_id: 'gastrocnemius' });
    const deloaded = buildWorkout(
      weeklyInput({ targets: [target], periodizationContext: { deloadActive: true, setVolumeMultiplier: 0.5, deloadRepRangeBias: 'lower' } })
    );
    const placed = deloaded.exercises.filter((e) => e.target_id === 'gastrocnemius');
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) {
      const authoredPrescription = lookupExercisePrescriptionAnyLevel('gastrocnemius', item.exercise_id)!;
      const authored = parseRange(authoredPrescription.reps);
      const expectedLowerBiased = applyRepRangeBias(authored.min, authored.max, 'lower');
      expect(item.target_reps_min).toBe(expectedLowerBiased.min);
      expect(item.target_reps_max).toBe(expectedLowerBiased.max);
      // Never outside the authored range.
      expect(item.target_reps_min!).toBeGreaterThanOrEqual(authored.min);
      expect(item.target_reps_max!).toBeLessThanOrEqual(authored.max);
    }
  });

  it('with no periodizationContext supplied at all (every pre-existing caller), generation is completely unaffected', () => {
    const target = baseTarget({ target_id: 'gastrocnemius' });
    const withoutField = buildWorkout(weeklyInput({ targets: [target] }));
    const explicitlyNoDeload = buildWorkout(weeklyInput({ targets: [target], periodizationContext: { deloadActive: false, setVolumeMultiplier: 1, deloadRepRangeBias: null } }));
    const setsA = withoutField.exercises.filter((e) => e.target_id === 'gastrocnemius').reduce((sum, e) => sum + (e.target_sets ?? 0), 0);
    const setsB = explicitlyNoDeload.exercises.filter((e) => e.target_id === 'gastrocnemius').reduce((sum, e) => sum + (e.target_sets ?? 0), 0);
    expect(setsA).toBe(setsB);
  });
});
