// Step 12 Remediation §5 (P1): goal-review recovery evidence must reuse
// the real "last trained"/"recent badminton" computations the actual
// weekly-programming pipeline uses (workoutBuilder.ts's
// gatherTargetTouches/gatherRecentBadmintonSignal), never a fabricated
// simplified snapshot built from a session's own free-text `role` field
// or a hardcoded `recent_badminton: null`.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BadmintonSessionDetailsRepo } from '../../src/repositories/badmintonSessionDetailsRepo.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

let db: Database.Database;

function logCompletedSession(sessionsRepo: WorkoutSessionsRepo, date: string, exerciseId: string, weight: number, reps: number) {
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: exerciseId,
    order: 1,
    role: 'primary', // deliberately "primary" at the SESSION level even when irrelevant to the goal's target below
    sets: [{ set_number: 1, weight, reps, completed: true }],
  });
  return session;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — an unrelated exercise logged as the session\'s own "primary" never falsely flags recovery for a different target', () => {
  it('a same-day squat session (irrelevant to a triceps goal) does not trigger a false same-day "already trained" recovery flag', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    // Logged with role: 'primary' at the session level, but back-squat
    // has no real triceps relationship (primary OR secondary) at all —
    // the old bug (checking the session's own role field) would have
    // wrongly treated this as "the triceps target was trained today".
    logCompletedSession(sessionsRepo, '2026-09-01', 'back-squat', 100, 8);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.recovery_flagged).toBe(false);
  });
});

describe('Test B — a real same-day touch of the actual goal target correctly flags recovery', () => {
  it('a same-day cable-pushdown session (real triceps-primary) triggers the real same-day "already trained" recovery flag', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    logCompletedSession(sessionsRepo, '2026-09-01', 'cable-pushdown', 25, 10);

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.recovery_flagged).toBe(true);
  });
});

describe('Test C — real logged badminton data feeds recovery evidence, never a hardcoded null', () => {
  it('a real high-intensity badminton session logged on asOfDate triggers the real recovery reduce signal', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);

    const badmintonSession = sessionsRepo.createSession({ date: '2026-09-01', session_type: 'badminton', status: 'completed' });
    new BadmintonSessionDetailsRepo(db).record({ workout_session_id: badmintonSession.session_id, intensity: 'high' });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.recovery_flagged).toBe(true);
  });
});
