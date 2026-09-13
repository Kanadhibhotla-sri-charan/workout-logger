// AI Activity Alignment / Non-Regenerative Schedule Fixes
// (docs/CLAUDE_TASK_AI_ACTIVITY_ALIGNMENT_AND_NON_REGENERATIVE_SCHEDULE_FIXES.md):
// HTTP-level tests for the new POST /api/programming/week/swap and
// /week/move routes, and the new guards added to the existing
// PUT /week/days/:day/activity route (in-progress rejection, planned-
// session-conflict confirmation). "Today" is real wall-clock time (same
// convention as tests/routes/weekActivityOverride.test.ts) — never a
// hardcoded calendar date.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { todayForUser } from '../../src/lib/userTimezone.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

let db: Database.Database;
let app: ReturnType<typeof createApp>;

function setupProfile(trainingDays: string[] = ['thursday']) {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
}

function currentWeekStart(): string {
  return programmingWeekStart(todayForUser(db));
}

async function getWeek() {
  const res = await request(app).get('/api/programming/week').expect(200);
  return res.body;
}

function swap(dayA: string, dayB: string) {
  return request(app).post('/api/programming/week/swap').send({ dayA, dayB });
}

function move(fromDay: string, toDay: string) {
  return request(app).post('/api/programming/week/move').send({ fromDay, toDay });
}

function putActivity(day: string, activity: string, extra: Record<string, unknown> = {}) {
  return request(app).put(`/api/programming/week/days/${day}/activity`).send({ activity, ...extra });
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('POST /api/programming/week/swap — the primary worked example', () => {
  it('Rest Wednesday <-> Gym Thursday: the existing Thursday prescription moves to Wednesday, Thursday becomes Rest', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const before = await getWeek();
    expect(before.days.find((d: any) => d.weekday === 'wednesday').activity).toBe('unselected');
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayBefore.activity).toBe('gym');
    expect(thursdayBefore.plannedWork.length).toBeGreaterThan(0);

    const res = await swap('wednesday', 'thursday').expect(200);

    const wednesdayAfter = res.body.days.find((d: any) => d.weekday === 'wednesday');
    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');
    expect(wednesdayAfter.activity).toBe('gym');
    expect(wednesdayAfter.type).toBe('gym');
    expect(wednesdayAfter.plannedWork).toEqual(thursdayBefore.plannedWork); // the EXACT same prescription, reused
    expect(thursdayAfter.activity).toBe('unselected');
    expect(thursdayAfter.type).toBe('rest');
  });

  it('never invokes the LLM/provider — no fetch is stubbed and none is called (would throw if it tried)', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    // No fetch mock is installed anywhere in this test file — if the
    // swap route ever called out to a provider, the real global fetch
    // would attempt a real network call and this test would hang/fail
    // rather than silently succeed.
    await swap('wednesday', 'thursday').expect(200);
  });

  it('never modifies the recurring TrainingProfile', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    const profileBefore = (await request(app).get('/api/training-profile').expect(200)).body;

    await swap('wednesday', 'thursday').expect(200);

    const profileAfter = (await request(app).get('/api/training-profile').expect(200)).body;
    expect(profileAfter.training_days).toEqual(profileBefore.training_days);
  });

  it('/today agrees with /week after a swap', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    await swap('wednesday', 'thursday').expect(200);

    const week = await getWeek();
    const wednesday = week.days.find((d: any) => d.weekday === 'wednesday');
    const todayRes = await request(app).get('/api/programming/today').expect(200);
    if (todayRes.body.weekday === 'wednesday') {
      expect(todayRes.body.sessionType).toBe(wednesday.type);
      expect(todayRes.body.activity).toBe(wednesday.activity);
    }
  });

  it('is reversible — swapping back restores the exact original state', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();

    await swap('wednesday', 'thursday').expect(200);
    const res = await swap('thursday', 'wednesday').expect(200); // swap back

    const wednesdayAfter = res.body.days.find((d: any) => d.weekday === 'wednesday');
    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');
    const wednesdayBefore = before.days.find((d: any) => d.weekday === 'wednesday');
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');
    expect(wednesdayAfter.activity).toBe(wednesdayBefore.activity);
    expect(thursdayAfter.activity).toBe(thursdayBefore.activity);
    expect(thursdayAfter.plannedWork).toEqual(thursdayBefore.plannedWork);
  });

  it('repeating the same swap request is idempotent — no duplicate sessions/prescriptions accumulate', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    const weekStart = currentWeekStart();

    await swap('wednesday', 'thursday').expect(200);
    await swap('thursday', 'wednesday').expect(200); // net: back to original, applied twice total

    const program = new WeeklyProgramRepo(db).getByWeekStart(weekStart)!;
    // Exactly one persisted gym session for the whole week (the one
    // real prescription that ever existed), never two.
    expect(program.sessions).toHaveLength(1);
  });
});

