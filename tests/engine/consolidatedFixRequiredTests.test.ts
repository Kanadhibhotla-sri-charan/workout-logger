// Workout Programmer — Consolidated Fix Specification §16: the 12
// required regression tests, exercising the real production pipeline
// (buildWorkout / buildWeeklyProgrammingPlan — never an isolated helper
// standing in for it), matching the discipline every prior regression
// suite in this codebase already established.
//
// Some of the 12 required cases already have dedicated, real-pipeline
// coverage elsewhere and are intentionally NOT duplicated here:
//   Test 6 (package absence does not invalidate a Blueprint variation)
//     — tests/engine/blueprintCandidateGating.test.ts's rear-delt
//     regression already proves this generically (not rear-delt-
//     specific — see its own header comment).
//   Test 8 (recovery explanation cites the real date, never fabricated)
//     and Test 9 (coverage explanation names the real covering
//     exercise(s)) — tests/friendlyExplanation.test.ts's
//     buildFriendlySkipReasoning suite already covers both directly
//     against the real function.
// This file covers the remaining 10.

import { describe, expect, it } from 'vitest';
import { buildWorkout, buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { lookupExercisePrescriptionAnyLevel } from '../../src/blueprint/developmentPackages.js';

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

describe('Consolidated Fix §16 Test 1 — Hip Abduction cap: an authored 2-set exercise never exceeds 2 sets, even with 8+ sets of remaining target volume', () => {
  it('hip-abduction (glutes, authored sets=2 at both Efficient and Complete) stays at <= 2 sets when desiredWeekly is 50', () => {
    const target = normalDevTarget({
      target_id: 'gluteus-medius-minimus',
      current_exercise_id: 'hip-abduction', // Gate 5 continuity — deterministic winner
      current_weekly_primary_sets: 50, // desiredWeekly far exceeds any single exercise's own cap
      weekly_exposure_units: 50,
    });
    const result = buildWorkout({
      date: '2026-09-03', // Thursday — the real 'legs' day this week (never Monday, see sessionPurpose.ts)
      weekday: 'thursday',
      budget_minutes: 300,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [target],
    });
    const hipAbduction = result.exercises.filter((e) => e.exercise_id === 'hip-abduction');
    expect(hipAbduction.length).toBeGreaterThan(0);
    for (const e of hipAbduction) {
      expect(e.target_sets).toBeLessThanOrEqual(2);
    }
  });
});

describe('Consolidated Fix §16 Test 2 — generic authored-cap invariant: generated_sets <= authored_per_session_sets for EVERY placed Blueprint exercise, never an exercise-specific rule', () => {
  it('holds across several different targets, each given a huge remaining weekly volume', () => {
    const targets = [
      normalDevTarget({ target_id: 'gluteus-medius-minimus', current_exercise_id: 'hip-abduction', current_weekly_primary_sets: 60, weekly_exposure_units: 60 }),
      normalDevTarget({ target_id: 'triceps', current_exercise_id: 'cable-pushdown', current_weekly_primary_sets: 60, weekly_exposure_units: 60 }),
      normalDevTarget({ target_id: 'quads', current_exercise_id: 'back-squat', current_weekly_primary_sets: 60, weekly_exposure_units: 60 }),
    ];
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 300,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets,
    });
    expect(result.exercises.length).toBeGreaterThan(0);
    let checkedAtLeastOneBlueprintExercise = false;
    for (const e of result.exercises) {
      const prescription = lookupExercisePrescriptionAnyLevel(e.target_id, e.exercise_id);
      if (prescription === null) continue; // an outside-Blueprint candidate has no authored cap to check
      checkedAtLeastOneBlueprintExercise = true;
      expect(e.target_sets).toBeLessThanOrEqual(prescription.sets);
    }
    expect(checkedAtLeastOneBlueprintExercise).toBe(true);
  });
});

