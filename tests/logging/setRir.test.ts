// Reps in reserve per set (2026-10-12): the logger has an optional RIR box
// on every set, the API accepts a whole number 0-10 or null, and the value
// reaches Insights (and so the coach review) and the progression rule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { strengthProgress } from '../../src/insights/insightsService.js';
import { buildCoachInstruction } from '../../src/coaching/review/coachReviewService.js';

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T03:00:00Z'));
  db = openDb(':memory:');
  new UsersRepo(db).getOrCreateDefault();
});

afterEach(() => vi.useRealTimers());

const set = (n: number, weight: number, reps: number, rir?: unknown) => ({ set_number: n, weight, reps, completed: true, ...(rir === undefined ? {} : { rir }) });

describe('API', () => {
  it('POST and PATCH store RIR per set; missing stays null', async () => {
    const s = new WorkoutSessionsRepo(db).createSession({ date: '2026-11-09', session_type: 'gym', status: 'in_progress' });
    const app = createApp(db);
    const perf = (await request(app).post(`/api/workouts/${s.session_id}/exercises`)
      .send({ exercise_id: 'cable-pushdown', order: 0, role: 'primary', sets: [set(1, 27, 12), set(2, 33, 10, 1)] }).expect(201)).body;
    expect(perf.sets.map((x: any) => x.rir)).toEqual([null, 1]);
    const patched = (await request(app).patch(`/api/workouts/${s.session_id}/exercises/${perf.id}`)
      .send({ sets: [set(1, 27, 12, 3), set(2, 33, 10, 0)] }).expect(200)).body;
    expect(patched.sets.map((x: any) => x.rir)).toEqual([3, 0]);
  });

  it('rejects RIR that is not a whole number 0-10', async () => {
    const s = new WorkoutSessionsRepo(db).createSession({ date: '2026-11-09', session_type: 'gym', status: 'in_progress' });
    const app = createApp(db);
    for (const rir of [-1, 11, 1.5, '2']) {
      const res = await request(app).post(`/api/workouts/${s.session_id}/exercises`)
        .send({ exercise_id: 'cable-pushdown', order: 0, role: 'primary', sets: [set(1, 27, 12, rir)] }).expect(400);
      expect(res.body.error).toMatch(/rir/);
    }
    const perf = (await request(app).post(`/api/workouts/${s.session_id}/exercises`)
      .send({ exercise_id: 'cable-pushdown', order: 0, role: 'primary', sets: [set(1, 27, 12, null)] }).expect(201)).body;
    await request(app).patch(`/api/workouts/${s.session_id}/exercises/${perf.id}`).send({ sets: [set(1, 27, 12, 12)] }).expect(400);
  });
});

it('Insights best set carries the RIR, which the coach review reads', () => {
  const repo = new WorkoutSessionsRepo(db);
  for (const [date, rir] of [['2026-11-02', 2], ['2026-11-09', null]] as const) {
    const s = repo.createSession({ date, session_type: 'gym', status: 'completed' });
    repo.addExercisePerformance(s.session_id, { exercise_id: 'cable-pushdown', order: 0, role: 'primary', sets: [{ ...set(1, 33, 10), rir }] });
  }
  const [p] = strengthProgress(db, '2026-11-20').filter((x) => x.exerciseId === 'cable-pushdown');
  expect(p!.points.map((x) => x.bestSet)).toEqual(['33 kg × 10 @ RIR 2', '33 kg × 10']);
  expect(buildCoachInstruction()).toMatch(/@ RIR n/);
});

it('the logger has an RIR box on every set and shows it once logged', () => {
  const html = readFileSync(new URL('../../public/logger.html', import.meta.url), 'utf8');
  expect(html).toMatch(/placeholder: 'RIR'/);
  expect(html).toMatch(/row\.append\(weight, reps, rir, done, remove\)/);
  expect(html).toMatch(/el\('th', \{ text: 'RIR' \}\)/);
  expect(html).toMatch(/@RIR \$\{s\.rir\}/);
});
