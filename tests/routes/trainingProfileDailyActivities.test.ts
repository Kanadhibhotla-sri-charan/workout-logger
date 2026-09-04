// Blueprint Picker/Daily Activity spec §14: HTTP-level tests for the
// new GET/PUT daily-activities routes — exercising the actual Express
// routes, not just the repo in isolation.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

function seedProfile() {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'wednesday'],
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: [],
    other_activity_schedule: [{ day: 'wednesday', activity_type: 'badminton', notes: null }],
  });
}

describe('GET /api/training-profile/daily-activities', () => {
  it('returns all seven days as unselected when no profile exists yet', async () => {
    const res = await request(app).get('/api/training-profile/daily-activities').expect(200);
    expect(res.body).toHaveLength(7);
    expect(res.body.every((d: any) => d.activity === 'unselected')).toBe(true);
  });

  it('derives the real activity from the stored profile', async () => {
    seedProfile();
    const res = await request(app).get('/api/training-profile/daily-activities').expect(200);
    const byDay = Object.fromEntries(res.body.map((d: any) => [d.weekday, d.activity]));
    expect(byDay.monday).toBe('gym');
    expect(byDay.wednesday).toBe('both');
    expect(byDay.tuesday).toBe('unselected');
  });
});

describe('PUT /api/training-profile/daily-activities/:day', () => {
  it('changes one day and returns the fresh full week', async () => {
    seedProfile();
    const res = await request(app)
      .put('/api/training-profile/daily-activities/friday')
      .send({ activity: 'badminton' })
      .expect(200);
    const byDay = Object.fromEntries(res.body.map((d: any) => [d.weekday, d.activity]));
    expect(byDay.friday).toBe('badminton');
    expect(byDay.monday).toBe('gym'); // untouched
  });

  it('the change is immediately visible on a subsequent GET (no separate reconcile step needed)', async () => {
    seedProfile();
    await request(app).put('/api/training-profile/daily-activities/friday').send({ activity: 'gym' }).expect(200);
    const res = await request(app).get('/api/training-profile/daily-activities').expect(200);
    const friday = res.body.find((d: any) => d.weekday === 'friday');
    expect(friday.activity).toBe('gym');
  });

  it('rejects an invalid weekday', async () => {
    seedProfile();
    const res = await request(app).put('/api/training-profile/daily-activities/someday').send({ activity: 'gym' }).expect(400);
    expect(res.body.error).toMatch(/day must be one of/);
  });

  it('rejects an invalid activity value', async () => {
    seedProfile();
    const res = await request(app).put('/api/training-profile/daily-activities/monday').send({ activity: 'rest' }).expect(400);
    expect(res.body.error).toMatch(/activity must be one of/);
  });

  it('returns 404 when no training profile exists yet', async () => {
    const res = await request(app).put('/api/training-profile/daily-activities/monday').send({ activity: 'gym' }).expect(404);
    expect(res.body.error).toMatch(/No training profile/);
  });
});
