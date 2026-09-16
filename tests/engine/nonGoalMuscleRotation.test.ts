// Non-Goal Muscle Rotation Fix (2026-09-16): "Goal muscles keep the
// existing priority-based selection; non-goal muscles use a rotating
// sequence so the same non-goal muscles can never repeatedly dominate
// while another eligible non-goal muscle is continually ignored" — the
// user's own explicit design, verified here directly against
// buildWeeklyProgrammingPlan's real tie-break logic (never a second,
// parallel comparator). This is a pure-engine test: the rotation cursor
// is a plain, explicit WeeklyPlanInput field here, never touching the
// DB — see tests/repositories/nonGoalRotationRepo.test.ts for the
// persisted per-week stability semantics.

import { describe, expect, it } from 'vitest';
import { buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

function normalDevTarget(overrides: Partial<TargetBuildContext>): TargetBuildContext {
  return {
    target_type: 'physique_target',
    target_id: 'quads',
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

// Three real, push/universal-compatible targets, all pushed into a
// genuine 'maintenance'-tier tie: current_weekly_primary_sets: 50 sits
// comfortably above every real Blueprint target's own weekly
// development-package threshold, so needDeficit = 0 for all three;
// days_since_target_last_trained: null (never trained) ties the
// maintenance comparator too; no recovery caution ties recoveryNeed at
// 0. This is the exact condition that let the OLD alphabetical
// tie-break pick the same early-alphabet subset forever — several
// genuinely-tied maintenance targets. Alphabetically: 'mid-pec' <
// 'obliques' < 'rectus-abdominis', i.e. ring order [A, B, C].
const RING_A = 'mid-pec';
const RING_B = 'obliques';
const RING_C = 'rectus-abdominis';

function orderOfRingTargets(targets: string[]): string[] {
  const seen: string[] = [];
  for (const id of targets) {
    if (!seen.includes(id) && [RING_A, RING_B, RING_C].includes(id)) seen.push(id);
  }
  return seen;
}

function ringTarget(id: string): TargetBuildContext {
  return normalDevTarget({ target_id: id, current_weekly_primary_sets: 50 });
}

function buildWithCursor(cursor: number) {
  const targets = [RING_A, RING_B, RING_C].map(ringTarget);
  const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: cursor }));
  const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
  return { plan, order: orderOfRingTargets(monday.plannedWork.map((w) => w.target_id)) };
}

describe('Non-Goal Muscle Rotation — the A,B -> C,A -> B,C -> repeat design', () => {
  it('cursor 0 ranks the tied ring in its natural alphabetical order (A,B,C) — identical to the pre-fix, cursor-less behavior', () => {
    const { order } = buildWithCursor(0);
    expect(order).toEqual([RING_A, RING_B, RING_C]);
  });

  it('cursor 2 (after a 2-slot generation starting at 0) reproduces "C,A" — the exact next generation in the user\'s own example', () => {
    const { order } = buildWithCursor(2);
    expect(order).toEqual([RING_C, RING_A, RING_B]);
  });

  it('cursor 1 (after a 2-slot generation starting at 2) reproduces "B,C" — the third generation, still never resetting to A', () => {
    const { order } = buildWithCursor(1);
    expect(order).toEqual([RING_B, RING_C, RING_A]);
  });

  it('a full cycle returns to the original order — the ring wraps, it never grows or drifts', () => {
    // Three 2-wide generations starting at cursor 0 consume 6 total
    // turns == 2 full laps of a 3-member ring, landing back at 0.
    const { order } = buildWithCursor(0 + 2 + 2 + 2); // == 6 % 3 == 0
    expect(order).toEqual([RING_A, RING_B, RING_C]);
  });

  it('goal (specialization) targets are completely unaffected — they keep their existing alphabetical tie-break regardless of the rotation cursor', () => {
    // Two targets under the SAME goal (identical goal_priority, so
    // identical tier) with identical recoveryNeed — the one remaining
    // real tie-break case for GOAL muscles. 'aa-goal-target' would only
    // ever be a real Blueprint id in production; here the two ids just
    // need to alphabetically order deterministically for this assertion
    // (no exercise construction is inspected, only which target sorts
    // first is implied by rank position — checked indirectly via which
    // target's real work appears first in plannedWork when both are
    // real Blueprint ids sharing a goal).
    const targets = [
      normalDevTarget({ target_id: 'triceps', is_specialization: true, goal_id: 'goal_1', goal_priority: 1 }),
      normalDevTarget({ target_id: 'triceps-long-head', is_specialization: true, goal_id: 'goal_1', goal_priority: 1 }),
    ];
    const cursor0 = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: 0 }));
    const cursor1 = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: 1 }));
    const orderAt = (plan: typeof cursor0) => {
      const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
      const seen: string[] = [];
      for (const w of monday.plannedWork) if (!seen.includes(w.target_id)) seen.push(w.target_id);
      return seen;
    };
    // Same alphabetical order regardless of the rotation cursor — goal
    // muscles never consult it.
    expect(orderAt(cursor0)).toEqual(orderAt(cursor1));
  });

  it('nonGoalRotationCursorAfter advances by exactly the count of distinct non-goal targets that received real plannedWork this run', () => {
    const targets = [RING_A, RING_B, RING_C].map(ringTarget);
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: 0 }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const distinctNonGoalTargetsWithWork = new Set(monday.plannedWork.map((w) => w.target_id)).size;
    expect(plan.nonGoalRotationCursorAfter).toBe(distinctNonGoalTargetsWithWork % 3);
  });

  it('omitting nonGoalRotationCursor entirely defaults to 0 (byte-identical to every pre-existing fixture in this codebase)', () => {
    const targets = [RING_A, RING_B, RING_C].map(ringTarget);
    const withoutCursor = buildWeeklyProgrammingPlan(weeklyInput({ targets }));
    const explicitZero = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: 0 }));
    expect(withoutCursor.sessions).toEqual(explicitZero.sessions);
  });
});
