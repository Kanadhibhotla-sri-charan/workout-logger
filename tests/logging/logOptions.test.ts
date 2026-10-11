// Attachment and count unit on every logged exercise (2026-10-11): any
// exercise can record the attachment used (rope, V-bar...) and whether its
// set counts are reps, steps, seconds or metres. Progress is compared only
// within the same equipment, attachment and unit, and weight x reps maths
// never reads steps/seconds/metres as reps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { strengthProgress } from '../../src/insights/insightsService.js';
import { getTargetHistory } from '../../src/coaching/history/historicalService.js';
import { targetDeclineEvidence } from '../../src/coaching/periodization/reactiveTrendEvaluator.js';
import { getCompletedWorkouts } from '../../src/services/calorieTrackerExport.js';
import { ATTACHMENT_CHOICES, REP_UNITS } from '../../src/contracts/loggingOptions.js';

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T03:00:00Z'));
  db = openDb(':memory:');
  new UsersRepo(db).getOrCreateDefault();
});

afterEach(() => vi.useRealTimers());

function log(date: string, exerciseId: string, opts: { attachment?: string | null; rep_unit?: string | null }, sets: Array<[number | null, number]>) {
  const repo = new WorkoutSessionsRepo(db);
  const s = repo.listSessionsByDate(date)[0] ?? repo.createSession({ date, session_type: 'gym', status: 'completed' });
  return repo.addExercisePerformance(s.session_id, {
    exercise_id: exerciseId, order: 0, role: 'primary', ...opts,
    sets: sets.map(([weight, reps], i) => ({ set_number: i + 1, weight, reps, completed: true })),
  });
}

describe('storage and API', () => {
  it('any exercise takes any attachment and unit; a new row starts with the last ones used', () => {
    log('2026-11-02', 'flat-barbell-bench-press', { attachment: 'belt', rep_unit: 'reps' }, [[60, 8]]);
    log('2026-11-03', 'suitcase-carry', { rep_unit: 'steps' }, [[24, 40]]);
    const repo = new WorkoutSessionsRepo(db);
    const s = repo.createSession({ date: '2026-11-09', session_type: 'gym', status: 'planned' });
    const carry = repo.addExercisePerformance(s.session_id, { exercise_id: 'suitcase-carry', order: 0, role: 'primary', sets: [] });
    expect(carry.rep_unit).toBe('steps');
    expect(carry.attachment).toBeNull();
    const pushdown = repo.addExercisePerformance(s.session_id, { exercise_id: 'cable-pushdown', order: 1, role: 'primary', sets: [] });
    expect([pushdown.attachment, pushdown.rep_unit]).toEqual([null, null]);
  });

  it('PATCH sets or clears attachment and unit alone, and rejects junk', async () => {
    const perf = log('2026-11-09', 'cable-pushdown', {}, [[30, 12]]);
    const path = `/api/workouts/${perf.workout_session_id}/exercises/${perf.id}`;
    const app = createApp(db);
    expect((await request(app).patch(path).send({ attachment: 'rope' }).expect(200)).body).toMatchObject({ attachment: 'rope', rep_unit: null });
    expect((await request(app).patch(path).send({ rep_unit: 'seconds' }).expect(200)).body).toMatchObject({ attachment: 'rope', rep_unit: 'seconds' });
    expect(new WorkoutSessionsRepo(db).getExercisePerformances(perf.workout_session_id)[0]!.sets[0]!.weight).toBe(30); // sets untouched
    expect((await request(app).patch(path).send({ attachment: null, rep_unit: null }).expect(200)).body).toMatchObject({ attachment: null, rep_unit: null });
    await request(app).patch(path).send({ rep_unit: 'laps' }).expect(400);
    await request(app).patch(path).send({ attachment: 7 }).expect(400);
    await request(app).patch(path).send({}).expect(400);
  });

  it('POST accepts them too', async () => {
    const s = new WorkoutSessionsRepo(db).createSession({ date: '2026-11-09', session_type: 'gym', status: 'in_progress' });
    const body = (await request(createApp(db)).post(`/api/workouts/${s.session_id}/exercises`)
      .send({ exercise_id: 'farmers-carry', order: 0, role: 'primary', rep_unit: 'metres', attachment: 'other', sets: [] }).expect(201)).body;
    expect(body).toMatchObject({ rep_unit: 'metres', attachment: 'other' });
  });
});

