// Fix: Blueprint Exercise Candidate Selection Must Not Be Gated by
// Development Packages — required regression tests D, E, F.
//
// The bug: workoutBuilder.ts was treating "listed in this target's
// Efficient/Complete development package" as a candidate-ELIGIBILITY
// and prescription-EXISTENCE gate, discarding otherwise-valid Blueprint
// exercises before Gate 1-6 ranking ever ran (and always checking only
// the single 'efficient' package level even for a prescription lookup
// on the actual winner). Development packages are development-volume/
// reference data ONLY (see developmentReferenceEngine.ts and
// developmentPackages.ts's own header comment) — never an exercise
// menu, never an eligibility list, never a prescription-existence gate.
//
// These tests exercise the REAL end-to-end buildWorkout pipeline (never
// an isolated stand-in), proving:
//   D. rear-delt-row remains selectable even though it is absent from
//      shoulders-efficient (its real prescription now correctly
//      resolves from shoulders-complete, per lookupExercisePrescriptionAnyLevel).
//   E. the same rule holds for a completely different, non-rear-delt
//      target (quads/bulgarian-split-squat-knee-dominant), proving the
//      fix is architectural, not rear-delt-specific.
//   F. a genuinely unprescribed-anywhere Blueprint exercise
//      (rear-delt-fly, absent from EVERY shoulders package level) is
//      still correctly rejected/surfaced as a real data-quality gap —
//      never fabricated, and never blamed on mere package absence.

