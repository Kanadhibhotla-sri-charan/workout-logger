// Current-Week Reconciliation Fix §15: HTTP-level tests proving the new
// PUT /api/programming/week/days/:day/activity endpoint is a real
// CURRENT-WEEK override — separate from the recurring TrainingProfile,
// automatically reconciled (because /week and /today always recompute
// live from profile + this week's overrides), and never touching
// completed/logged history. "Today" is real wall-clock time (the
// endpoint always targets the week containing the actual current date,
// per its own design — see programmingWeekStart) — these tests never
// hardcode a calendar date; they always read the real current week's
// dates back from GET /week itself before asserting against them.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import type { DailyActivity } from '../../src/contracts/types.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

let db: Database.Database;
let app: ReturnType<typeof createApp>;

function setupProfile(trainingDays: string[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) {
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

async function getWeek() {
  const res = await request(app).get('/api/programming/week').expect(200);
  return res.body;
}

function putActivity(day: string, activity: DailyActivity) {
  return request(app).put(`/api/programming/week/days/${day}/activity`).send({ activity });
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('PUT /api/programming/week/days/:day/activity — validation', () => {
  it('rejects an invalid weekday', async () => {
    setupProfile();
    const res = await putActivity('someday', 'gym').expect(400);
    expect(res.body.error).toMatch(/day must be one of/);
  });

  it('rejects an invalid activity value', async () => {
    setupProfile();
    const res = await putActivity('monday', 'rest' as any).expect(400);
    expect(res.body.error).toMatch(/activity must be one of/);
  });

  it('returns 404 when no training profile exists yet', async () => {
    const res = await putActivity('monday', 'gym').expect(404);
    expect(res.body.error).toMatch(/No training profile/);
  });
});

// The engine's own "normal development" layer distributes each target's
// weekly sets across ALL currently-eligible gym days (frequencyEngine),
// so its explainability metadata (weekly_allocation.eligible_days_this_
// week, sessions_remaining_this_week, and the free-text reasoning
// describing them) CORRECTLY changes to describe the new eligible-day
// count whenever that count changes — this is accurate reporting, not
// instability, and is identical to what would happen if the recurring
// Training Profile itself gained/lost a training day (this fix changes
// nothing about that pre-existing, unmodified engine behavior). What
// spec §15 Test 1 actually asks to stay stable is the PRESCRIBED
// workout itself — which exercises, how many sets/reps — for a day
// that isn't touched by the override. This helper strips the
// always-current-state explainability envelope down to just that.
function corePrescription(plannedWork: any[]) {
  return plannedWork.map((w) => ({ exercise_id: w.exercise_id, target_id: w.target_id, sets: w.sets, reps_min: w.reps_min, reps_max: w.reps_max }));
}

describe('Test 1 — future-plan stability (spec §15)', () => {
  it('changing one day does not alter an unaffected day\'s prescribed workout when no redistribution is required', async () => {
    setupProfile(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']); // 5 gym days — plenty of slack
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const before = await getWeek();
    const mondayBefore = before.days.find((d: any) => d.weekday === 'monday');
    const tuesdayBefore = before.days.find((d: any) => d.weekday === 'tuesday');
    expect(mondayBefore.type).toBe('gym');
    expect(tuesdayBefore.type).toBe('gym');

    await putActivity('friday', 'badminton').expect(200);

    const after = await getWeek();
    const fridayAfter = after.days.find((d: any) => d.weekday === 'friday');
    expect(fridayAfter.type).toBe('badminton');
    expect(fridayAfter.activity).toBe('badminton');

    const mondayAfter = after.days.find((d: any) => d.weekday === 'monday');
    const tuesdayAfter = after.days.find((d: any) => d.weekday === 'tuesday');
    expect(corePrescription(mondayAfter.plannedWork)).toEqual(corePrescription(mondayBefore.plannedWork));
    expect(corePrescription(tuesdayAfter.plannedWork)).toEqual(corePrescription(tuesdayBefore.plannedWork));
  });
});

describe('Test 2 — profile remains unchanged (spec §15)', () => {
  it('a current-week override never modifies the recurring TrainingProfile default', async () => {
    setupProfile(['monday']); // Saturday is NOT a training day by default (profile default = not gym)
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const profileBefore = (await request(app).get('/api/training-profile').expect(200)).body;
    expect(profileBefore.training_days).not.toContain('saturday');

    await putActivity('saturday', 'badminton').expect(200);

    const week = await getWeek();
    const saturday = week.days.find((d: any) => d.weekday === 'saturday');
    expect(saturday.activity).toBe('badminton');

    const profileAfter = (await request(app).get('/api/training-profile').expect(200)).body;
    expect(profileAfter.training_days).toEqual(profileBefore.training_days);
    expect(profileAfter.other_activity_schedule).toEqual(profileBefore.other_activity_schedule);
  });

  it('the exact spec §10 example: profile default Saturday=Badminton, current week override Saturday=Both, profile still Badminton after', async () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [{ day: 'saturday', activity_type: 'badminton', notes: null }],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    await putActivity('saturday', 'both').expect(200);

    const week = await getWeek();
    expect(week.days.find((d: any) => d.weekday === 'saturday').activity).toBe('both');

    const profileAfter = (await request(app).get('/api/training-profile').expect(200)).body;
    expect(profileAfter.training_days).not.toContain('saturday');
    expect(profileAfter.other_activity_schedule).toEqual([{ day: 'saturday', activity_type: 'badminton', notes: null }]);
  });
});

describe('Test 3 — Gym -> Both (spec §15)', () => {
  it('adds badminton while retaining a real gym session', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const before = await getWeek();
    const mondayBefore = before.days.find((d: any) => d.weekday === 'monday');
    expect(mondayBefore.activity).toBe('gym');
    expect(mondayBefore.type).toBe('gym');
    expect(mondayBefore.plannedWork.length).toBeGreaterThan(0);

    await putActivity('monday', 'both').expect(200);

    const after = await getWeek();
    const mondayAfter = after.days.find((d: any) => d.weekday === 'monday');
    expect(mondayAfter.activity).toBe('both');
    expect(mondayAfter.type).toBe('gym'); // real gym session still present
    expect(mondayAfter.plannedWork.length).toBeGreaterThan(0);
  });
});

describe('Test 4 — Rest -> Gym (spec §15)', () => {
  it('creates a real gym session for a previously unselected day, without unnecessarily regenerating other days', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const before = await getWeek();
    const wednesdayBefore = before.days.find((d: any) => d.weekday === 'wednesday');
    expect(wednesdayBefore.activity).toBe('unselected');
    expect(wednesdayBefore.type).toBe('rest');
    const mondayBefore = before.days.find((d: any) => d.weekday === 'monday');

    await putActivity('wednesday', 'gym').expect(200);

    const after = await getWeek();
    const wednesdayAfter = after.days.find((d: any) => d.weekday === 'wednesday');
    expect(wednesdayAfter.activity).toBe('gym');
    expect(wednesdayAfter.type).toBe('gym');

    // Monday (untouched by this change) is not "unnecessarily regenerated" —
    // still the same real gym day, with the same prescribed workout, as
    // before (its explainability metadata may correctly update to
    // describe the new eligible-day count — see corePrescription's doc
    // comment above; that is accurate reporting, not instability).
    const mondayAfter = after.days.find((d: any) => d.weekday === 'monday');
    expect(mondayAfter.type).toBe('gym');
    expect(corePrescription(mondayAfter.plannedWork)).toEqual(corePrescription(mondayBefore.plannedWork));
  });
});

describe('Test 5 — completed-history protection (spec §15/§16)', () => {
  it('a completed workout on the changed day is byte-for-byte unchanged after the activity change', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const week = await getWeek();
    const mondayDate = week.days.find((d: any) => d.weekday === 'monday').date;

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const logged = sessionsRepo.createSession({
      date: mondayDate,
      session_type: 'gym',
      status: 'completed',
      duration_minutes: 55,
      notes: 'felt strong today',
    });

    await putActivity('monday', 'badminton').expect(200);

    const reloaded = sessionsRepo.listSessionsByDate(mondayDate).find((s) => s.session_id === logged.session_id);
    expect(reloaded).toEqual(logged);
  });

  it('changing a different day leaves an unrelated logged session on another day untouched', async () => {
    setupProfile(['monday', 'friday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const week = await getWeek();
    const mondayDate = week.days.find((d: any) => d.weekday === 'monday').date;

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const mondaySession = sessionsRepo.createSession({ date: mondayDate, session_type: 'gym', status: 'completed', duration_minutes: 50 });

    await putActivity('friday', 'unselected').expect(200);

    const reloadedMonday = sessionsRepo.listSessionsByDate(mondayDate).find((s) => s.session_id === mondaySession.session_id);
    expect(reloadedMonday).toEqual(mondaySession);
  });
});

describe('Test 6 — all required activity transitions (spec §6/§15)', () => {
  const TRANSITIONS: Array<{ from: DailyActivity; to: DailyActivity }> = [
    { from: 'gym', to: 'badminton' },
    { from: 'badminton', to: 'gym' },
    { from: 'gym', to: 'both' },
    { from: 'both', to: 'gym' },
    { from: 'badminton', to: 'both' },
    { from: 'both', to: 'badminton' },
    { from: 'unselected', to: 'gym' },
    { from: 'unselected', to: 'badminton' },
    { from: 'unselected', to: 'both' },
    { from: 'gym', to: 'unselected' },
    { from: 'badminton', to: 'unselected' },
    { from: 'both', to: 'unselected' },
  ];

  for (const { from, to } of TRANSITIONS) {
    it(`${from} -> ${to}`, async () => {
      setupProfile([]); // start with every day unselected by default
      new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

      if (from !== 'unselected') {
        await putActivity('tuesday', from).expect(200);
      }
      const before = await getWeek();
      expect(before.days.find((d: any) => d.weekday === 'tuesday').activity).toBe(from);

      await putActivity('tuesday', to).expect(200);
      const after = await getWeek();
      expect(after.days.find((d: any) => d.weekday === 'tuesday').activity).toBe(to);
    });
  }
});

describe('Reconciliation is automatic — no separate step required (spec §5/§11/§12)', () => {
  it('the PUT response itself already reflects the change (one round trip)', async () => {
    setupProfile(['monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const res = await putActivity('saturday', 'badminton').expect(200);
    expect(res.body.days.find((d: any) => d.weekday === 'saturday').activity).toBe('badminton');
  });

  it('GET /api/programming/today agrees with the override for the current day', async () => {
    setupProfile([]);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const todayBefore = await request(app).get('/api/programming/today').expect(200);
    await putActivity(todayBefore.body.weekday, 'both').expect(200);

    const todayAfter = await request(app).get('/api/programming/today').expect(200);
    expect(todayAfter.body.activity).toBe('both');
    expect(todayAfter.body.sessionType).toBe('gym');
  });
});
