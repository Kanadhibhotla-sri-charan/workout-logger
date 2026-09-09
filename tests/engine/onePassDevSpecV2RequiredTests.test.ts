// Workout Programmer — One-Pass Implementation Specification v2: the
// regression tests required by spec §31 that are NOT already covered by
// existing suites (Consolidated Fix's own required tests already prove
// the generic authored-set cap, single-day time/equipment invariance,
// no-debt-across-weeks, no-contradictory-state, and the "valid but not
// selected today" distinction — see tests/engine/consolidatedFixRequiredTests.test.ts
// and tests/friendlyExplanation.test.ts, both updated for this spec's
// renamed reason_code taxonomy). This file covers what those do not:
//
//   §31.1/§31.2 (generic cap, Hip Abduction) — already covered by
//     tests/engine/consolidatedFixRequiredTests.test.ts Tests 1-2.
//   §31.3 (package absence) — tests/engine/blueprintCandidateGating.test.ts.
//   §31.4/§31.5 (no valid exercise reaches the data-integrity code /
//     malformed-data fixture) — tests/engine/consolidatedFixRequiredTests.test.ts
//     Test 7, tests/friendlyExplanation.test.ts.
//   §31.6 (time invariance) — tests/engine/consolidatedFixRequiredTests.test.ts
//     Test 4.
//   §31.8/§31.9 (frequency across weeks, no debt) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 3.
//   §31.10 (actual training changes future state) —
//     tests/routes/actualTrainingAdaptation.test.ts,
//     tests/routes/weekProgramPersistence.test.ts.
//   §31.11/§31.12 (recovery/coverage explanation) —
//     tests/friendlyExplanation.test.ts.
//   §31.13 (better variation / redundant today explanation) —
//     tests/friendlyExplanation.test.ts's buildFriendlyRejectedCandidateReasoning suite.
//   §31.15/§31.16 (skip scope, no contradictory state) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Tests 11-12, plus
//     assertNoContradictoryProgramState's own executable production check.
//
// This file adds the two genuinely new required cases: §31.7 (full
// equipment-invariance equivalence, not just "still selects something")
// and §31.14 (an engine-level, real-pipeline `not_current_exposure`
// scenario, not just the presentation-layer wording test), plus a
// dedicated multi-day exposure-cramming regression proving §1.1/§7/§25/
// §26's worked example holds when a target has MULTIPLE real eligible
// days this week (consolidatedFixRequiredTests.test.ts Test 3 only
// exercises the single-eligible-day case, which was already correct
// before this spec — see this file's own test below for why).

import { describe, expect, it } from 'vitest';
import { buildWorkout, buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';

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

describe('One-Pass Dev Spec v2 §31.7 — full equipment invariance: identical prescription with empty vs full equipment', () => {
  it('quads on a real leg day: selected exercises, sets, reps, and RIR are byte-identical with zero vs full equipment', () => {
    const targets = [normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 })];
    const noEquipment = buildWorkout({
      date: '2026-09-03', // Thursday — the real 'legs' day this week
      weekday: 'thursday',
      budget_minutes: 60,
      available_equipment: [],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets,
    });
    const fullEquipment = buildWorkout({
      date: '2026-09-03',
      weekday: 'thursday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets,
    });
    expect(noEquipment.exercises.length).toBeGreaterThan(0);
    const strip = (r: typeof noEquipment) =>
      r.exercises.map((e) => ({ id: e.exercise_id, sets: e.target_sets, reps_min: e.target_reps_min, reps_max: e.target_reps_max, rir_min: e.target_rir_min, rir_max: e.target_rir_max }));
    expect(strip(noEquipment)).toEqual(strip(fullEquipment));
    expect(noEquipment.skipped_targets).toEqual(fullEquipment.skipped_targets);
  });
});

describe('One-Pass Dev Spec v2 §31.14 — not_current_exposure: a real engine-level scheduling gap, distinguished from invalid', () => {
  it('a physique target whose session-purpose is never compatible with any available training day is skipped with reason_code not_current_exposure, scope exposure', () => {
    // 'legs' purpose is deterministically never assigned to Monday
    // (sessionPurpose.ts) — a leg-region target with ONLY Monday
    // available therefore has zero compatible gym days this run.
    const target = normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday'], targets: [target] }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    expect(monday.plannedWork.some((w) => w.target_id === 'quads')).toBe(false);
    const skip = monday.skipped.find((s) => s.target_id === 'quads');
    expect(skip).toBeDefined();
    expect(skip!.reason_code).toBe('not_current_exposure');
    expect(skip!.scope).toBe('exposure');
    // Distinct from a genuine Blueprint data-integrity problem — this
    // target remains fully valid, just not schedulable right now.
    expect(skip!.reason_code).not.toBe('blueprint_data_integrity');
  });
});

describe('One-Pass Dev Spec v2 §1.1/§7/§25/§26 — multi-day exposure-cramming regression: several real eligible days this week, none of them absorbs more than one exposure\'s natural amount', () => {
  it('triceps with 3 real eligible days and a large real weekly need never delivers more than direct_sets_per_exposure on any single day', () => {
    const developmentReference = getDevelopmentReference('physique_target', 'triceps', 'efficient');
    expect(developmentReference.direct_sets_per_exposure).not.toBeNull();
    const sessionCap = developmentReference.direct_sets_per_exposure!;

    // A large "already at this volume" real weekly state (as if this
    // target has been training at a high maintained volume for a
    // while) — desiredWeekly stays at this same large number ('maintain'),
    // deliberately several multiples of one exposure's natural amount.
    const target = normalDevTarget({ target_id: 'triceps', current_weekly_primary_sets: sessionCap * 3, weekly_exposure_units: sessionCap * 3 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday', 'tuesday', 'thursday', 'friday'], targets: [target] }));

    const sessionsWithTriceps = plan.sessions.filter((s) => s.plannedWork.some((w) => w.target_id === 'triceps'));
    expect(sessionsWithTriceps.length).toBeGreaterThan(0);
    for (const session of sessionsWithTriceps) {
      const dayTotal = session.plannedWork.filter((w) => w.target_id === 'triceps').reduce((sum, w) => sum + w.sets, 0);
      // The core invariant this spec requires: no single real session
      // ever absorbs more than one exposure's natural per-exposure
      // amount for this target, no matter how large the outstanding
      // weekly reference is or how few/many real eligible days exist.
      expect(dayTotal).toBeLessThanOrEqual(sessionCap);
    }
    // The genuinely outstanding balance beyond what real eligible days
    // this week could deliver is left honestly unmet, not crammed.
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.deliveredDirectSets).toBeLessThan(sessionCap * 3);
    expect(allocation.unmetDirectSets).toBeGreaterThan(0);
    expect(allocation.deliveredDirectSets + allocation.unmetDirectSets).toBe(sessionCap * 3);
  });
});
