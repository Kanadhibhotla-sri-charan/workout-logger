// Recovery+Fallback Fix §1: goal-review recovery evidence must use REAL
// recent rolling exposure, never the phase-wide average pretending to be
// a 14-day rolling window. `rolling_exposure_units` (exposed on
// GoalReviewEvidence) and `actual_weekly_exposure` (the pre-existing
// phase-wide average) are intentionally different measurements — this
// file proves they diverge when the underlying data does, and that the
// rolling figure is real, target-specific, actual-only, and never leaks
// future data.

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

describe('Test A — recent rolling exposure differs from the phase-wide average', () => {
  it('a materially higher recent 14-day exposure is reflected in rolling_exposure_units without dragging the phase average up to match', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-30', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const asOfDate = '2026-08-29'; // 28 days elapsed -> phase_weeks_elapsed = 4

    // Older weeks, well before the 14-day rolling window ending 2026-08-29
    // (which starts 2026-08-16) — real, but modest, exposure.
    logCompletedSets(sessionsRepo, '2026-08-03', 'cable-pushdown', 2);
    logCompletedSets(sessionsRepo, '2026-08-08', 'cable-pushdown', 2);
    logCompletedSets(sessionsRepo, '2026-08-13', 'cable-pushdown', 2);
    // A real, substantially higher session inside the rolling window.
    logCompletedSets(sessionsRepo, '2026-08-29', 'cable-pushdown', 20);

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);

    expect(evidence.phase_total_primary_sets).toBe(26); // 2+2+2+20 across the whole phase
    expect(evidence.phase_weeks_elapsed).toBeCloseTo(4, 10);
    expect(evidence.actual_weekly_exposure).toBeCloseTo(26 / 4, 10); // real phase-wide average, unchanged

    // The real rolling figure reflects ONLY the 14 real calendar days
    // ending at asOfDate (2026-08-16..2026-08-29) — the three older
    // sessions fall outside it.
    expect(evidence.rolling_exposure_units).toBe(20);

    // This is the exact regression this fix closes: the two figures
    // must never be equal here, since they are genuinely different by
    // construction — a revert to `rolling_exposure_units: actual_weekly_exposure`
    // would make this fail (26/4 = 6.5 !== 20).
    expect(evidence.rolling_exposure_units).not.toBe(evidence.actual_weekly_exposure);
  });
});

describe('Test B — no recent training gives a real zero rolling exposure, never the phase average', () => {
  it('real phase history exists, but nothing in the last 14 days — rolling exposure is genuinely 0', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-30', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const asOfDate = '2026-08-29'; // rolling window: 2026-08-16..2026-08-29

    // All real sessions fall BEFORE the rolling window.
    logCompletedSets(sessionsRepo, '2026-08-03', 'cable-pushdown', 3);
    logCompletedSets(sessionsRepo, '2026-08-08', 'cable-pushdown', 3);

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);

    expect(evidence.actual_weekly_exposure).toBeGreaterThan(0); // real phase history exists
    expect(evidence.rolling_exposure_units).toBe(0); // but nothing recent — never substituted with the phase average
  });
});

describe('Test C — exposure logged after asOfDate never enters the rolling calculation', () => {
  it('a session dated after asOfDate is excluded, even though it is within what would otherwise be a 14-day window', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-30', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const asOfDate = '2026-08-29';

    logCompletedSets(sessionsRepo, '2026-08-20', 'cable-pushdown', 10); // real, inside the rolling window
    logCompletedSets(sessionsRepo, '2026-09-05', 'cable-pushdown', 30); // AFTER asOfDate — must never count

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);

    expect(evidence.rolling_exposure_units).toBe(10);
  });
});

describe('Test D — rolling exposure is target-specific, isolated from other targets', () => {
  it('real recent quads exposure never contaminates a triceps goal\'s rolling exposure', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-30', package_level: 'complete' });
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const asOfDate = '2026-08-29';

    // Real, substantial, RECENT quads exposure via back-squat — quads
    // primary, secondary adductors/erectors/trunk musculature — no real
    // triceps relationship at all (primary or secondary).
    logCompletedSets(sessionsRepo, '2026-08-25', 'back-squat', 15);

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);

    expect(evidence.rolling_exposure_units).toBe(0);
  });
});
