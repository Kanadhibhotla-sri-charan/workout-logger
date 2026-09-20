// Eval-only override: tell the model each goal muscle's target for the week is
// its full package reference. Must change only goal muscles and never mutate the
// brief it was given.

import { describe, expect, it } from 'vitest';
import { withGoalReferenceTargets } from '../../src/ai-programmer/context/evalBriefOverrides.js';
import type { AIProgrammerMuscleGuidance, AIProgrammerProgrammingBrief } from '../../src/ai-programmer/context/programmerContextTypes.js';

function muscle(overrides: Partial<AIProgrammerMuscleGuidance> & Pick<AIProgrammerMuscleGuidance, 'targetId'>): AIProgrammerMuscleGuidance {
  return {
    targetType: 'physique_target',
    developmentLevel: 'complete',
    isGoalOriented: true,
    weeklyDevelopmentReference: 24,
    directSetsPerExposureCap: 12,
    currentWeeklyDirectSets: 6,
    currentWeeklySecondarySets: 0,
    volumeAction: 'maintain',
    recommendedWeeklyPrimarySets: 6,
    recommendedSessionSets: { min: 3, max: 12 },
    recoveryAdjustment: 'reduce',
    eligibleForThisSession: true,
    reasoning: 'hold',
    antagonistGroup: null,
    ...overrides,
  };
}

const briefOf = (...muscles: AIProgrammerMuscleGuidance[]): AIProgrammerProgrammingBrief =>
  ({ session: { purpose: null, expectedCoverageTargetIds: [] }, muscles, approxSessionSetBudget: 20 }) as AIProgrammerProgrammingBrief;

describe('withGoalReferenceTargets', () => {
  it('sets a goal muscle to its package reference across the week\'s compatible sessions', () => {
    const out = withGoalReferenceTargets(briefOf(muscle({ targetId: 'triceps' })), ['push', 'pull', 'legs', 'upper']);
    const triceps = out.muscles[0]!;
    expect(triceps.recommendedWeeklyPrimarySets).toBe(24);
    expect(triceps.recommendedSessionSets).toEqual({ min: 12, max: 12 });
    expect(triceps.volumeAction).toBe('increase');
    expect(triceps.reasoning).toContain('EVAL OVERRIDE');
    expect(triceps.reasoning).toContain('hold');
  });

  it('never asks for more than the week can deliver (one leg day cannot deliver a two-session reference)', () => {
    const quads = muscle({ targetId: 'quads', weeklyDevelopmentReference: 16, directSetsPerExposureCap: 8, recommendedWeeklyPrimarySets: 4 });
    const out = withGoalReferenceTargets(briefOf(quads), ['push', 'pull', 'legs', 'upper']);
    expect(out.muscles[0]!.recommendedWeeklyPrimarySets).toBe(8);
    expect(out.muscles[0]!.recommendedSessionSets).toEqual({ min: 8, max: 8 });
  });

  it('leaves non-goal muscles and goal muscles with no reference untouched', () => {
    const normal = muscle({ targetId: 'mid-pec', isGoalOriented: false });
    const noReference = muscle({ targetId: 'adductors', weeklyDevelopmentReference: null, directSetsPerExposureCap: null });
    const out = withGoalReferenceTargets(briefOf(normal, noReference), ['push', 'upper']);
    expect(out.muscles[0]).toEqual(normal);
    expect(out.muscles[1]).toEqual(noReference);
  });

  it('does not mutate the brief it was given', () => {
    const original = briefOf(muscle({ targetId: 'triceps' }));
    withGoalReferenceTargets(original, ['push', 'upper']);
    expect(original.muscles[0]!.recommendedWeeklyPrimarySets).toBe(6);
    expect(original.muscles[0]!.volumeAction).toBe('maintain');
  });
});
