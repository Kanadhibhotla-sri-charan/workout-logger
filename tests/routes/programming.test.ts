// UI Build Phase §57/§58: real HTTP-level tests for the new read-only
// programming API — exercising the actual Express routes (never just the
// underlying repo/engine functions in isolation), since this is the
// contract the frontend actually depends on.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

let db: Database.Database;
let app: ReturnType<typeof createApp>;

const MON = '2026-08-31';

function setupProfile(trainingDays: string[] = ['monday', 'tuesday', 'thursday', 'friday']) {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [
      { day: 'saturday', activity_type: 'badminton', notes: null },
      { day: 'sunday', activity_type: 'badminton', notes: null },
    ],
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('GET /api/programming/week', () => {
  beforeEach(() => {
    setupProfile();
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 }); // Goal 1 -> mid-pec
  });

  it('is deterministic: two identical calls against identical stored state produce identical output', async () => {
    const a = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const b = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    expect(b.body).toEqual(a.body);
  });

  it('represents all seven calendar days, including rest/activity days', async () => {
    const res = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    expect(res.body.days).toHaveLength(7);
    const types = res.body.days.map((d: any) => d.type);
    expect(types).toContain('gym');
    expect(types.some((t: string) => t !== 'gym')).toBe(true); // wednesday (rest) and the badminton days
    const wednesday = res.body.days.find((d: any) => d.weekday === 'wednesday');
    expect(wednesday.type).toBe('rest');
    const saturday = res.body.days.find((d: any) => d.weekday === 'saturday');
    expect(saturday.type).toBe('badminton');
  });

  it('gym sessions contain the final, real programmed work (not empty placeholders)', async () => {
    const res = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const gymDays = res.body.days.filter((d: any) => d.type === 'gym');
    expect(gymDays.length).toBeGreaterThan(0);
    expect(gymDays.some((d: any) => d.plannedWork.length > 0)).toBe(true);
    for (const day of gymDays) {
      for (const w of day.plannedWork) {
        expect(w.exercise_name).toBeTruthy();
        expect(w.target_name).toBeTruthy();
      }
    }
  });

  it('Monday is never a lower-body day', async () => {
    const res = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const monday = res.body.days.find((d: any) => d.weekday === 'monday');
    expect(monday.sessionPurpose).not.toBe('legs');
    const lowerBodyIds = ['quads', 'hamstrings', 'glutes', 'calves', 'adductors'];
    expect(monday.plannedWork.some((w: any) => lowerBodyIds.includes(w.target_id))).toBe(false);
  });

  it("Goal 1's own priority survives into the real weekly plan, labeled as Goal 1", async () => {
    const res = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const midPec = res.body.targetAllocations.find((a: any) => a.target_id === 'mid-pec');
    expect(midPec).toBeDefined();
    expect(midPec.goal_label).toBe('Goal 1');
    expect(midPec.deliveredDirectSets).toBeGreaterThan(0);
  });

  it('real compound exposure is reflected in targetAllocations (never a static zero)', async () => {
    const res = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const midPec = res.body.targetAllocations.find((a: any) => a.target_id === 'mid-pec');
    expect(midPec.plannedPrimaryExposure).toBeGreaterThan(0);
  });

  it('respects real time/equipment constraints — a minimal profile yields less delivered work than a full one', async () => {
    const full = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);

    const restrictedDb = openDb(':memory:');
    const user = new UsersRepo(restrictedDb).getOrCreateDefault();
    new TrainingProfileRepo(restrictedDb).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday'] as any,
      default_session_duration_minutes: 15,
      minimum_session_duration_minutes: 10,
      maximum_session_duration_minutes: 20,
      available_equipment: ['dumbbell'],
      other_activity_schedule: [],
    });
    new GoalsRepo(restrictedDb).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const restrictedApp = createApp(restrictedDb);
    const restricted = await request(restrictedApp).get(`/api/programming/week?date=${MON}`).expect(200);

    const fullTotal = full.body.targetAllocations.reduce((sum: number, a: any) => sum + a.deliveredDirectSets, 0);
    const restrictedTotal = restricted.body.targetAllocations.reduce((sum: number, a: any) => sum + a.deliveredDirectSets, 0);
    expect(restrictedTotal).toBeLessThan(fullTotal);
  });
});

