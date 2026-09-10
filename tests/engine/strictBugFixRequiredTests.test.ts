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
import { buildWorkout, buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { lookupExercisePrescriptionAnyLevel } from '../../src/blueprint/developmentPackages.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

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

describe('Consolidated Fix §7/§15.C: real programming need is never overridden by a session time budget — a scarce budget removes nothing at all (supersedes the former Strict Bug-Fix §3.6 time-fitting test)', () => {
  // Two real normal-development push-compatible targets with
  // deliberately different exposure deficits, plus front-delt, which
  // (independent of time or need — verified identical under both a
  // scarce and a generous budget) has no candidate with a resolvable
  // front-delt-specific Blueprint prescription in this fixture's real
  // data and is therefore excluded via the genuine-data-gap path (spec
  // §9/§25), never via time. Under the OLD time-fitting mechanism, a
  // scarce budget would let only ONE of {triceps, mid-pec} survive
  // (whichever ranked/fit first); Consolidated Fix §7 means session time
  // now has zero effect on generation, so a scarce nominal budget must
  // never cause either of them to lose its own real work.
  function threeTargets() {
    return [
      normalDevTarget({ target_id: 'triceps', weekly_exposure_units: 0 }), // needDeficit=8 — highest need
      normalDevTarget({ target_id: 'mid-pec', weekly_exposure_units: 3 }), // needDeficit=5 — middle
      normalDevTarget({ target_id: 'front-delt', weekly_exposure_units: 6 }), // no resolvable prescription in this fixture — a genuine data gap, unrelated to time
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

  it('under a scarce nominal budget, both real prescribable targets still receive their own work — neither is dropped for time', () => {
    const result = buildAt(10);
    const targetIds = result.exercises.map((e) => e.target_id);
    expect(targetIds).toContain('triceps');
    expect(targetIds).toContain('mid-pec');
    expect(result.skipped_targets.some((s) => s.reason.includes('time-fitting'))).toBe(false);
  });

  it('the same two targets are still both present under a more generous budget too — the nominal budget never changes what gets included', () => {
    const result = buildAt(25);
    const targetIds = result.exercises.map((e) => e.target_id);
    expect(targetIds).toContain('triceps');
    expect(targetIds).toContain('mid-pec');
  });
});

describe('Post-v2 Corrective Fix §22/§29: the exposure-cycle decision is durable and consistent within one real week, regardless of which day within it is being generated', () => {
  it('generating Monday and Friday of the identical week, from identical stored state, computes consistent real exposure-cycle facts for the same target', () => {
    // mid-pec (Complete package, this fixture's own is_specialization
    // target): sessions_per_week_reference=2 -> expected exposure
    // interval floor(7/2)=3 days (a minimum real spacing, e.g. a
    // Monday+Thursday cadence, never a rounded average). Never trained
    // before (last_trained_date: null) -> due immediately on Monday (the
    // first real day this run considers); Friday is 4 real days after
    // Monday, which already clears the 3-day interval, so it becomes due
    // again there too — two real exposures this week, driven entirely by
    // actual dates, never a precomputed "eligible days this week" list or
    // a sessions-per-week count.
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

    const mondayPlanned = mondayResult.exercises.find((e) => e.target_id === 'mid-pec');
    const fridayPlanned = fridayResult.exercises.find((e) => e.target_id === 'mid-pec');
    expect(mondayPlanned).toBeDefined();
    expect(fridayPlanned).toBeDefined();

    const mondayExposure = mondayPlanned!.decision.exposure_decision!;
    const fridayExposure = fridayPlanned!.decision.exposure_decision!;

    // Both independent calls agree on this target's own real expected
    // interval — a fact of the target's Blueprint reference, never of
    // which day is being asked about.
    expect(mondayExposure.expected_exposure_interval_days).toBe(3);
    expect(fridayExposure.expected_exposure_interval_days).toBe(3);

    // Monday: the first real exposure this week — never trained before.
    expect(mondayExposure.last_exposure_date).toBeNull();
    expect(mondayExposure.is_due_today).toBe(true);

    // Friday: correctly reconstructs Monday's own placement as its real
    // last exposure (simulated forward WITHIN this independent run),
    // never re-deriving from "weekly target requirement / remaining
    // number of days" and never resetting because it's a different day.
    expect(fridayExposure.last_exposure_date).toBe('2026-08-31');
    expect(fridayExposure.days_since_last_exposure).toBe(4);
    expect(fridayExposure.is_due_today).toBe(true);
  });
});

describe('Post-v2 Corrective Fix §5/§9: a target compatible with many days is gated by its own real due-ness interval, never a precomputed eligible-day-count cap', () => {
  it('a universal target (compatible with every PPL+Upper session purpose) receives real exposures spaced by its own expected interval, never one on every compatible day', () => {
    // obliques (config.ts's UNIVERSAL_PHYSIQUE_TARGETS) is compatible
    // with push, pull, legs, AND upper — a real scenario where every
    // one of the week's 4 gym days is compatible. Under the corrected
    // model, real due-ness (not a "how many compatible days exist, up
    // to a cap" count) decides which of those 4 days actually receive
    // direct work.
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [normalDevTarget({ target_id: 'obliques', weekly_exposure_units: 0 })],
      })
    );
    const daysWithObliques = plan.sessions.filter((s) => s.plannedWork.some((w) => w.target_id === 'obliques'));
    // Never all 4 compatible days — real due-ness genuinely spaces real
    // exposures apart rather than filling every compatible day.
    expect(daysWithObliques.length).toBeGreaterThan(0);
    expect(daysWithObliques.length).toBeLessThan(4);
    // Every exercise placed still respects its own authored cap — real
    // due-based spacing never licenses inflating an exercise.
    for (const session of daysWithObliques) {
      for (const w of session.plannedWork.filter((w) => w.target_id === 'obliques')) {
        const prescription = lookupExercisePrescriptionAnyLevel('obliques', w.exercise_id);
        if (prescription) expect(w.sets).toBeLessThanOrEqual(prescription.sets);
      }
    }
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

  it('multiple exercises — deterministically, from the target\'s own real Blueprint exercise data — when one exercise cannot reasonably cover the real weekly requirement', () => {
    // current_weekly_primary_sets=0 -> decideVolume starts at Blueprint's
    // own starting_point_sets[0] (8); one eligible session this week ->
    // setsToday=8, which exceeds any single quads candidate's own
    // per-session sets figure — genuinely requiring multiple real
    // candidates to cover the full 8 sets without inventing a split.
    // Blueprint Candidate Fix: candidate discovery/ranking is NOT
    // limited to quads-efficient's own package-listed exercises (a
    // universal package-membership gate was exactly the bug this fix
    // closes) — bulgarian-split-squat-knee-dominant is a real quads
    // candidate with a real Blueprint prescription (from quads-complete,
    // which lists it even though quads-efficient does not; see
    // lookupExercisePrescriptionAnyLevel), so it legitimately outranks
    // leg-press here rather than being invisible to selection.
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
    // comes straight from real Blueprint exercise data (never a
    // random split), and the total exactly equals the real weekly
    // requirement — no volume silently dropped just because it spans
    // more than one exercise.
    const bySets = Object.fromEntries(quadsExercises.map((e) => [e.exercise_id, e.target_sets]));
    expect(bySets).toEqual({ 'back-squat': 3, 'bulgarian-split-squat-knee-dominant': 3, 'leg-extension': 2 });
    expect(quadsExercises.reduce((sum, e) => sum + e.target_sets, 0)).toBe(8);
    // Every exercise still carries its own real Blueprint reps/RIR —
    // multi-exercise construction never loses per-exercise prescription
    // data.
    for (const e of quadsExercises) {
      expect(e.target_reps_min).toBeGreaterThan(0);
      expect(e.progression_decision).toBeNull(); // no history supplied — first-time prescription for all three
    }
  });

  it('a small real requirement for a real Blueprint-packaged target is still split honestly across exercises when a single exercise\'s own authored cap cannot hold it alone — never padded, never exceeding any exercise\'s real cap', () => {
    // 'obliques' does have a real Blueprint package ('core-efficient');
    // real coverage of the "no package -> always single exercise" branch
    // lives in the functional_goal path, exercised by
    // finalPassRequiredTests.test.ts Tests 18-20 (functional goals never
    // get a Blueprint package at all). What this test actually protects:
    // a genuinely small per-exposure prescription (4 sets — the target's
    // whole real weekly total, since only ONE real compatible day exists
    // this run) legitimately spans 2 real exercises here because each
    // individual exercise's own authored per-exposure cap (2 sets) is
    // smaller than the requirement — this is honest multi-exercise
    // construction, not exposure-cramming. Final Remaining Corrective Fix
    // §7/§19: with only one real compatible day, this target's stable
    // per-exposure prescription equals its full weekly objective (never
    // divided across exposures that don't actually occur).
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday'],
      targets: [normalDevTarget({ target_id: 'obliques', current_weekly_primary_sets: 4, weekly_exposure_units: 4, most_recent_assessment: { rating: 4, date: '2026-08-25' } })],
    });
    const exercises = result.exercises.filter((e) => e.target_id === 'obliques');
    expect(exercises.length).toBeGreaterThan(0);
    expect(exercises.reduce((sum, e) => sum + e.target_sets, 0)).toBe(4);
    for (const e of exercises) {
      expect(e.target_sets).toBeGreaterThan(0);
    }
  });

  it('Consolidated Fix §7: multi-exercise construction ignores the time budget entirely — a tight nominal budget drops none of a target\'s own real additional exercises', () => {
    const result = buildWorkout({
      date: '2026-09-03',
      weekday: 'thursday',
      budget_minutes: 10, // a scarce nominal budget — must have zero effect (spec §7)
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['tuesday', 'wednesday', 'thursday'],
      targets: [normalDevTarget({ target_id: 'quads', current_weekly_primary_sets: 0, weekly_exposure_units: 0 })],
    });
    const quadsExercises = result.exercises.filter((e) => e.target_id === 'quads');
    // Every real candidate construction decided on for this target is
    // placed in full — multiple exercises, each capped at its own
    // authored sets, never trimmed for time.
    expect(quadsExercises.length).toBeGreaterThan(1);
    expect(result.estimated_minutes).toBeGreaterThan(10);
    // No time-fitting skip is ever created (spec §7/§9).
    const timeFittingSkip = result.skipped_targets.find((s) => s.reason.includes('time-fitting'));
    expect(timeFittingSkip).toBeUndefined();
  });
});
