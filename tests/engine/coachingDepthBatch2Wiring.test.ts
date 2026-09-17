// Coaching Depth Batch 2: wires the profile module's preferred frequency
// into developmentReferenceEngine.ts and its rep-range bias into
// workoutBuilder.ts's actual deterministic prescription path. Required
// tests per the batch 2 spec: profiled-vs-unprofiled frequency, weekly =
// per-exposure x effective frequency, higher/lower bias shift direction,
// the biased range never exceeding Blueprint's own authored range, and
// the generated workout itself carrying the biased prescription (not
// just the pure applyRepRangeBias function in isolation).

import { describe, expect, it, vi } from 'vitest';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { lookupExercisePrescriptionAnyLevel, parseRange } from '../../src/blueprint/developmentPackages.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';
import { buildWorkout, type BuildWorkoutInput, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';
import { applyRepRangeBias } from '../../src/coaching/profiles/muscleProfileService.js';
import type { MuscleProgrammingProfile } from '../../src/coaching/profiles/muscleProfileTypes.js';

// Isolated to this test file only (vitest resets the module registry per
// file): overrides getProfile ONLY for the real 'mid-pec' target, which
// the 'lower' bias test below needs a curated bias for — every OTHER
// target id (gastrocnemius, soleus, rectus-abdominis, obliques, triceps,
// etc.) falls straight through to the real, unmodified curated profile
// data. The "unprofiled/standard-bias unchanged" reps test deliberately
// uses 'triceps' instead of 'mid-pec' to stay clear of this override.
// getPreferredFrequencyReference/applyRepRangeBias and every other
// export are the real, unmocked implementations — mid-pec's real
// (unprofiled) frequency reference is unaffected by this override, since
// getPreferredFrequencyReference closes over the real internal
// muscleProfiles.js getProfile, never the mocked export below.
vi.mock('../../src/coaching/profiles/muscleProfileService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/coaching/profiles/muscleProfileService.js')>();
  return {
    ...actual,
    getProfile: (targetId: string): MuscleProgrammingProfile =>
      targetId === 'mid-pec' ? { targetId, repRangeBias: 'lower', source: 'blueprint_profile' } : actual.getProfile(targetId),
  };
});

const MONDAY = '2026-08-31'; // a real Monday
// Calves (gastrocnemius/soleus) are a lower-body region that only trains
// on this week's 'legs' purpose day. With available_training_days below
// (['monday','tuesday','thursday','friday']), sessionPurpose.ts's fixed
// push/pull/legs/upper rotation assigns 'legs' to the 3rd day, Thursday —
// Monday itself is also hard-forbidden for lower-body work regardless
// (constraintEngine.ts's isBodyFocusAllowedOnDay, spec §16).
const LEGS_DAY = '2026-09-03'; // the same week's Thursday
const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

