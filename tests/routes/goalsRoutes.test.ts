// UI Build Phase §60: real HTTP coverage of the goal-creation hybrid
// flow's persistence boundary, plus the new priority/deactivate/
// reactivate/events routes.

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

describe('POST /api/goals/match', () => {
  it('never persists a goal — read-only candidate matching', async () => {
    const before = await request(app).get('/api/goals').expect(200);
    expect(before.body).toHaveLength(0);

    const matched = await request(app).post('/api/goals/match').send({ text: 'my arms look thin from the side' }).expect(200);
    expect(Array.isArray(matched.body.candidates)).toBe(true);
    expect(matched.body.candidates.length).toBeGreaterThan(0);

    const after = await request(app).get('/api/goals').expect(200);
    expect(after.body).toHaveLength(0); // still nothing persisted
  });
});

describe('POST /api/goals with source=natural_language', () => {
  it('persists the confirmed goal with source and source_text preserved', async () => {
    const matched = await request(app).post('/api/goals/match').send({ text: 'my arms look thin from the side' }).expect(200);
    const candidate = matched.body.candidates[0];

    const created = await request(app)
      .post('/api/goals')
      .send({ goal_type: candidate.goal_type, blueprint_ref: candidate.blueprint_ref, priority: 1, source: 'natural_language', source_text: 'my arms look thin from the side' })
      .expect(201);

    expect(created.body.source).toBe('natural_language');
    expect(created.body.source_text).toBe('my arms look thin from the side');
    expect(created.body.blueprint_ref).toBe(candidate.blueprint_ref);

    const list = await request(app).get('/api/goals').expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('requires source_text when source is natural_language', async () => {
    await request(app)
      .post('/api/goals')
      .send({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, source: 'natural_language' })
      .expect(400);
  });
});

describe('goal priority/deactivate/reactivate/events routes', () => {
  it('PATCH /:id/priority changes rank and records a real event', async () => {
    const created = await request(app).post('/api/goals').send({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 }).expect(201);
    const updated = await request(app).patch(`/api/goals/${created.body.id}/priority`).send({ priority: 2 }).expect(200);
    expect(updated.body.priority).toBe(2);

    const events = await request(app).get(`/api/goals/${created.body.id}/events`).expect(200);
    expect(events.body.some((e: any) => e.event_type === 'priority_changed')).toBe(true);
  });

  it('POST /:id/deactivate frees the active-aesthetic-goal slot, POST /:id/reactivate restores it', async () => {
    const created = await request(app).post('/api/goals').send({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 }).expect(201);

    const deactivated = await request(app).post(`/api/goals/${created.body.id}/deactivate`).expect(200);
    expect(deactivated.body.active).toBe(false);

    const reactivated = await request(app).post(`/api/goals/${created.body.id}/reactivate`).expect(200);
    expect(reactivated.body.active).toBe(true);

    const events = await request(app).get(`/api/goals/${created.body.id}/events`).expect(200);
    const types = events.body.map((e: any) => e.event_type);
    expect(types).toEqual(['created', 'activated', 'deactivated', 'activated']);
  });

  it('rejects a third active aesthetic goal via the real backend restriction, surfaced as an error the UI must show verbatim', async () => {
    await request(app).post('/api/goals').send({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 }).expect(201);
    await request(app).post('/api/goals').send({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 2 }).expect(201);
    const rejected = await request(app).post('/api/goals').send({ goal_type: 'aesthetic', blueprint_ref: 'shoulder-width-front', priority: 3 }).expect(400);
    expect(rejected.body.error).toBeTruthy();
  });
});