describe('progress maths', () => {
  it('steps are not reps: no estimated 1RM or reps in history', () => {
    log('2026-11-02', 'suitcase-carry', { rep_unit: 'steps' }, [[24, 40]]);
    const [e] = getTargetHistory(db, 'obliques', '2026-11-01', '2026-11-20');
    expect(e).toMatchObject({ exerciseId: 'suitcase-carry', repUnit: 'steps', load: undefined, completedReps: undefined, completedSets: 1 });
  });

  it('Insights: a steps series tracks the heaviest load, labelled with the unit', () => {
    log('2026-11-02', 'suitcase-carry', { rep_unit: 'steps' }, [[20, 40]]);
    log('2026-11-09', 'suitcase-carry', { rep_unit: 'steps' }, [[24, 40]]);
    const [p] = strengthProgress(db, '2026-11-20').filter((x) => x.exerciseId === 'suitcase-carry');
    expect(p).toMatchObject({ unit: 'kg', countUnit: 'steps', first: 20, last: 24, status: 'new_best' });
    expect(p!.points.map((x) => x.bestSet)).toEqual(['20 kg × 40 steps', '24 kg × 40 steps']);
  });

  it('Insights: rope and straight-bar pushdowns are separate series', () => {
    for (const d of ['2026-11-02', '2026-11-05']) log(d, 'cable-pushdown', { attachment: 'straight bar' }, [[40, 12]]);
    for (const d of ['2026-11-09', '2026-11-12']) log(d, 'cable-pushdown', { attachment: 'rope' }, [[25, 12]]);
    const series = strengthProgress(db, '2026-11-20').filter((x) => x.exerciseId === 'cable-pushdown');
    expect(series.map((x) => [x.attachment, x.status]).sort()).toEqual([['rope', 'flat'], ['straight bar', 'flat']]);
  });

  it('switching attachment is not a decline for the reactive deload', () => {
    for (const d of ['2026-11-02', '2026-11-04', '2026-11-06']) log(d, 'cable-pushdown', { attachment: 'straight bar' }, [[40, 12]]);
    for (const d of ['2026-11-08', '2026-11-10', '2026-11-12']) log(d, 'cable-pushdown', { attachment: 'rope' }, [[25, 12]]);
    const e = targetDeclineEvidence(db, 'triceps', '2026-11-01', '2026-11-20', new Set());
    expect(e.trend).not.toBe('down');
    expect(e.exercises.map((x) => x.attachment).sort()).toEqual(['rope', 'straight bar']);
  });
});

it('the Calorie Tracker export says what each count measures', () => {
  log('2026-11-02', 'suitcase-carry', { rep_unit: 'steps' }, [[24, 40]]);
  log('2026-11-02', 'cable-pushdown', {}, [[30, 12]]);
  const [w] = getCompletedWorkouts(db, '2026-11-02');
  expect(w!.exercises.map((x: any) => [x.exercise_id, x.rep_unit]).sort()).toEqual([['cable-pushdown', 'reps'], ['suitcase-carry', 'steps']]);
});

it('the logger offers every attachment and unit on every exercise', () => {
  const html = readFileSync(new URL('../../public/logger.html', import.meta.url), 'utf8');
  const list = (name: string) => JSON.parse(html.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))![1]!.replace(/'/g, '"'));
  expect(list('ATTACHMENT_CHOICES')).toEqual([...ATTACHMENT_CHOICES]);
  expect(list('REP_UNITS')).toEqual([...REP_UNITS]);
  // One picker row on every logged exercise card, not filtered by exercise.
  expect(html).toMatch(/card\.appendChild\(buildLogOptionsPicker\(perf/);
  expect(html).toMatch(/buildLogOptionSelect\(perf, 'attachment', 'Attachment', ATTACHMENT_CHOICES/);
  expect(html).toMatch(/buildLogOptionSelect\(perf, 'rep_unit', 'Count', REP_UNITS/);
});

it('the logger script loads alongside app.js (no clashing top-level names)', () => {
  const read = (f: string) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
  const inline = read('logger.html').match(/<script>([\s\S]*?)<\/script>/)![1]!;
  // Classic scripts share one global scope: a duplicate declaration is a SyntaxError.
  expect(() => new Function(`${read('app.js')}\n${inline}`)).not.toThrow();
});
