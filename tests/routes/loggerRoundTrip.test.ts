// UI Build Phase §59: real HTTP round-trip through the logger's own API
// calls — POST session, POST exercise performance, PUT badminton
// details, PATCH completion, GET session — asserting the saved data
// comes back exactly as sent, through the real Express routes.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('logger round trip: gym session', () => {
  it('POST session -> POST exercise performance -> PATCH completion -> GET session round-trips exactly', async () => {
    const created = await request(app)
      .post('/api/workouts')
      .send({ date: '2026-08-31', session_type: 'gym', status: 'in_progress' })
      .expect(201);
    const sessionId = created.body.session_id;
    expect(created.body.status).toBe('in_progress');

    const sets = [
      { set_number: 1, weight: 55, reps: 8, completed: true },
      { set_number: 2, weight: 55, reps: 7, completed: true },
      { set_number: 3, weight: 52.5, reps: 8, completed: false },
    ];
    const perf = await request(app)
      .post(`/api/workouts/${sessionId}/exercises`)
      .send({ exercise_id: 'flat-barbell-bench-press', order: 1, role: 'primary', sets })
      .expect(201);
    expect(perf.body.exercise_id).toBe('flat-barbell-bench-press');
    expect(perf.body.sets).toHaveLength(3);
    expect(perf.body.sets[0]).toMatchObject({ weight: 55, reps: 8, completed: true });
    expect(perf.body.sets[2]).toMatchObject({ weight: 52.5, reps: 8, completed: false });

    const completed = await request(app)
      .patch(`/api/workouts/${sessionId}`)
      .send({ status: 'completed', duration_minutes: 42 })
      .expect(200);
    expect(completed.body.status).toBe('completed');
    expect(completed.body.duration_minutes).toBe(42);

    const fetched = await request(app).get(`/api/workouts/${sessionId}`).expect(200);
    expect(fetched.body.status).toBe('completed');
    expect(fetched.body.exercises).toHaveLength(1);
    expect(fetched.body.exercises[0].sets.map((s: any) => ({ weight: s.weight, reps: s.reps, completed: s.completed }))).toEqual([
      { weight: 55, reps: 8, completed: true },
      { weight: 55, reps: 7, completed: true },
      { weight: 52.5, reps: 8, completed: false },
    ]);
  });
});

describe('logger round trip: badminton session', () => {
  it('POST session -> PUT badminton-details -> GET session round-trips exactly', async () => {
    const created = await request(app)
      .post('/api/workouts')
      .send({ date: '2026-08-31', session_type: 'badminton', status: 'in_progress' })
      .expect(201);
    const sessionId = created.body.session_id;

    const details = await request(app)
      .put(`/api/workouts/${sessionId}/badminton-details`)
      .send({ intensity: 'high', format: 'singles', games_count: 3, session_quality: 4, post_session_fatigue: 5, notes: 'tough match' })
      .expect(200);
    expect(details.body).toMatchObject({ intensity: 'high', format: 'singles', games_count: 3, session_quality: 4, post_session_fatigue: 5, notes: 'tough match' });

    const fetched = await request(app).get(`/api/workouts/${sessionId}`).expect(200);
    expect(fetched.body.badminton_details).toMatchObject({ intensity: 'high', format: 'singles', games_count: 3 });
  });
});

describe('exercise history endpoint', () => {
  it('returns real logged performances for one exact exercise, most-recent-first', async () => {
    const s1 = await request(app).post('/api/workouts').send({ date: '2026-08-24', session_type: 'gym', status: 'completed' }).expect(201);
    await request(app)
      .post(`/api/workouts/${s1.body.session_id}/exercises`)
      .send({ exercise_id: 'flat-barbell-bench-press', order: 1, role: 'primary', sets: [{ set_number: 1, weight: 50, reps: 8, completed: true }] })
      .expect(201);

    const s2 = await request(app).post('/api/workouts').send({ date: '2026-08-31', session_type: 'gym', status: 'completed' }).expect(201);
    await request(app)
      .post(`/api/workouts/${s2.body.session_id}/exercises`)
      .send({ exercise_id: 'flat-barbell-bench-press', order: 1, role: 'primary', sets: [{ set_number: 1, weight: 55, reps: 8, completed: true }] })
      .expect(201);

    const history = await request(app).get('/api/workouts/exercises/flat-barbell-bench-press/history').expect(200);
    expect(history.body.exercise_name).toBeTruthy();
    expect(history.body.performances).toHaveLength(2);
    expect(history.body.performances[0].date).toBe('2026-08-31'); // most-recent-first
    expect(history.body.performances[1].date).toBe('2026-08-24');
  });
});