describe('Consolidated Fix §16 Test 3 — frequency is tracked through actual exposures, not crammed into one session because a calendar week has fewer opportunities', () => {
  it('a target with only one real eligible session this week receives one real exposure — never double, and no debt inflates the next independent weekly computation', () => {
    const oneSessionTarget = () => normalDevTarget({ target_id: 'triceps', current_weekly_primary_sets: 0, weekly_exposure_units: 0 });

    // "Week 1": only Monday is a real gym day this week.
    const week1 = buildWeeklyProgrammingPlan(weeklyInput({ weekStart: '2026-08-31', today: '2026-08-31', available_training_days: ['monday'], targets: [oneSessionTarget()] }));
    const week1Monday = week1.sessions.find((s) => s.date === '2026-08-31')!;
    const week1Delivered = week1Monday.plannedWork.filter((w) => w.target_id === 'triceps').reduce((sum, w) => sum + w.sets, 0);

    // "Week 2": a fresh, independent computation (as if called again from
    // real DB state where nothing has been logged yet this new week) —
    // only Monday is again the real eligible day.
    const week2 = buildWeeklyProgrammingPlan(weeklyInput({ weekStart: '2026-09-07', today: '2026-09-07', available_training_days: ['monday'], targets: [oneSessionTarget()] }));
    const week2Monday = week2.sessions.find((s) => s.date === '2026-09-07')!;
    const week2Delivered = week2Monday.plannedWork.filter((w) => w.target_id === 'triceps').reduce((sum, w) => sum + w.sets, 0);

    // Neither week doubles up — each independently-computed week
    // delivers the identical, non-inflated amount from the same zero
    // baseline (no accumulating "debt" from week 1 forcing week 2 to
    // deliver more).
    expect(week1Delivered).toBe(week2Delivered);
    expect(week1Delivered).toBeGreaterThan(0);

    // And neither session crams two exposures' worth of sets into one
    // exercise — every individual exercise still respects its own
    // authored cap (Consolidated Fix §3 invariant, re-verified here in
    // the exact cross-week scenario spec §5's example describes).
    for (const w of [...week1Monday.plannedWork, ...week2Monday.plannedWork]) {
      const prescription = lookupExercisePrescriptionAnyLevel(w.target_id, w.exercise_id);
      if (prescription === null) continue;
      expect(w.sets).toBeLessThanOrEqual(prescription.sets);
    }
  });
});

describe('Consolidated Fix §16 Test 4 — time cannot remove exercises, even at an extreme (near-zero) nominal budget', () => {
  it('a 1-minute nominal budget removes nothing: output is identical to a generous budget, and no time-fitting skip is ever created', () => {
    const targets = [normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 })];
    const tiny = buildWorkout({
      date: '2026-09-03', // Thursday — the real 'legs' day this week
      weekday: 'thursday',
      budget_minutes: 1,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets,
    });
    const generous = buildWorkout({
      date: '2026-09-03',
      weekday: 'thursday',
      budget_minutes: 300,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets,
    });
    expect(tiny.exercises.map((e) => e.exercise_id).sort()).toEqual(generous.exercises.map((e) => e.exercise_id).sort());
    expect(tiny.exercises.length).toBeGreaterThan(0);
    expect(tiny.skipped_targets.some((s) => s.reason.includes('time-fitting'))).toBe(false);
  });
});

describe('Consolidated Fix §16 Test 5 — equipment cannot remove exercises from normal generation', () => {
  it('a session with literally no available equipment still selects a real Blueprint exercise for the target', () => {
    const result = buildWorkout({
      date: '2026-09-03', // Thursday — the real 'legs' day this week
      weekday: 'thursday',
      budget_minutes: 60,
      available_equipment: [], // deliberately zero equipment
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 })],
    });
    const quads = result.exercises.filter((e) => e.target_id === 'quads');
    expect(quads.length).toBeGreaterThan(0);
    // Never excluded/skipped for lack of equipment — no such reason exists.
    expect(result.skipped_targets.some((s) => s.target_id === 'quads')).toBe(false);
  });
});

describe('Consolidated Fix §16 Test 7 — a genuine Blueprint data gap is classified distinctly, never as an ordinary programming skip', () => {
  it('a functional_goal target with no approved outside-Blueprint exercise (its only real prescription source) is classified as a genuine data gap, not "adequately exposed"/"no volume"/recovery', () => {
    const target = normalDevTarget({
      target_type: 'functional_goal',
      target_id: 'rotator-cuff',
      current_weekly_primary_sets: 0,
      weekly_exposure_units: 0,
      outside_blueprint_exercises: [], // no real prescription source exists for this target at all
    });
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [target],
    });
    const skip = result.skipped_targets.find((s) => s.target_id === 'rotator-cuff');
    expect(skip).toBeDefined();
    // A functional_goal has no Blueprint prescription source of its own
    // at all (developmentReferenceEngine.ts returns package_id: null for
    // any non-physique_target) — real Blueprint exercises DO exist that
    // touch this target (so candidateExerciseIds isn't empty), but every
    // one of them fails prescription resolution (no outside-Blueprint
    // entry, and functional_goal never resolves a Blueprint package
    // prescription), so this correctly lands on the genuine-data-gap
    // code, never a candidate-count-zero one.
    expect(skip!.reason_code).toBe('blueprint_data_integrity');
    // Distinct from every ordinary "valid but not selected today" code.
    expect(['recovery', 'not_current_exposure', 'adequately_covered', 'no_volume_recommended']).not.toContain(skip!.reason_code);
  });
});

