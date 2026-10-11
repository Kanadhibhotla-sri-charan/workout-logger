// "Other" day notes (2026-10-11): free text about a day's non-logged
// activity (rehab, a sport, an injury), saved per date, shown on the week
// and passed to the AI Programmer as context. Real routes and context
// builder, in-memory database, fixed clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { DayNotesRepo } from '../../src/repositories/dayNotesRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { buildPlannedAIContext, buildPlannedProgrammerSystemInstruction } from '../../src/ai-programmer/planning/plannedContext.js';

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T03:00:00Z'));
  process.env.AI_WEEK_GENERATION_MODE = 'explicit';
  db = openDb(':memory:');
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
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AI_WEEK_GENERATION_MODE;
});

describe('PUT /api/programming/days/:date/note', () => {
  it('saves a note, shows it on that day of the week, and deletes it when emptied', async () => {
    const app = createApp(db);
    await request(app).put('/api/programming/days/2026-10-10/note').send({ note: '  Knee rehab, 20 min. Left knee sore.  ' }).expect(200, { date: '2026-10-10', note: 'Knee rehab, 20 min. Left knee sore.' });
    const week = (await request(app).get('/api/programming/week?date=2026-10-10').expect(200)).body;
    expect(week.days.find((d: any) => d.date === '2026-10-10').otherNote).toBe('Knee rehab, 20 min. Left knee sore.');
    expect(week.days.filter((d: any) => d.otherNote).length).toBe(1);

    await request(app).put('/api/programming/days/2026-10-10/note').send({ note: '' }).expect(200, { date: '2026-10-10', note: null });
    expect(new DayNotesRepo(db).get('2026-10-10')).toBeNull();
  });

  it('does not change the day\'s activity or write a week program', async () => {
    const app = createApp(db);
    const before = (await request(app).get('/api/programming/week?date=2026-10-10').expect(200)).body.days.map((d: any) => d.activity);
    await request(app).put('/api/programming/days/2026-10-10/note').send({ note: 'rehab' }).expect(200);
    const after = (await request(app).get('/api/programming/week?date=2026-10-10').expect(200)).body.days.map((d: any) => d.activity);
    expect(after).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n).toBe(0);
  });

  it('rejects a bad date, a non-string note and an over-long note', async () => {
    const app = createApp(db);
    await request(app).put('/api/programming/days/2026-13-01/note').send({ note: 'x' }).expect(400);
    await request(app).put('/api/programming/days/2026-10-10/note').send({ note: 5 }).expect(400);
    await request(app).put('/api/programming/days/2026-10-10/note').send({ note: 'x'.repeat(2001) }).expect(400);
  });
});

describe('the AI Programmer reads the notes', () => {
  it('includes the last 14 days of notes up to the target date, oldest first', () => {
    const notes = new DayNotesRepo(db);
    notes.set('2026-09-20', 'too old');
    notes.set('2026-10-10', 'Knee rehab. Left knee sore.');
    notes.set('2026-10-01', 'Badminton, felt fine.');
    notes.set('2026-10-20', 'after the target date');
    const context = buildProgrammerContext(db, { targetDate: '2026-10-12', requestedSessionPurpose: 'push' });
    expect(context.activityNotes).toEqual([
      { date: '2026-10-01', note: 'Badminton, felt fine.' },
      { date: '2026-10-10', note: 'Knee rehab. Left knee sore.' },
    ]);
  });

  it('passes them in the planned context, with an instruction on how to use them', () => {
    new DayNotesRepo(db).set('2026-10-10', 'Knee rehab. Left knee sore.');
    const context = buildProgrammerContext(db, { targetDate: '2026-10-12', requestedSessionPurpose: 'push' });
    const planned = buildPlannedAIContext(context, planSession(context, { nonGoalRotationCursor: 0 }));
    expect(planned.activityNotes).toEqual([{ date: '2026-10-10', note: 'Knee rehab. Left knee sore.' }]);
    expect(buildPlannedProgrammerSystemInstruction()).toMatch(/context\.activityNotes are the user's own notes/);
  });

  it('a new note changes the context hash, so a failed day can be retried with it', () => {
    const before = buildProgrammerContext(db, { targetDate: '2026-10-12', requestedSessionPurpose: 'push' }).contextHash;
    new DayNotesRepo(db).set('2026-10-10', 'Knee rehab.');
    expect(buildProgrammerContext(db, { targetDate: '2026-10-12', requestedSessionPurpose: 'push' }).contextHash).not.toBe(before);
  });
});
