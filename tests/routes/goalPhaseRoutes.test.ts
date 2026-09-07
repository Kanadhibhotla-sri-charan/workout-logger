// Programming Redesign (Step 12) Phase 11: HTTP-level tests for the
// newly-exposed assessment/measurement routes and the new goal-phase/
// review routes — proves the routes are thin, correct wiring over the
// already-tested repos/engine (tests/repositories/goalPhaseRepo.test.ts,
// tests/engine/goalPhaseEngine.test.ts), not a second implementation.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let goalId: string;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
  // Remediation (Step 12 Fix) §5: an ACTIVE goal now gets its own
  // auto-created phase (GoalsRepo.create -> ensureActivePhase). This
  // file's "Goal phase routes"/"review routes" tests deliberately manage
  // phases explicitly through the routes themselves, so the goal is
  // created inactive here to avoid colliding with that auto-created
  // phase — the auto-creation hook itself is covered separately in
  // tests/goalPhaseLifecycleLinkage.test.ts.
  goalId = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, active: false }).id;
});

describe('Aesthetic assessment routes (previously unrouted)', () => {
  it('records and lists a real assessment for a goal', async () => {
    await request(app).post(`/api/goals/${goalId}/assessments`).send({ date: '2026-09-01', rating: 4 }).expect(201);
    const list = await request(app).get(`/api/goals/${goalId}/assessments`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].rating).toBe(4);
  });

  it('rejects an out-of-range rating', async () => {
    const res = await request(app).post(`/api/goals/${goalId}/assessments`).send({ date: '2026-09-01', rating: 9 }).expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it('404s for an unknown goal', async () => {
    await request(app).post('/api/goals/does-not-exist/assessments').send({ date: '2026-09-01', rating: 3 }).expect(404);
  });
});

describe('Measurement routes (previously unrouted)', () => {
  it('records and lists a real goal-scoped measurement', async () => {
    await request(app).post(`/api/goals/${goalId}/measurements`).send({ date: '2026-09-01', metric_name: 'chest', value: 101.5, unit: 'cm' }).expect(201);
    const list = await request(app).get(`/api/goals/${goalId}/measurements`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].value).toBe(101.5);
  });

  it('records a measurement with no goal via the top-level route', async () => {
    const res = await request(app).post('/api/goals/measurements').send({ date: '2026-09-01', metric_name: 'bodyweight', value: 78, unit: 'kg' }).expect(201);
    expect(res.body.goal_id).toBeNull();
    const list = await request(app).get('/api/goals/measurements').expect(200);
    expect(list.body.some((m: any) => m.id === res.body.id)).toBe(true);
  });
});

describe('Goal phase routes', () => {
  it('creates a phase, rejects a second concurrent one, and lists history', async () => {
    const created = await request(app)
      .post(`/api/goals/${goalId}/phases`)
      .send({ start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' })
      .expect(201);
    expect(created.body.status).toBe('active');

    await request(app).post(`/api/goals/${goalId}/phases`).send({ start_date: '2026-08-01', review_date: '2026-09-12' }).expect(400);

    const active = await request(app).get(`/api/goals/${goalId}/phases/active`).expect(200);
    expect(active.body.id).toBe(created.body.id);

    const list = await request(app).get(`/api/goals/${goalId}/phases`).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('404s phases/active when no phase exists yet', async () => {
    await request(app).get(`/api/goals/${goalId}/phases/active`).expect(404);
  });
});

describe('Goal phase review routes — full lifecycle round trip', () => {
  it('run a review, then apply a decision, and see the real lifecycle effect', async () => {
    const phase = await request(app)
      .post(`/api/goals/${goalId}/phases`)
      .send({ start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' })
      .expect(201);

    const review = await request(app)
      .post(`/api/goals/${goalId}/phases/${phase.body.id}/reviews`)
      .send({ as_of_date: '2026-09-12' })
      .expect(201);
    expect(['continue', 'adjust', 'graduate']).toContain(review.body.system_recommendation);
    expect(review.body.user_decision).toBeNull();

    const listed = await request(app).get(`/api/goals/${goalId}/phases/${phase.body.id}/reviews`).expect(200);
    expect(listed.body).toHaveLength(1);

    const decided = await request(app)
      .put(`/api/goals/${goalId}/phases/${phase.body.id}/reviews/${review.body.id}/decision`)
      .send({ decision: 'continue', as_of_date: '2026-09-12' })
      .expect(200);
    expect(decided.body.phase.status).toBe('active');
    expect(decided.body.phase.id).toBe(phase.body.id);
  });

  it('the "adjust" decision, applied via the route, produces a real new phase visible in the goal\'s phase list', async () => {
    const phase = await request(app)
      .post(`/api/goals/${goalId}/phases`)
      .send({ start_date: '2026-08-01', review_date: '2026-09-12' })
      .expect(201);
    const review = await request(app).post(`/api/goals/${goalId}/phases/${phase.body.id}/reviews`).send({ as_of_date: '2026-09-12' }).expect(201);

    const decided = await request(app)
      .put(`/api/goals/${goalId}/phases/${phase.body.id}/reviews/${review.body.id}/decision`)
      .send({ decision: 'adjust', as_of_date: '2026-09-12' })
      .expect(200);
    expect(decided.body.phase.status).toBe('completed');
    expect(decided.body.newPhase).not.toBeNull();

    const list = await request(app).get(`/api/goals/${goalId}/phases`).expect(200);
    expect(list.body).toHaveLength(2);
  });

  it('the "graduate" decision deactivates the real goal', async () => {
    const phase = await request(app)
      .post(`/api/goals/${goalId}/phases`)
      .send({ start_date: '2026-08-01', review_date: '2026-09-12' })
      .expect(201);
    const review = await request(app).post(`/api/goals/${goalId}/phases/${phase.body.id}/reviews`).send({ as_of_date: '2026-09-12' }).expect(201);

    await request(app)
      .put(`/api/goals/${goalId}/phases/${phase.body.id}/reviews/${review.body.id}/decision`)
      .send({ decision: 'graduate', as_of_date: '2026-09-12' })
      .expect(200);

    const goal = await request(app).get(`/api/goals/${goalId}`).expect(200);
    expect(goal.body.active).toBe(false);
  });

  it('rejects an invalid decision value', async () => {
    const phase = await request(app).post(`/api/goals/${goalId}/phases`).send({ start_date: '2026-08-01', review_date: '2026-09-12' }).expect(201);
    const review = await request(app).post(`/api/goals/${goalId}/phases/${phase.body.id}/reviews`).send({ as_of_date: '2026-09-12' }).expect(201);
    await request(app)
      .put(`/api/goals/${goalId}/phases/${phase.body.id}/reviews/${review.body.id}/decision`)
      .send({ decision: 'not-a-real-decision' })
      .expect(400);
  });

  it('rejects recording a second decision on the same review', async () => {
    const phase = await request(app).post(`/api/goals/${goalId}/phases`).send({ start_date: '2026-08-01', review_date: '2026-09-12' }).expect(201);
    const review = await request(app).post(`/api/goals/${goalId}/phases/${phase.body.id}/reviews`).send({ as_of_date: '2026-09-12' }).expect(201);
    await request(app).put(`/api/goals/${goalId}/phases/${phase.body.id}/reviews/${review.body.id}/decision`).send({ decision: 'continue' }).expect(200);
    await request(app).put(`/api/goals/${goalId}/phases/${phase.body.id}/reviews/${review.body.id}/decision`).send({ decision: 'adjust' }).expect(400);
  });
});
