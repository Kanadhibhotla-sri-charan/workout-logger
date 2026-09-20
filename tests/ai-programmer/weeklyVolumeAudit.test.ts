// Whole-week volume audit: shared exercises credit every target they train,
// untagged/unscoped exercises credit the assigned target, and the comparison
// figure is what the week can actually deliver (one leg day cannot deliver a
// reference written for two).

import { describe, expect, it } from 'vitest';
import { auditGoalDeferrals, auditWeeklyVolume, goalBriefVsGenerated, type AuditExercise } from '../../src/ai-programmer/validation/weeklyVolumeAudit.js';
import type { AIProgrammerMuscleGuidance, AIProgrammerTargetContext } from '../../src/ai-programmer/context/programmerContextTypes.js';

function target(targetId: string, goal = false): AIProgrammerTargetContext {
  return { targetType: 'physique_target', targetId, isSpecialization: goal, goalId: goal ? 'g1' : null, validExercises: [] } as unknown as AIProgrammerTargetContext;
}

function ex(exerciseId: string, targetId: string, sets: number): AuditExercise {
  return { exerciseId, targetType: 'physique_target', targetId, sets };
}

const week = (...perDay: AuditExercise[][]) => ({ days: perDay.map((exercises, i) => ({ date: `2026-09-2${i}`, session: { exercises } })) });
const program = (...purposes: Array<string | null>) => purposes.map((sessionPurpose, i) => ({ date: `2026-09-2${i}`, sessionPurpose }));
const rowFor = (audit: ReturnType<typeof auditWeeklyVolume>, id: string) => audit.rows.find((r) => r.targetId === id)!;

describe('auditWeeklyVolume — shared exercise crediting', () => {
  const targets = [target('triceps', true), target('triceps-long-head', true)];

  it('credits an overhead extension to both broad triceps and the long head', () => {
    const audit = auditWeeklyVolume(week([ex('overhead-triceps-extension', 'triceps-long-head', 2)], [ex('overhead-triceps-extension', 'triceps-long-head', 2)]), { targets, existingProgram: program('push', 'upper') });
    expect(rowFor(audit, 'triceps-long-head').generatedDirectSets).toBe(4);
    expect(rowFor(audit, 'triceps').generatedDirectSets).toBe(4);
  });

  it('credits close-grip bench to broad triceps only', () => {
    const audit = auditWeeklyVolume(week([ex('close-grip-bench-press', 'triceps', 3)]), { targets, existingProgram: program('push', 'upper') });
    expect(rowFor(audit, 'triceps').generatedDirectSets).toBe(3);
    expect(rowFor(audit, 'triceps-long-head').generatedDirectSets).toBe(0);
  });

  it('credits an exercise the scope leaves untagged to the target it was assigned to', () => {
    const audit = auditWeeklyVolume(week([ex('lying-leg-curl', 'hamstrings', 2)]), { targets: [target('hamstrings')], existingProgram: program('legs') });
    expect(rowFor(audit, 'hamstrings').generatedDirectSets).toBe(2);
  });
});

describe('auditWeeklyVolume — what the week can actually deliver', () => {
  it('does not report a shortfall for a leg target that has one leg day, when it gets that day\'s full cap', () => {
    const audit = auditWeeklyVolume(week([ex('back-squat', 'quads', 3), ex('leg-press', 'quads', 3), ex('leg-extension', 'quads', 2)]), { targets: [target('quads')], existingProgram: program('push', 'pull', 'legs', 'upper') });
    const row = rowFor(audit, 'quads');
    expect(row.compatibleSessions).toBe(1);
    expect(row.deliverable).toBe(8);
    expect(row.reference).toBeGreaterThan(8);
    expect(row.shortfall).toBe(0);
  });

  it('reports the shortfall against the full reference when the week has two compatible sessions', () => {
    const audit = auditWeeklyVolume(week([ex('back-squat', 'quads', 3)]), { targets: [target('quads')], existingProgram: program('legs', 'legs') });
    const row = rowFor(audit, 'quads');
    expect(row.deliverable).toBe(row.reference);
    expect(row.shortfall).toBe(row.reference - 3);
    expect(audit.normalShortfalls.map((r) => r.targetId)).toContain('quads');
  });

  it('separates goal shortfalls from normal ones', () => {
    const audit = auditWeeklyVolume(week([]), { targets: [target('triceps', true), target('mid-pec')], existingProgram: program('push') });
    expect(audit.goalShortfalls.map((r) => r.targetId)).toEqual(['triceps']);
    expect(audit.normalShortfalls.map((r) => r.targetId)).toEqual(['mid-pec']);
  });
});

