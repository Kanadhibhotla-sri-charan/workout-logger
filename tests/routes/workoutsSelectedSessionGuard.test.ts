// Final Selected Session Resolution and AI/Deterministic Precedence
// Fixes §3/§10/§11.B, widened by the Actionable vs Historical Session
// Resolution Fixes §2/§7: `POST /api/workouts` is the generic session-
// creation entry point ("Start workout"/"Log something else" on
// today.html) — before those fixes it had NO conflict checking at all,
// unlike the AI-commit path (aiProposalLifecycle.ts), which already
// rejected committing over an existing planned/in_progress session. This
// closes that gap using the SAME shared rule
// (`findActiveGymSessionConflict`), and — per the Actionable vs
// Historical fix — a COMPLETED Gym session now also blocks a new one
// (reversing the prior phase's "completed never blocks" decision; a
// same-day makeup session is explicitly deferred to a future, separate
// feature).

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

describe('POST /api/workouts — active-gym-session conflict guard', () => {
  it('rejects a second gym session for a date that already has one planned (409 ACTIVE_GYM_SESSION_EXISTS)', async () => {
    const first = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'planned' }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'planned' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACTIVE_GYM_SESSION_EXISTS');
    expect(res.body.conflictingSessionId).toBe(first.body.session_id);
  });

  it('rejects a second gym session for a date that already has one in_progress (409 DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION)', async () => {
    const first = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'in_progress' }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION');
    expect(res.body.conflictingSessionId).toBe(first.body.session_id);
  });

  it('rejects a second gym session for a date whose only existing gym session is completed (409 DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION) — no hidden same-day replacement', async () => {
    const first = await request(app)
      .post('/api/workouts')
      .send({ date: '2026-09-10', session_type: 'gym', status: 'completed', duration_minutes: 40 })
      .expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION');
    expect(res.body.conflictingSessionId).toBe(first.body.session_id);
    // The completed session itself is never touched by the rejected write.
    const stillThere = await request(app).get(`/api/workouts/${first.body.session_id}`).expect(200);
    expect(stillThere.body.status).toBe('completed');
  });

  it('never blocks a badminton session on a date that already has an active gym session', async () => {
    await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'planned' }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'badminton', status: 'planned' });
    expect(res.status).toBe(201);
  });

  it('never blocks a gym session on a different date', async () => {
    await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'planned' }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-11', session_type: 'gym', status: 'planned' });
    expect(res.status).toBe(201);
  });
});