function baseTarget(overrides: Partial<TargetBuildContext> & Pick<TargetBuildContext, 'target_id'>): TargetBuildContext {
  return {
    target_type: 'physique_target',
    tier: 'supporting',
    is_specialization: false,
    goal_id: '__normal_development_or_maintenance__',
    goal_priority: 1000,
    current_weekly_primary_sets: 0,
    weekly_secondary_sets: 0,
    weekly_exposure_units: 0,
    rolling_exposure_units: 0,
    rolling_window_days: 28,
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

function weeklyInput(overrides: Partial<BuildWorkoutInput> = {}): BuildWorkoutInput {
  return {
    date: MONDAY,
    weekday: 'monday',
    budget_minutes: 300,
    available_equipment: FULL_EQUIPMENT,
    available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
    targets: [],
    ...overrides,
  };
}

describe('Coaching Depth Batch 2 — preferred frequency wired into developmentReferenceEngine', () => {
  it("a profiled muscle's development reference uses its curated preferred frequency, not Blueprint's raw package frequency", () => {
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'calves-efficient')!;
    expect(pkg.frequency.sessions_per_week).toBe(2); // Blueprint's own raw package frequency, unaffected
    const ref = getDevelopmentReference('physique_target', 'gastrocnemius', 'efficient');
    expect(ref.sessions_per_week_reference).toBe(4); // gastrocnemius's curated preferredFrequencyPerWeek (Batch 1)
    expect(ref.sessions_per_week_reference).not.toBe(pkg.frequency.sessions_per_week);
  });

  it('an unprofiled muscle remains unchanged: still Blueprint\'s own raw package frequency', () => {
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'chest-efficient')!;
    const ref = getDevelopmentReference('physique_target', 'mid-pec', 'efficient');
    expect(ref.sessions_per_week_reference).toBe(pkg.frequency.sessions_per_week);
  });

  it('weekly_direct_set_reference equals direct_sets_per_exposure x the effective (profile-overridden when present) frequency', () => {
    const profiled = getDevelopmentReference('physique_target', 'gastrocnemius', 'efficient');
    expect(profiled.weekly_direct_set_reference).toBe(profiled.direct_sets_per_exposure! * profiled.sessions_per_week_reference!);

    const unprofiled = getDevelopmentReference('physique_target', 'mid-pec', 'efficient');
    expect(unprofiled.weekly_direct_set_reference).toBe(unprofiled.direct_sets_per_exposure! * unprofiled.sessions_per_week_reference!);
  });

  it('direct_sets_per_exposure itself is never altered by the frequency override', () => {
    const pkg = BlueprintAdapter.getDevelopmentPackages().packages.find((p) => p.id === 'calves-efficient')!;
    const ref = getDevelopmentReference('physique_target', 'gastrocnemius', 'efficient');
    expect(ref.direct_sets_per_exposure).toBe(pkg.exercises.reduce((s, e) => s + e.sets, 0));
  });
});

