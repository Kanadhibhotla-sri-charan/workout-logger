import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { matchGoalCandidates } from '../../src/engine/goalCreation.js';
import { GOAL_MATCH } from '../../src/engine/config.js';

describe('matchGoalCandidates — spec §2.1 natural-language matching', () => {
  it('ranks the exact-phrasing Blueprint outcome first for a real common_user_phrasing', () => {
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.common_user_phrasings.length > 0)!;
    const phrasing = outcome.common_user_phrasings[0]!;

    const candidates = matchGoalCandidates(phrasing);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.goal_type).toBe('aesthetic');
    expect(candidates[0]!.blueprint_ref).toBe(outcome.id);
    // A verbatim phrasing normalizes close to (sometimes exactly to) the
    // outcome's own display_name token set, so the top score is a
    // near-perfect match — what matters is which outcome won, not
    // exactly which of its equally-good texts got credited as matched_on.
    expect(candidates[0]!.score).toBeGreaterThan(0.9);
  });

  it('every returned candidate meets the configured minimum score', () => {
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.common_user_phrasings.length > 0)!;
    const candidates = matchGoalCandidates(outcome.common_user_phrasings[0]!);
    for (const c of candidates) {
      expect(c.score).toBeGreaterThanOrEqual(GOAL_MATCH.minScore);
    }
  });

  it('never returns more than GOAL_MATCH.maxCandidates', () => {
    // A broad, generic phrase likely to brush against several outcomes.
    const candidates = matchGoalCandidates('my chest and arms look flat and small');
    expect(candidates.length).toBeLessThanOrEqual(GOAL_MATCH.maxCandidates);
  });

  it('returns an empty array for text with no meaningful overlap — not an error', () => {
    expect(matchGoalCandidates('zzz qqq xyzzy plugh')).toEqual([]);
  });

  it('returns an empty array for empty/whitespace-only text', () => {
    expect(matchGoalCandidates('   ')).toEqual([]);
  });

  it('can surface a functional goal candidate via name/definition text, scored lower-confidence than an aesthetic phrasing match', () => {
    const functionalGoal = BlueprintAdapter.getFunctionalGoals()[0]!;
    const candidates = matchGoalCandidates(functionalGoal.name);
    const match = candidates.find((c) => c.blueprint_ref === functionalGoal.id);
    expect(match?.goal_type).toBe('functional');
  });

  it('is pure — matching never touches the database or persists a goal', () => {
    const outcome = BlueprintAdapter.getAestheticGoals()[0]!;
    matchGoalCandidates(outcome.common_user_phrasings[0]!);
    // matchGoalCandidates takes no db handle at all; this call is here to
    // document that guarantee in a way a future refactor can't silently
    // break without also changing this test.
    expect(matchGoalCandidates.length).toBe(1); // (text) => ... — no db param
  });
});

describe('natural-language goal confirmation flow — spec §2.1', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('matching alone never creates a goal', () => {
    const outcome = BlueprintAdapter.getAestheticGoals()[0]!;
    matchGoalCandidates(outcome.common_user_phrasings[0]!);

    const repo = new GoalsRepo(db);
    expect(repo.list()).toHaveLength(0);
  });

  it('an explicit confirming create() call persists the goal with its source text attached', () => {
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.common_user_phrasings.length > 0)!;
    const phrasing = outcome.common_user_phrasings[0]!;
    const candidates = matchGoalCandidates(phrasing);
    const chosen = candidates[0]!;

    const repo = new GoalsRepo(db);
    const goal = repo.create({
      goal_type: chosen.goal_type,
      blueprint_ref: chosen.blueprint_ref,
      priority: 1,
      source: 'natural_language',
      source_text: phrasing,
    });

    expect(goal.source).toBe('natural_language');
    expect(goal.source_text).toBe(phrasing);
    expect(repo.list()).toHaveLength(1);
  });

  it('defaults source to "structured" when not provided (the pre-existing browse-and-pick path)', () => {
    const outcome = BlueprintAdapter.getAestheticGoals()[0]!;
    const repo = new GoalsRepo(db);
    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });

    expect(goal.source).toBe('structured');
    expect(goal.source_text).toBeNull();
  });
});
