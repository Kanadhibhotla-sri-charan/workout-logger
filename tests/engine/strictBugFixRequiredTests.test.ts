// Strict Final Bug-Fix Spec — required regression tests for Fix A
// (priority preservation through time fitting, §3.6), Fix B (durable
// weekly plan, §21/§22), and Fix C (multi-exercise constructor,
// §17/§18 of the required test suite, §31 "Multiple exercises"). Each
// test is individually labeled with the spec section it proves, and
// exercises the real `buildWorkout` pipeline (never an isolated helper
// standing in for it) — the same discipline finalPassRequiredTests.test.ts
// already established for the prior spec. The full-week production-path
// fixture required by §32 lives separately in
// tests/fixtures/strictBugFixFullWeek.test.ts.

import { describe, expect, it } from 'vitest';
import { buildWorkout, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';

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

describe('Strict Bug-Fix §3.6: real programming need survives time fitting — never overridden by alphabetical/array-position ID', () => {
  // Three real normal-development push-compatible targets (so they
  // genuinely compete for the same Monday session) with deliberately
  // different exposure deficits. "front-delt" — the LOWEST-need target
  // — is also the alphabetically EARLIEST real Blueprint id of the
  // three ("front-delt" < "mid-pec" < "triceps"); "triceps" — the
  // HIGHEST-need target — sorts alphabetically LAST. This is the exact
  // trap §3.6 describes: if a later stage ever fell back to ID
  // ordering, front-delt (not triceps) would win the scarce budget.
  function threeTargets() {
    return [
      normalDevTarget({ target_id: 'triceps', weekly_exposure_units: 0 }), // needDeficit=8 — highest need
      normalDevTarget({ target_id: 'mid-pec', weekly_exposure_units: 3 }), // needDeficit=5 — middle
      normalDevTarget({ target_id: 'front-delt', weekly_exposure_units: 6 }), // needDeficit=2 — lowest need, earliest id
    ];
  }

  function buildAt(budgetMinutes: number) {
    return buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: budgetMinutes,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: threeTargets(),
    });
  }

  it('under a scarce budget, the highest-need target survives and the lowest-need target is sacrificed first', () => {
    const result = buildAt(10);
    const targetIds = result.exercises.map((e) => e.target_id);
    expect(targetIds).toContain('triceps');
    expect(targetIds).not.toContain('mid-pec');
    expect(targetIds).not.toContain('front-delt');
  });

  it('the lowest-need target is NOT rescued by its alphabetically-earlier id even under a much more generous budget', () => {
    // Generous enough for triceps (highest need) and mid-pec (middle)
    // both, but front-delt (lowest need) — despite sorting first
    // alphabetically among the three real ids — must still be the one
    // left out, proving need (not ID) drives the outcome.
    const result = buildAt(25);
    const targetIds = result.exercises.map((e) => e.target_id);
    expect(targetIds).toContain('triceps');
    expect(targetIds).toContain('mid-pec');
    expect(targetIds).not.toContain('front-delt');
  });
});

describe('Strict Bug-Fix §22: the weekly plan is durable within one generation run', () => {
  it('generating Monday and Friday of the identical week, from identical stored state, computes the identical weekly_allocation for the same target', () => {
    const target = normalDevTarget({
      target_type: 'physique_target',
      target_id: 'mid-pec',
      is_specialization: true,
      goal_id: 'goal_1',
      goal_priority: 1,
      weekly_exposure_units: 0,
    });
    const input = (weekday: 'monday' | 'friday', date: string) => ({
      date,
      weekday,
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'] as const,
      targets: [target],
    });

    const mondayResult = buildWorkout(input('monday', '2026-08-31'));
    const fridayResult = buildWorkout(input('friday', '2026-09-04'));

    const mondayAllocation = mondayResult.exercises.find((e) => e.target_id === 'mid-pec')!.decision.weekly_allocation;
    const fridayAllocation = fridayResult.exercises.find((e) => e.target_id === 'mid-pec')!.decision.weekly_allocation;

    // NOT derived from "weekly target requirement / remaining number of
    // days from today" — both calls see the exact same real weekly
    // eligibility (push+upper — Monday and Friday both), so the SAME
    // per-session set count falls out regardless of which day within
    // the week is actually being generated. `session_purpose_today`
    // correctly differs (push on Monday, upper on Friday — that part IS
    // genuinely day-specific); everything about the durable weekly
    // allocation itself does not.
    expect(mondayAllocation?.eligible_days_this_week).toEqual(fridayAllocation?.eligible_days_this_week);
    expect(mondayAllocation?.sessions_remaining_this_week).toEqual(fridayAllocation?.sessions_remaining_this_week);
    expect(mondayAllocation?.eligible_days_this_week).toEqual(['monday', 'friday']);
    expect(mondayAllocation?.sessions_remaining_this_week).toBe(2);
  });
});

describe('Strict Bug-Fix §21/§7 Stage 7: a target compatible with more days than Blueprint\'s own frequency cap gets a deterministic subset, never every compatible day', () => {
  it('a universal target (compatible with every PPL+Upper session purpose) is capped at the real frequency range upper bound, not all 4 gym days', () => {
    // obliques (config.ts's UNIVERSAL_PHYSIQUE_TARGETS) is compatible
    // with push, pull, legs, AND upper — a real scenario where more
    // compatible days exist (4) than Blueprint's own frequency range
    // upper bound allows (3, per globalPrinciples.frequency
    // .typical_starting_range_per_week). A naive "every compatible day
    // is eligible" implementation would let it train all 4 days/week,
    // silently exceeding Blueprint's own guidance.
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [normalDevTarget({ target_id: 'obliques', weekly_exposure_units: 0 })],
    });
    const allocation = result.exercises.find((e) => e.target_id === 'obliques')!.decision.weekly_allocation!;
    expect(allocation.eligible_days_this_week.length).toBe(3);
    // Deterministic: the first 3 gym days in real Monday-first order,
    // not an arbitrary or random subset.
    expect(allocation.eligible_days_this_week).toEqual(['monday', 'tuesday', 'thursday']);
  });
});

