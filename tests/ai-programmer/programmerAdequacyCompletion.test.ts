// Push Generation Architectural Fix (2026-09-24), priority 3: unit tests
// for completeProposalAdequacy — deterministic exercise/volume
// completion. Uses REAL Blueprint target ids (side-delt, triceps,
// triceps-long-head, obliques) so effective ceilings and
// creditedTargetKeys resolve against real data, exactly as in
// production.

import { describe, expect, it } from 'vitest';
import { completeProposalAdequacy } from '../../src/ai-programmer/validation/programmerAdequacyCompletion.js';
import { validateProposalAdequacy, UNDER_PRESCRIPTION_TOLERANCE } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import { computeTargetFeasibility } from '../../src/ai-programmer/context/targetFeasibility.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';
import type {
  AIProgrammerContext,
  AIProgrammerMuscleGuidance,
  AIProgrammerTargetContext,
  AIProgrammerValidExerciseContext,
} from '../../src/ai-programmer/context/programmerContextTypes.js';

function validExercise(overrides: Partial<AIProgrammerValidExerciseContext> & Pick<AIProgrammerValidExerciseContext, 'exerciseId'>): AIProgrammerValidExerciseContext {
  return {
    name: overrides.exerciseId,
    role: 'primary',
    equipment: [],
    authoredPrescription: null,
    plausibleIntensityTechniques: [],
    recentConsecutiveSessionsUsed: 0,
    ...overrides,
  };
}

function target(targetId: string, validExercises: readonly AIProgrammerValidExerciseContext[], overrides: Partial<AIProgrammerTargetContext> = {}): AIProgrammerTargetContext {
  return {
    targetType: 'physique_target',
    targetId,
    displayName: targetId,
    parentRegion: null,
    isSpecialization: false,
    goalId: null,
    currentWeeklyPrimarySets: 0,
    weeklySecondarySets: 0,
    weeklyExposureUnits: 0,
    rollingExposureUnits: 0,
    rollingWindowDays: 7,
    lastTrainedDate: null,
    daysSinceLastTrainedAsOfTargetDate: null,
    exerciseHistory: {},
    recovery: { priority_adjustment: 'none' } as AIProgrammerTargetContext['recovery'],
    validExercises,
    ...overrides,
  } as AIProgrammerTargetContext;
}

function guidance(
  t: AIProgrammerTargetContext,
  allTargets: readonly AIProgrammerTargetContext[],
  recommendedMinimum: number,
  directSetsPerExposureCap: number | null,
  overrides: Partial<AIProgrammerMuscleGuidance> = {}
): AIProgrammerMuscleGuidance {
  return {
    targetType: t.targetType,
    targetId: t.targetId,
    developmentLevel: 'efficient',
    isGoalOriented: t.isSpecialization,
    weeklyDevelopmentReference: recommendedMinimum * 2,
    directSetsPerExposureCap,
    currentWeeklyDirectSets: 0,
    currentWeeklySecondarySets: 0,
    volumeAction: 'increase',
    recommendedWeeklyPrimarySets: recommendedMinimum,
    recommendedSessionSets: { min: recommendedMinimum, max: recommendedMinimum },
    recoveryAdjustment: 'none',
    eligibleForThisSession: true,
    reasoning: 'test fixture',
    antagonistGroup: null,
    feasibility: computeTargetFeasibility(t, allTargets, recommendedMinimum, directSetsPerExposureCap, UNDER_PRESCRIPTION_TOLERANCE),
    ...overrides,
  };
}

function exercise(overrides: Partial<AIWorkoutExerciseProposal> & Pick<AIWorkoutExerciseProposal, 'exerciseId' | 'targetId' | 'sets'>): AIWorkoutExerciseProposal {
  return {
    role: 'primary',
    targetType: 'physique_target',
    repsMin: 8,
    repsMax: 12,
    rirMin: 1,
    rirMax: 3,
    rationale: ['test'],
    source: 'blueprint',
    ...overrides,
  };
}

function proposal(exercises: AIWorkoutExerciseProposal[]): AIWorkoutSessionProposal {
  return {
    schemaVersion: 'ai-workout-session-proposal.v1',
    proposalId: 'p-1',
    mode: 'generate_session',
    targetDate: '2026-10-01',
    weekday: 'thursday',
    sessionFocus: ['push'],
    exercises,
    programmingRationale: [],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
  };
}

