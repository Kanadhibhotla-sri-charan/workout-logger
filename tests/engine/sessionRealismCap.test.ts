// Session Realism Cap (Programming Advisor Fix, 2026-09-14): a
// deliberate, user-requested exception to the Consolidated Fix's own
// "session size is never limited" rule — a hard ceiling on raw
// exercise/muscle COUNT only (never time or equipment, which stay
// fully unrestricted). Exercises the real production pipeline
// (buildWeeklyProgrammingPlan) directly, matching this repo's own
// established discipline for regression coverage of this engine.

import { describe, expect, it } from 'vitest';
import { buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { SESSION_REALISM_CAP } from '../../src/engine/config.js';

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

// Six real push-compatible physique targets, deliberately more than
// SESSION_REALISM_CAP.maxTargetsPerSession (4), all landing on the same
// single Monday push session with a generous 300-minute nominal budget
// (proving the cap is a real count limit, never a time-derived one).
const SIX_PUSH_TARGET_IDS = ['mid-pec', 'upper-pec', 'lower-pec', 'side-delt', 'obliques', 'triceps'];

// Nine real push/universal-compatible targets — more than the raised
// maxTargetsPerSession (7) — used specifically to prove the RAISED
// ceiling: strictly more than 4 (the old limit) may now share a
// session, while the new 7-muscle ceiling (and the unchanged 9-exercise
// ceiling) still both hold.
const NINE_TARGET_IDS = ['mid-pec', 'upper-pec', 'lower-pec', 'side-delt', 'obliques', 'triceps', 'triceps-long-head', 'rectus-abdominis', 'neck-thickness'];

describe('Session Realism Cap — a real session never exceeds the hard exercise/muscle limits', () => {
  it('the raised muscle ceiling (7, was 4) actually lets more than 4 real muscles share a session, while both hard caps still hold', () => {
    // A modest current_weekly_primary_sets (already-near-adequate, so
    // each target needs only 1-2 exercises rather than 3) isolates the
    // muscle-count dimension from the exercise-count one — with a
    // larger per-target volume (e.g. the engine's own package-derived
    // starting point at current_weekly_primary_sets=0), individual
    // targets can need 3 exercises each, and the pre-existing 9-
    // exercise ceiling becomes the binding constraint well before the
    // muscle ceiling does regardless of its own value — a real,
    // separate limitation documented in this fix's own report.
    const targets = NINE_TARGET_IDS.map((id) => normalDevTarget({ target_id: id, current_weekly_primary_sets: 3 }));
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;

    const distinctTargetsInSession = new Set(monday.plannedWork.map((w) => w.target_id));
    // The whole point of raising the cap: strictly more than the OLD
    // limit (4) now fits in one real session.
    expect(distinctTargetsInSession.size).toBeGreaterThan(4);
    // Both current hard ceilings still hold, exactly as configured.
    expect(distinctTargetsInSession.size).toBeLessThanOrEqual(SESSION_REALISM_CAP.maxTargetsPerSession);
    expect(monday.plannedWork.length).toBeLessThanOrEqual(SESSION_REALISM_CAP.maxExercisesPerSession);

    // At least one of the 9 offered targets was genuinely deferred by
    // the cap specifically (not some other, unrelated skip reason) —
    // confirms the muscle ceiling still actually engaged in this
    // fixture rather than every target trivially fitting.
    const capSkips = monday.skipped.filter((s) => s.reason_code === 'session_realism_cap');
    expect(capSkips.length).toBeGreaterThan(0);
    for (const skip of capSkips) {
      expect(distinctTargetsInSession.has(skip.target_id)).toBe(false);
    }
  });

  it('caps a real session to at most SESSION_REALISM_CAP.maxTargetsPerSession distinct targets and 9 total exercises, even with 6 real eligible targets and a huge time budget', () => {
    const targets = SIX_PUSH_TARGET_IDS.map((id) => normalDevTarget({ target_id: id }));
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;

    const distinctTargetsInSession = new Set(monday.plannedWork.map((w) => w.target_id));
    expect(distinctTargetsInSession.size).toBeLessThanOrEqual(SESSION_REALISM_CAP.maxTargetsPerSession);
    expect(monday.plannedWork.length).toBeLessThanOrEqual(SESSION_REALISM_CAP.maxExercisesPerSession);

    // Never split: a target present in plannedWork must never ALSO
    // appear as a session_realism_cap skip, and vice versa.
    const capSkips = monday.skipped.filter((s) => s.reason_code === 'session_realism_cap');
    for (const skip of capSkips) {
      expect(distinctTargetsInSession.has(skip.target_id)).toBe(false);
    }

    // Every one of the 6 targets is accounted for exactly once — either
    // it has real work in plannedWork, or it has a real, visible
    // session_realism_cap skip. Never silently missing from both.
    for (const id of SIX_PUSH_TARGET_IDS) {
      const inSession = distinctTargetsInSession.has(id);
      const skipped = capSkips.some((s) => s.target_id === id);
      expect(inSession || skipped).toBe(true);
      expect(inSession && skipped).toBe(false);
    }

    // At least one target really was deferred — this fixture only means
    // anything if the cap actually engaged.
    expect(capSkips.length).toBeGreaterThan(0);
  });

  it('deferred volume becomes real, traceable unmetDirectSets — never silently discarded', () => {
    const targets = SIX_PUSH_TARGET_IDS.map((id) => normalDevTarget({ target_id: id }));
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const capSkips = monday.skipped.filter((s) => s.reason_code === 'session_realism_cap');

    for (const skip of capSkips) {
      const allocation = plan.targetAllocations.find((a) => a.target_id === skip.target_id)!;
      expect(allocation).toBeDefined();
      expect(allocation.deliveredDirectSets).toBe(0);
      expect(allocation.unmetDirectSets).toBeGreaterThan(0);
      expect(allocation.unmetDirectSets).toBe(allocation.requiredDirectSets);
    }
  });

  it('a target with volume split across multiple exercises is never split between kept and deferred', () => {
    // A single target whose own volume is large enough to span more
    // than one exercise (Blueprint's own per-exercise authored caps
    // force this) alongside enough competing targets to threaten the
    // exercise-count cap — proves the fix for the real bug caught by
    // assertNoContradictoryProgramState during this fix's own
    // development (naive position-based slicing split one target's
    // entries across kept/deferred).
    const targets = [
      ...SIX_PUSH_TARGET_IDS.map((id) => normalDevTarget({ target_id: id })),
      normalDevTarget({ target_id: 'triceps-long-head', current_weekly_primary_sets: 20 }),
    ];
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;

    const distinctTargetsInSession = new Set(monday.plannedWork.map((w) => w.target_id));
    const capSkips = monday.skipped.filter((s) => s.reason_code === 'session_realism_cap');
    for (const id of [...SIX_PUSH_TARGET_IDS, 'triceps-long-head']) {
      const inSession = distinctTargetsInSession.has(id);
      const skipped = capSkips.some((s) => s.target_id === id);
      // Never both, never neither.
      expect(inSession !== skipped).toBe(true);
    }
    expect(monday.plannedWork.length).toBeLessThanOrEqual(SESSION_REALISM_CAP.maxExercisesPerSession);
  });
});
