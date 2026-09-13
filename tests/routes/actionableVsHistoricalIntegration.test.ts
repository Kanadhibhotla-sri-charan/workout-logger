// Final Actionable vs Historical Session Resolution Fixes: endpoint/
// integration coverage for /today, /week, logger, and completion, per
// the spec's own "Endpoint/integration tests" list. Verifies:
//   - actionable planned sessions are returned by explicit ID;
//   - completed sessions appear as historical/completed, never as a new
//     actionable workout;
//   - a genuinely conflicted state (two active planned AI sessions,
//     constructed directly to simulate data that predates this phase's
//     write-time guards) is surfaced consistently, not silently
//     resolved by recency;
//   - /today and /week agree on the selected session in every case;
//   - the logger (GET /api/workouts/:id) opens the exact session the
//     resolver selected;
//   - completion (PATCH) updates only that selected session.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { todayForUser } from '../../src/lib/userTimezone.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

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

async function getWeek() {
  const res = await request(app).get('/api/programming/week').expect(200);
  return res.body;
}

describe('Endpoint/integration: /today, /week, logger, completion agree via the actionable/historical fields', () => {
  it('no session for a gym day -> both endpoints report null historicalSession/selectedPlannedWorkout/selectionConflict', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const week = await getWeek();
    const thursday = week.days.find((d: any) => d.weekday === 'thursday');
    expect(thursday.historicalSession).toBeNull();
    expect(thursday.selectedPlannedWorkout).toBeNull();
    expect(thursday.selectionConflict).toBeNull();

    const today = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(today.body.historicalSession).toBeNull();
    expect(today.body.selectedPlannedWorkout).toBeNull();
    expect(today.body.selectionConflict).toBeNull();
  });

  it('an actionable AI-planned session is returned as selectedPlannedWorkout by explicit id, on both /week and /today', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');

    const ai = new WorkoutSessionsRepo(db).createSession({ date: thursday.date, session_type: 'gym', status: 'planned', source_type: 'ai' });

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.historicalSession).toBeNull();
    expect(thursdayAfter.selectedPlannedWorkout).toEqual({ id: ai.session_id, source: 'ai', status: 'planned' });
    expect(thursdayAfter.selectionConflict).toBeNull();

    const today = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(today.body.selectedPlannedWorkout).toEqual(thursdayAfter.selectedPlannedWorkout);
    expect(today.body.historicalSession).toBeNull();

    // Logger opens the exact session the resolver selected.
    const logger = await request(app).get(`/api/workouts/${today.body.selectedPlannedWorkout.id}`).expect(200);
    expect(logger.body.session_id).toBe(ai.session_id);
  });

  it('a completed session is returned as historicalSession, never as selectedPlannedWorkout, on both endpoints', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');

    const completed = new WorkoutSessionsRepo(db).createSession({
      date: thursday.date,
      session_type: 'gym',
      status: 'completed',
      duration_minutes: 45,
      source_type: 'deterministic',
    });

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.historicalSession).toEqual({ id: completed.session_id, source: 'deterministic', status: 'completed' });
    expect(thursdayAfter.selectedPlannedWorkout).toBeNull();
    expect(thursdayAfter.selectionConflict).toBeNull();

    const today = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(today.body.historicalSession).toEqual(thursdayAfter.historicalSession);
    expect(today.body.selectedPlannedWorkout).toBeNull();

    // Completion (a second PATCH, e.g. correcting notes) never resurrects
    // it as "planned" nor creates a competing selection.
    await request(app).patch(`/api/workouts/${completed.session_id}`).send({ notes: 'corrected' }).expect(200);
    const afterPatch = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    expect(afterPatch.body.historicalSession.status).toBe('completed');
    expect(afterPatch.body.selectedPlannedWorkout).toBeNull();
  });

  it('multiple active planned AI sessions (simulating pre-existing bad data) surface a selectionConflict consistently on /week and /today, with NO actionable workout selected', async () => {
    setupProfile(['thursday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    expect(thursday.plannedWork.length).toBeGreaterThan(0); // a real deterministic prescription exists for this slot

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const older = sessionsRepo.createSession({ date: thursday.date, session_type: 'gym', status: 'planned', source_type: 'ai' });
    const newer = sessionsRepo.createSession({ date: thursday.date, session_type: 'gym', status: 'planned', source_type: 'ai' });

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.selectionConflict).not.toBeNull();
    expect(thursdayAfter.selectionConflict.code).toBe('MULTIPLE_ACTIVE_PLANNED_SESSIONS');
    expect(thursdayAfter.selectionConflict.sessionIds.sort()).toEqual([older.session_id, newer.session_id].sort());
    // Final Conflict Selection Safety Fix: an ambiguous conflict must
    // NEVER return an actionable selection — not the "most recent"
    // conflicting session, and not the deterministic snapshot either
    // (which would silently look like a valid, current plan sitting
    // right next to the conflict warning).
    expect(thursdayAfter.selectedPlannedWorkout).toBeNull();
    expect(thursdayAfter.historicalSession).toBeNull();
    expect(thursdayAfter.plannedWork).toEqual([]);
    // The backward-compat combined field must also not silently expose
    // either conflicting session or the deterministic snapshot as "the"
    // plan during a conflict.
    expect(thursdayAfter.plannedSession).toBeNull();

    const today = await request(app).get('/api/programming/today').query({ date: thursday.date }).expect(200);
    // Compared field-by-field (with sessionIds sorted) rather than a
    // blanket deep-equal: two independent `listSessionsByDate` queries
    // for rows with an identical (null) start_time have no guaranteed
    // relative ordering, so the array's ELEMENT order is not itself part
    // of the contract — only its content and the conflict's other fields
    // must agree between /week and /today.
    expect(today.body.selectionConflict.code).toBe(thursdayAfter.selectionConflict.code);
    expect(today.body.selectionConflict.message).toBe(thursdayAfter.selectionConflict.message);
    expect(today.body.selectionConflict.sessionIds.sort()).toEqual(thursdayAfter.selectionConflict.sessionIds.sort());
    expect(today.body.selectedPlannedWorkout).toBeNull();
    expect(today.body.exercises).toEqual([]);
  });

  it('completion updates ONLY the selected session — an uninvolved historical session on a different date is untouched', async () => {
    setupProfile(['thursday', 'monday']);
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const before = await getWeek();
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    const monday = before.days.find((d: any) => d.weekday === 'monday');

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const mondayCompleted = sessionsRepo.createSession({ date: monday.date, session_type: 'gym', status: 'completed', duration_minutes: 50 });
    const thursdayAi = sessionsRepo.createSession({ date: thursday.date, session_type: 'gym', status: 'planned', source_type: 'ai' });

    await request(app).patch(`/api/workouts/${thursdayAi.session_id}`).send({ status: 'completed' }).expect(200);

    const mondayStillCompleted = sessionsRepo.getSession(mondayCompleted.session_id)!;
    expect(mondayStillCompleted.status).toBe('completed');
    expect(mondayStillCompleted.duration_minutes).toBe(50);

    const after = await getWeek();
    const thursdayAfter = after.days.find((d: any) => d.weekday === 'thursday');
    expect(thursdayAfter.historicalSession).toEqual({ id: thursdayAi.session_id, source: 'ai', status: 'completed' });
  });
});
