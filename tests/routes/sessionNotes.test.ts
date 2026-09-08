// Workout Programmer UI Fix §2/§11.B: session note create/persist/edit/
// clear/reload, via the real HTTP routes (workout_sessions.notes already
// existed for exactly this purpose — see docs/WORKOUT_PROGRAMMER_UI_AND_
// EQUIPMENT_FILTER_FIX_REPORT.md). No new schema/migration was required.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { todayForUser } from '../../src/lib/userTimezone.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('Session notes — create, persist, edit, clear, reload', () => {
  it('1/2/3: a session note can be created and is retrievable when the session is reopened', async () => {
    const created = await request(app)
      .post('/api/workouts')
      .send({ date: '2026-09-08', session_type: 'gym', notes: 'Rope for pushdowns, EZ bar for curls.' })
      .expect(201);
    expect(created.body.notes).toBe('Rope for pushdowns, EZ bar for curls.');

    const reopened = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    expect(reopened.body.notes).toBe('Rope for pushdowns, EZ bar for curls.');
  });

  it('4: the note can be edited after creation', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-09-08', session_type: 'gym', notes: 'First draft.' }).expect(201);

    await request(app).patch(`/api/workouts/${created.body.session_id}`).send({ notes: 'Updated note.' }).expect(200);

    const reopened = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    expect(reopened.body.notes).toBe('Updated note.');
  });

  it('5: the note can be cleared', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-09-08', session_type: 'gym', notes: 'Something.' }).expect(201);

    await request(app).patch(`/api/workouts/${created.body.session_id}`).send({ notes: null }).expect(200);

    const reopened = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    expect(reopened.body.notes).toBeNull();
  });

  it('6: the note survives independent reloads (no transient-only frontend state)', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-09-08', session_type: 'gym', notes: 'Persisted note.' }).expect(201);

    // Two independent GETs, simulating a page refresh / navigate away and back.
    const first = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    const second = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    expect(first.body.notes).toBe('Persisted note.');
    expect(second.body.notes).toBe('Persisted note.');
  });

  it('7: existing sessions created without a note continue to work (default null, no error)', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-09-08', session_type: 'gym' }).expect(201);
    expect(created.body.notes).toBeNull();

    const reopened = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    expect(reopened.body.notes).toBeNull();
    expect(reopened.body.exercises).toEqual([]);
  });

  it('8: adding/editing a note does not alter workout programming (no remaining-week reconciliation triggered) or workout history', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-09-08', session_type: 'gym', notes: null }).expect(201);
    await request(app).post(`/api/workouts/${created.body.session_id}/exercises`).send({
      exercise_id: 'flat-barbell-bench-press',
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, weight: 60, reps: 10, completed: true }],
    }).expect(201);

    const weekStart = programmingWeekStart(todayForUser(db));
    const programRepoBefore = new WeeklyProgramRepo(db).getByWeekStart(weekStart);

    await request(app).patch(`/api/workouts/${created.body.session_id}`).send({ notes: 'Just a note, not a completion.' }).expect(200);

    // Session stays in_progress (default), never auto-completed by a note edit.
    const afterNote = await request(app).get(`/api/workouts/${created.body.session_id}`).expect(200);
    expect(afterNote.body.status).not.toBe('completed');
    // Logged exercise history is untouched.
    expect(afterNote.body.exercises).toHaveLength(1);
    expect(afterNote.body.exercises[0].exercise_id).toBe('flat-barbell-bench-press');
    // No week-program reconciliation was triggered by the note edit
    // (only a real completion transition does that) — the persisted
    // program row (absent here, since nothing has been generated yet)
    // stays exactly as it was before the note edit.
    const programRepoAfter = new WeeklyProgramRepo(db).getByWeekStart(weekStart);
    expect(programRepoAfter).toEqual(programRepoBefore);
  });
});
