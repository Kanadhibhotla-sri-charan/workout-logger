// UI Build Phase §59: real HTTP round-trip through the logger's own API
// calls — POST session, POST exercise performance, PUT badminton
// details, PATCH completion, GET session — asserting the saved data
// comes back exactly as sent, through the real Express routes.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

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

describe('logger round trip: editing an already-existing exercise', () => {
  // Fix: an AI-committed session pre-creates its exercises (with empty,
  // uncompleted sets) at commit time — the only way to fill in
  // weight/reps for them is this PATCH route. This also covers the more
  // general case (any exercise, AI or not) that previously had no way
  // to be edited once its row existed at all.
  it('PATCH exercises/:exerciseId replaces that exercise\'s sets, and the change round-trips through GET', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-08-31', session_type: 'gym', status: 'planned' }).expect(201);
    const sessionId = created.body.session_id;

    // Simulates an AI-committed exercise: pre-created with empty,
    // uncompleted sets and a planned prescription, before any logging.
    // The public POST route has no target_* fields in its request body
    // (only aiProposalLifecycle.ts's commit calls the repo directly with
    // them), so the fixture is built through the repo layer directly.
    const exerciseId = new WorkoutSessionsRepo(db).addExercisePerformance(sessionId, {
      exercise_id: 'flat-barbell-bench-press',
      order: 1,
      role: 'primary',
      target_sets: 3,
      target_reps_min: 6,
      target_reps_max: 10,
      sets: [
        { set_number: 1, weight: null, reps: null, completed: false },
        { set_number: 2, weight: null, reps: null, completed: false },
        { set_number: 3, weight: null, reps: null, completed: false },
      ],
    }).id;

    const patched = await request(app)
      .patch(`/api/workouts/${sessionId}/exercises/${exerciseId}`)
      .send({ sets: [
        { set_number: 1, weight: 60, reps: 8, completed: true },
        { set_number: 2, weight: 60, reps: 7, completed: true },
        { set_number: 3, weight: 57.5, reps: 8, completed: false },
      ] })
      .expect(200);
    expect(patched.body.sets.map((s: any) => ({ weight: s.weight, reps: s.reps, completed: s.completed }))).toEqual([
      { weight: 60, reps: 8, completed: true },
      { weight: 60, reps: 7, completed: true },
      { weight: 57.5, reps: 8, completed: false },
    ]);
    // The planned prescription (target_*) is untouched by a sets-only PATCH.
    expect(patched.body.target_sets).toBe(3);

    const fetched = await request(app).get(`/api/workouts/${sessionId}`).expect(200);
    expect(fetched.body.exercises).toHaveLength(1); // PATCH replaces sets in place, never adds a second exercise row
    expect(fetched.body.exercises[0].sets.map((s: any) => ({ weight: s.weight, reps: s.reps, completed: s.completed }))).toEqual([
      { weight: 60, reps: 8, completed: true },
      { weight: 60, reps: 7, completed: true },
      { weight: 57.5, reps: 8, completed: false },
    ]);
  });

  it('PATCH exercises/:exerciseId rejects an exerciseId that belongs to a different session', async () => {
    const sessionA = await request(app).post('/api/workouts').send({ date: '2026-08-31', session_type: 'gym', status: 'planned' }).expect(201);
    const sessionB = await request(app).post('/api/workouts').send({ date: '2026-09-01', session_type: 'gym', status: 'planned' }).expect(201);
    const perfA = await request(app)
      .post(`/api/workouts/${sessionA.body.session_id}/exercises`)
      .send({ exercise_id: 'flat-barbell-bench-press', order: 1, role: 'primary', sets: [{ set_number: 1, weight: null, reps: null, completed: false }] })
      .expect(201);

    await request(app)
      .patch(`/api/workouts/${sessionB.body.session_id}/exercises/${perfA.body.id}`)
      .send({ sets: [{ set_number: 1, weight: 100, reps: 5, completed: true }] })
      .expect(404);

    // Session A's own exercise is untouched by the rejected cross-session attempt.
    const fetched = await request(app).get(`/api/workouts/${sessionA.body.session_id}`).expect(200);
    expect(fetched.body.exercises[0].sets[0]).toMatchObject({ weight: null, reps: null, completed: false });
  });

  // Fix: Skip for an already-persisted exercise needs a real delete
  // (unlike the deterministic flow's purely client-side skip) so it
  // doesn't reappear on the next GET/reload.
  it('DELETE exercises/:exerciseId removes the exercise (and its sets) entirely', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-08-31', session_type: 'gym', status: 'planned' }).expect(201);
    const sessionId = created.body.session_id;
    const perf = await request(app)
      .post(`/api/workouts/${sessionId}/exercises`)
      .send({ exercise_id: 'flat-barbell-bench-press', order: 1, role: 'primary', sets: [{ set_number: 1, weight: null, reps: null, completed: false }] })
      .expect(201);

    await request(app).delete(`/api/workouts/${sessionId}/exercises/${perf.body.id}`).expect(204);

    const fetched = await request(app).get(`/api/workouts/${sessionId}`).expect(200);
    expect(fetched.body.exercises).toHaveLength(0);
  });

  it('DELETE exercises/:exerciseId rejects an exerciseId that belongs to a different session', async () => {
    const sessionA = await request(app).post('/api/workouts').send({ date: '2026-08-31', session_type: 'gym', status: 'planned' }).expect(201);
    const sessionB = await request(app).post('/api/workouts').send({ date: '2026-09-01', session_type: 'gym', status: 'planned' }).expect(201);
    const perfA = await request(app)
      .post(`/api/workouts/${sessionA.body.session_id}/exercises`)
      .send({ exercise_id: 'flat-barbell-bench-press', order: 1, role: 'primary', sets: [{ set_number: 1, weight: null, reps: null, completed: false }] })
      .expect(201);

    await request(app).delete(`/api/workouts/${sessionB.body.session_id}/exercises/${perfA.body.id}`).expect(404);

    const fetched = await request(app).get(`/api/workouts/${sessionA.body.session_id}`).expect(200);
    expect(fetched.body.exercises).toHaveLength(1); // untouched by the rejected cross-session attempt
  });

  // Fix: target_type/target_id round-trip through POST/GET — needed so
  // Substitute (GET /api/programming/substitutes) works for an
  // already-persisted exercise, not just a deterministic-preview one.
  it('POST exercises accepts and round-trips the full planned prescription including target_type/target_id', async () => {
    const created = await request(app).post('/api/workouts').send({ date: '2026-08-31', session_type: 'gym', status: 'planned' }).expect(201);
    const sessionId = created.body.session_id;

    const perf = await request(app)
      .post(`/api/workouts/${sessionId}/exercises`)
      .send({
        exercise_id: 'flat-barbell-bench-press',
        order: 1,
        role: 'primary',
        target_sets: 3,
        target_reps_min: 6,
        target_reps_max: 10,
        target_rir_min: 1,
        target_rir_max: 3,
        target_rest_seconds: 90,
        target_type: 'physique_target',
        target_id: 'mid-pec',
        sets: [{ set_number: 1, weight: null, reps: null, completed: false }],
      })
      .expect(201);
    expect(perf.body).toMatchObject({ target_type: 'physique_target', target_id: 'mid-pec', target_sets: 3 });

    const fetched = await request(app).get(`/api/workouts/${sessionId}`).expect(200);
    expect(fetched.body.exercises[0]).toMatchObject({ target_type: 'physique_target', target_id: 'mid-pec' });
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