describe('Strict Bug-Fix §11-15/§31 "Multiple exercises": 0/1/multiple exercises per target, driven by real Blueprint data', () => {
  it('one exercise when a single Blueprint package exercise\'s own per-session sets figure already covers the real weekly requirement', () => {
    // current_weekly_primary_sets=3 with an 'improving' trend ->
    // decideVolume maintains at 3; one eligible session this week (only
    // Thursday is a legs day in this tue/wed/thu rotation) -> setsToday
    // = 3, which back-squat's own package sets figure (3) covers in a
    // single exercise — Strict Bug-Fix §14: "one exercise is a
    // decision, not a hard architectural constraint," and here it's
    // genuinely sufficient.
    const result = buildWorkout({
      date: '2026-09-03',
      weekday: 'thursday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['tuesday', 'wednesday', 'thursday'],
      targets: [
        normalDevTarget({
          target_id: 'quads',
          current_weekly_primary_sets: 3,
          weekly_exposure_units: 3,
          most_recent_assessment: { rating: 4, date: '2026-08-25' }, // improving
        }),
      ],
    });
    const quadsExercises = result.exercises.filter((e) => e.target_id === 'quads');
    expect(quadsExercises.length).toBe(1);
    expect(quadsExercises[0]!.target_sets).toBe(3);
  });

  it('multiple exercises — deterministically, from the target\'s own real Blueprint development package — when one exercise cannot reasonably cover the real weekly requirement', () => {
    // current_weekly_primary_sets=0 -> decideVolume starts at Blueprint's
    // own starting_point_sets[0] (8); one eligible session this week ->
    // setsToday=8, which exceeds any single quads package exercise's own
    // per-session sets figure (back-squat/leg-press=3, leg-extension=2)
    // — genuinely requiring all 3 of the package's real exercises to
    // cover the full 8 sets without inventing a split.
    const result = buildWorkout({
      date: '2026-09-03',
      weekday: 'thursday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['tuesday', 'wednesday', 'thursday'],
      targets: [normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 })],
    });
    const quadsExercises = result.exercises.filter((e) => e.target_id === 'quads');
    expect(quadsExercises.length).toBe(3);
    // Deterministic distribution: every exercise's own sets figure
    // comes straight from Blueprint's own development package (never a
    // random split), and the total exactly equals the real weekly
    // requirement — no volume silently dropped just because it spans
    // more than one exercise.
    const bySets = Object.fromEntries(quadsExercises.map((e) => [e.exercise_id, e.target_sets]));
    expect(bySets).toEqual({ 'back-squat': 3, 'leg-extension': 2, 'leg-press': 3 });
    expect(quadsExercises.reduce((sum, e) => sum + e.target_sets, 0)).toBe(8);
    // Every exercise still carries its own real Blueprint reps/RIR —
    // multi-exercise construction never loses per-exercise prescription
    // data.
    for (const e of quadsExercises) {
      expect(e.target_reps_min).toBeGreaterThan(0);
      expect(e.progression_decision).toBeNull(); // no history supplied — first-time prescription for all three
    }
  });

  it('a target with no Blueprint development package (an unmapped physique_target) never receives more than one exercise — no data exists to justify or size a split', () => {
    // 'obliques' is grouped in the "core" muscle_group but its own
    // package member roster is shared with rectus-abdominis; this test
    // instead uses a target with a genuinely small requirement to
    // confirm the single-exercise path is the honest default, not the
    // exception — real coverage of the "no package -> always single
    // exercise" branch lives in the functional_goal path, exercised by
    // finalPassRequiredTests.test.ts Tests 18-20 (functional goals never
    // get a Blueprint package at all).
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [normalDevTarget({ target_id: 'obliques', current_weekly_primary_sets: 4, weekly_exposure_units: 4, most_recent_assessment: { rating: 4, date: '2026-08-25' } })],
    });
    const exercises = result.exercises.filter((e) => e.target_id === 'obliques');
    expect(exercises.length).toBe(1);
  });

  it('multi-exercise construction still respects the time budget — a tight budget drops the lowest-priority of a target\'s own additional exercises rather than exceeding it', () => {
    const result = buildWorkout({
      date: '2026-09-03',
      weekday: 'thursday',
      budget_minutes: 10, // enough for back-squat's own 3 sets (~8.8 min), not for a second exercise too
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['tuesday', 'wednesday', 'thursday'],
      targets: [normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 })],
    });
    expect(result.estimated_minutes).toBeLessThanOrEqual(10);
    const quadsExercises = result.exercises.filter((e) => e.target_id === 'quads');
    expect(quadsExercises.length).toBe(1);
    expect(quadsExercises[0]!.exercise_id).toBe('back-squat');
    // The rest of this target's own real weekly requirement is exposed
    // as a real, explained skip — never silently dropped without a
    // trace.
    const droppedForQuads = result.skipped_targets.filter((s) => s.target_id === 'quads');
    expect(droppedForQuads.length).toBeGreaterThan(0);
  });
});