describe('GET /api/programming/today matches its exact real slice of GET /api/programming/week', () => {
  beforeEach(() => {
    setupProfile();
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
  });

  it('today === the exact corresponding session from the week (never merely "similar")', async () => {
    const week = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const today = await request(app).get(`/api/programming/today?date=${MON}`).expect(200);

    const mondayFromWeek = week.body.days.find((d: any) => d.date === MON);
    expect(mondayFromWeek.type).toBe('gym');

    const weekExerciseIds = mondayFromWeek.plannedWork.map((w: any) => w.exercise_id).sort();
    const todayExerciseIds = today.body.exercises.map((e: any) => e.exercise_id).sort();
    expect(todayExerciseIds).toEqual(weekExerciseIds);

    const weekTotalSets = mondayFromWeek.plannedWork.reduce((sum: number, w: any) => sum + w.sets, 0);
    const todayTotalSets = today.body.exercises.reduce((sum: number, e: any) => sum + e.target_sets, 0);
    expect(todayTotalSets).toBe(weekTotalSets);

    expect(today.body.sessionPurpose).toBe(mondayFromWeek.sessionPurpose);
    expect(today.body.estimatedMinutes).toBe(mondayFromWeek.estimatedMinutes);
  });
});

// Final Surgical Fix Pass §9-12: /api/programming/today must classify a
// day's sessionType using gym > activity > rest — never defaulting a
// non-gym day straight to "rest" when a real recurring activity
// (badminton or otherwise) is configured for it — and must always agree
// with /api/programming/week's own canonical type for the same date.
describe('GET /api/programming/today activity-type classification (gym > activity > rest)', () => {
  const SAT = '2026-09-05'; // configured badminton day, no gym session
  const WED = '2026-09-02'; // no training day, no recurring activity — true rest

  beforeEach(() => {
    setupProfile(); // monday/tuesday/thursday/friday gym; saturday+sunday badminton; wednesday genuinely free
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
  });

  it('§9 badminton regression: a configured non-gym activity day is classified as that activity, never "rest"', async () => {
    const today = await request(app).get(`/api/programming/today?date=${SAT}`).expect(200);
    expect(today.body.sessionType).toBe('badminton');

    const week = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const saturdayFromWeek = week.body.days.find((d: any) => d.date === SAT);
    expect(saturdayFromWeek.type).toBe('badminton');

    expect(today.body.sessionType).toBe(saturdayFromWeek.type);
  });

  it('§10 rest regression: a genuine rest day (no gym session, no recurring activity) is classified as "rest"', async () => {
    const today = await request(app).get(`/api/programming/today?date=${WED}`).expect(200);
    expect(today.body.sessionType).toBe('rest');
  });

  it('§11 gym regression: a real gym day is classified as "gym", even though Saturday/Sunday elsewhere in the week have a recurring activity', async () => {
    const today = await request(app).get(`/api/programming/today?date=${MON}`).expect(200);
    expect(today.body.sessionType).toBe('gym');
  });

  it('§12 today/week agreement: canonical day type matches for the same date, exercised for the badminton scenario', async () => {
    const today = await request(app).get(`/api/programming/today?date=${SAT}`).expect(200);
    const week = await request(app).get(`/api/programming/week?date=${MON}`).expect(200);
    const saturdayFromWeek = week.body.days.find((d: any) => d.date === SAT);
    expect(today.body.sessionType).toEqual(saturdayFromWeek.type);
  });
});

describe('GET /api/programming/substitutes', () => {
  beforeEach(() => setupProfile());

  it('returns Blueprint-approved candidates before any outside-Blueprint one, filtered by real equipment', async () => {
    const res = await request(app).get('/api/programming/substitutes?target_type=physique_target&target_id=mid-pec').expect(200);
    expect(res.body.blueprint.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.outsideBlueprint)).toBe(true);
    for (const c of res.body.blueprint) {
      expect(c.equipment.every((e: string) => FULL_EQUIPMENT.includes(e))).toBe(true);
    }
  });

  it('rejects a missing/invalid target', async () => {
    await request(app).get('/api/programming/substitutes').expect(400);
  });
});
