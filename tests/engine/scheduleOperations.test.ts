// AI Activity Alignment / Non-Regenerative Schedule Fixes
// (docs/CLAUDE_TASK_AI_ACTIVITY_ALIGNMENT_AND_NON_REGENERATIVE_SCHEDULE_FIXES.md
// Part 1/2/4): low-level tests of swapDayActivities against the real
// repositories, bypassing the HTTP layer and the deterministic planner
// entirely — proving the swap itself (activity + persisted prescription
// + planned-session-date) never touches either, and behaves correctly
// under the required test matrix's swap scenarios. Complements
// tests/routes/scheduleOperations.test.ts's HTTP-level coverage.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { ScheduleOperationError, swapDayActivities } from '../../src/engine/scheduleOperations.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../src/lib/dailyActivity.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const WEEK_START = '2026-08-31'; // a real Monday

let db: Database.Database;
let profileId: string;

function setupProfile(trainingDays: string[] = ['thursday']) {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
  profileId = profile.id;
}

function effectiveActivity(day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday') {
  const profile = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!;
  const overrides = new WeekActivityOverridesRepo(db).get(profile.id, WEEK_START);
  const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
  return deriveDailyActivity(day, effective.trainingDays, effective.otherActivitySchedule);
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('swapDayActivities — the primary worked example (Rest Wednesday <-> Gym Thursday)', () => {
  it('swaps activities and moves the persisted prescription, without ever generating a new one', () => {
    setupProfile(['thursday']);
    expect(effectiveActivity('wednesday')).toBe('unselected');
    expect(effectiveActivity('thursday')).toBe('gym');

    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    const thursdaySnapshot = { plannedWork: [{ exercise_id: 'back-squat', target_id: 'quads', target_type: 'physique_target', sets: 3, reps_min: 8, reps_max: 12 }] };
    programRepo.upsertSession(program.id, 3, 'Legs', 'gym', thursdaySnapshot); // Thursday = day_index 3

    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');

    expect(effectiveActivity('wednesday')).toBe('gym');
    expect(effectiveActivity('thursday')).toBe('unselected');

    const after = programRepo.getByWeekStart(WEEK_START)!;
    expect(after.sessions.find((s) => s.day_index === 3)).toBeUndefined(); // Thursday's row is gone
    const wednesdaySession = after.sessions.find((s) => s.day_index === 2)!; // Wednesday = day_index 2
    expect(wednesdaySession).toBeDefined();
    expect(wednesdaySession.snapshot).toEqual(thursdaySnapshot);
    expect(wednesdaySession.name).toBe('Legs');
  });

  it('never touches the recurring TrainingProfile', () => {
    setupProfile(['thursday']);
    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');
    const profile = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!;
    expect(profile.training_days).toEqual(['thursday']);
  });

  it('is idempotent/reversible — swapping twice restores the original state exactly', () => {
    setupProfile(['thursday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    const snapshot = { plannedWork: [{ exercise_id: 'back-squat', target_id: 'quads', target_type: 'physique_target', sets: 3, reps_min: 8, reps_max: 12 }] };
    programRepo.upsertSession(program.id, 3, 'Legs', 'gym', snapshot);

    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');
    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');

    expect(effectiveActivity('wednesday')).toBe('unselected');
    expect(effectiveActivity('thursday')).toBe('gym');
    const after = programRepo.getByWeekStart(WEEK_START)!;
    expect(after.sessions.find((s) => s.day_index === 2)).toBeUndefined();
    expect(after.sessions.find((s) => s.day_index === 3)!.snapshot).toEqual(snapshot);
    // No duplicate rows accumulated from the two swaps.
    expect(after.sessions).toHaveLength(1);
  });

  it('repeating the exact same swap request twice in a row (not reversing it) never creates duplicate sessions', () => {
    setupProfile(['thursday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    programRepo.upsertSession(program.id, 3, 'Legs', 'gym', { plannedWork: [] });

    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');
    swapDayActivities(db, WEEK_START, 'thursday', 'wednesday'); // same pair, argument order flipped — same net effect as re-issuing it

    const after = programRepo.getByWeekStart(WEEK_START)!;
    expect(after.sessions).toHaveLength(1);
  });
});

describe('swapDayActivities — both days already Gym (Monday <-> Thursday)', () => {
  it('exchanges two real prescriptions, each preserved exactly', () => {
    setupProfile(['monday', 'thursday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    const mondaySnapshot = { plannedWork: [{ exercise_id: 'bench-press', target_id: 'mid-pec', target_type: 'physique_target', sets: 3, reps_min: 6, reps_max: 12 }] };
    const thursdaySnapshot = { plannedWork: [{ exercise_id: 'back-squat', target_id: 'quads', target_type: 'physique_target', sets: 3, reps_min: 8, reps_max: 12 }] };
    programRepo.upsertSession(program.id, 0, 'Push', 'gym', mondaySnapshot);
    programRepo.upsertSession(program.id, 3, 'Legs', 'gym', thursdaySnapshot);

    swapDayActivities(db, WEEK_START, 'monday', 'thursday');

    expect(effectiveActivity('monday')).toBe('gym');
    expect(effectiveActivity('thursday')).toBe('gym');
    const after = programRepo.getByWeekStart(WEEK_START)!;
    expect(after.sessions.find((s) => s.day_index === 0)!.snapshot).toEqual(thursdaySnapshot);
    expect(after.sessions.find((s) => s.day_index === 3)!.snapshot).toEqual(mondaySnapshot);
  });
});

describe('swapDayActivities — badminton day involved', () => {
  it('swaps Badminton Wednesday with Gym Thursday', () => {
    setupProfile(['thursday']);
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['thursday'] as any,
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [{ day: 'wednesday', activity_type: 'badminton', notes: null }],
    });
    expect(effectiveActivity('wednesday')).toBe('badminton');

    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');

    expect(effectiveActivity('wednesday')).toBe('gym');
    expect(effectiveActivity('thursday')).toBe('badminton');
  });
});

describe('swapDayActivities — no persisted prescription on either day', () => {
  it('just swaps the activity — no crash, nothing to move', () => {
    setupProfile([]);
    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');
    expect(effectiveActivity('wednesday')).toBe('unselected');
    expect(effectiveActivity('thursday')).toBe('unselected');
  });

  it('works even when the week has never been persisted at all (no programs row yet)', () => {
    setupProfile(['thursday']);
    expect(new WeeklyProgramRepo(db).getByWeekStart(WEEK_START)).toBeUndefined();
    expect(() => swapDayActivities(db, WEEK_START, 'wednesday', 'thursday')).not.toThrow();
    expect(effectiveActivity('wednesday')).toBe('gym');
  });
});

describe('swapDayActivities — moves a real planned (AI-committed) session', () => {
  it('moves a planned workout_sessions row\'s date along with the swap', () => {
    setupProfile(['thursday']);
    const thursdayDate = '2026-09-03';
    const wednesdayDate = '2026-09-02';
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const planned = sessionsRepo.createSession({ date: thursdayDate, session_type: 'gym', status: 'planned', notes: 'AI-proposed session' });

    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');

    const moved = sessionsRepo.getSession(planned.session_id)!;
    expect(moved.date).toBe(wednesdayDate);
  });

  it('reports the moved session id in its result', () => {
    setupProfile(['thursday']);
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const planned = sessionsRepo.createSession({ date: '2026-09-03', session_type: 'gym', status: 'planned' });

    const result = swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');
    expect(result.movedPlannedSessionIds).toEqual([planned.session_id]);
  });

  it('moves BOTH sides correctly when each day has its own planned session — neither is silently moved back onto itself', () => {
    // Regression test: an earlier implementation read+moved dateA's
    // planned sessions, THEN read dateB's list — which, by that point,
    // already included the just-moved session, and moved it straight
    // back, silently undoing half the swap.
    setupProfile(['thursday']);
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const wednesdayDate = '2026-09-02';
    const thursdayDate = '2026-09-03';
    const plannedOnWednesday = sessionsRepo.createSession({ date: wednesdayDate, session_type: 'gym', status: 'planned', notes: 'wednesday-original' });
    const plannedOnThursday = sessionsRepo.createSession({ date: thursdayDate, session_type: 'gym', status: 'planned', notes: 'thursday-original' });

    const result = swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');

    expect(sessionsRepo.getSession(plannedOnWednesday.session_id)!.date).toBe(thursdayDate);
    expect(sessionsRepo.getSession(plannedOnThursday.session_id)!.date).toBe(wednesdayDate);
    expect(result.movedPlannedSessionIds.sort()).toEqual([plannedOnThursday.session_id, plannedOnWednesday.session_id].sort());
  });
});

describe('swapDayActivities — locking (Part 4)', () => {
  it('rejects the whole swap when the gym day has a completed session, writing nothing', () => {
    setupProfile(['thursday']);
    const sessionsRepo = new WorkoutSessionsRepo(db);
    sessionsRepo.createSession({ date: '2026-09-03', session_type: 'gym', status: 'completed' });

    expect(() => swapDayActivities(db, WEEK_START, 'wednesday', 'thursday')).toThrow(ScheduleOperationError);
    expect(effectiveActivity('wednesday')).toBe('unselected'); // untouched
    expect(effectiveActivity('thursday')).toBe('gym'); // untouched
  });

  it('rejects the whole swap when the gym day has an in-progress session', () => {
    setupProfile(['thursday']);
    new WorkoutSessionsRepo(db).createSession({ date: '2026-09-03', session_type: 'gym', status: 'in_progress' });

    try {
      swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');
      expect.unreachable('expected swapDayActivities to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleOperationError);
      expect((err as ScheduleOperationError).code).toBe('DAY_LOCKED');
    }
  });

  it('rejects when the OTHER (non-gym) day is locked too', () => {
    setupProfile(['thursday']);
    new WorkoutSessionsRepo(db).createSession({ date: '2026-09-02', session_type: 'badminton', status: 'completed' });
    expect(() => swapDayActivities(db, WEEK_START, 'wednesday', 'thursday')).toThrow(ScheduleOperationError);
  });
});

describe('swapDayActivities — validation', () => {
  it('rejects swapping a day with itself', () => {
    setupProfile(['thursday']);
    expect(() => swapDayActivities(db, WEEK_START, 'thursday', 'thursday')).toThrow(ScheduleOperationError);
  });

  it('rejects when no training profile exists yet', () => {
    expect(() => swapDayActivities(db, WEEK_START, 'wednesday', 'thursday')).toThrow(ScheduleOperationError);
  });
});
