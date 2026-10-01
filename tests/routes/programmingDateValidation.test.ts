// P2 reliability fix (2026-10-01): a malformed ?date= on GET /api/programming/today
// (or /week) used to throw from date math outside the route's try in an async
// handler — an unhandled rejection that exited the production process (8 times,
// triggered by a scraper requesting the frontend's unexpanded `${session.date}`).
// It must now be a plain HTTP 400 that never escapes the request.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { todayForUser } from '../../src/lib/userTimezone.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell'],
    other_activity_schedule: [],
  });
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

const MALFORMED = ['${session.date}', '%24%7Bsession.date%7D', 'not-a-date', '2026-02-30', '2026-13-01', '20261001', ''];

describe('GET /api/programming/today and /week — malformed ?date=', () => {
  for (const route of ['/api/programming/today', '/api/programming/week']) {
    for (const bad of MALFORMED) {
      it(`${route}?date=${bad} → 400, nothing escapes the request`, async () => {
        const res = await request(app).get(`${route}?date=${bad}`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'date must be a real calendar date in YYYY-MM-DD format' });
      });
    }
  }

  it('the exact production request is a 400, raises no unhandled rejection, and the app keeps serving', async () => {
    await request(app).get('/api/programming/today?date=${session.date}').expect(400);
    await request(app).get('/api/programming/week?date=${session.date}').expect(400);
    await new Promise((r) => setTimeout(r, 20)); // let any stray rejection surface
    expect(unhandled).toEqual([]);
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/programming/today').expect(200);
  });
});

describe('valid dates are unchanged', () => {
  it('/today with today\'s date returns exactly what /today without a date returns', async () => {
    const today = todayForUser(db);
    const implicit = await request(app).get('/api/programming/today').expect(200);
    const explicit = await request(app).get(`/api/programming/today?date=${today}`).expect(200);
    expect(explicit.body).toEqual(implicit.body);
  });

  it('/week with a valid date in this week returns exactly what /week without a date returns', async () => {
    const today = todayForUser(db);
    const implicit = await request(app).get('/api/programming/week').expect(200);
    const explicit = await request(app).get(`/api/programming/week?date=${today}`).expect(200);
    expect(explicit.body).toEqual(implicit.body);
    expect(unhandled).toEqual([]);
  });
});
