// Programming Redesign (Step 12) §16.H: goal phase lifecycle tests —
// creation, active state, review_due, and the terminal transitions
// (continue/adjust/graduate are exercised at the goalPhaseEngine.ts
// level in tests/engine/goalPhaseEngine.test.ts; this file covers the
// repo's own state machine directly). Also proves historical phases are
// preserved and no debt transfers between phases.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';

let db: Database.Database;
let goalId: string;

beforeEach(() => {
  db = openDb(':memory:');
  // Remediation (Step 12 Fix) §5: an ACTIVE goal now gets its own
  // auto-created phase (GoalsRepo.create -> ensureActivePhase), which
  // these tests would otherwise collide with — they exercise
  // GoalPhaseRepo's own state machine directly via hand-built phases.
  // Creating the goal inactive keeps this file's scope exactly what it
  // was: the repo's own primitives, independent of goal-lifecycle wiring
  // (which is covered separately in tests/goalPhaseLifecycleLinkage.test.ts).
  goalId = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, active: false }).id;
});

describe('GoalPhaseRepo — creation and active state', () => {
  it('a new phase always starts active, with no completed_at', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete', priority_snapshot: 1, emphasis: 'width' });
    expect(phase.status).toBe('active');
    expect(phase.completed_at).toBeNull();
    expect(phase.goal_id).toBe(goalId);
  });

  it('getActiveForGoal returns the one non-completed phase', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12' });
    expect(repo.getActiveForGoal(goalId)?.id).toBe(phase.id);
  });

  it('getActiveForGoal returns undefined once the phase is completed', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12' });
    repo.complete(phase.id);
    expect(repo.getActiveForGoal(goalId)).toBeUndefined();
  });
});

describe('GoalPhaseRepo — review_due lifecycle', () => {
  it('markReviewDue transitions active -> review_due', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12' });
    const updated = repo.markReviewDue(phase.id);
    expect(updated?.status).toBe('review_due');
  });

  it('markReviewDue is a no-op from any status other than active', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12' });
    repo.markReviewDue(phase.id);
    const secondCall = repo.markReviewDue(phase.id); // already review_due
    expect(secondCall).toBeUndefined();
  });

  it('beginReview transitions review_due -> review, and is a no-op from active', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12' });
    expect(repo.beginReview(phase.id)).toBeUndefined(); // still active
    repo.markReviewDue(phase.id);
    expect(repo.beginReview(phase.id)?.status).toBe('review');
  });
});

describe('GoalPhaseRepo — continue (no new phase, no escalation)', () => {
  it('continueActive keeps the SAME phase id, just extends review_date', () => {
    const repo = new GoalPhaseRepo(db);
    const phase = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12', emphasis: 'width' });
    repo.markReviewDue(phase.id);
    repo.beginReview(phase.id);
    const continued = repo.continueActive(phase.id, '2026-10-24');
    expect(continued?.id).toBe(phase.id);
    expect(continued?.status).toBe('active');
    expect(continued?.review_date).toBe('2026-10-24');
    expect(continued?.start_date).toBe('2026-08-01'); // unchanged — not a new phase
    expect(continued?.emphasis).toBe('width'); // nothing about the phase itself changed
  });
});

describe('GoalPhaseRepo — historical preservation and no debt transfer', () => {
  it('a completed phase remains queryable via listForGoal after a new one begins', () => {
    const repo = new GoalPhaseRepo(db);
    const first = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12' });
    repo.complete(first.id);
    const second = repo.create({ goal_id: goalId, start_date: '2026-09-12', review_date: '2026-10-24' });

    const all = repo.listForGoal(goalId);
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.id === first.id)?.status).toBe('completed');
    expect(all.find((p) => p.id === second.id)?.status).toBe('active');
  });

  it('a new phase begins with no reference to the prior phase\'s own state — no volume/emphasis carried over unless the caller explicitly passes it', () => {
    const repo = new GoalPhaseRepo(db);
    const first = repo.create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12', emphasis: 'old-emphasis', priority_snapshot: 1 });
    repo.complete(first.id);
    const second = repo.create({ goal_id: goalId, start_date: '2026-09-12', review_date: '2026-10-24' }); // deliberately no emphasis/priority passed
    expect(second.emphasis).toBeNull();
    expect(second.priority_snapshot).toBeNull();
    expect(second.id).not.toBe(first.id);
  });
});
