// Production-impact review (log 69) + parent/sub-target analysis (log 71):
// Qwen was never told that a set assigned to a specific sub-target (e.g.
// triceps-long-head) is also credited toward a broader parent target
// (triceps) — leading it to treat the smaller sub-target as effectively
// discharging the parent's own separate requirement. This adds exactly one
// new rule communicating that existing backend concept; it does not touch
// crediting, the schema, or the validator. These tests verify the new rule
// says what it needs to and that rules 5/19 (the pre-existing "not a rigid
// quota" / "session cap" judgment language) survive unweakened.

import { describe, expect, it } from 'vitest';
import { buildWeekReconciliationSystemInstruction } from '../../src/ai-programmer/service/aiProgrammerService.js';

describe('buildWeekReconciliationSystemInstruction — parent/sub-target shared-credit rule', () => {
  const instruction = buildWeekReconciliationSystemInstruction();

  it('explains that a shared exercise is recognizable by the same exerciseId appearing in both targets\' validExercises', () => {
    expect(instruction).toMatch(/share one or more exercises with a more specific sub-target/);
    expect(instruction).toMatch(/the exact same exerciseId appears in both targets' own validExercises lists/);
  });

  it('states the credit is shared, never double-counted, and never deliberately duplicated across target ids', () => {
    expect(instruction).toMatch(/automatically credited by the app toward the broader target's own weekly number too/);
    expect(instruction).toMatch(/never counted as two separate sets/);
    expect(instruction).toMatch(/must never list the same exercise under both target ids to try to credit it twice/);
  });

  it('asks the model to work out the remaining amount and use its own coaching judgment — never a mechanical top-up', () => {
    expect(instruction).toMatch(/work out how much of the broader target's own number is still realistically unmet/);
    expect(instruction).toMatch(/use your own coaching judgment/);
    expect(instruction).toMatch(/never a mechanical top-up/);
  });

  it('does not introduce a new hard quota, and does not weaken rule 5 (not rigid quotas) or the session-cap judgment rule', () => {
    expect(instruction).toMatch(/Blueprint package references are development\/coverage references, not rigid exercise quotas\./);
    expect(instruction).toMatch(/deferred volume is never lost, it becomes real unmet volume that target's own next real exposure/);
    expect(instruction).not.toMatch(/mechanically (add|insert|fill)/);
  });

  it('renumbered every later rule by one without losing or duplicating any', () => {
    const numbers = [...instruction.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]!));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
    expect(numbers.length).toBe(19); // 18 original rules + 1 new one
  });
});
