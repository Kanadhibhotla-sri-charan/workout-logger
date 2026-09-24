// Push Generation Architectural Fix (2026-09-24), priority 2: unit tests
// for computeTargetFeasibility — the deterministic "can one exercise
// reach this target's own adequacy floor, and if not, what's the
// smallest real combination that can" calculation. Uses REAL Blueprint
// target ids (side-delt, triceps, triceps-long-head, obliques,
// rectus-abdominis) so sharedCreditWith (backed by creditedTargetKeys,
// real Blueprint sub-target scope data) resolves against real data,
// exactly as it will in production — never a fuzzy or invented
// relationship.

import { describe, expect, it } from 'vitest';
import { computeTargetFeasibility } from '../../src/ai-programmer/context/targetFeasibility.js';
import { UNDER_PRESCRIPTION_TOLERANCE } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import type { AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from '../../src/ai-programmer/context/programmerContextTypes.js';

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

function target(
  targetId: string,
  validExercises: readonly AIProgrammerValidExerciseContext[],
  overrides: Partial<AIProgrammerTargetContext> = {}
): AIProgrammerTargetContext {
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

describe('computeTargetFeasibility', () => {
  describe('side-delt (real Blueprint data: 3 authored candidates, no single one clears a 7-set floor at 50%)', () => {
    const sideDelt = target('side-delt', [
      validExercise({ exerciseId: 'cable-lateral-raise', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'dumbbell-lateral-raise', authoredPrescription: { sets: 3, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'machine-lateral-raise', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [sideDelt];

    it('reports that its single best candidate (3 sets) cannot alone reach the 3.5-set adequacy threshold for a 7-set floor', () => {
      const result = computeTargetFeasibility(sideDelt, allTargets, 7, 7, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.adequacyThreshold).toBe(3.5);
      expect(result.singleExerciseSufficient).toBe(false);
    });

    it('reports a real, feasible 2-exercise combination that clears the threshold, drawn only from real candidates', () => {
      const result = computeTargetFeasibility(sideDelt, allTargets, 7, 7, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.isFeasible).toBe(true);
      expect(result.minimumExerciseCount).toBe(2);
      expect(result.feasibleCombinations).toHaveLength(1);
      const combo = result.feasibleCombinations[0]!;
      expect(combo).toHaveLength(2);
      for (const id of combo) {
        expect(['cable-lateral-raise', 'dumbbell-lateral-raise', 'machine-lateral-raise']).toContain(id);
      }
      // The combination genuinely reaches the ceiling sum >= 3.5 (best two: 3+2=5).
    });
  });

  describe('triceps-long-head (real Blueprint data: a single 2-set candidate clears a 4-set floor at 50%)', () => {
    const tricepsLongHead = target('triceps-long-head', [
      validExercise({ exerciseId: 'cable-overhead-extension-leaning-forward', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'overhead-triceps-extension', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [tricepsLongHead];

    it('reports that a single candidate (2 sets) already clears the 2-set adequacy threshold for a 4-set floor', () => {
      const result = computeTargetFeasibility(tricepsLongHead, allTargets, 4, 4, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.adequacyThreshold).toBe(2);
      expect(result.singleExerciseSufficient).toBe(true);
      expect(result.minimumExerciseCount).toBe(1);
      expect(result.isFeasible).toBe(true);
    });
  });

  describe('shared credit (real Blueprint sub-target scope — triceps/triceps-long-head genuinely share exercises)', () => {
    it('reports triceps-long-head as sharedCreditWith triceps, via the exact real exerciseId/package relationship (never inferred)', () => {
      const tricepsLongHead = target('triceps-long-head', [
        validExercise({ exerciseId: 'overhead-triceps-extension', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      ]);
      const triceps = target('triceps', [
        validExercise({ exerciseId: 'overhead-triceps-extension', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
        validExercise({ exerciseId: 'cable-pushdown', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      ]);
      const allTargets = [triceps, tricepsLongHead];

      const result = computeTargetFeasibility(tricepsLongHead, allTargets, 4, 4, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.sharedCreditWith).toEqual(['physique_target:triceps']);
    });

    it('does NOT report a shared-credit relationship for a target whose only candidate is exclusive to it (cable-pushdown is triceps-only, never long-head)', () => {
      const triceps = target('triceps', [validExercise({ exerciseId: 'cable-pushdown', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } })]);
      const tricepsLongHead = target('triceps-long-head', []);
      const allTargets = [triceps, tricepsLongHead];

      const result = computeTargetFeasibility(triceps, allTargets, 6, 12, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.sharedCreditWith).toEqual([]);
    });
  });

  describe('obliques and rectus-abdominis (documented real finding: NO shared Blueprint sub-target scope entry exists today)', () => {
    // Real Blueprint core-package candidates, per each exercise's own
    // authored contribution text (see sharedCredit.ts's own header
    // comment): none of them are scoped to BOTH targets — cable-crunch/
    // hanging-knee-leg-raise are rectus-abdominis-specific text,
    // pallof-press/cable-woodchop are oblique-specific text. Since the
    // `core` muscle_group has no entry in SUB_TARGET_EXERCISE_SCOPE at
    // all today, creditedTargetKeys credits every one of them only to
    // whichever target it's literally assigned to.
    const obliques = target('obliques', [
      validExercise({ exerciseId: 'cable-crunch', authoredPrescription: { sets: 3, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'cable-woodchop', authoredPrescription: { sets: 2, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'pallof-press', authoredPrescription: { sets: 2, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
    ]);
    const rectusAbdominis = target('rectus-abdominis', [
      validExercise({ exerciseId: 'cable-crunch', authoredPrescription: { sets: 3, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'hanging-knee-leg-raise', authoredPrescription: { sets: 3, repsMin: 9, repsMax: 15, rirMin: 1, rirMax: 3 } }),
    ]);
    const allTargets = [obliques, rectusAbdominis];

    it('each target independently has a real, feasible 2-exercise combination using only its own candidates', () => {
      const obliquesResult = computeTargetFeasibility(obliques, allTargets, 8, 8, UNDER_PRESCRIPTION_TOLERANCE);
      const rectusResult = computeTargetFeasibility(rectusAbdominis, allTargets, 8, 8, UNDER_PRESCRIPTION_TOLERANCE);
      expect(obliquesResult.isFeasible).toBe(true);
      expect(obliquesResult.minimumExerciseCount).toBe(2);
      expect(rectusResult.isFeasible).toBe(true);
      expect(rectusResult.minimumExerciseCount).toBe(2);
    });

    it('documents that neither target reports the other as sharedCreditWith — real Blueprint data shows no overlap, never inferred from physiological similarity', () => {
      const obliquesResult = computeTargetFeasibility(obliques, allTargets, 8, 8, UNDER_PRESCRIPTION_TOLERANCE);
      const rectusResult = computeTargetFeasibility(rectusAbdominis, allTargets, 8, 8, UNDER_PRESCRIPTION_TOLERANCE);
      expect(obliquesResult.sharedCreditWith).toEqual([]);
      expect(rectusResult.sharedCreditWith).toEqual([]);
    });

    // This is exactly why programmerContextBuilder.ts's own
    // feasibilityWarnings surfaces the real collision this creates
    // (2+2=4 exercises needed, but ABS_SESSION_EXERCISE_SHARE_MAX caps
    // the whole session's abs work at 2) — see
    // programmerContextBuilder.test.ts for that integration-level check.
    it('ABS_SESSION_EXERCISE_SHARE_MAX itself is untouched by this fix — still 2', async () => {
      const { ABS_SESSION_EXERCISE_SHARE_MAX } = await import('../../src/engine/config.js');
      expect(ABS_SESSION_EXERCISE_SHARE_MAX).toBe(2);
    });
  });

  describe('a target with no feasible combination at all', () => {
    it('reports isFeasible: false and minimumExerciseCount: null explicitly, rather than inventing a combination', () => {
      const hopeless = target('side-delt', [
        validExercise({ exerciseId: 'cable-lateral-raise', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      ]);
      // A floor far beyond anything this target's one real candidate
      // (capped at 2 by directSetsPerExposureCap) could ever reach, even
      // alone — genuinely infeasible under real data.
      const result = computeTargetFeasibility(hopeless, [hopeless], 20, 2, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.isFeasible).toBe(false);
      expect(result.minimumExerciseCount).toBeNull();
      expect(result.feasibleCombinations).toEqual([]);
    });

    it('a target with zero real candidates at all is infeasible for any positive threshold', () => {
      const noCandidates = target('some-target', []);
      const result = computeTargetFeasibility(noCandidates, [noCandidates], 8, 8, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.isFeasible).toBe(false);
      expect(result.minimumExerciseCount).toBeNull();
    });
  });

  it('a target with recommendedMinimum 0 (e.g. an ineligible or unassessed target) is trivially feasible with zero exercises', () => {
    const t = target('side-delt', []);
    const result = computeTargetFeasibility(t, [t], 0, 7, UNDER_PRESCRIPTION_TOLERANCE);
    expect(result.isFeasible).toBe(true);
    expect(result.minimumExerciseCount).toBe(0);
    expect(result.adequacyThreshold).toBe(0);
  });

  // UPDATED (Feasibility/Completion Consistency Fix, 2026-09-24): an
  // unauthored candidate's generic application-default ceiling used to
  // count toward feasibility — but deterministic completion can never
  // legally add an unauthored candidate (it would require inventing a
  // rep/RIR range), so a target whose ONLY real candidate is unauthored
  // must now be reported infeasible, never feasible-in-name-only.
  it('an unauthored candidate NEVER counts toward feasibility — completion could never legally act on it', () => {
    const t = target('some-outside-target', [validExercise({ exerciseId: 'some-unauthored-exercise' })]);
    const result = computeTargetFeasibility(t, [t], 6, null, UNDER_PRESCRIPTION_TOLERANCE);
    expect(result.singleExerciseSufficient).toBe(false);
    expect(result.isFeasible).toBe(false);
    expect(result.minimumExerciseCount).toBeNull();
    expect(result.feasibleCombinations).toEqual([]);
  });

  // The exact Pull upper-traps scenario, reproduced with real Blueprint
  // data: only one authored candidate (barbell-dumbbell-shrug, ceiling
  // 2), already used at its own ceiling by the AI's proposal, plus
  // several unauthored candidates whose generic ceiling would
  // technically clear the threshold if completion were allowed to use
  // them (it is not, permanently). Feasibility must now say the
  // completion-feasible universe cannot close this target.
  describe('the exact Pull upper-traps scenario (real Blueprint data)', () => {
    const upperTraps = target('upper-traps', [
      validExercise({ exerciseId: 'barbell-dumbbell-shrug', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'conventional-deadlift' }), // unauthored
      validExercise({ exerciseId: 'farmers-carry' }), // unauthored
      validExercise({ exerciseId: 'rack-pull' }), // unauthored
      validExercise({ exerciseId: 'sumo-deadlift' }), // unauthored
    ]);
    const allTargets = [upperTraps];

    it('reports isFeasible: false — the only authored candidate (ceiling 2) alone cannot clear a 4-set threshold, and no unauthored candidate may be used to close the rest', () => {
      const result = computeTargetFeasibility(upperTraps, allTargets, 8, 8, UNDER_PRESCRIPTION_TOLERANCE);
      expect(result.adequacyThreshold).toBe(4);
      expect(result.singleExerciseSufficient).toBe(false);
      expect(result.isFeasible).toBe(false);
      expect(result.minimumExerciseCount).toBeNull();
      expect(result.feasibleCombinations).toEqual([]);
      // None of the unauthored candidates ever appear in a reported
      // combination — there is none to report.
      for (const combo of result.feasibleCombinations) {
        expect(combo).not.toContain('conventional-deadlift');
      }
    });

    it('completion remains a no-op for this exact scenario — the existing adequacy failure is preserved, never forced', async () => {
      const { completeProposalAdequacy } = await import('../../src/ai-programmer/validation/programmerAdequacyCompletion.js');
      const { validateProposalAdequacy, UNDER_PRESCRIPTION_TOLERANCE: tol } = await import('../../src/ai-programmer/validation/programmerAdequacyValidator.js');
      const guidance = {
        targetType: 'physique_target' as const,
        targetId: 'upper-traps',
        developmentLevel: 'efficient' as const,
        isGoalOriented: false,
        weeklyDevelopmentReference: 16,
        directSetsPerExposureCap: 8,
        currentWeeklyDirectSets: 0,
        currentWeeklySecondarySets: 0,
        volumeAction: 'increase' as const,
        recommendedWeeklyPrimarySets: 8,
        recommendedSessionSets: { min: 8, max: 8 },
        recoveryAdjustment: 'none' as const,
        eligibleForThisSession: true,
        reasoning: 'test fixture',
        antagonistGroup: 'pull' as const,
        feasibility: computeTargetFeasibility(upperTraps, allTargets, 8, 8, tol),
      };
      const context = {
        targets: allTargets,
        programmingBrief: {
          session: { purpose: 'pull', expectedCoverageTargetIds: ['upper-traps'] },
          muscles: [guidance],
          approxSessionSetBudget: 20,
          feasibilityWarnings: [],
        },
      } as unknown as Parameters<typeof completeProposalAdequacy>[1];
      const proposal = {
        schemaVersion: 'ai-workout-session-proposal.v1' as const,
        proposalId: 'p-1',
        mode: 'generate_session' as const,
        targetDate: '2026-10-02',
        weekday: 'friday',
        sessionFocus: ['pull'],
        exercises: [
          {
            exerciseId: 'barbell-dumbbell-shrug',
            role: 'primary' as const,
            targetType: 'physique_target' as const,
            targetId: 'upper-traps',
            sets: 2,
            repsMin: 10,
            repsMax: 20,
            rirMin: 1,
            rirMax: 3,
            rationale: ['test'],
            source: 'blueprint' as const,
          },
        ],
        programmingRationale: [],
        goalAlignment: [],
        recoveryConsiderations: [],
        warnings: [],
      };

      const { proposal: completed, notes } = completeProposalAdequacy(proposal, context);
      expect(notes).toEqual([]);
      expect(completed).toBe(proposal); // genuine no-op
      const adequacy = validateProposalAdequacy(completed, context);
      expect(adequacy.ok).toBe(false);
      expect(adequacy.errors.some((e) => e.includes('upper-traps') && e.includes('inadequate'))).toBe(true);
    });
  });

  // Regression test (per explicit request): an authored candidate that
  // CAN actually complete the target still reports isFeasible: true and
  // remains usable by completion — the fix above must never make a
  // genuinely-feasible authored-only target look infeasible.
  it('regression: a target with a real, sufficient AUTHORED candidate still reports isFeasible: true', () => {
    const sideDelt = target('side-delt', [
      validExercise({ exerciseId: 'cable-lateral-raise', authoredPrescription: { sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'dumbbell-lateral-raise', authoredPrescription: { sets: 3, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
      validExercise({ exerciseId: 'machine-lateral-raise', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3 } }),
    ]);
    const result = computeTargetFeasibility(sideDelt, [sideDelt], 7, 7, UNDER_PRESCRIPTION_TOLERANCE);
    expect(result.isFeasible).toBe(true);
    expect(result.minimumExerciseCount).toBe(2);
    expect(result.feasibleCombinations[0]).toBeDefined();
    for (const id of result.feasibleCombinations[0]!) {
      expect(['cable-lateral-raise', 'dumbbell-lateral-raise', 'machine-lateral-raise']).toContain(id);
    }
  });
});
