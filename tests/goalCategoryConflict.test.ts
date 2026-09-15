// Goal Same-Day Conflict Fix (2026-09-14): two active aesthetic goals
// whose Blueprint targets share a real push/pull/legs category compete
// for the same real session every week rather than each getting a
// session of its own — the exact mechanism that let two goals under
// the SAME category (both push, in this case) permanently squeeze out
// a real muscle from the session cap. This file proves the new
// activation-time restriction directly against real Blueprint data,
// exactly like every other regression suite in this codebase.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { GoalsRepo, ConflictingGoalCategoryError, TooManyActiveAestheticGoalsError } from '../src/repositories/goalsRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

// Real Blueprint aesthetic outcome ids, verified single-category via
// their own real primary_targets/supporting_targets (see this fix's
// own investigation): 'chest-front-width'/'triceps-back-depth' -> push
// only; 'back-width-v-taper'/'biceps-front-peak' -> pull only;
// 'glute-roundness'/'quad-front-mass' -> legs only; 'arm-side-thickness'
// -> BOTH push (triceps) and pull (brachialis) simultaneously —
// deliberately spans two categories, unlike every other goal checked.
// 'ab-front-definition' has no push/pull/legs targets at all (abs are
// universal), used to prove a category-less goal never conflicts.
const PUSH_GOAL_A = 'chest-front-width';
const PUSH_GOAL_B = 'triceps-back-depth';
const PULL_GOAL = 'back-width-v-taper';
const LEGS_GOAL = 'glute-roundness';
const MULTI_CATEGORY_GOAL = 'arm-side-thickness';
const UNIVERSAL_ONLY_GOAL = 'ab-front-definition';

describe('Goal Same-Day Conflict Fix — activation-time push/pull/legs category restriction', () => {
  it('allows two goals in genuinely different categories (push + pull)', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 1 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: PULL_GOAL, priority: 2 })).not.toThrow();
    expect(repo.list({ active: true, goal_type: 'aesthetic' })).toHaveLength(2);
  });

  it('allows two goals in different categories (push + legs)', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 1 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: LEGS_GOAL, priority: 2 })).not.toThrow();
  });

  it('rejects two goals in the SAME category (both push) — the exact scenario that caused real starvation', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 1 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_B, priority: 2 })).toThrow(ConflictingGoalCategoryError);
    // Nothing persisted from the rejected attempt.
    expect(repo.list({ active: true, goal_type: 'aesthetic' })).toHaveLength(1);
  });

  it('a multi-category goal (arm-side-thickness) blocks ANY other aesthetic goal, not just push or pull ones', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: MULTI_CATEGORY_GOAL, priority: 1 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: LEGS_GOAL, priority: 2 })).toThrow(ConflictingGoalCategoryError);
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: PULL_GOAL, priority: 2 })).toThrow(ConflictingGoalCategoryError);
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 2 })).toThrow(ConflictingGoalCategoryError);
  });

  it('no other goal already active blocks activating the multi-category goal either — it counts as occupying two slots on its own', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: LEGS_GOAL, priority: 1 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: MULTI_CATEGORY_GOAL, priority: 2 })).toThrow(ConflictingGoalCategoryError);
  });

  it('a universal-only goal (no push/pull/legs targets at all) never conflicts with anything', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 1 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: UNIVERSAL_ONLY_GOAL, priority: 2 })).not.toThrow();
  });

  it('the existing max-2-active-goals cap is still checked first/independently', () => {
    const repo = new GoalsRepo(db);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 1 });
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PULL_GOAL, priority: 2 });
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: LEGS_GOAL, priority: 3 })).toThrow(TooManyActiveAestheticGoalsError);
  });

  it('reactivating a deactivated goal is subject to the exact same category restriction', () => {
    const repo = new GoalsRepo(db);
    const pushGoal = repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_A, priority: 1 });
    repo.deactivate(pushGoal.id);
    repo.create({ goal_type: 'aesthetic', blueprint_ref: PUSH_GOAL_B, priority: 1 });

    expect(() => repo.reactivate(pushGoal.id)).toThrow(ConflictingGoalCategoryError);
    expect(repo.get(pushGoal.id)!.active).toBe(false); // rejected reactivation never took effect
  });

  it('functional goals are never subject to this restriction at all', () => {
    const repo = new GoalsRepo(db);
    const functionalIds = BlueprintAdapter.getFunctionalGoals()
      .slice(0, 2)
      .map((g) => g.id);
    repo.create({ goal_type: 'functional', blueprint_ref: functionalIds[0]!, priority: 1 });
    expect(() => repo.create({ goal_type: 'functional', blueprint_ref: functionalIds[1]!, priority: 2 })).not.toThrow();
  });

  it('verified against every real Blueprint aesthetic outcome: exactly one (arm-side-thickness) spans more than one category', () => {
    const PUSH = ['upper-pec', 'mid-pec', 'lower-pec', 'front-delt', 'side-delt', 'triceps', 'triceps-long-head'];
    const PULL = ['lat-width', 'back-thickness', 'upper-traps', 'rear-delt', 'biceps', 'brachialis-arm-thickness', 'forearm-flexors', 'forearm-extensors'];
    const LEGS = ['quads', 'hamstrings', 'gluteus-maximus', 'gluteus-medius-minimus', 'adductors', 'gastrocnemius', 'soleus'];
    const classify = (id: string): 'push' | 'pull' | 'legs' | null =>
      PUSH.includes(id) ? 'push' : PULL.includes(id) ? 'pull' : LEGS.includes(id) ? 'legs' : null;
    const multiCategoryGoals = BlueprintAdapter.getAestheticGoals().filter((g) => {
      const targets = [...g.primary_targets, ...(g.supporting_targets ?? [])];
      const categories = new Set(targets.map(classify).filter((c): c is 'push' | 'pull' | 'legs' => c !== null));
      return categories.size > 1;
    });
    expect(multiCategoryGoals.map((g) => g.id)).toEqual([MULTI_CATEGORY_GOAL]);
  });
});
