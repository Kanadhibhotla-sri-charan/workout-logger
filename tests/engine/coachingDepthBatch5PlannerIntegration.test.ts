// Coaching Depth Batch 5 spec §11.4 "Integration tests": proves the
// intensity-technique and structural-advisory layers actually reach the
// real generated `buildWeeklyProgrammingPlan` output (not just their own
// pure functions in isolation), and that applying a technique never
// changes the real sets/exposure accounting.

import { describe, expect, it } from 'vitest';
import { buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const CABLE_FLY = 'cable-fly'; // isolation, low fatigue/skill, medium stability — real Blueprint drop-set candidate

function normalDevTarget(targetId: string, overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return {
    target_type: 'physique_target',
    target_id: targetId,
    tier: 'supporting',
    is_specialization: false,
    goal_id: '__normal_development_or_maintenance__',
    goal_priority: 1000,
    current_weekly_primary_sets: 0,
    weekly_secondary_sets: 0,
    weekly_exposure_units: 0,
    rolling_exposure_units: 0,
    rolling_window_days: 14,
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

function weeklyInput(overrides: Partial<WeeklyPlanInput> = {}): WeeklyPlanInput {
  return {
    weekStart: '2026-08-31',
    today: '2026-08-31',
    todayWeekday: 'monday',
    todayBudgetMinutes: 300,
    defaultSessionMinutes: 300,
    available_equipment: FULL_EQUIPMENT,
    available_training_days: ['monday'],
    targets: [],
    ...overrides,
  };
}

function midPecTargetWithHistory(overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return normalDevTarget('mid-pec', {
    current_weekly_primary_sets: 3,
    weekly_exposure_units: 3,
    current_exercise_id: CABLE_FLY,
    recent_exercise_ids: [CABLE_FLY],
    exercise_history: { [CABLE_FLY]: [{ date: '2026-08-24', sets: [{ weight: 20, reps: 12, completed: true, rir: 2 }] }] },
    ...overrides,
  });
}

describe('Coaching Depth Batch 5 — intensity techniques reach the real generated plan', () => {
  it('applies a real technique to the placed exercise when experience is confirmed and no deload is active', () => {
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [midPecTargetWithHistory()], trainingExperience: 'advanced' }));
    const placed = plan.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY);
    expect(placed).toBeDefined();
    expect(placed!.applied_intensity_technique?.technique_id).toBe('drop-set');
    expect(placed!.decision.intensity_technique_evaluation).toEqual({ considered: true, applied_technique_id: 'drop-set', suppressed_reason: null });
  });

  it('never applies a technique with no confirmed training experience', () => {
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [midPecTargetWithHistory()] }));
    const placed = plan.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY);
    expect(placed!.applied_intensity_technique).toBeNull();
  });

  it('suppresses the technique during an active deload even with confirmed experience', () => {
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({
        targets: [midPecTargetWithHistory()],
        trainingExperience: 'advanced',
        periodizationContext: { deloadActive: true, setVolumeMultiplier: 0.5, deloadRepRangeBias: 'lower' },
      })
    );
    const placed = plan.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY);
    expect(placed!.applied_intensity_technique).toBeNull();
    expect(placed!.decision.intensity_technique_evaluation?.suppressed_reason).toMatch(/deload/i);
  });

  it('never changes the real sets/exposure accounting regardless of whether a technique was applied', () => {
    const withTechnique = buildWeeklyProgrammingPlan(weeklyInput({ targets: [midPecTargetWithHistory()], trainingExperience: 'advanced' }));
    const withoutTechnique = buildWeeklyProgrammingPlan(weeklyInput({ targets: [midPecTargetWithHistory()] }));
    const a = withTechnique.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY)!;
    const b = withoutTechnique.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY)!;
    expect(a.applied_intensity_technique).not.toBeNull();
    expect(b.applied_intensity_technique).toBeNull();
    expect(a.sets).toBe(b.sets);
    expect(a.primary_exposure).toBe(b.primary_exposure);
    expect(a.secondary_exposure).toBe(b.secondary_exposure);
    expect(a.reps_min).toBe(b.reps_min);
    expect(a.reps_max).toBe(b.reps_max);
  });

  it('with no trainingExperience/periodizationContext supplied at all (every pre-Batch-5 caller), generation is completely unaffected', () => {
    const target = midPecTargetWithHistory();
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target] }));
    expect(plan.sessions[0]!.plannedWork.every((w) => w.applied_intensity_technique === null)).toBe(true);
    expect(Array.isArray(plan.structuralAdvisories)).toBe(true);
  });

  it('repeated calls with identical input never duplicate technique application (idempotent, deterministic)', () => {
    const target = midPecTargetWithHistory();
    const first = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target], trainingExperience: 'advanced' }));
    const second = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target], trainingExperience: 'advanced' }));
    const a = first.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY)!;
    const b = second.sessions[0]!.plannedWork.find((w) => w.exercise_id === CABLE_FLY)!;
    expect(a.applied_intensity_technique).toEqual(b.applied_intensity_technique);
  });
});

describe('Coaching Depth Batch 5 — structural advisories reach the real generated plan', () => {
  it('surfaces a real push/pull imbalance advisory computed from this plan\'s own real targets', () => {
    const push = normalDevTarget('mid-pec', { rolling_exposure_units: 20 });
    const pull = normalDevTarget('back-thickness', { rolling_exposure_units: 5 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [push, pull] }));
    expect(plan.structuralAdvisories.some((a) => a.category === 'push_pull_imbalance')).toBe(true);
  });

  it('produces no advisories for a fresh program with no real accumulated exposure yet', () => {
    const target = normalDevTarget('mid-pec', { rolling_exposure_units: 0 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target] }));
    expect(plan.structuralAdvisories).toEqual([]);
  });
});