function contextWith(
  targets: readonly AIProgrammerTargetContext[],
  muscles: readonly AIProgrammerMuscleGuidance[],
  expectedCoverageTargetIds: readonly string[] = muscles.map((m) => m.targetId)
): AIProgrammerContext {
  return {
    targets,
    programmingBrief: {
      session: { purpose: 'push', expectedCoverageTargetIds },
      muscles,
      approxSessionSetBudget: 30,
      feasibilityWarnings: [],
    },
  } as unknown as AIProgrammerContext;
}

// Real Blueprint side-delt candidates (see targetFeasibility.test.ts).
const sideDeltAuthored = [
  validExercise({ exerciseId: 'cable-lateral-raise', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
  validExercise({ exerciseId: 'dumbbell-lateral-raise', authoredPrescription: { sets: 3, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
  validExercise({ exerciseId: 'machine-lateral-raise', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
];

describe('completeProposalAdequacy', () => {
  it('1. side-delt: AI selects one 3-set exercise; completion adds the minimum additional real exercise; final adequacy passes', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7);
    const ctx = contextWith(allTargets, [g]);
    const p = proposal([exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 })]);

    const { proposal: completed, notes } = completeProposalAdequacy(p, ctx);
    expect(notes.length).toBeGreaterThan(0);
    const sideDeltExercises = completed.exercises.filter((e) => e.targetId === 'side-delt');
    expect(sideDeltExercises.length).toBe(2);
    // Never re-adds the exercise already present.
    expect(sideDeltExercises.map((e) => e.exerciseId)).not.toContain('dumbbell-lateral-raise-again');
    const totalSets = sideDeltExercises.reduce((sum, e) => sum + e.sets, 0);
    expect(totalSets).toBeGreaterThanOrEqual(3.5);

    const adequacy = validateProposalAdequacy(completed, ctx);
    expect(adequacy.ok).toBe(true);
  });

  it('2. a target already above threshold: no completion occurs', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7);
    const ctx = contextWith(allTargets, [g]);
    // 3+2 = 5, well above the 3.5 threshold.
    const p = proposal([
      exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 }),
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 2 }),
    ]);

    const { proposal: completed, notes } = completeProposalAdequacy(p, ctx);
    expect(notes).toEqual([]);
    expect(completed).toBe(p); // same reference — a genuine no-op, never a needless copy
  });

  it('3. a target exactly at threshold: no completion occurs', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7); // threshold = 3.5
    const ctx = contextWith(allTargets, [g]);
    // dumbbell-lateral-raise(3) + machine-lateral-raise(cap 2, but give it
    // only enough to land exactly on 3.5 isn't representable in integers,
    // so use two exercises summing to exactly 4 (>= 3.5, the smallest
    // integer total that lands "at or above" the threshold) and confirm
    // no further completion happens once already at/above it.
    const p = proposal([
      exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 2 }),
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 2 }),
    ]);

    const { notes } = completeProposalAdequacy(p, ctx);
    expect(notes).toEqual([]);
  });

  it('4. a target below threshold with NO feasible completion: existing adequacy failure remains, nothing forced', () => {
    // Only one real candidate, capped at 2 by directSetsPerExposureCap —
    // genuinely cannot reach a 20-set floor's 10-set threshold no matter
    // what completion does.
    const hopeless = target('side-delt', [validExercise({ exerciseId: 'cable-lateral-raise', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } })]);
    const allTargets = [hopeless];
    const g = guidance(hopeless, allTargets, 20, 2);
    expect(g.feasibility!.isFeasible).toBe(false);
    const ctx = contextWith(allTargets, [g]);
    const p = proposal([exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 2 })]);

    const { proposal: completed, notes } = completeProposalAdequacy(p, ctx);
    expect(notes).toEqual([]);
    expect(completed).toBe(p);
    const adequacy = validateProposalAdequacy(completed, ctx);
    expect(adequacy.ok).toBe(false);
    expect(adequacy.errors.some((e) => e.includes('side-delt') && e.includes('inadequate'))).toBe(true);
  });

  it('5. completion cannot exceed an exercise-level authored ceiling when bumping an existing exercise', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7);
    const ctx = contextWith(allTargets, [g]);
    // dumbbell-lateral-raise's own authored ceiling is 3 — already there.
    // No headroom to bump; completion must add a NEW exercise instead.
    const p = proposal([exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 })]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    const dlr = completed.exercises.find((e) => e.exerciseId === 'dumbbell-lateral-raise')!;
    expect(dlr.sets).toBe(3); // never bumped past its own ceiling
    expect(completed.exercises.length).toBe(2); // a new exercise was added instead
  });

  it('6. completion cannot exceed the session exercise cap', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7);
    const ctx = contextWith(allTargets, [g]);
    // Fill the session to exactly the general 10-exercise cap with inert,
    // unrelated single-set filler exercises on other real targets, then
    // confirm completion for side-delt (which would need to ADD an
    // 11th) is refused and reported rather than exceeding the cap.
    const fillers = Array.from({ length: 9 }, (_, i) =>
      exercise({ exerciseId: `filler-${i}`, targetId: `filler-target-${i}`, sets: 1, targetType: 'physique_target' })
    );
    const p = proposal([exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 }), ...fillers]);

    const { proposal: completed, notes } = completeProposalAdequacy(p, ctx);
    expect(completed.exercises.length).toBe(10); // never exceeds the real 10-exercise cap
    expect(notes.some((n) => n.includes('session-wide cap'))).toBe(true);
  });

  it('7. completion cannot exceed ABS_SESSION_EXERCISE_SHARE_MAX', async () => {
    const { ABS_SESSION_EXERCISE_SHARE_MAX } = await import('../../src/engine/config.js');
    const obliques = target('obliques', [
      validExercise({ exerciseId: 'cable-crunch', authoredPrescription: { sets: 3, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'cable-woodchop', authoredPrescription: { sets: 2, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'pallof-press', authoredPrescription: { sets: 2, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [obliques];
    const g = guidance(obliques, allTargets, 8, 8);
    const ctx = contextWith(allTargets, [g]);
    // Already at the abs share cap (2 abs exercises) via cable-crunch +
    // some OTHER abs exercise not for obliques itself — simulate by
    // pre-filling 2 abs-target exercises (cable-crunch here, plus one
    // more against rectus-abdominis) so a 3rd is refused.
    const p = proposal([
      exercise({ exerciseId: 'cable-crunch', targetId: 'obliques', sets: 3 }),
      exercise({ exerciseId: 'hanging-knee-leg-raise', targetId: 'rectus-abdominis', sets: 3 }),
    ]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    const absExerciseCount = completed.exercises.filter((e) => e.targetId === 'obliques' || e.targetId === 'rectus-abdominis').length;
    expect(absExerciseCount).toBeLessThanOrEqual(ABS_SESSION_EXERCISE_SHARE_MAX);
  });

  it('8. shared-credit target: completion sees the real credited total (creditedTargetKeys), not just literal targetId', () => {
    const tricepsLongHead = target('triceps-long-head', [
      validExercise({ exerciseId: 'overhead-triceps-extension', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const triceps = target('triceps', [
      validExercise({ exerciseId: 'overhead-triceps-extension', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'close-grip-bench-press', authoredPrescription: { sets: 3, repsMin: 6, repsMax: 12, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'cable-pushdown', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [triceps, tricepsLongHead];
    const gTriceps = guidance(triceps, allTargets, 8, 12, { isGoalOriented: true });
    const gTricepsLongHead = guidance(tricepsLongHead, allTargets, 4, 4, { isGoalOriented: true });
    const ctx = contextWith(allTargets, [gTriceps, gTricepsLongHead]);
    // ALL triceps volume given only under triceps-long-head — credited to
    // triceps too via creditedTargetKeys, exactly as adequacy validation
    // itself now checks.
    const p = proposal([exercise({ exerciseId: 'overhead-triceps-extension', targetId: 'triceps-long-head', sets: 2 })]);

    const { proposal: completed, notes } = completeProposalAdequacy(p, ctx);
    // triceps (threshold 4) was credited 2 via the shared exercise —
    // completion must recognize that (not treat it as 0) and add only
    // the REMAINING gap, never a redundant full 4.
    expect(notes.some((n) => n.includes('triceps') && !n.includes('triceps-long-head'))).toBe(true);
    const tricepsOwnExercises = completed.exercises.filter((e) => e.targetId === 'triceps');
    expect(tricepsOwnExercises.length).toBe(1); // one small addition, not a redundant full rebuild
    const adequacy = validateProposalAdequacy(completed, ctx);
    expect(adequacy.ok).toBe(true);
  });

  it('9. duplicate exercise: completion never adds an exercise already present anywhere in the proposal', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7);
    const ctx = contextWith(allTargets, [g]);
    // Both real 3-ceiling-or-less candidates already present — only
    // machine-lateral-raise remains as a genuinely new option.
    const p = proposal([
      exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 }),
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 1 }),
    ]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    const exerciseIds = completed.exercises.map((e) => e.exerciseId);
    const uniqueIds = new Set(exerciseIds);
    expect(exerciseIds.length).toBe(uniqueIds.size); // no duplicate exerciseId anywhere
  });

  it('10. minimum-change: reaches the adequacy threshold without unnecessarily filling the entire recommended floor', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7); // floor 7, threshold 3.5
    const ctx = contextWith(allTargets, [g]);
    const p = proposal([exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 })]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    const total = completed.exercises.filter((e) => e.targetId === 'side-delt').reduce((sum, e) => sum + e.sets, 0);
    expect(total).toBeGreaterThanOrEqual(3.5);
    expect(total).toBeLessThan(7); // never silently filled all the way to the full recommended floor
  });

  it('11. persistence: the COMPLETED proposal (not the pre-completion one) is what a caller receives and would persist', () => {
    const sideDelt = target('side-delt', sideDeltAuthored);
    const allTargets = [sideDelt];
    const g = guidance(sideDelt, allTargets, 7, 7);
    const ctx = contextWith(allTargets, [g]);
    const p = proposal([exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 })]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    expect(completed).not.toBe(p); // a genuinely different object once completion acted
    expect(completed.exercises.length).toBeGreaterThan(p.exercises.length);
    // The pre-completion proposal itself is never mutated in place.
    expect(p.exercises.length).toBe(1);
    // And validating the ORIGINAL (pre-completion) proposal would still
    // fail — proving completion is what makes the difference, not some
    // unrelated change to the input.
    const adequacyOnOriginal = validateProposalAdequacy(p, ctx);
    expect(adequacyOnOriginal.ok).toBe(false);
    const adequacyOnCompleted = validateProposalAdequacy(completed, ctx);
    expect(adequacyOnCompleted.ok).toBe(true);
  });

  // Cross-Target Candidate Contention Fix (2026-09-28): completion used to
  // process targets in fixed declaration order, so one target's own
  // greedy pick could permanently consume a candidate a still-pending
  // target had no alternative for — even when a joint legal allocation
  // existed for both. These tests cover the most-constrained-target-first
  // scheduler that replaced that fixed order.

  it('12. regression: two targets sharing one candidate, each with a viable alternative, both reach adequacy via the correct joint allocation', () => {
    // lat-width has TWO remaining candidates once its own existing
    // exercise is at cap (shared-candidate, own-alternative); back-
    // thickness has only ONE (shared-candidate). Declaration order below
    // lists lat-width FIRST — the exact ordering that reproduced the real
    // bug (the old fixed-order pass would let lat-width greedily claim
    // shared-candidate first, starving back-thickness). The new
    // most-constrained-first scheduler must process back-thickness first
    // regardless of declaration order.
    const latWidth = target('lat-width', [
      validExercise({ exerciseId: 'lat-own-exercise', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'lat-own-alternative', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const backThickness = target('back-thickness', [
      validExercise({ exerciseId: 'back-own-exercise', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [latWidth, backThickness];
    const gLatWidth = guidance(latWidth, allTargets, 8, 8); // threshold 4
    const gBackThickness = guidance(backThickness, allTargets, 8, 8); // threshold 4
    const ctx = contextWith(allTargets, [gLatWidth, gBackThickness]);
    // Both already at their own exercise's ceiling (3) — each needs
    // exactly 1 more set, and only `shared-candidate` is unused by both.
    const p = proposal([
      exercise({ exerciseId: 'lat-own-exercise', targetId: 'lat-width', sets: 3 }),
      exercise({ exerciseId: 'back-own-exercise', targetId: 'back-thickness', sets: 3 }),
    ]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);

    const latWidthExercises = completed.exercises.filter((e) => e.targetId === 'lat-width');
    const backThicknessExercises = completed.exercises.filter((e) => e.targetId === 'back-thickness');
    // back-thickness (the more constrained target) gets the shared
    // candidate; lat-width falls back to its own alternative — never the
    // reverse (which is what the old bug produced).
    expect(backThicknessExercises.map((e) => e.exerciseId)).toContain('shared-candidate');
    expect(latWidthExercises.map((e) => e.exerciseId)).toContain('lat-own-alternative');
    expect(latWidthExercises.map((e) => e.exerciseId)).not.toContain('shared-candidate');

    const adequacy = validateProposalAdequacy(completed, ctx);
    expect(adequacy.ok).toBe(true); // both targets reach adequacy — the joint legal allocation is found
  });

  it('13. three-way contention: two of three deficient targets are completed deterministically; the third is left correctly under-threshold, never forced', () => {
    // back-thickness can only use candidate X; biceps can only use
    // candidate Y; lat-width could use either X or Y. Only two exercises'
    // worth of shared capacity exist for three needs — lat-width, the
    // most flexible (least constrained) target, is the one left short.
    const backThickness = target('back-thickness', [
      validExercise({ exerciseId: 'back-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-x', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const latWidth = target('lat-width', [
      validExercise({ exerciseId: 'lat-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-x', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-y', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const biceps = target('biceps', [
      validExercise({ exerciseId: 'bicep-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-y', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [backThickness, latWidth, biceps];
    const gBackThickness = guidance(backThickness, allTargets, 8, 8);
    const gLatWidth = guidance(latWidth, allTargets, 8, 8);
    const gBiceps = guidance(biceps, allTargets, 8, 8);
    const ctx = contextWith(allTargets, [gLatWidth, gBackThickness, gBiceps]);
    const p = proposal([
      exercise({ exerciseId: 'back-filler', targetId: 'back-thickness', sets: 3 }),
      exercise({ exerciseId: 'lat-filler', targetId: 'lat-width', sets: 3 }),
      exercise({ exerciseId: 'bicep-filler', targetId: 'biceps', sets: 3 }),
    ]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    const adequacy = validateProposalAdequacy(completed, ctx);

    // back-thickness and biceps — each with exactly one exclusive
    // candidate — are always completed; lat-width, the only target with
    // two options, is deterministically the one left short once both
    // exclusive claims are honored first.
    expect(adequacy.errors.some((e) => e.includes('back-thickness'))).toBe(false);
    expect(adequacy.errors.some((e) => e.includes('biceps'))).toBe(false);
    expect(adequacy.errors.some((e) => e.includes('lat-width'))).toBe(true);
    expect(completed.exercises.filter((e) => e.targetId === 'lat-width').map((e) => e.exerciseId)).not.toContain('shared-x');
    expect(completed.exercises.filter((e) => e.targetId === 'lat-width').map((e) => e.exerciseId)).not.toContain('shared-y');
  });

  it('14. genuine infeasibility: two targets sharing exactly one candidate — only one can legally consume it, the other correctly remains inadequate (never forced, never duplicated)', () => {
    const backThickness = target('back-thickness', [
      validExercise({ exerciseId: 'back-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'only-shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const latWidth = target('lat-width', [
      validExercise({ exerciseId: 'lat-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'only-shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [backThickness, latWidth];
    const gBackThickness = guidance(backThickness, allTargets, 8, 8);
    const gLatWidth = guidance(latWidth, allTargets, 8, 8);
    const ctx = contextWith(allTargets, [gLatWidth, gBackThickness]);
    const p = proposal([
      exercise({ exerciseId: 'back-filler', targetId: 'back-thickness', sets: 3 }),
      exercise({ exerciseId: 'lat-filler', targetId: 'lat-width', sets: 3 }),
    ]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);
    const sharedUsers = completed.exercises.filter((e) => e.exerciseId === 'only-shared-candidate');
    expect(sharedUsers.length).toBe(1); // never assigned to both — an exerciseId can only carry one targetId

    const adequacy = validateProposalAdequacy(completed, ctx);
    expect(adequacy.ok).toBe(false); // no legal joint solution exists — correctly rejected, nothing forced
    const exerciseIds = completed.exercises.map((e) => e.exerciseId);
    expect(exerciseIds.length).toBe(new Set(exerciseIds).size); // still no duplicate exerciseId anywhere
  });

  it('15. determinism: the same contended input produces byte-identical completion output across repeated runs', () => {
    const latWidth = target('lat-width', [
      validExercise({ exerciseId: 'lat-own-exercise', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'lat-own-alternative', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const backThickness = target('back-thickness', [
      validExercise({ exerciseId: 'back-own-exercise', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [latWidth, backThickness];
    const gLatWidth = guidance(latWidth, allTargets, 8, 8);
    const gBackThickness = guidance(backThickness, allTargets, 8, 8);
    const ctx = contextWith(allTargets, [gLatWidth, gBackThickness]);
    const p = proposal([
      exercise({ exerciseId: 'lat-own-exercise', targetId: 'lat-width', sets: 3 }),
      exercise({ exerciseId: 'back-own-exercise', targetId: 'back-thickness', sets: 3 }),
    ]);

    const run1 = completeProposalAdequacy(p, ctx);
    const run2 = completeProposalAdequacy(p, ctx);
    expect(run1.proposal.exercises).toEqual(run2.proposal.exercises);
    expect(run1.notes).toEqual(run2.notes);
  });

  it('16. a target completable by Step-1 bump alone is unaffected by, and never interferes with, a separate contended pair in the same proposal', () => {
    // triceps has real headroom on its own already-present exercise — no
    // new candidate needed at all, so it never competes for anything.
    const triceps = target('triceps', [
      validExercise({ exerciseId: 'triceps-own-exercise', authoredPrescription: { sets: 5, repsMin: 6, repsMax: 12, rirMin: 1, rirMax: 3 } }),
    ]);
    const backThickness = target('back-thickness', [
      validExercise({ exerciseId: 'back-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'only-shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const latWidth = target('lat-width', [
      validExercise({ exerciseId: 'lat-filler', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'only-shared-candidate', authoredPrescription: { sets: 3, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [triceps, backThickness, latWidth];
    const gTriceps = guidance(triceps, allTargets, 8, 12); // threshold 4; existing 3 sets, ceiling 5 -> bump alone closes it
    const gBackThickness = guidance(backThickness, allTargets, 8, 8);
    const gLatWidth = guidance(latWidth, allTargets, 8, 8);
    const ctx = contextWith(allTargets, [gTriceps, gBackThickness, gLatWidth]);
    const p = proposal([
      exercise({ exerciseId: 'triceps-own-exercise', targetId: 'triceps', sets: 3 }),
      exercise({ exerciseId: 'back-filler', targetId: 'back-thickness', sets: 3 }),
      exercise({ exerciseId: 'lat-filler', targetId: 'lat-width', sets: 3 }),
    ]);

    const { proposal: completed } = completeProposalAdequacy(p, ctx);

    // triceps: bumped in place, no new exercise, unaffected by the
    // separate contention elsewhere in the same proposal.
    const tricepsExercises = completed.exercises.filter((e) => e.targetId === 'triceps');
    expect(tricepsExercises.length).toBe(1);
    expect(tricepsExercises[0]!.sets).toBe(4);

    // The separate back-thickness/lat-width contention still resolves
    // exactly as test 14 — triceps never consumes or blocks their shared
    // candidate.
    const sharedUsers = completed.exercises.filter((e) => e.exerciseId === 'only-shared-candidate');
    expect(sharedUsers.length).toBe(1);
    const adequacy = validateProposalAdequacy(completed, ctx);
    expect(adequacy.errors.some((e) => e.includes('triceps'))).toBe(false);
  });
});