describe('Coaching Depth Batch 2 — rep-range bias wired into the actual prescription path', () => {
  it('a higher-biased physique target\'s generated prescription is shifted toward the high end of its own authored Blueprint range', () => {
    const target = baseTarget({ target_id: 'gastrocnemius' }); // curated repRangeBias: 'higher'
    const result = buildWorkout(weeklyInput({ date: LEGS_DAY, weekday: 'thursday', targets: [target] }));
    const placed = result.exercises.filter((e) => e.target_id === 'gastrocnemius');
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) {
      const authoredPrescription = lookupExercisePrescriptionAnyLevel('gastrocnemius', item.exercise_id)!;
      expect(authoredPrescription).toBeDefined();
      const authored = parseRange(authoredPrescription.reps);
      const expectedBiased = applyRepRangeBias(authored.min, authored.max, 'higher');
      expect(item.target_reps_min).toBe(expectedBiased.min);
      expect(item.target_reps_max).toBe(expectedBiased.max);
      // "shifted toward the high end": the bottom moved up (unless the
      // authored range was too narrow to shift at all), the top did not.
      expect(item.target_reps_max).toBe(authored.max);
      if (authored.max - authored.min >= 2) {
        expect(item.target_reps_min).toBeGreaterThan(authored.min);
      }
    }
  });

  it('a lower-biased physique target\'s generated prescription is shifted toward the low end of its own authored Blueprint range', () => {
    // No curated profile in the real Batch 1/2 data uses 'lower' bias yet
    // (rectus-abdominis/obliques/gastrocnemius/soleus/forearm-flexors/
    // forearm-extensors are all 'higher') — applyRepRangeBias's own
    // 'lower' branch is already unit-tested directly
    // (tests/coaching/muscleProfiles.test.ts).
    // This test instead proves the real WIRING carries a 'lower' bias
    // through to the generated workout, via the file-level mock above
    // that gives the real 'mid-pec' target a synthetic 'lower' profile.
    const target = baseTarget({ target_id: 'mid-pec' });
    const result = buildWorkout(weeklyInput({ targets: [target] }));
    const placed = result.exercises.filter((e) => e.target_id === 'mid-pec');
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) {
      const authoredPrescription = lookupExercisePrescriptionAnyLevel('mid-pec', item.exercise_id)!;
      const authored = parseRange(authoredPrescription.reps);
      const expectedBiased = applyRepRangeBias(authored.min, authored.max, 'lower');
      expect(item.target_reps_min).toBe(expectedBiased.min);
      expect(item.target_reps_max).toBe(expectedBiased.max);
      expect(item.target_reps_min).toBe(authored.min);
      if (authored.max - authored.min >= 2) {
        expect(item.target_reps_max).toBeLessThan(authored.max);
      }
    }
  });

  it('the resulting range never exceeds Blueprint\'s own authored range, for every curated non-standard-bias target', () => {
    const lowerBodyTargets = new Set(['gastrocnemius', 'soleus']);
    for (const targetId of ['gastrocnemius', 'soleus', 'rectus-abdominis', 'obliques']) {
      const target = baseTarget({ target_id: targetId });
      const onLowerBodyDay = lowerBodyTargets.has(targetId);
      const result = buildWorkout(weeklyInput({ date: onLowerBodyDay ? LEGS_DAY : MONDAY, weekday: onLowerBodyDay ? 'thursday' : 'monday', targets: [target] }));
      const placed = result.exercises.filter((e) => e.target_id === targetId);
      expect(placed.length).toBeGreaterThan(0);
      for (const item of placed) {
        const authoredPrescription = lookupExercisePrescriptionAnyLevel(targetId, item.exercise_id)!;
        const authored = parseRange(authoredPrescription.reps);
        expect(item.target_reps_min).toBeGreaterThanOrEqual(authored.min);
        expect(item.target_reps_max).toBeLessThanOrEqual(authored.max);
      }
    }
  });

  it('an unprofiled (standard-bias) target\'s generated prescription is exactly Blueprint\'s own authored range, unchanged', () => {
    // Deliberately 'triceps', not 'mid-pec' — mid-pec is given a
    // synthetic 'lower' profile by the file-level mock above, so a
    // genuinely-unprofiled target is needed here instead.
    const target = baseTarget({ target_id: 'triceps' });
    const result = buildWorkout(weeklyInput({ targets: [target] }));
    const placed = result.exercises.filter((e) => e.target_id === 'triceps');
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) {
      const authoredPrescription = lookupExercisePrescriptionAnyLevel('triceps', item.exercise_id)!;
      const authored = parseRange(authoredPrescription.reps);
      expect(item.target_reps_min).toBe(authored.min);
      expect(item.target_reps_max).toBe(authored.max);
    }
  });

  it('the generated workout itself carries the biased prescription (not just the pure applyRepRangeBias function)', () => {
    const target = baseTarget({ target_id: 'gastrocnemius' });
    const result = buildWorkout(weeklyInput({ date: LEGS_DAY, weekday: 'thursday', targets: [target] }));
    const placed = result.exercises.filter((e) => e.target_id === 'gastrocnemius');
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) {
      const authoredPrescription = lookupExercisePrescriptionAnyLevel('gastrocnemius', item.exercise_id)!;
      const authored = parseRange(authoredPrescription.reps);
      if (authored.max - authored.min >= 2) {
        // The real generated PlannedWorkItem's own reps_min genuinely
        // differs from Blueprint's raw authored minimum — proof the bias
        // reached the actual output object placed into the session, not
        // merely a value computed and discarded.
        expect(item.target_reps_min).not.toBe(authored.min);
      }
    }
  });

  it('a functional_goal target (no physique-target profile lookup at all) is never affected by rep-range bias wiring', () => {
    const target = baseTarget({
      target_id: 'rotator-cuff',
      target_type: 'functional_goal',
      outside_blueprint_exercises: [
        { id: 'band-pull-apart', name: 'Band Pull Apart', role: 'primary', equipment: [], reps_range: '15-25', rir_range: '2-4' },
      ],
    });
    const result = buildWorkout(weeklyInput({ targets: [target] }));
    const placed = result.exercises.filter((e) => e.target_id === 'rotator-cuff');
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) {
      // An outside-Blueprint candidate's own human-approved range is
      // used verbatim — never biased (bias only ever applies to a real
      // Blueprint-authored physique-target package range).
      expect(item.target_reps_min).toBe(15);
      expect(item.target_reps_max).toBe(25);
    }
  });
});
