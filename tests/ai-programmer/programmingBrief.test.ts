// Repair: unit tests for buildProgrammingBrief — the deterministic
// pre-AI programming guidance that closes the gap where AI generation
// independently invented muscle allocation/set counts instead of
// reusing developmentReferenceEngine.ts/volumeEngine.ts. Pure unit
// tests against hand-built AIProgrammerTargetContext/ActiveGoalContext
// fixtures — no DB, no provider — since buildProgrammingBrief itself
// takes only already-shaped context data plus session-purpose input.

import { describe, expect, it } from 'vitest';
import { buildProgrammingBrief } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerActiveGoalContext, AIProgrammerTargetContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import type { RecoveryConstraintResult } from '../../src/engine/recoveryEngine.js';

const TODAY = '2026-09-15';

function recovery(targetId: string, priority_adjustment: RecoveryConstraintResult['priority_adjustment'] = 'none'): RecoveryConstraintResult {
  return { target_type: 'physique_target', target_id: targetId, priority_adjustment, reasoning: 'test fixture', badminton_triggered: false };
}

function target(overrides: Partial<AIProgrammerTargetContext> & Pick<AIProgrammerTargetContext, 'targetId'>): AIProgrammerTargetContext {
  return {
    targetType: 'physique_target',
    displayName: overrides.targetId,
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
    recovery: recovery(overrides.targetId),
    validExercises: [],
    ...overrides,
  };
}

describe('buildProgrammingBrief', () => {
  it('assigns Complete to a goal-oriented (specialization) target and Efficient to a non-goal target, using the real Blueprint packages', () => {
    const goals: AIProgrammerActiveGoalContext[] = [
      { goalId: 'goal-1', goalType: 'aesthetic', blueprintRef: 'triceps-long-head', displayName: 'Triceps depth', priority: 1, reviewCadenceDays: 14, mostRecentAssessment: null },
    ];
    const targets = [
      target({ targetId: 'triceps-long-head', isSpecialization: true, goalId: 'goal-1' }),
      target({ targetId: 'upper-pec', isSpecialization: false }),
    ];

    const brief = buildProgrammingBrief(targets, goals, 'push', [], TODAY, 60);

    const triceps = brief.muscles.find((m) => m.targetId === 'triceps-long-head')!;
    const chest = brief.muscles.find((m) => m.targetId === 'upper-pec')!;
    expect(triceps.developmentLevel).toBe('complete');
    expect(triceps.isGoalOriented).toBe(true);
    expect(chest.developmentLevel).toBe('efficient');
    expect(chest.isGoalOriented).toBe(false);
    // Real Blueprint numbers (src/blueprint/snapshot/programming.json):
    // triceps muscle_group Complete package = 12 sets/session x 2/week = 24.
    expect(triceps.weeklyDevelopmentReference).toBe(24);
    expect(triceps.directSetsPerExposureCap).toBe(12);
    // chest muscle_group Efficient package = 8 sets/session x 2/week = 16.
    expect(chest.weeklyDevelopmentReference).toBe(16);
    expect(chest.directSetsPerExposureCap).toBe(8);
  });

  it('never jumps a zero-volume target straight to its full weekly reference, even when goal-oriented (build-up rule, regardless of priority)', () => {
    const goals: AIProgrammerActiveGoalContext[] = [
      { goalId: 'goal-1', goalType: 'aesthetic', blueprintRef: 'triceps-long-head', displayName: 'Triceps depth', priority: 1, reviewCadenceDays: 14, mostRecentAssessment: null },
    ];
    const targets = [target({ targetId: 'triceps-long-head', isSpecialization: true, goalId: 'goal-1', currentWeeklyPrimarySets: 0 })];

    const brief = buildProgrammingBrief(targets, goals, 'push', [], TODAY, 60);
    const triceps = brief.muscles[0]!;

    expect(triceps.volumeAction).toBe('increase');
    // Universal starting_point_sets[0] = 8, min(8, 24) = 8 — never jumps to 24.
    expect(triceps.recommendedWeeklyPrimarySets).toBe(8);
  });

  it('marks a target incompatible with the session purpose as ineligible, and a compatible one as eligible', () => {
    const targets = [target({ targetId: 'brachialis' }), target({ targetId: 'upper-pec' })];

    const brief = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60);

    expect(brief.muscles.find((m) => m.targetId === 'brachialis')!.eligibleForThisSession).toBe(false);
    expect(brief.muscles.find((m) => m.targetId === 'upper-pec')!.eligibleForThisSession).toBe(true);
  });

  it('treats every target as eligible when the session has no identity (rest/badminton/unselected day)', () => {
    const targets = [target({ targetId: 'brachialis' })];
    const brief = buildProgrammingBrief(targets, [], null, [], TODAY, 60);
    expect(brief.muscles[0]!.eligibleForThisSession).toBe(true);
    expect(brief.session.purpose).toBeNull();
    expect(brief.session.expectedCoverageTargetIds).toEqual([]);
  });

  it('exposes the recoveryEngine result verbatim as recoveryAdjustment', () => {
    const targets = [target({ targetId: 'upper-pec', recovery: recovery('upper-pec', 'reduce') })];
    const brief = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60);
    expect(brief.muscles[0]!.recoveryAdjustment).toBe('reduce');
  });

  it('session.expectedCoverageTargetIds names the real Push targets plus the universal targets', () => {
    const brief = buildProgrammingBrief([], [], 'push', [], TODAY, 60);
    expect(brief.session.expectedCoverageTargetIds).toEqual(
      expect.arrayContaining(['upper-pec', 'mid-pec', 'lower-pec', 'front-delt', 'side-delt', 'triceps', 'triceps-long-head', 'rectus-abdominis'])
    );
    expect(brief.session.expectedCoverageTargetIds).not.toContain('lat-width'); // a Pull target, not Push
  });

  it('scales approxSessionSetBudget down when the deterministic guidance would need more time than the real budget allows', () => {
    const targets = [target({ targetId: 'upper-pec' }), target({ targetId: 'side-delt' }), target({ targetId: 'triceps-long-head' })];
    const briefTightBudget = buildProgrammingBrief(targets, [], 'push', [], TODAY, 10); // 10 real minutes — clearly not enough
    const briefGenerousBudget = buildProgrammingBrief(targets, [], 'push', [], TODAY, 120);
    expect(briefTightBudget.approxSessionSetBudget).toBeLessThan(briefGenerousBudget.approxSessionSetBudget);
  });
});
