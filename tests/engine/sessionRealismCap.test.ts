// Session Realism Cap (Programming Advisor Fix, 2026-09-14): a
// deliberate, user-requested exception to the Consolidated Fix's own
// "session size is never limited" rule — a hard ceiling on raw
// exercise/muscle COUNT only (never time or equipment, which stay
// fully unrestricted). Exercises the real production pipeline
// (buildWeeklyProgrammingPlan) directly, matching this repo's own
// established discipline for regression coverage of this engine.

import { describe, expect, it } from 'vitest';
import { buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { LEGS_SESSION_MAX_EXERCISES, LEGS_SESSION_MAX_TARGETS, LEGS_WITH_ABS_SESSION_MAX_EXERCISES, SESSION_REALISM_CAP } from '../../src/engine/config.js';

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

// All nine real push/universal-compatible targets that exist at all
// (the 7 PUSH_PHYSIQUE_TARGETS plus the 2 remaining UNIVERSAL_PHYSIQUE_TARGETS
// now that neck-thickness has been removed) — more than the raised
// maxTargetsPerSession (8) — used specifically to prove the RAISED
// ceiling: strictly more than 4 (the old limit) may now share a
// session, while the new 8-muscle ceiling (and the raised 10-exercise
// ceiling) still both hold.
const NINE_TARGET_IDS = ['mid-pec', 'upper-pec', 'lower-pec', 'front-delt', 'side-delt', 'triceps', 'triceps-long-head', 'obliques', 'rectus-abdominis'];

describe('Session Realism Cap — a real session never exceeds the hard exercise/muscle limits', () => {
  it('the raised muscle ceiling (7, was 4) actually lets more than 4 real muscles share a session, while both hard caps still hold', () => {
    // A modest current_weekly_primary_sets (already-near-adequate, so
    // each target needs only 1-2 exercises rather than 3) isolates the
    // muscle-count dimension from the exercise-count one, independent of
    // the Exercise-Slot-Consumption Starvation Fix covered by the next
    // test below.
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

  it('Exercise-Slot-Consumption Starvation Fix: a legitimate top-N muscle whose own full exercise count no longer fits the remaining budget still gets SOME real work, never zero', () => {
    // Re-derived twice (2026-09-19): once for Sub-Target Exercise Scope, then for the
    // fractional need ranking (untouched non-goal muscles now tie at 100% unmet and the
    // rotation ring orders them). Under the current rules every offered target starts
    // untouched, and 'triceps' (uncapped need 3 exercises) is the target whose full need
    // does not fit what is left of the 10-exercise budget once the targets ranked ahead
    // of it are placed. Verified stable: it is trimmed to 2 of 3 with every other target
    // at 0 sets AND under every single-target head-start from 1-12 sets tried, so this
    // is not a precisely-tuned boundary.
    const targets = NINE_TARGET_IDS.map((id) => normalDevTarget({ target_id: id, current_weekly_primary_sets: 0 }));
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;

    const distinctTargetsInSession = new Set(monday.plannedWork.map((w) => w.target_id));
    const capSkips = monday.skipped.filter((s) => s.reason_code === 'session_realism_cap');

    // The exercise cap still genuinely binds in this fixture (otherwise
    // this test would prove nothing).
    expect(monday.plannedWork.length).toBe(SESSION_REALISM_CAP.maxExercisesPerSession);

    // The real proof: 'triceps' got SOME real work here...
    const tricepsExercisesInCappedSession = monday.plannedWork.filter((w) => w.target_id === 'triceps').length;
    expect(tricepsExercisesInCappedSession).toBeGreaterThan(0);

    // ...strictly fewer than its own natural, uncapped need (proving
    // this is a genuine partial trim, not a coincidence of it only ever
    // needing one exercise) — checked by building the exact same target
    // alone, with the full exercise budget entirely to itself.
    const isolatedPlan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [normalDevTarget({ target_id: 'triceps', current_weekly_primary_sets: 0 })] }));
    const tricepsExercisesUncapped = isolatedPlan.sessions.find((s) => s.date === '2026-08-31')!.plannedWork.length;
    expect(tricepsExercisesUncapped).toBeGreaterThan(tricepsExercisesInCappedSession);

    // A partially-trimmed target must never ALSO carry a
    // session_realism_cap skip (assertNoContradictoryProgramState's own
    // invariant) — it already has real plannedWork.
    expect(capSkips.some((s) => s.target_id === 'triceps')).toBe(false);

    // Its reduced (not zero, not full) delivered volume is real and
    // traceable, exactly like any other under-delivered target.
    const tricepsAllocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(tricepsAllocation.deliveredDirectSets).toBeGreaterThan(0);
    expect(tricepsAllocation.unmetDirectSets).toBeGreaterThan(0);

    // Every target that DOES have real plannedWork also has real,
    // non-zero delivered volume, and is never simultaneously reported
    // as cap-skipped.
    for (const id of distinctTargetsInSession) {
      const allocation = plan.targetAllocations.find((a) => a.target_id === id)!;
      expect(allocation.deliveredDirectSets).toBeGreaterThan(0);
      expect(capSkips.some((s) => s.target_id === id)).toBe(false);
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

  it('Legs-Session Exercise Cap (2026-09-16): a real legs-purpose session never exceeds 5 exercises, even with all 7 real leg-region targets eligible and a huge time budget', () => {
    // available_training_days here deliberately spans push/pull/legs
    // (Monday/Tuesday/Thursday, matching this app's own PPL+Upper
    // rotation) so Thursday is genuinely assigned session purpose
    // 'legs' by the real assignSessionPurposes logic — never hardcoded.
    const SEVEN_LEG_TARGET_IDS = ['quads', 'hamstrings', 'gluteus-maximus', 'gluteus-medius-minimus', 'adductors', 'gastrocnemius', 'soleus'];
    const targets = SEVEN_LEG_TARGET_IDS.map((id) => normalDevTarget({ target_id: id }));
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({
        targets,
        available_training_days: ['monday', 'tuesday', 'thursday'],
      })
    );
    const thursday = plan.sessions.find((s) => s.date === '2026-09-03')!;
    expect(thursday.sessionPurpose).toBe('legs');

    // The whole point of this fix: strictly tighter than the general
    // 9-exercise ceiling, even though the muscle-count ceiling (7) alone
    // would allow every one of these 7 targets a real slot.
    expect(thursday.plannedWork.length).toBeLessThanOrEqual(LEGS_SESSION_MAX_EXERCISES);
    expect(LEGS_SESSION_MAX_EXERCISES).toBeLessThan(SESSION_REALISM_CAP.maxExercisesPerSession);

    // The cap genuinely engaged in this fixture (otherwise this test
    // would prove nothing) — at least one real leg target was deferred.
    const capSkips = thursday.skipped.filter((s) => s.reason_code === 'session_realism_cap');
    expect(capSkips.length).toBeGreaterThan(0);
    const distinctTargetsInSession = new Set(thursday.plannedWork.map((w) => w.target_id));
    for (const skip of capSkips) {
      expect(distinctTargetsInSession.has(skip.target_id)).toBe(false);
    }
  });

  it('Legs-Session Exercise Cap (2026-09-16): a push-purpose session on the SAME week keeps the general 9-exercise ceiling, unaffected by the tighter legs-only cap', () => {
    const targets = SIX_PUSH_TARGET_IDS.map((id) => normalDevTarget({ target_id: id, current_weekly_primary_sets: 0 }));
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({
        targets,
        available_training_days: ['monday', 'tuesday', 'thursday'],
      })
    );
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    expect(monday.sessionPurpose).toBe('push');
    expect(monday.plannedWork.length).toBeGreaterThan(LEGS_SESSION_MAX_EXERCISES);
    expect(monday.plannedWork.length).toBeLessThanOrEqual(SESSION_REALISM_CAP.maxExercisesPerSession);
  });

  // Fix (2026-09-19), explicit user request: a leg day's own muscle
  // ceiling is now tighter (5) than the general cap (7) too, not just
  // its exercise ceiling.
  it('Leg+Abs Session Cap fix: a real legs-purpose session never exceeds 5 distinct muscles, even with all 7 real leg-region targets eligible', () => {
    const SEVEN_LEG_TARGET_IDS = ['quads', 'hamstrings', 'gluteus-maximus', 'gluteus-medius-minimus', 'adductors', 'gastrocnemius', 'soleus'];
    // current_weekly_primary_sets: 3 (near-adequate) isolates the
    // muscle-count dimension from the exercise-count one, matching the
    // same isolation technique the general-cap test above uses.
    const targets = SEVEN_LEG_TARGET_IDS.map((id) => normalDevTarget({ target_id: id, current_weekly_primary_sets: 3 }));
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({ targets, available_training_days: ['monday', 'tuesday', 'thursday'] })
    );
    const thursday = plan.sessions.find((s) => s.date === '2026-09-03')!;
    expect(thursday.sessionPurpose).toBe('legs');

    const distinctTargetsInSession = new Set(thursday.plannedWork.map((w) => w.target_id));
    expect(distinctTargetsInSession.size).toBeLessThanOrEqual(LEGS_SESSION_MAX_TARGETS);
    expect(LEGS_SESSION_MAX_TARGETS).toBeLessThan(SESSION_REALISM_CAP.maxTargetsPerSession);

    const capSkips = thursday.skipped.filter((s) => s.reason_code === 'session_realism_cap');
    expect(capSkips.length).toBeGreaterThan(0);
  });

  it('Leg+Abs Session Cap fix: abs work alongside legs raises the exercise ceiling to 8, but leg exercises themselves stay capped at 5', () => {
    const SEVEN_LEG_TARGET_IDS = ['quads', 'hamstrings', 'gluteus-maximus', 'gluteus-medius-minimus', 'adductors', 'gastrocnemius', 'soleus'];
    const targets = [
      ...SEVEN_LEG_TARGET_IDS.map((id) => normalDevTarget({ target_id: id, current_weekly_primary_sets: 0 })),
      normalDevTarget({ target_id: 'obliques', current_weekly_primary_sets: 0 }),
      normalDevTarget({ target_id: 'rectus-abdominis', current_weekly_primary_sets: 0 }),
    ];
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({ targets, available_training_days: ['monday', 'tuesday', 'thursday'] })
    );
    const thursday = plan.sessions.find((s) => s.date === '2026-09-03')!;
    expect(thursday.sessionPurpose).toBe('legs');

    const legExercises = thursday.plannedWork.filter((w) => SEVEN_LEG_TARGET_IDS.includes(w.target_id));
    expect(legExercises.length).toBeLessThanOrEqual(LEGS_SESSION_MAX_EXERCISES);
    expect(thursday.plannedWork.length).toBeLessThanOrEqual(LEGS_WITH_ABS_SESSION_MAX_EXERCISES);

    // The whole point: real room for abs beyond the leg-only 5-exercise
    // ceiling, genuinely used in this fixture (otherwise this test would
    // prove nothing about the +3 exception actually engaging).
    const absExercises = thursday.plannedWork.filter((w) => w.target_id === 'obliques' || w.target_id === 'rectus-abdominis');
    expect(absExercises.length).toBeGreaterThan(0);
    expect(thursday.plannedWork.length).toBeGreaterThan(LEGS_SESSION_MAX_EXERCISES);
  });
});