describe('auditGoalDeferrals', () => {
  const targets = [target('triceps', true), target('mid-pec')];
  const audit = auditWeeklyVolume(week([]), { targets, existingProgram: program('push') });

  it('flags a short goal target that has no deferral', () => {
    expect(auditGoalDeferrals(audit, [], targets).some((e) => e.includes('goal target triceps is short'))).toBe(true);
  });

  it('accepts a recovery or recent_overexposure deferral', () => {
    expect(auditGoalDeferrals(audit, [{ targetId: 'triceps', reasonCode: 'recovery' }], targets)).toEqual([]);
    expect(auditGoalDeferrals(audit, [{ targetId: 'triceps', reasonCode: 'recent_overexposure' }], targets)).toEqual([]);
  });

  it('rejects a capacity or rotation deferral on a goal target', () => {
    const errors = auditGoalDeferrals(audit, [{ targetId: 'triceps', reasonCode: 'capacity' }], targets);
    expect(errors.some((e) => e.includes('invalid deferral reasonCode capacity'))).toBe(true);
  });

  it('does not require a deferral for a normal-muscle shortfall', () => {
    expect(auditGoalDeferrals(audit, [{ targetId: 'triceps', reasonCode: 'recovery' }], targets)).toEqual([]);
  });
});

describe('goalBriefVsGenerated — did the model miss the brief, or is the audit stricter than the brief?', () => {
  const targets = [target('triceps', true)];
  const brief = (recommendedWeeklyPrimarySets: number, isGoalOriented = true) =>
    [{ targetType: 'physique_target', targetId: 'triceps', isGoalOriented, recommendedWeeklyPrimarySets, recommendedSessionSets: { min: 4, max: 12 }, volumeAction: 'increase', reasoning: 'build-up' } as unknown as AIProgrammerMuscleGuidance];
  // 3 + 2 + 2 = 7 sets on each of two days = 14 total, against a 24-set reference.
  const fourteen = () => week([ex('close-grip-bench-press', 'triceps', 3), ex('overhead-triceps-extension', 'triceps', 2), ex('cable-overhead-extension-leaning-forward', 'triceps', 2)], [ex('close-grip-bench-press', 'triceps', 3), ex('overhead-triceps-extension', 'triceps', 2), ex('cable-overhead-extension-leaning-forward', 'triceps', 2)]);
  const audit = auditWeeklyVolume(fourteen(), { targets, existingProgram: program('push', 'upper') });

  it('meets the brief but not the full reference when the brief asked for a build-up figure', () => {
    const [row] = goalBriefVsGenerated(audit, brief(8));
    expect(row!.generatedDirectSets).toBe(14);
    expect(row!.briefRecommendedWeeklySets).toBe(8);
    expect(row!.weeklyReference).toBe(24);
    expect(row!.verdict).toBe('meets_brief_below_reference');
  });

  it('is below the brief when the brief asked for the full reference and the model gave less', () => {
    expect(goalBriefVsGenerated(audit, brief(24))[0]!.verdict).toBe('below_brief');
  });

  it('meets the reference when the week delivers it', () => {
    const full = auditWeeklyVolume(week([ex('close-grip-bench-press', 'triceps', 12)], [ex('close-grip-bench-press', 'triceps', 12)]), { targets, existingProgram: program('push', 'upper') });
    expect(goalBriefVsGenerated(full, brief(24))[0]!.verdict).toBe('meets_reference');
  });

  it('only reports goal muscles', () => {
    expect(goalBriefVsGenerated(audit, brief(8, false))).toEqual([]);
  });
});
