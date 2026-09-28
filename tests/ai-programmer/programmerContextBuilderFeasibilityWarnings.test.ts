// Push Generation Architectural Fix (2026-09-24), priority 2: unit tests
// for buildProgrammingBrief's own feasibilityWarnings — the real,
// session-wide collision check for two ABS_PHYSIQUE_TARGETS that each
// need >=2 of their own exercises to individually clear their own
// adequacy floor, but together share a real session-wide exercise-count
// cap (ABS_SESSION_EXERCISE_SHARE_MAX) smaller than their combined need.
// Uses buildProgrammingBrief directly (a pure function over real
// AIProgrammerTargetContext fixtures) rather than standing up a full DB,
// since this check depends only on its own arguments plus real Blueprint
// data (developmentReferenceEngine/subTargetExerciseScope), both of
// which this test exercises for real.

import { describe, expect, it } from 'vitest';
import { buildProgrammingBrief } from '../../src/ai-programmer/context/programmerContextBuilder.js';
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

function target(targetId: string, validExercises: readonly AIProgrammerValidExerciseContext[]): AIProgrammerTargetContext {
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
  } as AIProgrammerTargetContext;
}

// Real Blueprint core-package candidates (see targetFeasibility.test.ts's
// own header comment for why none is shared between the two targets).
const obliques = target('obliques', [
  validExercise({ exerciseId: 'cable-crunch', authoredPrescription: { sets: 3, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
  validExercise({ exerciseId: 'cable-woodchop', authoredPrescription: { sets: 2, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
  validExercise({ exerciseId: 'pallof-press', authoredPrescription: { sets: 2, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
]);
const rectusAbdominis = target('rectus-abdominis', [
  validExercise({ exerciseId: 'cable-crunch', authoredPrescription: { sets: 3, repsMin: 14, repsMax: 20, rirMin: 1, rirMax: 3 } }),
  validExercise({ exerciseId: 'hanging-knee-leg-raise', authoredPrescription: { sets: 3, repsMin: 9, repsMax: 15, rirMin: 1, rirMax: 3 } }),
]);

describe('buildProgrammingBrief — feasibilityWarnings (Push Generation Architectural Fix, priority 2)', () => {
  it('flags the real obliques/rectus-abdominis collision on a Push session: both eligible, both independently need >=2 exercises, but the shared abs cap is only 2', () => {
    const brief = buildProgrammingBrief([obliques, rectusAbdominis], [], 'push', [], '2026-09-28', 60);
    expect(brief.feasibilityWarnings!.length).toBeGreaterThan(0);
    const warning = brief.feasibilityWarnings!.find((w) => w.includes('obliques') && w.includes('rectus-abdominis'));
    expect(warning).toBeDefined();
    expect(warning).toContain('abs-exercise cap allows only 2 total');
  });

  it('does not flag anything on a legs-purpose session — the leg+abs exception is a separate, already-existing rule', () => {
    const brief = buildProgrammingBrief([obliques, rectusAbdominis], [], 'legs', [], '2026-09-28', 60);
    expect(brief.feasibilityWarnings).toEqual([]);
  });

  it('does not flag anything when only one of the two abs targets is present', () => {
    const brief = buildProgrammingBrief([obliques], [], 'push', [], '2026-09-28', 60);
    expect(brief.feasibilityWarnings).toEqual([]);
  });

  it('every muscle entry carries a real feasibility object (not undefined) from the real construction path', () => {
    const brief = buildProgrammingBrief([obliques, rectusAbdominis], [], 'push', [], '2026-09-28', 60);
    for (const m of brief.muscles) {
      expect(m.feasibility).toBeDefined();
      expect(typeof m.feasibility!.isFeasible).toBe('boolean');
    }
  });
});
