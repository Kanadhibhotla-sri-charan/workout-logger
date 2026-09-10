// Workout Programmer — Remaining Post-v2 Corrective Fixes: the
// regression tests required by spec §20 that are NOT already covered by
// existing suites.
//
//   §20 Test 3 (no catch-up after an underfilled week) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 3.
//   §20 Test 4 (frequency 2/week Monday/Thursday/Sunday) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts §24.A/§24.G.
//   §20 Test 5 (calendar boundary continuity) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts §24.C.
//   §20 Test 6 (one compatible session per week, several real weeks) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts §24.B.
//   §20 Test 7 (planned exposure is not actual) —
//     tests/engine/assembleAndBuildWorkout.test.ts's "deterministic at
//     the real impure boundary" test.
//   §20 Test 8 (actual completion changes future state) —
//     tests/routes/actualTrainingAdaptation.test.ts.
//   §20 Test 9 (authored-set cap) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Tests 1-2.
//   §20 Test 10 (Blueprint exercise remains valid) —
//     tests/engine/blueprintCandidateGating.test.ts,
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 10.
//   §20 Test 11/Test 12 (time/equipment invariance) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 4,
//     tests/engine/onePassDevSpecV2RequiredTests.test.ts §31.7.
//   §20 Test 13 (package aggregate not duplicated) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts §24.L.
//   §20 Test 14 (skip scope) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Tests 11-12.
//   §20 Test 15 (completed/locked protection) —
//     tests/engine/weekProgramReconciliation.test.ts.
//
// This file adds the two genuinely new required cases this spec
// introduces: §20 Test 1 (a spent weekly reference must never block a
// genuinely due later exposure) and §20 Test 2 (a large weekly deficit
// must never force an exposure the frequency/cadence decision says
// isn't due yet) — the exact primary defect this spec's remaining fix
// targets, previously untested because earlier phases' own tests always
// used weekly reference figures deliberately large enough to never be
// exhausted mid-run (see e.g. postV2CorrectiveFixV2RequiredTests.test.ts
// §24.A's own `sessionCap * 3` sizing), which never exercised this exact
// path.

import { describe, expect, it } from 'vitest';
import { buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

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

describe('Remaining Post-v2 Corrective Fixes §20 Test 1 — a due later exposure is never blocked, and (per the Final Remaining Corrective Fix) is never sized differently than an earlier one', () => {
  it('a target due on two real days this week receives the same stable per-exposure prescription both times — the second is not blocked, and is not merely "whatever remains" of the first', () => {
    // 'obliques' (efficient package): direct_sets_per_exposure (sessionCap)=8,
    // sessions_per_week=2. current_weekly_primary_sets set to sessionCap
    // so the target's own real weekly objective is exactly sessionCap —
    // under the Final Remaining Corrective Fix's stable per-exposure
    // model (weekly objective ÷ real exposure count this run), with
    // exactly 2 real compatible/due days this run, each gets sessionCap/2.
    const developmentReference = getDevelopmentReference('physique_target', 'obliques', 'efficient');
    const sessionCap = developmentReference.direct_sets_per_exposure!;
    const target = normalDevTarget('obliques', {
      current_weekly_primary_sets: sessionCap,
      weekly_exposure_units: sessionCap,
      most_recent_assessment: { rating: 3, date: '2026-08-20' }, // stagnant -> 'maintain', never inflated by itself
    });

    // Monday and Thursday: 3 real days apart — satisfies both the
    // minimum-spacing gate (interval 3) and the maximum-frequency gate
    // (only 1 prior exposure within the trailing window), so Thursday is
    // genuinely due purely on its own real cadence.
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday', 'thursday'], targets: [target] }));

    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const thursday = plan.sessions.find((s) => s.date === '2026-09-03')!;
    const mondaySets = monday.plannedWork.filter((w) => w.target_id === 'obliques').reduce((sum, w) => sum + w.sets, 0);
    const thursdaySets = thursday.plannedWork.filter((w) => w.target_id === 'obliques').reduce((sum, w) => sum + w.sets, 0);

    // Thursday is not silently empty just because Monday already
    // delivered a real exposure — it still receives a real, natural one.
    expect(thursdaySets).toBeGreaterThan(0);
    // The core requirement of THIS fix: the two due exposures are equal
    // — Thursday's prescription is not "whatever remains" after Monday's
    // own delivery, it is the SAME stable per-exposure figure.
    expect(thursdaySets).toBe(mondaySets);
    expect(mondaySets).toBe(Math.ceil(sessionCap / 2));
    // Never flagged as any kind of skip — it was never blocked.
    const thursdaySkip = thursday.skipped.find((s) => s.target_id === 'obliques');
    expect(thursdaySkip).toBeUndefined();
  });
});

describe('Remaining Post-v2 Corrective Fixes §20 Test 2 — a large weekly deficit cannot force a not-due target', () => {
  it('a target with zero current volume (the largest possible weekly deficit) trained only yesterday remains not due, no catch-up exposure generated', () => {
    // A fresh (zero-volume) target has the largest deficit
    // decideVolume can produce (recommends starting weekly volume from
    // nothing) — yet it was already given a real exposure just
    // yesterday, well short of its own real minimum spacing (3 days for
    // a 2/week reference). The deficit must never override that.
    const target = normalDevTarget('obliques', {
      current_weekly_primary_sets: 0,
      weekly_exposure_units: 0,
      last_trained_date: '2026-08-30',
      recent_direct_exposure_dates: ['2026-08-30'],
      days_since_target_last_trained: 1,
    });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday'], targets: [target] }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;

    expect(monday.plannedWork.some((w) => w.target_id === 'obliques')).toBe(false);
    const skip = monday.skipped.find((s) => s.target_id === 'obliques');
    expect(skip).toBeDefined();
    expect(skip!.reason_code).toBe('not_current_exposure');
    // The volume decision genuinely recommends real weekly volume (a
    // real, large deficit) — confirming this test isn't accidentally
    // passing because there was nothing to prescribe in the first place.
    expect(skip!.decision.volume_decision?.recommended_weekly_primary_sets).toBeGreaterThan(0);
    expect(skip!.decision.exposure_decision?.is_due_today).toBe(false);
  });
});