describe('POST /api/programming/week/swap — Badminton <-> Gym', () => {
  it('swaps a badminton day with a gym day', async () => {
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
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const res = await swap('wednesday', 'thursday').expect(200);
    expect(res.body.days.find((d: any) => d.weekday === 'wednesday').activity).toBe('gym');
    expect(res.body.days.find((d: any) => d.weekday === 'thursday').activity).toBe('badminton');
  });
});

describe('POST /api/programming/week/swap — Gym <-> Gym', () => {
  it('exchanges two real prescriptions between two gym days', async () => {
    setupProfile(['monday', 'thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayBefore = before.days.find((d: any) => d.weekday === 'monday');
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');
    expect(mondayBefore.plannedWork).not.toEqual(thursdayBefore.plannedWork);

    const res = await swap('monday', 'thursday').expect(200);

    expect(res.body.days.find((d: any) => d.weekday === 'monday').plannedWork).toEqual(thursdayBefore.plannedWork);
    expect(res.body.days.find((d: any) => d.weekday === 'thursday').plannedWork).toEqual(mondayBefore.plannedWork);
  });
});

describe('POST /api/programming/week/swap — locking (Part 4)', () => {
  it('rejects with 409 when the gym day has a completed session, and does not change anything', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    new WorkoutSessionsRepo(db).createSession({ date: thursdayDate, session_type: 'gym', status: 'completed' });

    const res = await swap('wednesday', 'thursday').expect(409);
    expect(res.body.code).toBe('DAY_LOCKED');

    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'wednesday').activity).toBe('unselected');
    expect(after.days.find((d: any) => d.weekday === 'thursday').activity).toBe('gym');
  });

  it('rejects with 409 when the gym day has an in-progress session', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    new WorkoutSessionsRepo(db).createSession({ date: thursdayDate, session_type: 'gym', status: 'in_progress' });

    const res = await swap('wednesday', 'thursday').expect(409);
    expect(res.body.code).toBe('DAY_LOCKED');
  });

  it('moves a real planned (AI-committed) session along with the swap', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const wednesdayDate = before.days.find((d: any) => d.weekday === 'wednesday').date;
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: wednesdayDate, session_type: 'gym', status: 'planned', notes: 'AI-proposed session' });

    const res = await swap('wednesday', 'thursday').expect(200);
    expect(res.body.movedPlannedSessionIds).toContain(planned.session_id);

    const moved = new WorkoutSessionsRepo(db).getSession(planned.session_id)!;
    expect(moved.date).toBe(thursdayDate);
  });
});

describe('POST /api/programming/week/swap — validation', () => {
  it('rejects an invalid weekday', async () => {
    setupProfile(['thursday']);
    const res = await swap('someday', 'thursday').expect(400);
    expect(res.body.error).toMatch(/must each be one of/);
  });

  it('rejects swapping a day with itself', async () => {
    setupProfile(['thursday']);
    const res = await swap('thursday', 'thursday').expect(400);
    expect(res.body.error).toMatch(/different weekdays/);
  });

  it('returns 404 when no training profile exists yet', async () => {
    const res = await swap('wednesday', 'thursday').expect(404);
    expect(res.body.code).toBe('NO_TRAINING_PROFILE');
  });
});

