// Final Selected Session Resolution and AI/Deterministic Precedence
// Fixes §3/§10/§11.B: `POST /api/workouts` is the generic session-
// creation entry point ("Start workout"/"Log something else" on
// today.html) — before this fix it had NO conflict checking at all,
// unlike the AI-commit path (aiProposalLifecycle.ts), which already
// rejected committing over an existing planned/in_progress session. This
// closes that gap using the SAME shared rule
// (`findActiveGymSessionConflict`), so "at most one active real gym
// session per date" holds through every supported write path.

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
  it('rejects a second gym session for a date that already has one planned (409)', async () => {
    const first = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'planned' }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'planned' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACTIVE_GYM_SESSION_EXISTS');
    expect(res.body.conflictingSessionId).toBe(first.body.session_id);
  });

  it('rejects a second gym session for a date that already has one in_progress (409)', async () => {
    const first = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'in_progress' }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym' });
    expect(res.status).toBe(409);
    expect(res.body.conflictingSessionId).toBe(first.body.session_id);
  });

  it('allows a new gym session for a date whose only existing gym session is completed (a same-day makeup session)', async () => {
    await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym', status: 'completed', duration_minutes: 40 }).expect(201);

    const res = await request(app).post('/api/workouts').send({ date: '2026-09-10', session_type: 'gym' });
    expect(res.status).toBe(201);
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
