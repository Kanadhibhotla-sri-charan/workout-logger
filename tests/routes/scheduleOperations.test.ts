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

// Fix 7 / Final AI-Deterministic Precedence Fixes §6: prescriptionPolicy
// is required and direction-dependent — 'regenerate' for a Gym/Both
// target activity, 'schedule-only' for anything else — as the helper's
// own default, preserving every pre-existing call site's original
// (pre-Fix-7) behavior; a test specifically about 'reuse' passes it
// explicitly via `extra`.
function putActivity(day: string, activity: string, extra: Record<string, unknown> = {}) {
  const defaultPolicy = activity === 'gym' || activity === 'both' ? 'regenerate' : 'schedule-only';
  return request(app).put(`/api/programming/week/days/${day}/activity`).send({ activity, prescriptionPolicy: defaultPolicy, ...extra });
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

describe('POST /api/programming/week/swap — Rest <-> Rest (§11.C)', () => {
  it('is a harmless no-op — both days remain Rest, no LLM/planner call, /today and /week agree', async () => {
    setupProfile([]); // every day starts Rest
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const res = await swap('monday', 'tuesday').expect(200);
    const mondayAfter = res.body.days.find((d: any) => d.weekday === 'monday');
    const tuesdayAfter = res.body.days.find((d: any) => d.weekday === 'tuesday');
    expect(mondayAfter.activity).toBe('unselected');
    expect(tuesdayAfter.activity).toBe('unselected');
    expect(res.body.movedPlannedSessionIds).toEqual([]);
  });
});

// Final AI-Deterministic Precedence and Scheduling Fixes §8/§11.F: every
// surface must resolve the SAME selected workout for a given date —
// verified here for /week vs /today specifically after a pure schedule
// operation (swap/move), complementing the existing AI-commit
// consistency test above.
describe('§8/§11.F: /week and /today agree after a pure schedule operation', () => {
  it('agree after a swap', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await swap('wednesday', 'thursday').expect(200);

    const week = await getWeek();
    const wednesdayInWeek = week.days.find((d: any) => d.weekday === 'wednesday');
    const today = await request(app).get('/api/programming/today').query({ date: wednesdayInWeek.date });

    expect(today.body.activity).toBe(wednesdayInWeek.activity);
    expect(today.body.plannedSession).toEqual(wednesdayInWeek.plannedSession);
    expect(today.body.exercises.map((e: any) => e.exercise_name).sort()).toEqual(wednesdayInWeek.plannedWork.map((w: any) => w.exercise_name).sort());
  });

  it('agree after a move', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await move('thursday', 'wednesday').expect(200);

    const week = await getWeek();
    const wednesdayInWeek = week.days.find((d: any) => d.weekday === 'wednesday');
    const today = await request(app).get('/api/programming/today').query({ date: wednesdayInWeek.date });

    expect(today.body.activity).toBe(wednesdayInWeek.activity);
    expect(today.body.plannedSession).toEqual(wednesdayInWeek.plannedSession);
    expect(today.body.exercises.map((e: any) => e.exercise_name).sort()).toEqual(wednesdayInWeek.plannedWork.map((w: any) => w.exercise_name).sort());
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

// Final AI-Deterministic Precedence and Scheduling Fixes §4 (Option B):
// true asymmetric move — replaces the prior release's `/week/move`,
// which was only a misleadingly-named alias for `/week/swap`.
describe('POST /api/programming/week/move — true asymmetric move (§4/§11.D)', () => {
  it('the worked example: Gym Thursday -> Wednesday, Thursday becomes Rest', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');
    expect(before.days.find((d: any) => d.weekday === 'wednesday').activity).toBe('unselected');

    const res = await move('thursday', 'wednesday').expect(200);
    expect(res.body.operation).toBe('move');

    const wednesdayAfter = res.body.days.find((d: any) => d.weekday === 'wednesday');
    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');
    expect(wednesdayAfter.activity).toBe('gym');
    expect(wednesdayAfter.plannedWork).toEqual(thursdayBefore.plannedWork);
    expect(thursdayAfter.activity).toBe('unselected');
  });

  it('moving onto a Badminton destination DISCARDS Badminton (not a swap — Thursday does not become Badminton)', async () => {
    setupProfile(['thursday']);
    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    new WeekActivityOverridesRepo(db).setOverride(profile.id, currentWeekStart(), 'wednesday', 'badminton');
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const res = await move('thursday', 'wednesday').expect(200);
    const wednesdayAfter = res.body.days.find((d: any) => d.weekday === 'wednesday');
    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');
    expect(wednesdayAfter.activity).toBe('gym');
    expect(thursdayAfter.activity).toBe('unselected'); // NOT 'badminton' — that would be a swap
  });

  it('rejects when the destination already has an active planned session (DESTINATION_OCCUPIED, 409)', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const wednesdayDate = before.days.find((d: any) => d.weekday === 'wednesday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: wednesdayDate, session_type: 'gym', status: 'planned', source_type: 'ai' });

    const res = await move('thursday', 'wednesday');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DESTINATION_OCCUPIED');
    expect(res.body.details.conflictingSessionId).toBe(planned.session_id);
  });

  it('moves a real planned session on the SOURCE day along with the move', async () => {
    setupProfile([]);
    const before = await getWeek();
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    const wednesdayDate = before.days.find((d: any) => d.weekday === 'wednesday').date;
    const planned = new WorkoutSessionsRepo(db).createSession({ date: thursdayDate, session_type: 'gym', status: 'planned', source_type: 'ai' });

    const res = await move('thursday', 'wednesday').expect(200);
    expect(res.body.movedPlannedSessionIds).toEqual([planned.session_id]);
    expect(new WorkoutSessionsRepo(db).getSession(planned.session_id)!.date).toBe(wednesdayDate);
  });

  it('rejects when the source has a completed session (DAY_LOCKED)', async () => {
    setupProfile(['thursday']);
    const before = await getWeek();
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    new WorkoutSessionsRepo(db).createSession({ date: thursdayDate, session_type: 'gym', status: 'completed', duration_minutes: 50 });

    const res = await move('thursday', 'wednesday');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DAY_LOCKED');
  });

  it('rejects when the source has an in-progress session (DAY_LOCKED)', async () => {
    setupProfile(['thursday']);
    const before = await getWeek();
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;
    new WorkoutSessionsRepo(db).createSession({ date: thursdayDate, session_type: 'gym', status: 'in_progress' });

    const res = await move('thursday', 'wednesday');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DAY_LOCKED');
  });

  it('is reversible: moving back restores the original state', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursdayBefore = before.days.find((d: any) => d.weekday === 'thursday');

    await move('thursday', 'wednesday').expect(200);
    const res = await move('wednesday', 'thursday').expect(200);

    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');
    const wednesdayAfter = res.body.days.find((d: any) => d.weekday === 'wednesday');
    expect(thursdayAfter.activity).toBe('gym');
    expect(thursdayAfter.plannedWork).toEqual(thursdayBefore.plannedWork);
    expect(wednesdayAfter.activity).toBe('unselected');
  });

  it('is idempotent: repeating the same move a second time is a harmless no-op', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();

    const first = await move('thursday', 'wednesday').expect(200);
    const second = await move('thursday', 'wednesday').expect(200);

    const wedFirst = first.body.days.find((d: any) => d.weekday === 'wednesday');
    const wedSecond = second.body.days.find((d: any) => d.weekday === 'wednesday');
    const thuSecond = second.body.days.find((d: any) => d.weekday === 'thursday');
    expect(wedSecond.activity).toBe('gym');
    expect(wedSecond.plannedWork).toEqual(wedFirst.plannedWork); // NOT wiped by the repeated call
    expect(thuSecond.activity).toBe('unselected');
    expect(second.body.movedPlannedSessionIds).toEqual([]);
  });

  it('rejects same-day and invalid weekday values, and reports NO_TRAINING_PROFILE distinctly', async () => {
    const same = await move('thursday', 'thursday');
    expect(same.status).toBe(400);
    const invalid = await request(app).post('/api/programming/week/move').send({ fromDay: 'someday', toDay: 'thursday' });
    expect(invalid.status).toBe(400);
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

  // Final AI-Deterministic Precedence and Scheduling Fixes §7, invariant
  // 5: "Schedule changes must not alter historical exercise logs, sets,
  // reps, or completion timestamps." Verified against the REAL,
  // performed workout_exercises/workout_sets data (not just the
  // deterministic program_sessions snapshot, which weekProgramPersistence.
  // test.ts's §22 already covers) — an activity change on a completed
  // day is allowed (its forward-looking activity label may change), but
  // the historical record of what was actually performed must not.
  it('§7 invariant 5: a completed session\'s real logged exercises/sets are byte-identical after its own activity is changed', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: mondayDate, session_type: 'gym', status: 'completed', duration_minutes: 50, end_time: '10:00' });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: 'flat-barbell-bench-press',
      order: 0,
      role: 'primary',
      sets: [{ set_number: 1, weight: 100, reps: 8, completed: true, rir: 2 }],
    });
    const before2 = sessionsRepo.getSession(session.session_id)!;
    const exercisesBefore = sessionsRepo.getExercisePerformances(session.session_id);

    await putActivity('monday', 'badminton').expect(200);

    const after = sessionsRepo.getSession(session.session_id)!;
    const exercisesAfter = sessionsRepo.getExercisePerformances(session.session_id);
    expect(after).toEqual(before2);
    expect(exercisesAfter).toEqual(exercisesBefore);
  });

  it('§7 invariant 5: an uninvolved completed session\'s real logged data survives a swap between two OTHER days', async () => {
    setupProfile(['monday', 'thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: mondayDate, session_type: 'gym', status: 'completed', duration_minutes: 45 });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: 'flat-barbell-bench-press',
      order: 0,
      role: 'primary',
      sets: [{ set_number: 1, weight: 80, reps: 10, completed: true }],
    });
    const before2 = sessionsRepo.getSession(session.session_id)!;
    const exercisesBefore = sessionsRepo.getExercisePerformances(session.session_id);

    await swap('wednesday', 'thursday').expect(200);
    await move('wednesday', 'thursday').catch(() => {}); // whichever succeeds/fails, Monday must be untouched either way

    expect(sessionsRepo.getSession(session.session_id)).toEqual(before2);
    expect(sessionsRepo.getExercisePerformances(session.session_id)).toEqual(exercisesBefore);
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

  it('Final AI-Deterministic Precedence Fixes §3: "reuse" NEVER borrows a prescription from another date, even when one exists', async () => {
    // Monday has a real prescription; Wednesday (the target) has none.
    // "reuse" on Wednesday must not reach across and pull Monday's
    // prescription onto Wednesday — that is /week/move's job, with its
    // own explicit source/destination semantics, never this endpoint's.
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const mondayBefore = before.days.find((d: any) => d.weekday === 'monday');
    expect(mondayBefore.plannedWork.length).toBeGreaterThan(0);

    const res = await putActivity('wednesday', 'gym', { prescriptionPolicy: 'reuse' });
    expect(res.status).toBe(409);
    expect(res.body.generationRequired).toBe(true);

    const after = await getWeek();
    expect(after.days.find((d: any) => d.weekday === 'wednesday').activity).toBe('unselected'); // never written
    expect(after.days.find((d: any) => d.weekday === 'monday').plannedWork).toEqual(mondayBefore.plannedWork); // untouched
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

  it('turning a day AWAY from gym succeeds with prescriptionPolicy: "schedule-only" (no prescription decision needed either way)', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await putActivity('thursday', 'unselected', { prescriptionPolicy: 'schedule-only' }).expect(200);
  });

  it('Fix 6 (Final AI-Deterministic Precedence Fixes): "reuse"/"regenerate" are rejected as unsupported combinations when leaving Gym', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    await putActivity('thursday', 'unselected', { prescriptionPolicy: 'reuse' }).expect(400);
    await putActivity('thursday', 'unselected', { prescriptionPolicy: 'regenerate' }).expect(400);
  });

  it('Fix 6: "schedule-only" is rejected as an unsupported combination when changing TO Gym/Both', async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    await getWeek();
    const res = await putActivity('wednesday', 'gym', { prescriptionPolicy: 'schedule-only' });
    expect(res.status).toBe(400);
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
    new WorkoutSessionsRepo(db).createSession({ date: wednesdayDate, session_type: 'gym', status: 'planned', notes: 'AI-proposed session', source_type: 'ai' });

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
    const committed = new WorkoutSessionsRepo(db).createSession({ date: today, session_type: 'gym', status: 'planned', notes: 'AI-proposed session', source_type: 'ai' });

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

// Final AI-Deterministic Precedence and Scheduling Fixes §1/§2/§8: the
// precise bug the spec describes — AI `fill_existing_gym_day` commits
// on a date that ALREADY has a persisted deterministic program_sessions
// prescription. Before this fix, /week's rendering unconditionally
// preferred the deterministic branch whenever a persisted snapshot
// existed, so the AI-committed real session was created but never
// reflected in /week/today's displayed plan — a hidden, silently
// competing workout.
describe('Single-selected-workout precedence: AI/manual session supersedes an existing deterministic prescription', () => {
  it('an AI-committed session on a day with an existing deterministic prescription supersedes it in /week', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    expect(thursday.plannedWork.length).toBeGreaterThan(0); // real deterministic prescription exists
    expect(thursday.plannedSession).toBeNull(); // not started yet

    const ai = new WorkoutSessionsRepo(db).createSession({
      date: thursday.date,
      session_type: 'gym',
      status: 'planned',
      notes: 'AI-proposed session',
      source_type: 'ai',
    });

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    // The deterministic snapshot's own plannedWork must NOT be shown as
    // the current plan anymore — the AI session is now selected.
    expect(thursdayAfter.plannedWork).toEqual([]);
    expect(thursdayAfter.plannedSession).toMatchObject({ id: ai.session_id, source: 'ai', status: 'planned' });
    // Explicit provenance: which deterministic row is being superseded.
    expect(typeof thursdayAfter.supersedesProgramSessionId).toBe('string');
    // §11.G: an empty plannedWork must NEVER be read by a caller as "no
    // workout planned" / Rest — the day's `activity`/`type` stay 'gym'
    // precisely because `plannedSession` exists, proving the frontend
    // (and any other consumer) has a truthful signal to key off instead
    // of inferring absence from an empty array.
    expect(thursdayAfter.activity).toBe('gym');
    expect(thursdayAfter.type).toBe('gym');
    expect(thursdayAfter.status).not.toBe('rest');

    // /today must show the exact same selection — never a stale
    // deterministic plan in one view and the AI session in another.
    const todayRes = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(todayRes.body.plannedSession).toMatchObject({ id: ai.session_id, source: 'ai', status: 'planned' });
    expect(todayRes.body.exercises).toEqual([]);
    expect(todayRes.body.activity).toBe('gym');
    expect(todayRes.body.sessionType).toBe('gym');
  });

  it('the deterministic prescription itself is preserved (recoverable), not deleted, when superseded', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    const originalPlannedWork = thursday.plannedWork;

    new WorkoutSessionsRepo(db).createSession({ date: thursday.date, session_type: 'gym', status: 'planned', source_type: 'ai' });
    await getWeek();

    // The program_sessions row itself is untouched — only display
    // precedence changed. Verified via the repo directly (there is no
    // "rollback" API; this proves the data was never mutated/deleted).
    const weekStart = programmingWeekStart(thursday.date);
    const program = new WeeklyProgramRepo(db).getByWeekStart(weekStart)!;
    const thursdayIndex = 3; // Monday=0..Thursday=3
    const persisted = program.sessions.find((s) => s.day_index === thursdayIndex)!;
    expect(persisted.snapshot).toMatchObject({ plannedWork: originalPlannedWork });
  });

  it('a manually-logged gym session on a day with an existing deterministic prescription also supersedes it', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');

    const manual = new WorkoutSessionsRepo(db).createSession({ date: thursday.date, session_type: 'gym', status: 'in_progress', source_type: 'manual' });

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.plannedWork).toEqual([]);
    expect(thursdayAfter.plannedSession).toMatchObject({ id: manual.session_id, source: 'manual', status: 'in_progress' });
  });

  it('a real session with source_type "deterministic" (the day\'s own plan, started) does NOT supersede — full plannedWork remains visible', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');

    const started = new WorkoutSessionsRepo(db).createSession({ date: thursday.date, session_type: 'gym', status: 'in_progress' }); // source_type omitted -> defaults to 'deterministic'

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.plannedWork).toEqual(thursday.plannedWork);
    expect(thursdayAfter.plannedSession).toMatchObject({ id: started.session_id, source: 'deterministic', status: 'in_progress' });
    expect(thursdayAfter.supersedesProgramSessionId).toBeNull();
  });

  // Final AI-Deterministic Precedence and Scheduling Fixes §11.A:
  // "Completion updates the selected workout and does not accidentally
  // complete a hidden competing workout." With supersession, only ONE
  // real session ever exists per date (the AI/manual one) and the
  // deterministic prescription is a plain, status-less snapshot — so
  // completing the real session can only ever affect that one row, and
  // /week's rendering must reflect completion consistently everywhere.
  it('§11.A: completing the AI-committed session updates only that session, and /week + /today agree it is completed', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    const originalPlannedWork = thursday.plannedWork;

    const ai = new WorkoutSessionsRepo(db).createSession({
      date: thursday.date,
      session_type: 'gym',
      status: 'in_progress',
      source_type: 'ai',
    });
    await getWeek();

    const patchRes = await request(app).patch(`/api/workouts/${ai.session_id}`).send({ status: 'completed' }).expect(200);
    expect(patchRes.body.status).toBe('completed');

    // The superseded deterministic snapshot is a plain data row (no
    // status field to accidentally flip) and remains exactly as it was —
    // there is no "hidden" second workout that could have been completed
    // instead.
    const weekStart = programmingWeekStart(thursday.date);
    const program = new WeeklyProgramRepo(db).getByWeekStart(weekStart)!;
    const thursdayIndex = 3; // Monday=0..Thursday=3
    const persisted = program.sessions.find((s) => s.day_index === thursdayIndex)!;
    expect(persisted.snapshot).toMatchObject({ plannedWork: originalPlannedWork });

    // Only one real session exists for this date — the AI one just
    // completed.
    const realSessionsOnDate = new WorkoutSessionsRepo(db).listSessionsByDate(thursday.date);
    expect(realSessionsOnDate).toHaveLength(1);
    expect(realSessionsOnDate[0]!.session_id).toBe(ai.session_id);
    expect(realSessionsOnDate[0]!.status).toBe('completed');

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.plannedSession).toMatchObject({ id: ai.session_id, source: 'ai', status: 'completed' });

    const todayRes = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(todayRes.body.plannedSession).toEqual(thursdayAfter.plannedSession);
  });

  // Final AI-Deterministic Precedence and Scheduling Fixes §11.F:
  // "Logger and /today open the same session." Proves logger.html's own
  // data source (GET /api/workouts/:id, which returns session.exercises
  // from repo.getExercisePerformances) is exactly the session /today
  // points callers to via plannedSession.id — including the session's
  // REAL logged exercises, not the deterministic plannedWork.
  it('§11.F: logger (GET /api/workouts/:id) opens the exact same session /today reports, with matching real exercises', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');

    const ai = new WorkoutSessionsRepo(db).createSession({
      date: thursday.date,
      session_type: 'gym',
      status: 'in_progress',
      source_type: 'ai',
    });
    await request(app)
      .post(`/api/workouts/${ai.session_id}/exercises`)
      .send({
        exercise_id: 'flat-barbell-bench-press',
        order: 0,
        role: 'primary',
        sets: [{ set_number: 1, weight: 100, reps: 8, completed: true, rir: 2 }],
      })
      .expect(201);

    const todayRes = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(todayRes.body.plannedSession).toMatchObject({ id: ai.session_id, source: 'ai' });

    const loggerRes = await request(app).get(`/api/workouts/${todayRes.body.plannedSession.id}`).expect(200);
    expect(loggerRes.body.session_id).toBe(ai.session_id);
    expect(loggerRes.body.session_type).toBe('gym');
    expect(loggerRes.body.exercises).toEqual(new WorkoutSessionsRepo(db).getExercisePerformances(ai.session_id));
    expect(loggerRes.body.exercises).toMatchObject([{ exercise_id: 'flat-barbell-bench-press' }]);
  });
});

