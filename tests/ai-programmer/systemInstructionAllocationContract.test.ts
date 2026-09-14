// Correction: the live Tuesday test showed the model treating
// programmingBrief.muscles[].recommendedSessionSets as optional
// guidance (choosing 2-3 sets against a 7-8 set floor) despite rule 13
// telling it to "keep sets within recommendedSessionSets... unless a
// stated reason... justifies falling below the min" — that escape
// hatch let the model self-certify any deviation. This test proves the
// corrected system instruction (a) unambiguously distinguishes the four
// distinct numbers (weekly reference vs. this-session allocation vs.
// hard cap vs. total session budget), (b) states an explicit,
// objectively-checkable allocation procedure rather than a vague
// exception, and (c) no longer contains the old self-certifiable
// loophole wording.

import { describe, expect, it } from 'vitest';
import { buildProgrammerSystemInstruction } from '../../src/ai-programmer/service/aiProgrammerService.js';

describe('buildProgrammerSystemInstruction — session allocation contract', () => {
  const instruction = buildProgrammerSystemInstruction();

  it('distinguishes weeklyDevelopmentReference as a WEEKLY figure, not this session\'s number', () => {
    expect(instruction).toMatch(/weeklyDevelopmentReference is that target's WEEKLY volume reference/);
    expect(instruction).toMatch(/a weekly total, not this session's number/);
  });

  it('states recommendedSessionSets is deterministic allocation for THIS session, not a suggestion', () => {
    expect(instruction).toMatch(/recommendedSessionSets \{min, max\} is the deterministic number of sets THIS target must receive IN THIS SESSION/);
    expect(instruction).toMatch(/this is the number you follow, not a suggestion/);
  });

  it('states directSetsPerExposureCap is a hard ceiling, never exceeded', () => {
    expect(instruction).toMatch(/directSetsPerExposureCap is the hard per-session ceiling.*never exceed it under any circumstance/);
  });

  it('states approxSessionSetBudget is the total session-wide working-set budget', () => {
    expect(instruction).toMatch(/approxSessionSetBudget is the total working-set budget for the WHOLE session/);
  });

  it('explicitly separates flexible target/exercise selection from non-flexible set-count allocation', () => {
    expect(instruction).toMatch(/WHICH targets\/exercises to train is fully flexible/);
    expect(instruction).toMatch(/HOW MANY sets each target you choose to train receives is NOT flexible/);
  });

  it('gives an explicit, ordered allocation procedure (goal targets first, then maintenance, within-range, budget-exception-only)', () => {
    expect(instruction).toMatch(/Allocation procedure, followed in this exact order/);
    expect(instruction).toMatch(/first choose which active-goal .* targets to train/);
    expect(instruction).toMatch(/Then choose eligible maintenance/);
    expect(instruction).toMatch(/summing every eligible target's own recommendedSessionSets\.min already exceeds approxSessionSetBudget/);
    expect(instruction).toMatch(/reduce or drop eligible maintenance .* targets FIRST, before ever taking an eligible active-goal .* target below its own min/);
  });

  it('names the exact failure pattern observed live as a rules violation (2-3 sets against a 7-8 set floor)', () => {
    expect(instruction).toMatch(/choosing 2-3 sets for a target whose min is 7-8 is a rules violation/);
  });

  it('no longer contains the old self-certifiable escape hatch', () => {
    expect(instruction).not.toMatch(/unless a stated reason \(redundant compound coverage, time budget, or a recovery caution already reflected in recoveryAdjustment\) justifies falling below the min/);
  });

  it('preserves exercise-selection flexibility language (rule 6/7/16 untouched in spirit)', () => {
    expect(instruction).toMatch(/Never copy an Efficient\/Complete package's exercise list verbatim/);
    expect(instruction).toMatch(/choose freely from validExercises/);
  });
});
