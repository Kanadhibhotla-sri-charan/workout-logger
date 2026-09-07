// Step 12 Remediation §6 (P1): measurement evidence must be
// metric-specific — only readings of the SAME metric_name/unit are ever
// compared chronologically against each other; different metrics (e.g.
// a chest circumference in cm vs. a bodyweight in kg) must never be
// collapsed into one meaningless "trend".

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { MeasurementsRepo } from '../../src/repositories/measurementsRepo.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — different metrics are never collapsed into one trend', () => {
  it('a rising chest measurement is not corrupted by a single, unrelated bodyweight reading interleaved with it', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const measurementsRepo = new MeasurementsRepo(db);

    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-02', metric_name: 'chest', value: 100, unit: 'cm' });
    // A single unrelated-metric reading with a wildly different value —
    // the old bug (first-vs-last across ALL measurements regardless of
    // metric) would have compared this against the LAST chest reading
    // below and produced a nonsense result.
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-15', metric_name: 'bodyweight', value: 5, unit: 'kg' });
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-30', metric_name: 'chest', value: 103, unit: 'cm' });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.measurement_trend).toBe('improving'); // real chest-only trend: 100 -> 103
  });
});

describe('Test B — a real decline in one tracked metric is never masked by an unrelated metric improving', () => {
  it('surfaces "declining" when a real tracked metric declined, even while a different metric improved', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const measurementsRepo = new MeasurementsRepo(db);

    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-02', metric_name: 'chest', value: 100, unit: 'cm' });
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-30', metric_name: 'chest', value: 97, unit: 'cm' }); // real decline

    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-02', metric_name: 'bodyweight', value: 78, unit: 'kg' });
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-30', metric_name: 'bodyweight', value: 80, unit: 'kg' }); // improving

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.measurement_trend).toBe('declining');
  });
});

describe('Test C — a metric with only one reading contributes no trend (metric-specific insufficiency)', () => {
  it('a single chest reading and a single bodyweight reading together are still insufficient data, never compared against each other', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const measurementsRepo = new MeasurementsRepo(db);

    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-02', metric_name: 'chest', value: 100, unit: 'cm' });
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-15', metric_name: 'bodyweight', value: 78, unit: 'kg' });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.measurement_trend).toBe('insufficient_data');
  });
});

describe('Test D — the same metric name in different units is never compared directly', () => {
  it('a cm reading and an inch reading of the same metric_name never get diffed against each other', () => {
    const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
    const measurementsRepo = new MeasurementsRepo(db);

    // Numerically these look like a huge "decline" (100 -> 40) if
    // compared directly, but 40 inches is actually larger than 100cm —
    // the point is they must never be compared at all since the units
    // differ, so this stays insufficient_data (each unit has only 1
    // reading of its own).
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-02', metric_name: 'chest', value: 100, unit: 'cm' });
    measurementsRepo.record({ goal_id: goal.id, date: '2026-08-30', metric_name: 'chest', value: 40, unit: 'in' });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-01');
    expect(evidence.measurement_trend).toBe('insufficient_data');
  });
});
