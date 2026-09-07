// Final Step 12 Fix Pass §P0-4: adherence must be computed by exact
// calendar-date enumeration — reusing the SAME per-week override
// resolution the real weekly-programming pipeline already uses
// (WeekActivityOverridesRepo + applyWeekOverrides via
// enumerateTrainingOpportunityDates) — never an approximate
// phaseDays/7 * trainingDaysCount estimate. No future dates, no
// extrapolation beyond the phase's own boundary, and an intentional
// current-week override is honored conservatively (never counted as a
// missed opportunity).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { WEEKDAYS, type Weekday } from '../../src/contracts/types.js';
import { weekdayOfDate, programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { addDays } from '../../src/engine/dateMath.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

let db: Database.Database;

function nextWeekday(fromDate: string, target: Weekday): string {
  let d = fromDate;
  while (weekdayOfDate(d) !== target) d = addDays(d, 1);
  return d;
}

function setupProfile(trainingDays: readonly Weekday[]) {
  const user = new UsersRepo(db).getOrCreateDefault();
  return new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: [...trainingDays],
    preferred_split: null,
    default_session_duration_minutes: 90,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 120,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
}

function logCompletedGymSession(date: string) {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: 'back-squat',
    order: 1,
    role: 'primary',
    sets: [{ set_number: 1, weight: 80, reps: 8, completed: true }],
  });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — complete week, exact count', () => {
  it('7 real training days in the window with 5 real attended days gives an exact 5/7 adherence ratio', () => {
    setupProfile(WEEKDAYS); // every day is a training opportunity
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const start = '2026-08-03';
    const asOfDate = addDays(start, 6); // exactly 7 real days: start..start+6
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: start, review_date: addDays(start, 90), package_level: 'complete' });

    const attendedDates = [start, addDays(start, 1), addDays(start, 2), addDays(start, 4), addDays(start, 6)]; // 5 of 7
    for (const d of attendedDates) logCompletedGymSession(d);

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);
    expect(evidence.adherence_ratio).toBeCloseTo(5 / 7, 10);
  });
});

describe('Test B — partial week, exact count', () => {
  it('only 3 real days have elapsed in the window — the exact count, never a fractional-week estimate', () => {
    setupProfile(WEEKDAYS);
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const start = '2026-08-03';
    const asOfDate = addDays(start, 2); // exactly 3 real days: start, start+1, start+2
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: start, review_date: addDays(start, 90), package_level: 'complete' });

    logCompletedGymSession(start);
    logCompletedGymSession(addDays(start, 2));

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);
    expect(evidence.adherence_ratio).toBeCloseTo(2 / 3, 10);
  });
});

describe('Test C — multi-week, exact count', () => {
  it('a 21-day (3-week) window with 10 real attended days gives an exact 10/21 ratio, not a weeks x days-per-week estimate', () => {
    setupProfile(WEEKDAYS);
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const start = '2026-08-03';
    const asOfDate = addDays(start, 20); // exactly 21 real days
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: start, review_date: addDays(start, 90), package_level: 'complete' });

    for (let i = 0; i < 10; i++) logCompletedGymSession(addDays(start, i));

    const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);
    expect(evidence.adherence_ratio).toBeCloseTo(10 / 21, 10);
  });
});

describe('Test D — future dates excluded, never extrapolated', () => {
  it('the adherence window never extends past the phase review_date even when asOfDate is much later, and a session logged beyond it is never counted', () => {
    setupProfile(WEEKDAYS);
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const start = '2026-08-03';
    const reviewDate = addDays(start, 5); // phase's own boundary: exactly 6 real days (start..start+5)
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: start, review_date: reviewDate, package_level: 'complete' });

    // Attend every real day within the phase's own boundary...
    for (let i = 0; i <= 5; i++) logCompletedGymSession(addDays(start, i));
    // ...plus a session logged well beyond the phase's own review_date,
    // which a naive implementation might wrongly fold into the window.
    logCompletedGymSession(addDays(start, 30));

    const evidence = gatherReviewEvidence(db, goal, phase, addDays(start, 50)); // asOfDate far beyond review_date
    // Exactly 6/6 — the phase boundary caps the window, so the extra
    // future-relative session neither inflates the numerator nor the
    // denominator.
    expect(evidence.adherence_ratio).toBeCloseTo(1, 10);
  });
});

describe('Test E — an intentional current-week override is handled conservatively, never as an automatic failure', () => {
  it('a day the user explicitly moved OFF gym for that week is excluded from real opportunities entirely, never counted as missed', () => {
    const profile = setupProfile(['monday']);
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const monday = nextWeekday('2026-08-01', 'monday');
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: monday, review_date: addDays(monday, 90), package_level: 'complete' });

    // Without any override: Monday is a real opportunity, unattended ->
    // a real ratio of 0 (a genuine miss).
    const withoutOverride = gatherReviewEvidence(db, goal, phase, monday);
    expect(withoutOverride.adherence_ratio).toBe(0);

    // The user explicitly overrides THIS week's Monday off gym — an
    // intentional, real decision, not a missed session.
    new WeekActivityOverridesRepo(db).setOverride(profile.id, programmingWeekStart(monday), 'monday', 'unselected');

    const withOverride = gatherReviewEvidence(db, goal, phase, monday);
    // Conservative: no real opportunity existed that week at all, so
    // this is null (insufficient data), never a punitive 0% — the
    // override is not automatically treated as a failure.
    expect(withOverride.adherence_ratio).toBeNull();
  });
});
