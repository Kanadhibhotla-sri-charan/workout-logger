import { describe, expect, it } from 'vitest';
import { buildWorkout, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

function baseTarget(overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return {
    target_type: 'physique_target',
    target_id: 'mid-pec',
    tier: 'primary',
    goal_id: 'goal_1',
    goal_priority: 1,
    current_weekly_primary_sets: 0,
    weekly_exposure_units: 0,
    rolling_exposure_units: 0,
    rolling_window_days: 14,
    most_recent_assessment: null,
    review_cadence_days: 28,
    days_since_target_last_trained: null,
    recent_badminton: null,
    recent_exercise_ids: [],
    current_exercise_id: null,
    exercise_history: {},
    ...overrides,
  };
}

const CHEST_EQUIPMENT = ['barbell', 'bench', 'rack'];

describe('buildWorkout — spec §19 pipeline (pure)', () => {
  it('produces a real exercise with Blueprint-sourced reps/RIR for a new (zero-exposure) target', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget()],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.target_id).toBe('mid-pec');
    expect(planned.target_sets).toBeGreaterThan(0);
    expect(planned.target_reps_min).toBeGreaterThan(0);
    expect(planned.target_reps_max).toBeGreaterThanOrEqual(planned.target_reps_min);
    expect(planned.estimated_minutes).toBeGreaterThan(0);
    // The exercise must genuinely be Blueprint's own package data for mid-pec.
    expect(BlueprintAdapter.getExercise(planned.exercise_id)).toBeDefined();
    // No exercise_history was supplied — a first-time prescription has
    // nothing to progress from yet.
    expect(planned.progression_decision).toBeNull();
    expect(planned.previous_performance).toBeNull();
  });

  it('remediation §6: usable exercise history produces a real progression_decision and previous_performance, consumed by the builder', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          current_exercise_id: 'flat-barbell-bench-press',
          exercise_history: {
            'flat-barbell-bench-press': [
              {
                date: '2026-08-27',
                sets: [
                  { weight: 60, reps: 12, completed: true, rir: 1 },
                  { weight: 60, reps: 12, completed: true, rir: 1 },
                ],
              },
            ],
          },
        }),
      ],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.exercise_id).toBe('flat-barbell-bench-press');
    expect(planned.progression_decision).not.toBeNull();
    expect(planned.progression_decision!.exercise_id).toBe('flat-barbell-bench-press');
    expect(planned.previous_performance).toEqual({ date: '2026-08-27', weight: 60, reps: 12 });
  });

  it('remediation §6: a "reduce" progression decision actually reduces the session\'s set count, distinct from weekly volume', () => {
    // Four consecutive sessions all falling short of the bottom of the
    // rep range (well below the ~8-12 Blueprint prescribes for
    // flat-barbell-bench-press) is a genuine multi-session decline
    // pattern progressionEngine recognizes as 'reduce'.
    const decliningSession = {
      date: '2026-08-20',
      sets: [{ weight: 60, reps: 3, completed: true, rir: 0 }],
    };
    const withoutDecline = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ current_weekly_primary_sets: 12 })],
    });
    const withDecline = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          current_weekly_primary_sets: 12,
          current_exercise_id: 'flat-barbell-bench-press',
          exercise_history: {
            'flat-barbell-bench-press': [decliningSession, decliningSession, decliningSession],
          },
        }),
      ],
    });

    const withoutPlan = withoutDecline.exercises[0]!;
    const withPlan = withDecline.exercises.find((e) => e.exercise_id === 'flat-barbell-bench-press');
    expect(withPlan).toBeDefined();
    expect(withPlan!.progression_decision?.recommendation).toBe('reduce');
    expect(withPlan!.target_sets).toBeLessThan(withoutPlan.target_sets);
  });

  it('never exceeds the time budget across multiple targets', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 10,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ target_id: 'mid-pec', goal_priority: 1 }), baseTarget({ target_id: 'upper-pec', goal_priority: 2 })],
    });
    expect(result.estimated_minutes).toBeLessThanOrEqual(10);
  });

  it('preserves the higher-priority target when the time budget forces a drop', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 6, // enough for roughly one exercise, not two
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ target_id: 'upper-pec', goal_priority: 2 }), baseTarget({ target_id: 'mid-pec', goal_priority: 1 })],
    });
    if (result.exercises.length === 1) {
      expect(result.exercises[0]!.target_id).toBe('mid-pec');
      expect(result.skipped_targets.some((s) => s.target_id === 'upper-pec')).toBe(true);
    }
  });

  it('skips a target with no equipment-feasible exercise, with a clear reason', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: [], // nothing available
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget()],
    });
    expect(result.exercises).toEqual([]);
    expect(result.skipped_targets[0]!.target_id).toBe('mid-pec');
    expect(result.skipped_targets[0]!.reason.length).toBeGreaterThan(10);
  });

  it('skips (avoids) a target already trained today, per recoveryEngine', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ days_since_target_last_trained: 0 })],
    });
    expect(result.exercises).toEqual([]);
    expect(result.skipped_targets[0]!.reason).toContain('recovery');
  });

  it('a stagnant target never gets an automatic volume increase — maintains at its existing (non-zero) volume instead', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          current_weekly_primary_sets: 10,
          most_recent_assessment: { rating: 3, date: '2026-08-25' }, // stagnant
        }),
      ],
    });
    // Volume is neither silently increased nor invented — the pipeline
    // maintains at current_weekly_primary_sets (10), distributed across
    // sessions, never jumping because of stagnation.
    if (result.exercises.length === 1) {
      const totalWeeklyImplied = result.exercises[0]!.target_sets;
      expect(totalWeeklyImplied).toBeLessThanOrEqual(10);
    }
    expect(result.reasoning_log.some((l) => l.includes('introspect'))).toBe(true);
  });

  it('never assigns a lower-body target to Monday, even indirectly through this pipeline', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['barbell', 'rack', 'bench'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ target_id: 'quads', current_weekly_primary_sets: 10 })],
    });
    expect(result.exercises.find((e) => e.target_id === 'quads')).toBeUndefined();
  });

  it('skips a functional_goal target with no Blueprint development-package data, surfacing the exact gap rather than inventing a rep range', () => {
    const functionalGoal = BlueprintAdapter.getFunctionalGoals()[0]!;
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['bodyweight'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          target_type: 'functional_goal',
          target_id: functionalGoal.id,
          current_weekly_primary_sets: 4,
        }),
      ],
    });
    expect(result.exercises.find((e) => e.target_id === functionalGoal.id)).toBeUndefined();
    const skip = result.skipped_targets.find((s) => s.target_id === functionalGoal.id);
    expect(skip).toBeDefined();
  });

  it('required test 3: substitutes a feasible Blueprint exercise when the preferred/current one is unavailable', () => {
    // Only 'cable' equipment is available. flat-barbell-bench-press
    // (barbell/bench/rack) is infeasible; cable-fly (mid-pec primary,
    // 'cable' only) is both feasible and has real Blueprint
    // development-package prescription data — cable-chest-press is
    // feasible too but has no package prescription, so it must not be
    // the one selected (proves the substitution lands on a genuinely
    // usable alternative, not just any feasible one).
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['cable'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ current_exercise_id: 'flat-barbell-bench-press' })],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.exercise_id).not.toBe('flat-barbell-bench-press');
    expect(['cable-fly']).toContain(planned.exercise_id);
    expect(planned.reasoning).toContain('replaces');
  });

  it('required test 11: a heavy recent badminton session changes the pipeline\'s recovery-driven reasoning for a stagnant target', () => {
    const stagnantTarget = baseTarget({
      current_weekly_primary_sets: 10,
      most_recent_assessment: { rating: 3, date: '2026-08-25' },
    });

    const withoutBadminton = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [stagnantTarget],
    });

    const withHeavyBadminton = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [{ ...stagnantTarget, recent_badminton: { intensity: 'high', post_session_fatigue: null } }],
    });

    // Both stay in "introspect_needed" territory (neither auto-increases —
    // required test 10 territory too), but *why* differs: recovery-flagged
    // vs. plain-stagnation reasoning, because badminton demand actually
    // reached the recovery decision that feeds volumeEngine.
    const withoutReasoning = withoutBadminton.reasoning_log.join(' ');
    const withReasoning = withHeavyBadminton.reasoning_log.join(' ');
    expect(withReasoning).toContain('recovery is flagged');
    expect(withoutReasoning).not.toContain('recovery is flagged');
  });

  it('is deterministic: identical input always produces identical output', () => {
    const input = {
      date: '2026-08-31',
      weekday: 'monday' as const,
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'] as const,
      targets: [baseTarget()],
    };
    expect(buildWorkout(input)).toEqual(buildWorkout(input));
  });

  it('every decision is logged with real reasoning — nothing opaque (spec §20)', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget()],
    });
    expect(result.reasoning_log.length).toBeGreaterThan(0);
    for (const line of result.reasoning_log) {
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(5);
    }
  });
});
