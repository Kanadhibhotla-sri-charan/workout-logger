// Whole-week volume audit: shared exercises credit every target they train,
// untagged/unscoped exercises credit the assigned target, and the comparison
// figure is what the week can actually deliver (one leg day cannot deliver a
// reference written for two).

import { describe, expect, it } from 'vitest';
import { auditGoalDeferrals, auditWeeklyVolume, type AuditExercise } from '../../src/ai-programmer/validation/weeklyVolumeAudit.js';
import type { AIProgrammerTargetContext } from '../../src/ai-programmer/context/programmerContextTypes.js';

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