describe('Consolidated Fix §16 Test 10 — a valid Blueprint variation not selected today is never classified as unprescribable', () => {
  it('when one of two equally-valid real candidates is selected, the other is simply absent from skipped_targets — never flagged invalid', () => {
    // cable-pushdown and close-grip-bench-press are both real,
    // independently-prescribable triceps-efficient candidates.
    // current_exercise_id forces cable-pushdown as the Gate-5
    // continuity winner; desiredWeekly is sized to need only it.
    const target = normalDevTarget({
      target_id: 'triceps',
      current_exercise_id: 'cable-pushdown',
      current_weekly_primary_sets: 2,
      weekly_exposure_units: 2,
    });
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [target],
    });
    expect(result.exercises.some((e) => e.exercise_id === 'cable-pushdown')).toBe(true);
    expect(result.exercises.some((e) => e.exercise_id === 'close-grip-bench-press')).toBe(false);
    // The unselected real candidate is never itself flagged anywhere —
    // only the whole TARGET could ever be skipped, and it wasn't (real
    // work was placed for it).
    expect(result.skipped_targets.some((s) => s.target_id === 'triceps')).toBe(false);
    // The winner's own reasoning cites a real Gate decision, never an
    // invented one.
    const winner = result.exercises.find((e) => e.exercise_id === 'cable-pushdown')!;
    expect(winner.decision.selection?.decisive_gate).toBeTruthy();
  });
});

describe('Consolidated Fix §16 Test 11 — global (week-scoped) skip deduplication: a whole-week fact is never presented as an independent daily discovery', () => {
  it('a week-level skip carries scope: "week" and is identically explainable on every session, never appearing to be freshly discovered each day', () => {
    // front-delt has no candidate with a resolvable front-delt-specific
    // Blueprint prescription in this fixture's real data (verified in
    // tests/engine/strictBugFixRequiredTests.test.ts) — a real,
    // deterministic week-level skip.
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({ available_training_days: ['monday', 'tuesday', 'thursday', 'friday'], targets: [normalDevTarget({ target_id: 'front-delt', weekly_exposure_units: 0 })] })
    );
    expect(plan.sessions.length).toBeGreaterThan(1);
    for (const session of plan.sessions) {
      const skip = session.skipped.find((s) => s.target_id === 'front-delt');
      expect(skip).toBeDefined();
      // Explicitly marked as a whole-week fact, not a per-day discovery.
      expect(skip!.scope).toBe('week');
    }
    // The identical skip (by content) recurs on every session — a
    // caller CAN deduplicate by (target_id, scope) rather than being
    // forced to treat each day's copy as a new, independent finding.
    const reasons = new Set(plan.sessions.map((s) => s.skipped.find((sk) => sk.target_id === 'front-delt')?.reason));
    expect(reasons.size).toBe(1);
  });
});

describe('Consolidated Fix §16 Test 12 — no contradictory state: a target/exercise is never simultaneously included in a session and shown as skipped for that same session', () => {
  it('across a full real week, no session ever lists the same target in both plannedWork and skipped', () => {
    const targets = [
      normalDevTarget({ target_id: 'quads', current_exercise_id: 'back-squat', current_weekly_primary_sets: 8, weekly_exposure_units: 8 }),
      normalDevTarget({ target_id: 'triceps', current_weekly_primary_sets: 0, weekly_exposure_units: 0 }),
      normalDevTarget({ target_id: 'front-delt', weekly_exposure_units: 0 }), // real week-level data-gap skip
    ];
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday', 'tuesday', 'thursday', 'friday'], targets }));
    expect(plan.sessions.length).toBeGreaterThan(0);
    for (const session of plan.sessions) {
      const plannedTargetIds = new Set(session.plannedWork.map((w) => w.target_id));
      const skippedTargetIds = new Set(session.skipped.map((s) => s.target_id));
      for (const id of plannedTargetIds) {
        expect(skippedTargetIds.has(id)).toBe(false);
      }
    }
  });
});