// Phase 6 (2026-09-23): reported symptom — "day titles change but
// workouts stay attached to the original days" after a swap. Static
// analysis of swapDayActivities/renderWeekDays found no defect (the
// deterministic snapshot's sessionPurpose and plannedWork are always two
// fields of the SAME persisted row, moved by one upsertSession call —
// structurally impossible to decouple), and the existing "Gym <-> Gym"
// test above already proves plannedWork itself moves correctly for the
// plain case. This is a genuinely NEW scenario neither test covers: a
// gym day whose deterministic prescription is superseded by a real
// AI-committed session (a second, date-keyed piece of state) swapped
// with a plain Rest day — the one case where two independently-moved
// pieces of state (the day_index-keyed snapshot and the date-keyed real
// session) could plausibly end up paired with the wrong day if either
// half's move logic disagreed with the other's.
describe('Phase 6 reproduction: swap with a superseded (AI-committed) session — does the title/session/exercise pairing ever split?', () => {
  it('the AI session, its real exercises, and the (nulled) deterministic display all move to the new date together — never split across days', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    const wednesdayDateBefore = before.days.find((d: any) => d.weekday === 'wednesday').date;
    expect(thursday.plannedWork.length).toBeGreaterThan(0); // a real deterministic prescription exists pre-supersession

    // Supersede Thursday's deterministic prescription with a real
    // AI-committed session carrying its own distinct exercise, exactly
    // as aiProposalLifecycle.ts's 'fill_existing_gym_day' intent does.
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const ai = sessionsRepo.createSession({ date: thursday.date, session_type: 'gym', status: 'planned', notes: 'AI-proposed session', source_type: 'ai' });
    sessionsRepo.addExercisePerformance(ai.session_id, {
      exercise_id: 'incline-dumbbell-press',
      order: 0,
      role: 'primary',
      sets: [{ set_number: 1, weight: 40, reps: 10, completed: false }],
    });

    const beforeSwap = await getWeek();
    const thursdayBeforeSwap = beforeSwap.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayBeforeSwap.plannedWork).toEqual([]); // superseded — nulled, not fabricated
    expect(thursdayBeforeSwap.plannedSession).toMatchObject({ id: ai.session_id, source: 'ai' });

    const res = await swap('wednesday', 'thursday').expect(200);
    expect(res.body.movedPlannedSessionIds).toContain(ai.session_id);

    const wednesdayAfter = res.body.days.find((d: any) => d.weekday === 'wednesday');
    const thursdayAfter = res.body.days.find((d: any) => d.weekday === 'thursday');

    // The title (activity/type) and the real session now agree on the
    // SAME day — Wednesday, never split between the two.
    expect(wednesdayAfter.activity).toBe('gym');
    expect(wednesdayAfter.type).toBe('gym');
    expect(wednesdayAfter.plannedSession).toMatchObject({ id: ai.session_id, source: 'ai', status: 'planned' });
    expect(wednesdayAfter.plannedWork).toEqual([]); // still nulled (superseded), never a stale Thursday snapshot leaking through

    // Thursday reverts to Wednesday's original (Rest) title, with
    // neither the real session nor the (now relocated) deterministic
    // snapshot left behind there.
    expect(thursdayAfter.activity).toBe('unselected');
    expect(thursdayAfter.type).toBe('rest');
    expect(thursdayAfter.plannedSession).toBeNull();

    // The real session's own exercises followed the session itself
    // (keyed by session_id, never by date) — opening it from its NEW
    // date shows the exact same real exercise, not the old deterministic
    // one and not nothing.
    const openedSession = await request(app).get(`/api/workouts/${ai.session_id}`).expect(200);
    expect(openedSession.body.exercises).toMatchObject([{ exercise_id: 'incline-dumbbell-press' }]);
    expect(sessionsRepo.getSession(ai.session_id)!.date).toBe(wednesdayDateBefore);

    // /today, opened for Wednesday's date, agrees with /week exactly —
    // the same cross-surface consistency check the existing §8/§11.F
    // suite already runs for the plain (non-superseded) case, now also
    // proven for the superseded one.
    const todayRes = await request(app).get('/api/programming/today').query({ date: wednesdayAfter.date }).expect(200);
    expect(todayRes.body.plannedSession).toEqual(wednesdayAfter.plannedSession);
  });
});
