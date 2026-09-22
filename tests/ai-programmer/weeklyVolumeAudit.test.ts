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
  const shortfall = rowFor(audit, 'triceps').shortfall;

  // Case 1: target fully met, no deferral -> PASS.
  it('needs no deferral when the goal target is fully met (all 5 triceps exercises at full sets, both sessions)', () => {
    const fullSession = [
      ex('close-grip-bench-press', 'triceps', 3),
      ex('dip-triceps-biased', 'triceps', 3),
      ex('overhead-triceps-extension', 'triceps', 2),
      ex('cable-pushdown', 'triceps', 2),
      ex('cable-overhead-extension-leaning-forward', 'triceps', 2),
    ];
    const metAudit = auditWeeklyVolume(week(fullSession, fullSession), { targets: [target('triceps', true)], existingProgram: program('push', 'upper') });
    expect(rowFor(metAudit, 'triceps').shortfall).toBe(0);
    expect(auditGoalDeferrals(metAudit, [], [target('triceps', true)])).toEqual([]);
  });

  // Case 2: short, no deferral -> FAIL.
  it('flags a short goal target that has no deferral', () => {
    expect(shortfall).toBeGreaterThan(0);
    expect(auditGoalDeferrals(audit, [], targets).some((e) => e.includes('goal target triceps is short'))).toBe(true);
  });

  // Case 3: short, deferral declares unmetSets 0 -> FAIL (never silently corrected to the real figure).
  it('rejects a deferral that declares zero unmetSets for a real shortfall', () => {
    const errors = auditGoalDeferrals(audit, [{ targetId: 'triceps', unmetSets: 0, reasonCode: 'recovery' }], targets);
    expect(errors.some((e) => e.includes('unmetSets 0'))).toBe(true);
    expect(errors.some((e) => e.includes('goal target triceps is short'))).toBe(false); // a deferral record does exist; the failure is its dishonest value, not its absence
  });

  // Case 4: short, deferral declares the exact audited shortfall, valid reason -> PASS.
  it('accepts a recovery or recent_overexposure deferral whose declared unmetSets matches the audit exactly', () => {
    expect(auditGoalDeferrals(audit, [{ targetId: 'triceps', unmetSets: shortfall, reasonCode: 'recovery' }], targets)).toEqual([]);
    expect(auditGoalDeferrals(audit, [{ targetId: 'triceps', unmetSets: shortfall, reasonCode: 'recent_overexposure' }], targets)).toEqual([]);
  });

  // Case 5: short, deferral declares a smaller-than-real shortfall, valid reason -> FAIL.
  it('rejects a deferral whose declared unmetSets is smaller than the audited shortfall', () => {
    const errors = auditGoalDeferrals(audit, [{ targetId: 'triceps', unmetSets: Math.max(1, shortfall - 1), reasonCode: 'recovery' }], targets);
    expect(errors.some((e) => e.includes('the declared shortfall must match the audited one exactly'))).toBe(true);
  });

  it('rejects a capacity or rotation deferral on a goal target even when unmetSets matches', () => {
    const errors = auditGoalDeferrals(audit, [{ targetId: 'triceps', unmetSets: shortfall, reasonCode: 'capacity' }], targets);
    expect(errors.some((e) => e.includes('invalid deferral reasonCode capacity'))).toBe(true);
  });

  // Case 6: multiple active goals, each checked independently.
  it('checks each active goal independently', () => {
    const twoGoals = [target('triceps', true), target('triceps-long-head', true)];
    const twoAudit = auditWeeklyVolume(week([]), { targets: twoGoals, existingProgram: program('push', 'upper') });
    const tricepsShort = rowFor(twoAudit, 'triceps').shortfall;
    const longHeadShort = rowFor(twoAudit, 'triceps-long-head').shortfall;
    expect(longHeadShort).toBeGreaterThan(0);
    const errors = auditGoalDeferrals(twoAudit, [{ targetId: 'triceps', unmetSets: tricepsShort, reasonCode: 'recovery' }], twoGoals);
    expect(errors.some((e) => e.includes('goal target triceps-long-head is short'))).toBe(true); // no deferral of its own
    expect(errors.some((e) => e.includes('goal target triceps is short'))).toBe(false); // its own deferral was truthful
  });

  // Case 7: a shared exercise credits every target it trains, and each target's
  // declared deferral is checked against its own (correctly shared) shortfall.
  it('validates a shared exercise\'s credit consistently across every target it trains', () => {
    const twoGoals = [target('triceps', true), target('triceps-long-head', true)];
    const sharedWeek = week([ex('overhead-triceps-extension', 'triceps-long-head', 2)], [ex('overhead-triceps-extension', 'triceps-long-head', 2)]);
    const sharedAudit = auditWeeklyVolume(sharedWeek, { targets: twoGoals, existingProgram: program('push', 'upper') });
    const tricepsRow = rowFor(sharedAudit, 'triceps');
    const longHeadRow = rowFor(sharedAudit, 'triceps-long-head');
    expect(tricepsRow.generatedDirectSets).toBe(4); // credited via the shared exercise, same as triceps-long-head
    expect(longHeadRow.generatedDirectSets).toBe(4);
    const errors = auditGoalDeferrals(
      sharedAudit,
      [
        { targetId: 'triceps', unmetSets: tricepsRow.shortfall, reasonCode: 'recovery' },
        { targetId: 'triceps-long-head', unmetSets: longHeadRow.shortfall, reasonCode: 'recovery' },
      ],
      twoGoals
    );
    expect(errors).toEqual([]);
  });

  it('does not require a deferral for a normal-muscle shortfall', () => {
    expect(auditGoalDeferrals(audit, [{ targetId: 'triceps', unmetSets: shortfall, reasonCode: 'recovery' }], targets)).toEqual([]);
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

describe('auditWeeklyVolume — the requirement is the brief the model was given', () => {
  const targets = [target('triceps', true)];
  const briefOf = (recommendedWeeklyPrimarySets: number) => ({ muscles: [{ targetType: 'physique_target', targetId: 'triceps', recommendedWeeklyPrimarySets }] });
  const fourteen = week(
    [ex('close-grip-bench-press', 'triceps', 3), ex('overhead-triceps-extension', 'triceps', 2), ex('cable-overhead-extension-leaning-forward', 'triceps', 2)],
    [ex('close-grip-bench-press', 'triceps', 3), ex('overhead-triceps-extension', 'triceps', 2), ex('cable-overhead-extension-leaning-forward', 'triceps', 2)]
  );
  const audit = (recommended: number | null) =>
    auditWeeklyVolume(fourteen, { targets, existingProgram: program('push', 'upper'), ...(recommended === null ? {} : { programmingBrief: briefOf(recommended) }) });

  it('a week that exceeds a hold-current brief (14 vs 6) has no shortfall, even though the full reference is 24', () => {
    const result = audit(6);
    const row = rowFor(result, 'triceps');
    expect(row.reference).toBe(24);
    expect(row.required).toBe(6);
    expect(row.shortfall).toBe(0);
    expect(result.goalShortfalls).toEqual([]);
  });

  it('still fails a goal week that gives less than the brief asked for', () => {
    const result = audit(24);
    expect(rowFor(result, 'triceps').shortfall).toBe(10);
    expect(result.goalShortfalls.map((r) => r.targetId)).toEqual(['triceps']);
  });

  it('never requires more than the week can deliver, even when the brief asks for more', () => {
    const result = auditWeeklyVolume(week([]), { targets: [target('quads')], existingProgram: program('legs'), programmingBrief: { muscles: [{ targetType: 'physique_target', targetId: 'quads', recommendedWeeklyPrimarySets: 99 }] } });
    expect(rowFor(result, 'quads').required).toBe(rowFor(result, 'quads').deliverable);
  });

  it('falls back to the deliverable figure when no brief is supplied', () => {
    const row = rowFor(audit(null), 'triceps');
    expect(row.briefRecommendedWeeklySets).toBeNull();
    expect(row.required).toBe(row.deliverable);
  });
});
