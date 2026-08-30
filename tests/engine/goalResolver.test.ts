import { describe, expect, it } from 'vitest';
import { buildPriorityMap, tierOf, UnresolvedGoalReferenceError } from '../../src/engine/goalResolver.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('goalResolver — aesthetic goals', () => {
  it('builds a priority map with primary + supporting targets from the resolved AestheticOutcome', () => {
    // Real fixture from docs/TRAINING_ENGINE_DESIGN.md's mandatory scenario.
    const map = buildPriorityMap({ id: 'goal_1', goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness' });

    expect(map.targets).toEqual([
      { target_type: 'physique_target', target_id: 'brachialis-arm-thickness', tier: 'primary' },
      { target_type: 'physique_target', target_id: 'triceps', tier: 'supporting' },
    ]);
  });

  it('does not hard-code a final exercise list — only targets', () => {
    const map = buildPriorityMap({ id: 'goal_1', goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness' });
    for (const t of map.targets) {
      expect(t).not.toHaveProperty('exercise_id');
    }
  });

  it('throws for an aesthetic blueprint_ref that does not resolve', () => {
    expect(() => buildPriorityMap({ id: 'goal_1', goal_type: 'aesthetic', blueprint_ref: 'not-a-real-outcome' })).toThrow(
      UnresolvedGoalReferenceError
    );
  });

  it('§24: does not crash for a legitimate aesthetic outcome with no supporting_targets field at all', () => {
    // chest-upper-shelf is a real, displayed Blueprint outcome whose raw
    // snapshot data has no supporting_targets key (confirmed: 22 of ~46
    // aesthetic outcomes are like this) — buildPriorityMap must treat
    // that as "no supporting targets," never throw.
    const outcome = BlueprintAdapter.getAestheticGoal('chest-upper-shelf')!;
    expect(outcome).toBeDefined();
    expect('supporting_targets' in outcome).toBe(false);

    const map = buildPriorityMap({ id: 'goal_1', goal_type: 'aesthetic', blueprint_ref: 'chest-upper-shelf' });
    expect(map.targets.every((t) => t.tier === 'primary')).toBe(true);
    expect(map.targets.length).toBeGreaterThan(0);
  });
});

describe('goalResolver — functional goals', () => {
  it('treats a functional goal as its own sole primary target, with no supporting split', () => {
    const functionalId = BlueprintAdapter.getFunctionalGoals()[0]!.id;
    const map = buildPriorityMap({ id: 'goal_2', goal_type: 'functional', blueprint_ref: functionalId });

    expect(map.targets).toEqual([{ target_type: 'functional_goal', target_id: functionalId, tier: 'primary' }]);
  });

  it('does not reuse aesthetic-style primary/supporting logic for functional goals', () => {
    // Aesthetic outcomes commonly have >1 target; every functional goal
    // must resolve to exactly one (itself) — proves the two goal_types
    // are not run through identical logic (spec §8).
    for (const fg of BlueprintAdapter.getFunctionalGoals()) {
      const map = buildPriorityMap({ id: 'goal_x', goal_type: 'functional', blueprint_ref: fg.id });
      expect(map.targets).toHaveLength(1);
      expect(map.targets[0]!.tier).toBe('primary');
    }
  });

  it('throws for a functional blueprint_ref that does not resolve', () => {
    expect(() => buildPriorityMap({ id: 'goal_2', goal_type: 'functional', blueprint_ref: 'not-a-real-goal' })).toThrow(
      UnresolvedGoalReferenceError
    );
  });
});

describe('tierOf', () => {
  it('returns the correct tier for primary/supporting targets and "neutral" for everything else', () => {
    const map = buildPriorityMap({ id: 'goal_1', goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness' });

    expect(tierOf(map, 'physique_target', 'brachialis-arm-thickness')).toBe('primary');
    expect(tierOf(map, 'physique_target', 'triceps')).toBe('supporting');
    expect(tierOf(map, 'physique_target', 'upper-pec')).toBe('neutral');
  });
});
