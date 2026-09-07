// Step 12 Remediation §3 (P0): goal-review exposure evidence must be
// calculated across the ENTIRE phase window (phase.start_date..asOfDate),
// never a single current week — aggregateWeeklyExposure silently discards
// every session outside the week containing asOfDate, which let a
// current-week reading masquerade as the phase's real exposure. Partial
// phases must reflect only their real elapsed pace, never invent exposure
// for the remainder of the phase and never dilute a fast early start
// across the full planned phase length.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

let db: Database.Database;

function logCompletedSets(sessionsRepo: WorkoutSessionsRepo, date: string, exerciseId: string, setCount: number) {
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: exerciseId,
    order: 1,
    role: 'primary',
    sets: Array.from({ length: setCount }, (_, i) => ({ set_number: i + 1, weight: 20, reps: 10, completed: true })),
  });
  return session;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — phase exposure captures the whole phase, not just the current week', () => {
  it('an early-phase session outside the current week still contributes to phase exposure', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    // asOfDate's own (Monday-start) week is 2026-08-31..2026-09-06 — this
    // session falls well outside it, in the phase's first week.
    logCompletedSets(sessionsRepo, '2026-08-03', 'cable-pushdown', 2);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.phase_total_primary_sets).toBe(2);
    expect(evidence.actual_weekly_exposure).toBeGreaterThan(0);
  });
});

describe('Test B — real phase-total and average-weekly figures are correct', () => {
  it('total and weekly-average exposure are exact real arithmetic over the elapsed phase', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    // Exactly 2 elapsed weeks (2026-08-01 -> 2026-08-15 = 14 days) with 3
    // completed sets logged in each week: 6 total, 3/week average.
    logCompletedSets(sessionsRepo, '2026-08-02', 'cable-pushdown', 3);
    logCompletedSets(sessionsRepo, '2026-08-09', 'cable-pushdown', 3);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-08-15');
    expect(evidence.phase_weeks_elapsed).toBeCloseTo(2, 5);
    expect(evidence.phase_total_primary_sets).toBe(6);
    expect(evidence.actual_weekly_exposure).toBeCloseTo(3, 5);
  });
});

describe('Test C — partial-phase handling never invents future exposure', () => {
  it('a review a few days into a long phase reflects only the real elapsed pace, never diluted across the full planned phase length', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    // Phase is planned to run ~6 weeks (2026-08-01..2026-09-12), but is
    // reviewed only 3 days in.
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    logCompletedSets(sessionsRepo, '2026-08-02', 'cable-pushdown', 3);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-08-04');
    expect(evidence.phase_total_primary_sets).toBe(3);
    // Elapsed-pace average (3 sets / (3/7) weeks = 7/week) — never the
    // full-planned-phase-length dilution (3 sets / ~6 weeks = 0.5/week),
    // which would silently invent a slow pace for weeks that haven't
    // happened yet.
    expect(evidence.actual_weekly_exposure).toBeGreaterThan(5);
  });
});

describe('Test D — a zero current-week reading never masquerades as zero phase-level exposure', () => {
  it('real substantial exposure earlier in the phase still shows even when the current week itself has none logged', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    // Real, substantial exposure — but entirely inside an earlier week,
    // with nothing logged in the (Monday-start) week containing asOfDate
    // (2026-08-31..2026-09-06).
    logCompletedSets(sessionsRepo, '2026-08-05', 'cable-pushdown', 10);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.phase_total_primary_sets).toBe(10);
    expect(evidence.actual_weekly_exposure).toBeGreaterThan(0);
  });
});
