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

// Fix 7: prescriptionPolicy is now required — 'regenerate' as the
// helper's own default preserves every pre-existing call site's
// original (pre-Fix-7) behavior; a test specifically about the 'reuse'
// policy passes it explicitly via `extra`.
function putActivity(day: string, activity: string, extra: Record<string, unknown> = {}) {
  return request(app).put(`/api/programming/week/days/${day}/activity`).send({ activity, prescriptionPolicy: 'regenerate', ...extra });
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

// Activity Scheduling and AI Alignment Fixes, Fix 4 (Option A): the
// prior release exposed `/week/move` as a thin, misleadingly-named alias
// for `/week/swap` — removed entirely rather than continuing to claim
// move semantics it never implemented (see scheduleOperations.ts's own
// ScheduleChangeMode doc comment). This route must not exist.
describe('POST /api/programming/week/move — removed (Fix 4)', () => {
  it('no longer exists — 404, not a swap alias', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const res = await move('thursday', 'wednesday');
    expect(res.status).toBe(404);
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

  it('Fix 3: rejects moving a gym-having day to a non-gym activity when a planned session exists — unconditionally, with no bypass', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: mondayDate, session_type: 'gym', status: 'planned' });

    const res = await putActivity('monday', 'unselected').expect(409);
    expect(res.body.conflictingSessionId).toBe(planned.session_id);
    expect(res.body.error).toMatch(/active planned workout session/i);

    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'monday').activity).toBe('gym');
  });

  it('Fix 3: there is no bypass field — passing the old confirmReplacePlanned: true no longer has any effect, still 409', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: mondayDate, session_type: 'gym', status: 'planned' });

    const res = await putActivity('monday', 'unselected', { confirmReplacePlanned: true }).expect(409);
    expect(res.body.conflictingSessionId).toBe(planned.session_id);

    // Never silently detached (Invariant 3): the day's activity is
    // untouched, and the planned session is untouched.
    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'monday').activity).toBe('gym');
    expect(new WorkoutSessionsRepo(db).getSession(planned.session_id)?.status).toBe('planned');
  });

  it('does not require confirmation when moving TO a gym-having activity (only away from one)', async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await putActivity('wednesday', 'gym').expect(200);
  });
});

describe('PUT /week/days/:day/activity — Fix 7: explicit prescriptionPolicy', () => {
  it('rejects a request with prescriptionPolicy omitted — 400, no silently-regenerating default', async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    const res = await request(app).put('/api/programming/week/days/wednesday/activity').send({ activity: 'gym' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prescriptionPolicy/);
  });

  it('rejects an invalid prescriptionPolicy value with 400', async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    const res = await putActivity('wednesday', 'gym', { prescriptionPolicy: 'invent_one' });
    expect(res.status).toBe(400);
  });

  it("'reuse' on a day with no existing gym prescription returns generationRequired, without calling the planner or writing the override", async () => {
    setupProfile([]); // every day starts Rest — nothing to reuse anywhere
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const res = await putActivity('wednesday', 'gym', { prescriptionPolicy: 'reuse' });
    expect(res.status).toBe(409);
    expect(res.body.generationRequired).toBe(true);

    const after = await getWeek();
    const wednesday = after.days.find((d: any) => d.weekday === 'wednesday');
    expect(wednesday.activity).toBe('unselected'); // override never written
    expect(wednesday.type).toBe('rest');
  });

  it("'reuse' on a day that already has a persisted gym prescription keeps that exact content and never regenerates", async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayBefore.plannedWork.length).toBeGreaterThan(0);

    // Re-applying the SAME activity via 'reuse' must keep the exact
    // persisted content (byte-for-byte) rather than recomputing it.
    const res = await putActivity('thursday', 'gym', { prescriptionPolicy: 'reuse' }).expect(200);
    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.plannedWork).toEqual(thursdayBefore.plannedWork);
  });

  it("'regenerate' on a day with no existing prescription generates one (pre-existing behavior, explicit now)", async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const res = await putActivity('wednesday', 'gym', { prescriptionPolicy: 'regenerate' }).expect(200);
    const wednesday = res.body.days.find((d: any) => d.weekday === 'wednesday');
    expect(wednesday.activity).toBe('gym');
    expect(wednesday.type).toBe('gym');
  });

  it('turning a day AWAY from gym succeeds regardless of prescriptionPolicy value (no prescription needed either way)', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await putActivity('thursday', 'unselected', { prescriptionPolicy: 'reuse' }).expect(200);
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
    // Fix 8: replaces the prior release's unconsumed
    // `hasUnpersistedSnapshot` flag with a user-facing `plannedSession`
    // field — a UI can show "a planned workout exists" and link to it,
    // without ever fabricating deterministic `plannedWork` data.
    expect(wednesdayAfter.hasUnpersistedSnapshot).toBeUndefined();
    expect(wednesdayAfter.plannedSession).toMatchObject({ source: 'ai', status: 'planned' });
    expect(typeof wednesdayAfter.plannedSession.id).toBe('string');
  });

  it('Fix 8: a deterministic gym day with a real started session reports plannedSession with source "deterministic"', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    const started = new WorkoutSessionsRepo(db).createSession({ date: thursdayDate, session_type: 'gym', status: 'in_progress' });

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.plannedSession).toMatchObject({ id: started.session_id, source: 'deterministic', status: 'in_progress' });
  });

  it('Fix 8: GET /today reports the SAME plannedSession as /week for an AI-committed today', async () => {
    setupProfile([]); // every day starts Rest by default
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const today = todayForUser(db);
    const weekStart = programmingWeekStart(today);
    await getWeek();

    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
    const todayOffset = Math.floor((new Date(today + 'T00:00:00Z').getTime() - new Date(weekStart + 'T00:00:00Z').getTime()) / 86400000);
    const todayWeekday = WEEKDAY_NAMES[todayOffset]!;
    new WeekActivityOverridesRepo(db).setOverride(profile.id, weekStart, todayWeekday, 'gym');
    const committed = new WorkoutSessionsRepo(db).createSession({ date: today, session_type: 'gym', status: 'planned', notes: 'AI-proposed session' });

    const weekAfter = await getWeek();
    const todayInWeek = weekAfter.days.find((d: any) => d.date === today);
    const todayRes = await request(app).get('/api/programming/today').expect(200);

    expect(todayRes.body.plannedSession).toEqual(todayInWeek.plannedSession);
    expect(todayRes.body.plannedSession).toMatchObject({ id: committed.session_id, source: 'ai', status: 'planned' });
  });

  it('Fix 8: a gym day with no real session at all reports plannedSession: null (nothing to open yet)', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.plannedSession).toBeNull();
  });
});
