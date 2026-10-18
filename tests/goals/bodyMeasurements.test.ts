// Body measurements on the Goals page (2026-10-12): validated input, a
// delete for typos, a summary that judges each change in the right
// direction (bigger arms, smaller waist, bodyweight not judged), the goal
// review using that direction, and the coach review seeing the readings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { MeasurementsRepo } from '../../src/repositories/measurementsRepo.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';
import { bodyMeasurements } from '../../src/insights/insightsService.js';
import { buildCoachFacts, buildCoachInstruction } from '../../src/coaching/review/coachReviewService.js';
import { MEASUREMENT_PRESETS, measurementDirection } from '../../src/contracts/measurementMetrics.js';

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T06:00:00Z'));
  db = openDb(':memory:');
  new UsersRepo(db).getOrCreateDefault();
});

afterEach(() => vi.useRealTimers());

const reading = (date: string, metric_name: string, value: number, unit = 'cm', goal_id: string | null = null) =>
  new MeasurementsRepo(db).record({ goal_id, date, metric_name, value, unit });

describe('API', () => {
  it('saves a trimmed reading, rejects bad input, and deletes a reading', async () => {
    const app = createApp(db);
    const post = (body: object) => request(app).post('/api/goals/measurements').send({ date: '2026-10-12', metric_name: 'upper arm (flexed)', value: 34.5, unit: 'cm', ...body });
    const saved = (await post({ metric_name: '  upper arm (flexed) ', notes: '  ' }).expect(201)).body;
    expect(saved).toMatchObject({ metric_name: 'upper arm (flexed)', notes: null, goal_id: null });
    for (const bad of [{ date: '2026-10-13' }, { date: '12-10-2026' }, { value: 0 }, { value: -3 }, { metric_name: ' ' }, { unit: '' }, { metric_name: 'x'.repeat(61) }]) {
      await post(bad).expect(400);
    }
    await request(app).delete(`/api/goals/measurements/${saved.id}`).expect(204);
    await request(app).delete(`/api/goals/measurements/${saved.id}`).expect(404);
    expect((await request(app).get('/api/goals/measurements').expect(200)).body).toEqual([]);
  });

  it('summary returns the presets and each series', async () => {
    reading('2026-10-01', 'waist (at navel)', 82);
    const body = (await request(createApp(db)).get('/api/goals/measurements/summary').expect(200)).body;
    expect(body.presets).toEqual(MEASUREMENT_PRESETS);
    expect(body.series[0]).toMatchObject({ metric: 'waist (at navel)', better: 'lower', verdict: 'one reading', change: null });
  });
});

describe('direction', () => {
  it('presets and typed names', () => {
    expect(['upper arm (flexed)', 'waist (at navel)', 'bodyweight', 'neck', 'Hips', 'body fat %', 'morning weight'].map((n) => measurementDirection(n)))
      .toEqual(['higher', 'lower', 'neutral', 'higher', 'lower', 'lower', 'neutral']);
  });

  it('athletic tests: jump distances bigger, times smaller (by name or by unit)', () => {
    expect([
      measurementDirection('standing broad jump'),
      measurementDirection('shuttle run time'),
      measurementDirection('10 m sprint'),
      measurementDirection('agility drill', 's'),
      measurementDirection('plank hold', 'cm'),
    ]).toEqual(['higher', 'lower', 'lower', 'lower', 'higher']);
  });

  it('summary judges each change its own way; units never mix', () => {
    reading('2026-09-28', 'upper arm (flexed)', 33.0);
    reading('2026-10-12', 'Upper arm (flexed)', 34.5);
    reading('2026-09-28', 'waist (at navel)', 84);
    reading('2026-10-12', 'waist (at navel)', 82.5);
    reading('2026-09-28', 'chest', 98);
    reading('2026-10-12', 'chest', 97);
    reading('2026-09-28', 'bodyweight', 70, 'kg');
    reading('2026-10-12', 'bodyweight', 71.2, 'kg');
    reading('2026-10-12', 'chest', 38.5, 'in');
    const byName = Object.fromEntries(bodyMeasurements(db).map((s) => [`${s.metric}|${s.unit}`, [s.change, s.verdict, s.readings.length]]));
    expect(byName).toEqual({
      'upper arm (flexed)|cm': [1.5, 'better', 2],
      'waist (at navel)|cm': [-1.5, 'better', 2],
      'chest|cm': [-1, 'worse', 2],
      'bodyweight|kg': [1.2, 'not judged', 2],
      'chest|in': [null, 'one reading', 1],
    });
  });
});

describe('goal phase review', () => {
  function phaseFor(ref: string) {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: ref, priority: 1 });
    return { goal, phase: new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-09-01', review_date: '2026-10-12', package_level: 'complete' }) };
  }

  it('a shrinking waist is progress, a growing one is not', () => {
    const { goal, phase } = phaseFor('chest-front-width');
    reading('2026-09-02', 'waist (at navel)', 84, 'cm', goal.id);
    reading('2026-10-10', 'waist (at navel)', 82, 'cm', goal.id);
    expect(gatherReviewEvidence(db, goal, phase, '2026-10-12').measurement_trend).toBe('improving');
    reading('2026-10-11', 'waist (at navel)', 86, 'cm', goal.id);
    expect(gatherReviewEvidence(db, goal, phase, '2026-10-12').measurement_trend).toBe('declining');
  });

  it('bodyweight alone is never judged', () => {
    const { goal, phase } = phaseFor('chest-front-width');
    reading('2026-09-02', 'bodyweight', 70, 'kg', goal.id);
    reading('2026-10-10', 'bodyweight', 68, 'kg', goal.id);
    expect(gatherReviewEvidence(db, goal, phase, '2026-10-12').measurement_trend).toBe('insufficient_data');
  });
});

it('the coach review sees the readings and how to read them', () => {
  reading('2026-09-28', 'upper arm (flexed)', 33.0);
  reading('2026-10-12', 'upper arm (flexed)', 34.5);
  const facts = buildCoachFacts(db, '2026-10-12', () => ({ required: new Map<string, number>(), goalLabel: new Map<string, string | null>() }));
  expect(facts.bodyMeasurements).toEqual([{
    measurement: 'upper arm (flexed) (cm)', betterWhen: 'bigger', goals: [],
    readings: ['2026-09-28: 33', '2026-10-12: 34.5'], change: '+1.5 cm since 2026-09-28 (better)',
  }]);
  expect(buildCoachInstruction()).toMatch(/bodyMeasurements are the only direct evidence/);
});

it('the Goals page script loads alongside app.js and has the measurement form', () => {
  const read = (f: string) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
  const html = read('index.html');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Function(`${read('app.js')}\n${inline}`)).not.toThrow();
  expect(html).toMatch(/id="measurements-section"/);
  expect(inline).toMatch(/api\('\/api\/goals\/measurements', \{ method: 'POST'/);
  expect(inline).toMatch(/method: 'DELETE'/);
});
