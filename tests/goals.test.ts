import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { GoalsRepo, TooManyActiveAestheticGoalsError, UnknownBlueprintGoalReferenceError } from '../src/repositories/goalsRepo.js';
import { GoalEventsRepo } from '../src/repositories/goalEventsRepo.js';
import { WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';
import { buildTrainingState } from '../src/engine/trainingState.js';
import { MAX_ACTIVE_AESTHETIC_GOALS } from '../src/engine/config.js';

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

describe('active-aesthetic-goal cap — spec §1.2 (required test 6)', () => {
  it('rejects a third simultaneously active aesthetic goal', () => {
    const repo = new GoalsRepo(db);
    const [firstRef, secondRef, thirdRef] = BlueprintAdapter.getAestheticGoals();
    expect(MAX_ACTIVE_AESTHETIC_GOALS).toBe(2);

    repo.create({ goal_type: 'aesthetic', blueprint_ref: firstRef!.id, priority: 1 });
    repo.create({ goal_type: 'aesthetic', blueprint_ref: secondRef!.id, priority: 2 });

    expect(() => repo.create({ goal_type: 'aesthetic', blueprint_ref: thirdRef!.id, priority: 3 })).toThrow(
      TooManyActiveAestheticGoalsError
    );
    expect(repo.list({ active: true, goal_type: 'aesthetic' })).toHaveLength(2);
  });

  it('allows a third aesthetic goal once one of the first two is deactivated', () => {
    const repo = new GoalsRepo(db);
    const [firstRef, secondRef, thirdRef] = BlueprintAdapter.getAestheticGoals();

    const first = repo.create({ goal_type: 'aesthetic', blueprint_ref: firstRef!.id, priority: 1 });
    repo.create({ goal_type: 'aesthetic', blueprint_ref: secondRef!.id, priority: 2 });
    repo.deactivate(first.id);

    const third = repo.create({ goal_type: 'aesthetic', blueprint_ref: thirdRef!.id, priority: 3 });
    expect(third.active).toBe(true);
    expect(repo.list({ active: true, goal_type: 'aesthetic' })).toHaveLength(2);
  });

  it('does not cap functional goals — a third active functional goal is allowed', () => {
    const repo = new GoalsRepo(db);
    const functionalGoals = BlueprintAdapter.getFunctionalGoals();
    expect(functionalGoals.length).toBeGreaterThanOrEqual(3);

    for (const [i, goal] of functionalGoals.slice(0, 3).entries()) {
      repo.create({ goal_type: 'functional', blueprint_ref: goal.id, priority: i + 1 });
    }
    expect(repo.list({ active: true, goal_type: 'functional' })).toHaveLength(3);
  });
});

describe('returning goal — spec §18 (required test 15: prior history loads, not restarts from zero)', () => {
  it('deactivating then reactivating a goal preserves its full event history, never deletes it', () => {
    const repo = new GoalsRepo(db);
    const eventsRepo = new GoalEventsRepo(db);
    const blueprintRef = BlueprintAdapter.getAestheticGoals()[0]!.id;

    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: blueprintRef, priority: 1 });
    repo.setPriority(goal.id, 2);
    repo.deactivate(goal.id, 'switching focus for a while');
    repo.reactivate(goal.id);

    const history = eventsRepo.listForGoal(goal.id);
    const eventTypes = history.map((e) => e.event_type);
    expect(eventTypes).toEqual(['created', 'activated', 'priority_changed', 'deactivated', 'activated']);
    expect(history.find((e) => e.event_type === 'deactivated')?.notes).toBe('switching focus for a while');
  });

  it('a reactivated goal reappears in TrainingState.active_goals with its priority_map intact', () => {
    const repo = new GoalsRepo(db);
    const blueprintRef = BlueprintAdapter.getAestheticGoals()[0]!.id;
    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: blueprintRef, priority: 1 });

    repo.deactivate(goal.id);
    expect(buildTrainingState(db, '2026-08-31').active_goals.map((g) => g.id)).not.toContain(goal.id);

    repo.reactivate(goal.id);
    const state = buildTrainingState(db, '2026-08-31');
    expect(state.active_goals.map((g) => g.id)).toContain(goal.id);
    const priorityMap = state.priority_maps[state.active_goals.findIndex((g) => g.id === goal.id)];
    expect(priorityMap?.blueprint_ref).toBe(blueprintRef);
    expect(priorityMap?.targets.length).toBeGreaterThan(0);
  });

  it('exposure logged for a target while the goal was active is still reflected after the goal returns (nothing is deleted)', () => {
    const repo = new GoalsRepo(db);
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.length > 0)!;
    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });

    const targetId = outcome.primary_targets[0]!;
    const exerciseId = BlueprintAdapter.getExercises().find((e) => (e.physique_targets ?? []).includes(targetId))!.id;

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: '2026-08-24', session_type: 'gym' });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: exerciseId,
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, weight: 40, reps: 8, completed: true }],
    });

    repo.deactivate(goal.id);
    repo.reactivate(goal.id);

    const state = buildTrainingState(db, '2026-08-31', { rollingWindowDays: 14 });
    const exposure = state.rolling_exposure.find((e) => e.target_type === 'physique_target' && e.target_id === targetId);
    expect(exposure?.total_sets).toBeGreaterThan(0);
  });
});
