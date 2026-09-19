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
import { applyDeloadSetVolumeReduction } from '../../src/coaching/periodization/deloadPolicy.js';

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
    // Real Blueprint numbers (src/blueprint/snapshot/programming.json),
    // under Sub-Target Exercise Scope (2026-09-19): 'triceps-long-head'
    // and 'upper-pec' each share their muscle_group's package with
    // sibling target_ids, so they're credited only with the exercises
    // that actually train them (per each exercise's own contribution
    // text), not the whole shared package.
    // triceps-long-head Complete: overhead-triceps-extension(2) +
    // cable-overhead-extension-leaning-forward(2) = 4 sets/session x
    // 2/week = 8.
    expect(triceps.weeklyDevelopmentReference).toBe(8);
    expect(triceps.directSetsPerExposureCap).toBe(4);
    // upper-pec Efficient: incline-barbell-press(3) + cable-fly(2) =
    // 5 sets/session x 2/week = 10.
    expect(chest.weeklyDevelopmentReference).toBe(10);
    expect(chest.directSetsPerExposureCap).toBe(5);
  });

  it('never jumps a zero-volume target straight to its full weekly reference, even when goal-oriented (build-up rule, regardless of priority)', () => {
    const goals: AIProgrammerActiveGoalContext[] = [
      { goalId: 'goal-1', goalType: 'aesthetic', blueprintRef: 'triceps-long-head', displayName: 'Triceps depth', priority: 1, reviewCadenceDays: 14, mostRecentAssessment: null },
    ];
    const targets = [target({ targetId: 'triceps-long-head', isSpecialization: true, goalId: 'goal-1', currentWeeklyPrimarySets: 0 })];

    const brief = buildProgrammingBrief(targets, goals, 'push', [], TODAY, 60);
    const triceps = brief.muscles[0]!;

    expect(triceps.volumeAction).toBe('increase');
    // Universal starting_point_sets[0] = 8. Under Sub-Target Exercise
    // Scope (2026-09-19), triceps-long-head's own Complete reference is
    // also 8 (see the test above) — min(8, 8) = 8 either way, but this
    // still proves the build-up rule genuinely runs (never jumps straight
    // to a package figure without going through the universal starting
    // point's own min()).
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

  // Fix: previously buildProgrammingBrief never applied deload's
  // set-volume reduction at all — the AI received the full, non-deload
  // number and was left to guess its own reduction (see the RIR-drift
  // and back-omission incidents this fixes). recommendedWeeklyPrimarySets/
  // recommendedSessionSets must now already reflect an active deload,
  // via the exact same applyDeloadSetVolumeReduction the deterministic
  // engine itself uses — never a second, independently-derived formula.
  describe('deload set-volume reduction (Fix: coaching judgment vs. deterministic reliability)', () => {
    it('defaults to no reduction when periodization is omitted (backward compatible with every existing call site)', () => {
      const targets = [target({ targetId: 'triceps-long-head', isSpecialization: true, currentWeeklyPrimarySets: 0 })];
      const brief = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60);
      expect(brief.muscles[0]!.recommendedWeeklyPrimarySets).toBe(8); // build-up rule, unreduced
    });

    it('reduces recommendedWeeklyPrimarySets by the exact real deload formula when deloadActive is true', () => {
      const targets = [target({ targetId: 'triceps-long-head', isSpecialization: true, currentWeeklyPrimarySets: 0 })];
      const brief = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60, { deloadActive: true });
      // 8 is the real, unreduced build-up value (see the sibling test
      // above) — this asserts against applyDeloadSetVolumeReduction
      // itself, never a hand-derived expected number, so this test can
      // never silently drift from the real deload policy.
      expect(brief.muscles[0]!.recommendedWeeklyPrimarySets).toBe(applyDeloadSetVolumeReduction(8));
    });

    it('recommendedSessionSets itself also reflects the deload reduction, not just recommendedWeeklyPrimarySets', () => {
      // Sub-Target Exercise Scope (2026-09-19): triceps-long-head's own
      // directSetsPerExposureCap dropped from 12 to 4 (see the first
      // describe block above), so a currentWeeklyPrimarySets fixture
      // large enough to clear the OLD cap (20) now clamps BOTH normal and
      // deloaded .min to the same new, much smaller ceiling (4),
      // hiding the reduction this test exists to prove. Re-derived to a
      // smaller, still-realistic weekly figure (5) that stays under the
      // new cap on the un-deloaded side, so the deload's own proportional
      // reduction is what actually moves .min, not the ceiling.
      const targets = [target({ targetId: 'triceps-long-head', isSpecialization: true, currentWeeklyPrimarySets: 5 })];
      const normal = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60);
      const deloaded = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60, { deloadActive: true });
      const normalMuscle = normal.muscles[0]!;
      const deloadedMuscle = deloaded.muscles[0]!;
      expect(deloadedMuscle.recommendedSessionSets.min).toBeLessThan(normalMuscle.recommendedSessionSets.min);
    });

    it('never reduces below 1, matching applyDeloadSetVolumeReduction\'s own floor', () => {
      const targets = [target({ targetId: 'triceps-long-head', isSpecialization: true, currentWeeklyPrimarySets: 1 })];
      const brief = buildProgrammingBrief(targets, [], 'push', [], TODAY, 60, { deloadActive: true });
      expect(brief.muscles[0]!.recommendedWeeklyPrimarySets).toBeGreaterThanOrEqual(1);
    });
  });
});