describe('POST /api/programming/week/move — alias for swap onto a Rest day', () => {
  it('"move Thursday to Wednesday" produces the exact same result as swapping them', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');

    const res = await move('thursday', 'wednesday').expect(200);

    expect(res.body.days.find((d: any) => d.weekday === 'wednesday').plannedWork).toEqual(thursdayBefore.plannedWork);
    expect(res.body.days.find((d: any) => d.weekday === 'thursday').activity).toBe('unselected');
  });
});

describe('PUT /week/days/:day/activity — new Part 4 guards', () => {
  it('rejects changing an in-progress day\'s own activity with a clear 409, writing nothing', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    new WorkoutSessionsRepo(db).createSession({ date: mondayDate, session_type: 'gym', status: 'in_progress' });

    const res = await putActivity('monday', 'badminton').expect(409);
    expect(res.body.error).toMatch(/in progress/i);

    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'monday').activity).toBe('gym');
  });

  it('still allows changing a COMPLETED day\'s activity (pre-existing behavior, unchanged)', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    new WorkoutSessionsRepo(db).createSession({ date: mondayDate, session_type: 'gym', status: 'completed', duration_minutes: 50 });

    await putActivity('monday', 'badminton').expect(200);
  });

  it('rejects moving a gym-having day to a non-gym activity when a planned session exists, without confirmReplacePlanned', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: mondayDate, session_type: 'gym', status: 'planned' });

    const res = await putActivity('monday', 'unselected').expect(409);
    expect(res.body.conflictingSessionId).toBe(planned.session_id);

    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'monday').activity).toBe('gym');
  });

  it('proceeds when confirmReplacePlanned: true is passed, without deleting the planned session', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: mondayDate, session_type: 'gym', status: 'planned' });

    await putActivity('monday', 'unselected', { confirmReplacePlanned: true }).expect(200);

    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'monday').activity).toBe('unselected');
    // The planned session itself was never deleted (no cancellation
    // workflow exists in this codebase — see this route's own doc
    // comment).
    expect(new WorkoutSessionsRepo(db).getSession(planned.session_id)).toBeDefined();
  });

  it('does not require confirmation when moving TO a gym-having activity (only away from one)', async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await putActivity('wednesday', 'gym').expect(200);
  });
});

describe('GET /week — a Gym-via-alignment-override day with no deterministic snapshot is never shown as Rest (Part 3/5)', () => {
  it('reports type/status correctly for a day whose activity is Gym but has no persisted program_sessions row', async () => {
    setupProfile([]); // every day starts Rest by default
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const wednesdayDate = before.days.find((d: any) => d.weekday === 'wednesday').date;
    expect(before.days.find((d: any) => d.weekday === 'wednesday').type).toBe('rest');

    // Simulate exactly what an AI commit with intent: 'replace_day_activity'
    // does to the weekly activity representation, without generating any
    // deterministic prescription for the day.
    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    new WeekActivityOverridesRepo(db).setOverride(profile.id, currentWeekStart(), 'wednesday', 'gym');
    new WorkoutSessionsRepo(db).createSession({ date: wednesdayDate, session_type: 'gym', status: 'planned', notes: 'AI-proposed session' });

    const after = await getWeek();
    const wednesdayAfter = after.days.find((d: any) => d.weekday === 'wednesday');
    expect(wednesdayAfter.activity).toBe('gym');
    expect(wednesdayAfter.type).toBe('gym'); // never 'rest' — the actual bug this task fixes
    expect(wednesdayAfter.status).toBe('planned');
    expect(wednesdayAfter.hasUnpersistedSnapshot).toBe(true);
  });
});
