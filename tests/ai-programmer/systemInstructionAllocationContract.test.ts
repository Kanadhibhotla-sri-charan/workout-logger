// Correction: the live Tuesday test showed the model treating
// programmingBrief.muscles[].recommendedSessionSets as optional
// guidance (choosing 2-3 sets against a 7-8 set floor) despite an
// earlier rule wording that let the model self-certify any deviation.
// This test proves the system instruction (a) unambiguously
// distinguishes the four distinct numbers (weekly reference vs.
// this-session allocation vs. hard cap vs. total session budget), (b)
// states an explicit, objectively-checkable allocation procedure rather
// than a vague exception, and (c) no longer contains the old
// self-certifiable loophole wording.
//
// Rewritten 2026-09-19 for the sharpened/renumbered rule set (26 rules
// collapsed to 23; dead/redundant list-adherence rules merged; jargon
// trimmed) — same underlying safety properties, updated to match the
// actual current wording rather than the original, more verbose draft.

import { describe, expect, it } from 'vitest';
import { buildProgrammerSystemInstruction } from '../../src/ai-programmer/service/aiProgrammerService.js';

describe('buildProgrammerSystemInstruction — session allocation contract', () => {
  const instruction = buildProgrammerSystemInstruction();

  it('distinguishes all four distinct volume numbers by name', () => {
    expect(instruction).toMatch(/a weekly target/);
    expect(instruction).toMatch(/a number of sets for THIS session/);
    expect(instruction).toMatch(/a hard per-muscle set cap \(directSetsPerExposureCap\)/);
    expect(instruction).toMatch(/a total session set budget \(approxSessionSetBudget\)/);
  });

  it('states recommendedSessionSets is a range to follow, not a suggestion', () => {
    expect(instruction).toMatch(/recommendedSessionSets/);
    expect(instruction).toMatch(/a range, not a suggestion/);
  });

  it('explicitly separates flexible target\\/exercise selection from non-flexible set-count allocation', () => {
    expect(instruction).toMatch(/full freedom over WHICH muscles\/exercises to train/);
    expect(instruction).toMatch(/NO freedom over HOW MANY sets each one gets/);
  });

  it('gives an explicit, ordered allocation procedure (goal muscles first, then maintenance, within-range, budget-exception-only)', () => {
    expect(instruction).toMatch(/Assigning sets, in this exact order/);
    expect(instruction).toMatch(/give each active-goal .* muscle you choose to train a set count within its own recommendedSessionSets/);
    expect(instruction).toMatch(/then give each eligible maintenance/);
    expect(instruction).toMatch(/summing every eligible muscle's own recommendedSessionSets\.min already exceeds approxSessionSetBudget/);
    expect(instruction).toMatch(/cut supporting \(maintenance\) muscles first, before ever taking an active-goal muscle below its own min/);
  });

  it('forbids rounding down toward the bottom of a range without the real budget exception applying', () => {
    expect(instruction).toMatch(/never choose a value near the bottom of a range.*merely because it .seems like a reasonable session./);
    expect(instruction).toMatch(/that is a rules violation unless step \(3\)'s budget exception genuinely applies/);
  });

  it('no longer contains the old self-certifiable escape hatch', () => {
    expect(instruction).not.toMatch(/unless a stated reason \(redundant compound coverage, time budget, or a recovery caution already reflected in recoveryAdjustment\) justifies falling below the min/);
  });

  it('preserves exercise-selection flexibility language', () => {
    expect(instruction).toMatch(/choose freely from it/);
    expect(instruction).toMatch(/validExercises is your complete, closed list of options/);
  });

  it('deload volume reduction is stated as already-final, never to be re-applied by the model', () => {
    expect(instruction).toMatch(/the session number already reflects that reduction — never reduce it again/);
  });
});
