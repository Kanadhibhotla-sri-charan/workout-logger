// Past-day activity (2026-11-09): last week's Monday through yesterday can
// be changed by date; only that day's override is written, and what a day
// can become depends on what was logged there. "Today" is the real clock,
// so every date here is computed from it.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { addDays } from '../../src/engine/dateMath.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { todayForUser } from '../../src/lib/userTimezone.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

function setupProfile() {
  const user = new UsersRepo(db).getOrCreateDefault();
  return new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['dumbbell'],
    other_activity_schedule: [{ day: 'sunday', activity_type: 'badminton' }] as any,
  });
}

const put = (date: string, activity: string) => request(app).put(`/api/programming/past-days/${date}/activity`).send({ activity });

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('past-day activity', () => {
  it('lists last Monday through yesterday, newest first', async () => {
    setupProfile();
    const today = todayForUser(db);
    const res = await request(app).get('/api/programming/past-days').expect(200);
    const lastMonday = addDays(programmingWeekStart(today), -7);
    expect(res.body.first).toBe(lastMonday);
    expect(res.body.last).toBe(addDays(today, -1));
    expect(res.body.days[0].date).toBe(addDays(today, -1));
    expect(res.body.days.at(-1)).toMatchObject({ date: lastMonday, weekday: 'monday', activity: 'gym', workout: null, allowed: ['unselected', 'badminton'] });
    const lastSunday = res.body.days.find((d: { date: string }) => d.date === addDays(lastMonday, 6));
    expect(lastSunday).toMatchObject({ weekday: 'sunday', activity: 'badminton' });
  });

  it('marks last Sunday as rest: one override in that week, nothing else', async () => {
    const profile = setupProfile();
    const lastWeek = addDays(programmingWeekStart(todayForUser(db)), -7);
    const sunday = addDays(lastWeek, 6);
    const res = await put(sunday, 'unselected').expect(200);
    expect(res.body).toMatchObject({ date: sunday, activity: 'unselected' });
    expect([...new WeekActivityOverridesRepo(db).get(profile.id, lastWeek)]).toEqual([['sunday', 'unselected']]);
    expect(new WeekActivityOverridesRepo(db).get(profile.id, programmingWeekStart(todayForUser(db))).size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workout_sessions').get()).toEqual({ n: 0 });
  });

  it('a day with a completed workout can be Gym or Both only', async () => {
    setupProfile();
    const monday = addDays(programmingWeekStart(todayForUser(db)), -7);
    new WorkoutSessionsRepo(db).createSession({ date: monday, session_type: 'gym', status: 'completed', duration_minutes: 50 } as any);
    expect((await put(monday, 'unselected').expect(400)).body.error).toMatch(/gym\|both.*a gym workout logged/);
    expect((await put(monday, 'both').expect(200)).body).toMatchObject({ activity: 'both', allowed: ['gym', 'both'] });
  });

  it('a day with no workout can be Rest or Badminton only', async () => {
    setupProfile();
    const tuesday = addDays(programmingWeekStart(todayForUser(db)), -6);
    expect((await put(tuesday, 'gym').expect(400)).body.error).toMatch(/unselected\|badminton/);
    await put(tuesday, 'badminton').expect(200);
  });

  it('badminton is logged as a session but is not a gym workout (Saturday 7 Nov)', async () => {
    setupProfile();
    const saturday = addDays(programmingWeekStart(todayForUser(db)), -2);
    const sessions = new WorkoutSessionsRepo(db);
    sessions.createSession({ date: saturday, session_type: 'badminton', status: 'completed', duration_minutes: 100 } as any);
    const res = await request(app).get('/api/programming/past-days').expect(200);
    expect(res.body.days.find((d: { date: string }) => d.date === saturday)).toMatchObject({ workout: null, badmintonLogged: true, allowed: ['badminton'] });
    expect((await put(saturday, 'unselected').expect(400)).body.error).toMatch(/badminton logged/);
    await put(saturday, 'badminton').expect(200);
    // Gym on the same day too: Both only.
    sessions.createSession({ date: saturday, session_type: 'gym', status: 'completed', duration_minutes: 50 } as any);
    expect((await put(saturday, 'gym').expect(400)).body.error).toMatch(/a gym workout and badminton logged/);
    expect((await put(saturday, 'both').expect(200)).body).toMatchObject({ activity: 'both', allowed: ['both'] });
  });

  it('a planned workout blocks the change', async () => {
    setupProfile();
    const friday = addDays(programmingWeekStart(todayForUser(db)), -3);
    new WorkoutSessionsRepo(db).createSession({ date: friday, session_type: 'gym', status: 'planned' } as any);
    expect((await put(friday, 'unselected').expect(409)).body.error).toMatch(/planned workout/);
  });

  it('today, the future and two weeks back are refused', async () => {
    setupProfile();
    const today = todayForUser(db);
    await put(today, 'unselected').expect(400);
    await put(addDays(today, 1), 'unselected').expect(400);
    await put(addDays(programmingWeekStart(today), -8), 'unselected').expect(400);
    await put('2026-02-30', 'unselected').expect(400);
  });
});
