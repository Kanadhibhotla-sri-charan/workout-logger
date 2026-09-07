// Step 12 Remediation §2 (P0): goal-review performance evidence must be
// target-specific — an exercise's contribution to a goal's
// performance_trend is now decided by that exercise's REAL Blueprint
// target relationship to the goal's own target (roleFor, the same
// authoritative lookup exerciseSelector.ts already uses), never by the
// logged session's own free-text `role` field (which only describes an
// exercise's role WITHIN its session, not which target it trains).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

let db: Database.Database;

function logCompletedSession(sessionsRepo: WorkoutSessionsRepo, date: string, exerciseId: string, weight: number, reps: number) {
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: exerciseId,
    order: 1,
    role: 'primary', // the SESSION's own role tag — deliberately "primary" even for irrelevant exercises below, to prove this field is no longer what evidence relies on
    sets: [
      { set_number: 1, weight, reps, completed: true },
      { set_number: 2, weight, reps, completed: true },
    ],
  });
  return session;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — relevant performance included', () => {
  it('a triceps goal\'s performance evidence reflects real improvement in a real triceps exercise', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    logCompletedSession(sessionsRepo, '2026-08-03', 'cable-pushdown', 20, 10);
    logCompletedSession(sessionsRepo, '2026-08-31', 'cable-pushdown', 30, 10); // real, substantial improvement

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.performance_trend).toBe('improving');
  });
});

describe('Test B — unrelated performance excluded', () => {
  it('a triceps goal\'s performance evidence is UNCHANGED by a substantial squat improvement', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    // Only squat (quads) performance logged, logged with role: 'primary'
    // at the session level — the exact scenario the old buggy code would
    // have wrongly counted as triceps performance evidence.
    logCompletedSession(sessionsRepo, '2026-08-03', 'back-squat', 80, 8);
    logCompletedSession(sessionsRepo, '2026-08-31', 'back-squat', 120, 8); // huge real improvement, but irrelevant

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.performance_trend).toBe('insufficient_data'); // no real triceps data exists at all
  });
});

describe('Test C — compound relevance (secondary never treated as direct)', () => {
  it('an exercise with only a SECONDARY relationship to the goal target contributes to exposure but never to direct performance evidence', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    // flat-barbell-bench-press: chest is primary, triceps is only
    // secondary (established in tests/engine/exposureCoefficientsTraceability.test.ts
    // and coreEngineSurgicalFixPassTests.test.ts) — real secondary
    // exposure exists, but it must never count as direct performance
    // evidence for the triceps goal.
    logCompletedSession(sessionsRepo, '2026-08-03', 'flat-barbell-bench-press', 60, 8);
    logCompletedSession(sessionsRepo, '2026-08-31', 'flat-barbell-bench-press', 90, 8);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.performance_trend).toBe('insufficient_data'); // secondary-only relationship never becomes direct performance evidence
  });
});

describe('Test D — multiple relevant exercises, no leak from an unrelated one', () => {
  it('performance evidence aggregates several real triceps-primary exercises while a concurrently-improving unrelated exercise never leaks in', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    logCompletedSession(sessionsRepo, '2026-08-03', 'cable-pushdown', 20, 10);
    logCompletedSession(sessionsRepo, '2026-08-10', 'close-grip-bench-press', 40, 8); // also real triceps-primary
    logCompletedSession(sessionsRepo, '2026-08-24', 'back-squat', 200, 8); // unrelated, wildly improving in parallel — must never leak in
    logCompletedSession(sessionsRepo, '2026-08-31', 'cable-pushdown', 35, 10);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.performance_trend).toBe('improving');
  });
});
