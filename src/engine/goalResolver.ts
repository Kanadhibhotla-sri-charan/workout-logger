// Goal Resolver — spec §7, §9, §10 (docs/TRAINING_ENGINE_DESIGN.md).
//
// Resolves a local Goal to a deterministic PriorityMap of Blueprint
// targets. Pure: takes an already-loaded Goal and reads only
// BlueprintAdapter's static, in-memory snapshot — no database access, no
// side effects (§32's "pure deterministic interfaces" principle). The
// impure step (loading a Goal by id from storage) stays in
// GoalsRepo/trainingState.ts, not here.
//
// Aesthetic and functional goals are NOT treated identically (§8): an
// aesthetic goal's Blueprint reference (an AestheticOutcome) names
// separate primary/supporting physique targets; a functional goal's
// reference IS the target itself — Blueprint's functional-goals.yaml has
// no primary/supporting split to draw from, and this module does not
// invent one.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { BlueprintId, Goal } from '../contracts/types.js';

export class UnresolvedGoalReferenceError extends Error {
  constructor(public goal: Pick<Goal, 'id' | 'goal_type' | 'blueprint_ref'>) {
    super(`Goal ${goal.id}'s blueprint_ref "${goal.blueprint_ref}" (${goal.goal_type}) no longer resolves in Blueprint`);
    this.name = 'UnresolvedGoalReferenceError';
  }
}

export type TargetType = 'physique_target' | 'functional_goal';

/** Only 'primary' and 'supporting' are ever produced by buildPriorityMap
 * — every other Blueprint target is implicitly 'neutral' (not explicitly
 * enumerated; there is no complete, closed list of "every target" worth
 * materializing). A 'deprioritized' tier requires cross-goal composition
 * rules this module does not implement — see
 * docs/TRAINING_ENGINE_DESIGN.md §10. */
export type TargetPriorityTier = 'primary' | 'supporting';

export interface PrioritizedTarget {
  target_type: TargetType;
  target_id: BlueprintId;
  tier: TargetPriorityTier;
}

export interface PriorityMap {
  goal_id: string;
  goal_type: Goal['goal_type'];
  blueprint_ref: BlueprintId;
  targets: PrioritizedTarget[];
}

/**
 * Resolves `goal` to its PriorityMap. Throws UnresolvedGoalReferenceError
 * if blueprint_ref no longer resolves (should not happen for a Goal that
 * passed GoalsRepo.create's validation, but Blueprint's own data can in
 * principle change under a later snapshot commit — see
 * Program.blueprint_commit in docs/architecture.md).
 */
export function buildPriorityMap(goal: Pick<Goal, 'id' | 'goal_type' | 'blueprint_ref'>): PriorityMap {
  if (goal.goal_type === 'aesthetic') {
    const outcome = BlueprintAdapter.getAestheticGoal(goal.blueprint_ref);
    if (!outcome) throw new UnresolvedGoalReferenceError(goal);
    return {
      goal_id: goal.id,
      goal_type: goal.goal_type,
      blueprint_ref: goal.blueprint_ref,
      targets: [
        ...outcome.primary_targets.map((target_id): PrioritizedTarget => ({
          target_type: 'physique_target',
          target_id,
          tier: 'primary',
        })),
        // §24: a legitimate Blueprint aesthetic outcome may have no
        // supporting_targets field at all, not an empty array — never
        // assume it exists.
        ...(outcome.supporting_targets ?? []).map((target_id): PrioritizedTarget => ({
          target_type: 'physique_target',
          target_id,
          tier: 'supporting',
        })),
      ],
    };
  }

  const functionalGoal = BlueprintAdapter.getFunctionalGoal(goal.blueprint_ref);
  if (!functionalGoal) throw new UnresolvedGoalReferenceError(goal);
  return {
    goal_id: goal.id,
    goal_type: goal.goal_type,
    blueprint_ref: goal.blueprint_ref,
    // A functional goal has no Blueprint-authored supporting-target
    // split — the referenced functional goal IS the (sole) primary
    // target. See docs/TRAINING_EXPOSURE_MODEL.md §1.
    targets: [{ target_type: 'functional_goal', target_id: functionalGoal.id, tier: 'primary' }],
  };
}

/** Looks up a target's tier within one PriorityMap. Returns 'neutral' for
 * anything not explicitly primary/supporting — see the TargetPriorityTier
 * doc comment above for why 'neutral' isn't itself a PrioritizedTarget
 * value. */
export function tierOf(map: PriorityMap, targetType: TargetType, targetId: BlueprintId): TargetPriorityTier | 'neutral' {
  const found = map.targets.find((t) => t.target_type === targetType && t.target_id === targetId);
  return found?.tier ?? 'neutral';
}
