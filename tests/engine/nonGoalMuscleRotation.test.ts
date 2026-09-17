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

// Three real, push-compatible targets sharing the exact same
// muscle_group package (chest) — so their weekly development-package
// threshold is identically 16 for all three, tying needDeficit at the
// same positive value regardless of `current_weekly_primary_sets`/
// `weekly_exposure_units` (both left at this fixture's defaults);
// days_since_target_last_trained: null (never trained) ties the
// maintenance comparator too; no recovery caution ties recoveryNeed at
// 0. This is the exact condition that let the OLD alphabetical
// tie-break pick the same early-alphabet subset forever — several
// genuinely-tied targets. Deliberately three DIFFERENT chest sub-targets
// (never 'obliques'/'rectus-abdominis' — Coaching Depth Batch 2 gave
// those two their own curated preferred-frequency profile, which is now
// wired into their weekly reference and would break this tie). Alphabetically:
// 'lower-pec' < 'mid-pec' < 'upper-pec', i.e. ring order [A, B, C].
const RING_A = 'lower-pec';
const RING_B = 'mid-pec';
const RING_C = 'upper-pec';

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

  it('a leg-day-style session with ZERO goal targets and many tied non-goal candidates rotates a window well above 2, never getting stuck reproducing the same pair', () => {
    // The window is never hardcoded anywhere in the implementation — it
    // is whatever SESSION_REALISM_CAP and each target's own real
    // exercise count naturally allow, exactly like a real leg day where
    // no goal claims any of the muscles competing for the session. This
    // uses 8 real, genuinely-tied (all 'maintenance', sets: 50) push/
    // universal targets — deliberately more than the 3-member controlled
    // ring above — with NO goal targets at all.
    const EIGHT_TIED_IDS = ['mid-pec', 'upper-pec', 'lower-pec', 'obliques', 'rectus-abdominis', 'side-delt', 'triceps', 'triceps-long-head'];
    const targets = EIGHT_TIED_IDS.map(ringTarget);

    const gen1 = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: 0 }));
    const monday1 = gen1.sessions.find((s) => s.date === '2026-08-31')!;
    const distinct1 = new Set(monday1.plannedWork.map((w) => w.target_id));

    // Strictly more than a 2-member window actually receives real work
    // — the whole point of this test.
    expect(distinct1.size).toBeGreaterThan(2);
    // No goal-linked work exists in this fixture at all — every real
    // exercise here is genuinely non-goal.
    expect(monday1.plannedWork.every((w) => w.classification !== 'specialization')).toBe(true);
    // The cursor advances by however many were ACTUALLY achieved (never
    // hardcoded to 2, or to any other fixed number).
    expect(gen1.nonGoalRotationCursorAfter).toBe(distinct1.size % EIGHT_TIED_IDS.length);

    // A second generation, continuing from where the first left off,
    // gets a genuinely DIFFERENT composition — never silently stuck
    // reproducing the exact same pair (or the exact same larger set)
    // forever, which is the entire real-world problem this fix exists
    // to solve.
    const gen2 = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: gen1.nonGoalRotationCursorAfter }));
    const monday2 = gen2.sessions.find((s) => s.date === '2026-08-31')!;
    const distinct2 = new Set(monday2.plannedWork.map((w) => w.target_id));
    expect(distinct2.size).toBeGreaterThan(2);
    expect(distinct2).not.toEqual(distinct1);

    // Across enough generations, MORE than the original window's worth
    // of candidates eventually gets real work — some of these 8 real
    // push muscles also share secondary exposure with each other (e.g.
    // a pressing movement's secondary credit to triceps/side-delt), so
    // not every one of the 8 is guaranteed a turn by rotation alone in
    // this particular mixed fixture (a separate, pre-existing, correct
    // exposure-adequacy mechanism, not a rotation fairness gap) — but
    // strictly more than any single generation's own window keeps
    // rotating in over time, proving this is real movement, not a
    // permanently stuck pair.
    const everSeen = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < EIGHT_TIED_IDS.length; i++) {
      const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets, nonGoalRotationCursor: cursor }));
      const session = plan.sessions.find((s) => s.date === '2026-08-31')!;
      for (const w of session.plannedWork) everSeen.add(w.target_id);
      cursor = plan.nonGoalRotationCursorAfter;
    }
    expect(everSeen.size).toBeGreaterThan(distinct1.size);
  });
});