import { describe, expect, it } from 'vitest';
import { buildWorkout, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { lookupExercisePrescription, lookupExercisePrescriptionAnyLevel } from '../../src/blueprint/developmentPackages.js';

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

describe('Blueprint Candidate Fix — real Blueprint snapshot data preconditions', () => {
  it('confirms the exact real-data fixtures these tests depend on (documents the actual offending rule, spec\'s "Search / Audit Requirements")', () => {
    // rear-delt-row: absent from shoulders-efficient, present (with a
    // real prescription) in shoulders-complete only.
    expect(lookupExercisePrescription('rear-delt', 'rear-delt-row', 'efficient')).toBeNull();
    const complete = lookupExercisePrescription('rear-delt', 'rear-delt-row', 'complete');
    expect(complete).not.toBeNull();
    expect(complete!.sets).toBeGreaterThan(0);

    // rear-delt-fly: a real Blueprint exercise for rear-delt, but
    // genuinely absent from BOTH package levels — Blueprint's own
    // curation gap, not something this fix may paper over by adding it
    // to a package (spec rule #5).
    expect(lookupExercisePrescription('rear-delt', 'rear-delt-fly', 'efficient')).toBeNull();
    expect(lookupExercisePrescription('rear-delt', 'rear-delt-fly', 'complete')).toBeNull();
    expect(lookupExercisePrescriptionAnyLevel('rear-delt', 'rear-delt-fly')).toBeNull();

    // bulgarian-split-squat-knee-dominant: absent from quads-efficient,
    // present (with a real prescription) in quads-complete only —
    // independent, non-rear-delt proof of the identical bug pattern.
    expect(lookupExercisePrescription('quads', 'bulgarian-split-squat-knee-dominant', 'efficient')).toBeNull();
    expect(lookupExercisePrescription('quads', 'bulgarian-split-squat-knee-dominant', 'complete')).not.toBeNull();

    // Neither Blueprint exercise is a fiction of this test file.
    expect(BlueprintAdapter.getExercise('rear-delt-row')).toBeDefined();
    expect(BlueprintAdapter.getExercise('rear-delt-fly')).toBeDefined();
    expect(BlueprintAdapter.getExercise('bulgarian-split-squat-knee-dominant')).toBeDefined();
  });
});

describe('Requirement D — rear-delt regression coverage', () => {
  it('rear-delt-row remains a real, selectable candidate even though it is absent from shoulders-efficient', () => {
    const result = buildWorkout({
      // rear-delt is a real PULL-session target (config.ts's
      // PULL_PHYSIQUE_TARGETS) — Tuesday is this week's real pull day
      // once Monday/Tuesday are the only two available gym days
      // (session-purpose rotation: push, pull, legs, upper).
      date: '2026-09-01',
      weekday: 'tuesday',
      budget_minutes: 60,
      // dumbbell+bench isolates rear-delt-row as the ONLY equipment-
      // feasible rear-delt Blueprint exercise (cable-rear-delt-builder
      // needs cable; face-pull needs cable+band; machine-reverse-fly
      // needs machine; rear-delt-fly needs dumbbell+machine) — so a
      // pre-fix pool that excluded package-absent candidates before
      // ranking would leave nothing at all to select here.
      available_equipment: ['dumbbell', 'bench'],
      available_training_days: ['monday', 'tuesday'],
      targets: [normalDevTarget({ target_id: 'rear-delt' })],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.target_id).toBe('rear-delt');
    expect(planned.exercise_id).toBe('rear-delt-row');
    expect(planned.target_sets).toBeGreaterThan(0);
    // Its real prescription is sourced from shoulders-COMPLETE (the
    // only level that lists rear-delt-row) — proving the widened
    // any-level lookup, not a fabricated rep/RIR range, supplied it.
    expect(planned.target_reps_min).toBe(8);
    expect(planned.target_reps_max).toBe(15);
    expect(planned.target_rir_min).toBe(1);
    expect(planned.target_rir_max).toBe(3);
    expect(result.skipped_targets.find((s) => s.target_id === 'rear-delt')).toBeUndefined();
  });
});

describe('Requirement E — generic (non-rear-delt) package-gating regression test', () => {
  it('bulgarian-split-squat-knee-dominant remains eligible for quads despite being absent from quads-efficient (eligible === true, architectural not rear-delt-specific)', () => {
    const result = buildWorkout({
      // quads is a real LEGS-session target — with Monday/Tuesday/
      // Wednesday as the week's only available gym days (rotation:
      // push, pull, legs, upper), Wednesday is this week's real legs
      // day.
      date: '2026-09-02',
      weekday: 'wednesday',
      budget_minutes: 60,
      // dumbbell+barbell: back-squat (needs rack too) and every
      // machine-only quads exercise are infeasible; sumo-squat/sumo-
      // deadlift are feasible but have NO prescription at any package
      // level, so the real per-attempt retry must pass over them and
      // land on bulgarian-split-squat-knee-dominant — the only
      // feasible candidate with a real (quads-complete-sourced)
      // prescription.
      available_equipment: ['dumbbell', 'barbell'],
      available_training_days: ['monday', 'tuesday', 'wednesday'],
      targets: [normalDevTarget({ target_id: 'quads' })],
    });

    const planned = result.exercises.find((e) => e.target_id === 'quads');
    expect(planned).toBeDefined();
    expect(planned!.exercise_id).toBe('bulgarian-split-squat-knee-dominant');
    const eligible = planned !== undefined;
    expect(eligible).toBe(true);
    expect(planned!.target_sets).toBeGreaterThan(0);
    expect(result.skipped_targets.find((s) => s.target_id === 'quads')).toBeUndefined();
  });
});

describe('Requirement F — negative test: genuine prescription gap', () => {
  it('rear-delt-fly (absent from every shoulders package level) is surfaced as a real data-quality gap — never fabricated, never blamed on mere package absence', () => {
    const result = buildWorkout({
      // Same real pull-day placement as Requirement D's test above.
      date: '2026-09-01',
      weekday: 'tuesday',
      budget_minutes: 60,
      // dumbbell+machine isolates rear-delt-fly as the ONLY equipment-
      // feasible rear-delt candidate (rear-delt-row needs bench;
      // cable-rear-delt-builder/face-pull need cable).
      available_equipment: ['dumbbell', 'machine'],
      available_training_days: ['monday', 'tuesday'],
      targets: [normalDevTarget({ target_id: 'rear-delt' })],
    });

    // No exercise is fabricated for rear-delt — there is genuinely no
    // valid Blueprint prescription anywhere for this candidate.
    expect(result.exercises.find((e) => e.target_id === 'rear-delt')).toBeUndefined();

    const skip = result.skipped_targets.find((s) => s.target_id === 'rear-delt');
    expect(skip).toBeDefined();
    // The real reason is a genuine prescription/data gap...
    expect(skip!.reason).toContain('resolvable Blueprint prescription');
    expect(skip!.reason).toContain('rear-delt-fly');
    // ...never a claim that absence from the package makes the
    // exercise itself invalid (the exact incorrect rule this fix
    // removes — spec rule #3).
    expect(skip!.reason.toLowerCase()).not.toContain('invalid');
    expect(skip!.reason.toLowerCase()).not.toMatch(/absent from (the )?(efficient|complete) package/);
  });
});

describe('Acceptance: no package contamination as a side effect of this fix', () => {
  it('shoulders and quads development packages are byte-identical to their real pre-fix Blueprint-authored contents — nothing was added to bypass the bug', () => {
    const { packages } = BlueprintAdapter.getDevelopmentPackages();
    const shouldersEfficient = packages.find((p) => p.muscle_group === 'shoulders' && p.level === 'efficient')!;
    const shouldersComplete = packages.find((p) => p.muscle_group === 'shoulders' && p.level === 'complete')!;
    const quadsEfficient = packages.find((p) => p.muscle_group === 'quads' && p.level === 'efficient')!;
    const quadsComplete = packages.find((p) => p.muscle_group === 'quads' && p.level === 'complete')!;

    expect(shouldersEfficient.exercises.map((e) => e.exercise_id).sort()).toEqual(['cable-lateral-raise', 'dumbbell-lateral-raise', 'face-pull'].sort());
    expect(shouldersComplete.exercises.map((e) => e.exercise_id).sort()).toEqual(
      ['cable-lateral-raise', 'dumbbell-lateral-raise', 'face-pull', 'machine-lateral-raise', 'rear-delt-row'].sort()
    );
    // rear-delt-fly was never added to either level to "solve" this bug.
    expect(shouldersEfficient.exercises.some((e) => e.exercise_id === 'rear-delt-fly')).toBe(false);
    expect(shouldersComplete.exercises.some((e) => e.exercise_id === 'rear-delt-fly')).toBe(false);

    expect(quadsEfficient.exercises.map((e) => e.exercise_id).sort()).toEqual(['back-squat', 'leg-extension', 'leg-press'].sort());
    expect(quadsComplete.exercises.map((e) => e.exercise_id).sort()).toEqual(
      ['back-squat', 'bulgarian-split-squat-knee-dominant', 'leg-extension', 'leg-press', 'reverse-nordic-curl'].sort()
    );
  });
});
