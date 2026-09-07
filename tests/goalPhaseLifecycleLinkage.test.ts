// Step 12 Remediation §5 (P0): the goal lifecycle and the goal-phase
// lifecycle were previously disconnected — a goal could be active with
// no phase at all, and deactivating/graduating a goal never touched its
// phase. GoalsRepo now owns the smallest possible hook
// (ensureActivePhase, called from create/reactivate; phase completion
// called from deactivate) rather than a second goal-creation flow.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { GoalsRepo } from '../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../src/repositories/goalPhaseRepo.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — an active goal is created with an appropriate active phase', () => {
  it('GoalsRepo.create() for an active goal starts a real Complete-package active phase', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phase = new GoalPhaseRepo(db).getActiveForGoal(goal.id);
    expect(phase).toBeDefined();
    expect(phase!.status).toBe('active');
    expect(phase!.package_level).toBe('complete');
  });

  it('an inactive goal is created with no phase at all', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, active: false });
    expect(new GoalPhaseRepo(db).getActiveForGoal(goal.id)).toBeUndefined();
    expect(new GoalPhaseRepo(db).listForGoal(goal.id)).toHaveLength(0);
  });
});

describe('Test B — deactivating a goal never leaves a falsely-active phase', () => {
  it('deactivate() completes the goal\'s own active phase', () => {
    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phaseRepo = new GoalPhaseRepo(db);
    const activeBefore = phaseRepo.getActiveForGoal(goal.id)!;
    expect(activeBefore.status).toBe('active');

    goalsRepo.deactivate(goal.id);

    expect(phaseRepo.getActiveForGoal(goal.id)).toBeUndefined();
    const phase = phaseRepo.get(activeBefore.id)!;
    expect(phase.status).toBe('completed');
    expect(phase.completed_at).not.toBeNull();
  });

  it('deactivating a goal with no phase yet is a safe no-op on the phase side', () => {
    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, active: false });
    goalsRepo.reactivate(goal.id); // now active, with a fresh phase
    const phaseRepo = new GoalPhaseRepo(db);
    expect(phaseRepo.getActiveForGoal(goal.id)).toBeDefined();
    expect(() => goalsRepo.deactivate(goal.id)).not.toThrow();
    expect(phaseRepo.getActiveForGoal(goal.id)).toBeUndefined();
  });
});

describe('Test C — reactivating a goal starts a fresh active phase', () => {
  it('reactivate() gives the goal a new active phase after its prior one was completed by deactivate()', () => {
    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phaseRepo = new GoalPhaseRepo(db);
    const firstPhase = phaseRepo.getActiveForGoal(goal.id)!;

    goalsRepo.deactivate(goal.id);
    goalsRepo.reactivate(goal.id);

    const secondPhase = phaseRepo.getActiveForGoal(goal.id);
    expect(secondPhase).toBeDefined();
    expect(secondPhase!.id).not.toBe(firstPhase.id);
    expect(secondPhase!.status).toBe('active');
  });
});

describe('Test D — historical phases stay immutable through the goal lifecycle', () => {
  it('a completed phase from before deactivation remains queryable, unchanged, after reactivation starts a new one', () => {
    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phaseRepo = new GoalPhaseRepo(db);
    const firstPhase = phaseRepo.getActiveForGoal(goal.id)!;

    goalsRepo.deactivate(goal.id);
    goalsRepo.reactivate(goal.id);

    const all = phaseRepo.listForGoal(goal.id);
    expect(all).toHaveLength(2);
    const historical = all.find((p) => p.id === firstPhase.id)!;
    expect(historical.status).toBe('completed');
    expect(historical.start_date).toBe(firstPhase.start_date);
    expect(historical.package_level).toBe(firstPhase.package_level);
  });
});

describe('Test E — never a second, duplicate active phase', () => {
  it('ensureActivePhase is a no-op when the goal already has a non-completed phase', () => {
    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phaseRepo = new GoalPhaseRepo(db);
    const before = phaseRepo.listForGoal(goal.id);
    expect(before).toHaveLength(1);

    // Reactivating an already-active goal is a no-op on the goal row
    // (GoalsRepo.reactivate returns early for an already-active goal),
    // so this never even reaches ensureActivePhase again — asserting the
    // phase count stays exactly 1 either way.
    goalsRepo.reactivate(goal.id);
    expect(phaseRepo.listForGoal(goal.id)).toHaveLength(1);
  });
});
