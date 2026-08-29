import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { GoalsRepo, UnknownBlueprintGoalReferenceError } from '../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('local Goal vs Blueprint goal reference', () => {
  it('gives a local goal its own id, distinct from blueprint_ref', () => {
    const repo = new GoalsRepo(db);
    const blueprintRef = BlueprintAdapter.getAestheticGoals()[0]!.id;

    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: blueprintRef, priority: 1 });

    expect(goal.id).not.toBe(goal.blueprint_ref);
    expect(goal.blueprint_ref).toBe(blueprintRef);
    expect(goal.id.startsWith('goal_')).toBe(true);
  });

  it('resolves a local goal through to Blueprint knowledge via blueprint_ref', () => {
    const repo = new GoalsRepo(db);
    const blueprintRef = BlueprintAdapter.getFunctionalGoals()[0]!.id;
    const goal = repo.create({ goal_type: 'functional', blueprint_ref: blueprintRef, priority: 1 });

    const resolved = repo.resolveBlueprint(goal.id);

    expect(resolved?.id).toBe(blueprintRef);
  });

  it('rejects an invalid Blueprint reference cleanly, persisting nothing', () => {
    const repo = new GoalsRepo(db);

    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: 'not-a-real-outcome', priority: 1 })).toThrow(
      UnknownBlueprintGoalReferenceError
    );
    expect(repo.list()).toHaveLength(0);
  });

  it('rejects a functional blueprint_ref used as an aesthetic goal (and vice versa)', () => {
    const repo = new GoalsRepo(db);
    const functionalId = BlueprintAdapter.getFunctionalGoals()[0]!.id;

    // A real Blueprint id, but for the wrong goal_type — must still fail.
    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: functionalId, priority: 1 })).toThrow(
      UnknownBlueprintGoalReferenceError
    );
  });

  it('lets a WorkoutSession reference the local goal id, never the blueprint_ref, as goal_context.goal_id', () => {
    const goalsRepo = new GoalsRepo(db);
    const blueprintRef = BlueprintAdapter.getAestheticGoals()[0]!.id;
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: blueprintRef, priority: 1 });

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({
      date: '2026-08-29',
      session_type: 'gym',
      goal_context: { goal_type: 'aesthetic', goal_id: goal.id, priority: 1, program_phase: null },
    });

    const loaded = sessionsRepo.getSession(session.session_id)!;
    expect(loaded.goal_context?.goal_id).toBe(goal.id);
    expect(loaded.goal_context?.goal_id).not.toBe(blueprintRef);
    // The workout session doesn't need to know blueprint_ref at all — the
    // caller resolves Blueprint knowledge by loading the Goal from its id.
    expect(goalsRepo.resolveBlueprint(loaded.goal_context!.goal_id)?.id).toBe(blueprintRef);
  });
});
