import { describe, expect, it } from 'vitest';
import { allocateResource } from '../../src/engine/resourceAllocation.js';

describe('resourceAllocation — spec §17', () => {
  it('required test 5: ranking affects allocation and cannot be overridden — a lower-priority goal never jumps ahead of a higher one', () => {
    const result = allocateResource({
      resource_name: 'session_minutes',
      total_available: 40,
      goals: [
        { goal_id: 'low-priority-big-ask', priority: 2, desired_amount: 100 },
        { goal_id: 'high-priority-small-ask', priority: 1, desired_amount: 10 },
      ],
    });

    const byId = Object.fromEntries(result.allocations.map((a) => [a.goal_id, a]));
    expect(byId['high-priority-small-ask']!.allocated_amount).toBe(10); // fully served first
    expect(byId['low-priority-big-ask']!.allocated_amount).toBe(30); // only the leftover, even though it asked for more
  });

  it('swapping which goal is priority 1 changes the outcome — ranking, not goal identity, drives allocation', () => {
    const goals = [
      { goal_id: 'a', priority: 1, desired_amount: 20 },
      { goal_id: 'b', priority: 2, desired_amount: 20 },
    ];
    const resultA = allocateResource({ resource_name: 'x', total_available: 25, goals });
    const swapped = allocateResource({
      resource_name: 'x',
      total_available: 25,
      goals: [
        { goal_id: 'a', priority: 2, desired_amount: 20 },
        { goal_id: 'b', priority: 1, desired_amount: 20 },
      ],
    });

    const aFirst = Object.fromEntries(resultA.allocations.map((x) => [x.goal_id, x.allocated_amount]));
    const bFirst = Object.fromEntries(swapped.allocations.map((x) => [x.goal_id, x.allocated_amount]));
    expect(aFirst['a']).toBe(20);
    expect(aFirst['b']).toBe(5);
    expect(bFirst['b']).toBe(20);
    expect(bFirst['a']).toBe(5);
  });

  it('never allocates more in aggregate than total_available', () => {
    const result = allocateResource({
      resource_name: 'exercise_slots',
      total_available: 6,
      goals: [
        { goal_id: 'a', priority: 1, desired_amount: 4 },
        { goal_id: 'b', priority: 2, desired_amount: 4 },
        { goal_id: 'c', priority: 3, desired_amount: 4 },
      ],
    });
    const total = result.allocations.reduce((sum, a) => sum + a.allocated_amount, 0);
    expect(total).toBeLessThanOrEqual(6);
    expect(total + result.unallocated_remaining).toBe(6);
  });

  it('never gives a goal more than its own desired_amount, even with abundant resource left over', () => {
    const result = allocateResource({
      resource_name: 'session_minutes',
      total_available: 1000,
      goals: [{ goal_id: 'a', priority: 1, desired_amount: 30 }],
    });
    expect(result.allocations[0]!.allocated_amount).toBe(30);
    expect(result.unallocated_remaining).toBe(970);
  });

  it('does not blindly maximize #1 — a well-progressing #1 is fully served, but leftover still reaches a stagnant lower-ranked goal', () => {
    const result = allocateResource({
      resource_name: 'session_minutes',
      total_available: 40,
      goals: [
        { goal_id: 'top-goal', priority: 1, desired_amount: 20, progress_status: 'improving' },
        { goal_id: 'stagnant-goal', priority: 2, desired_amount: 20, progress_status: 'stagnant' },
      ],
    });
    const byId = Object.fromEntries(result.allocations.map((a) => [a.goal_id, a]));
    expect(byId['top-goal']!.allocated_amount).toBe(20); // protected, fully served
    expect(byId['stagnant-goal']!.allocated_amount).toBe(20); // leftover reaches it, not hoarded by #1
    expect(byId['stagnant-goal']!.reasoning).toContain('stagnant');
  });

  it('is deterministic and tie-breaks equal-priority goals by goal_id', () => {
    const result = allocateResource({
      resource_name: 'x',
      total_available: 5,
      goals: [
        { goal_id: 'zeta', priority: 1, desired_amount: 3 },
        { goal_id: 'alpha', priority: 1, desired_amount: 3 },
      ],
    });
    expect(result.allocations[0]!.goal_id).toBe('alpha');
    expect(result.allocations[0]!.allocated_amount).toBe(3);
    expect(result.allocations[1]!.goal_id).toBe('zeta');
    expect(result.allocations[1]!.allocated_amount).toBe(2);
  });

  it('handles zero available resource without error', () => {
    const result = allocateResource({
      resource_name: 'x',
      total_available: 0,
      goals: [{ goal_id: 'a', priority: 1, desired_amount: 10 }],
    });
    expect(result.allocations[0]!.allocated_amount).toBe(0);
  });

  it('every allocation carries a non-opaque reasoning string (spec §20)', () => {
    const result = allocateResource({
      resource_name: 'session_minutes',
      total_available: 10,
      goals: [{ goal_id: 'a', priority: 1, desired_amount: 20 }],
    });
    expect(result.allocations[0]!.reasoning.length).toBeGreaterThan(10);
  });
});
