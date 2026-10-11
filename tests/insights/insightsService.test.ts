// Insights (2026-10-11): strength per exercise, volume history,
// consistency, goal check-ins and deload history, from logged data only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { PeriodizationEventsRepo } from '../../src/coaching/periodization/periodizationEventsRepo.js';
import { consistency, deloadHistory, goalCheckIns, strengthProgress, volumeHistory } from '../../src/insights/insightsService.js';

let db: Database.Database;
let userId: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T03:00:00Z'));
  db = openDb(':memory:');
  userId = new UsersRepo(db).getOrCreateDefault().id;
  new TrainingProfileRepo(db).upsert(userId, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell'],
    other_activity_schedule: [],
  });
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
});

afterEach(() => vi.useRealTimers());

function log(date: string, exerciseId: string, sets: Array<[number | null, number]>, targetSets = sets.length) {
  const repo = new WorkoutSessionsRepo(db);
  const s = repo.listSessionsByDate(date)[0] ?? repo.createSession({ date, session_type: 'gym', status: 'completed' });
  repo.addExercisePerformance(s.session_id, { exercise_id: exerciseId, order: 0, role: 'primary', target_sets: targetSets, sets: sets.map(([weight, reps], i) => ({ set_number: i + 1, weight, reps, completed: true })) });
}

function deloadEvent(date: string, newState: 'SCHEDULED_DELOAD' | 'REACTIVE_DELOAD' | 'ACTIVE') {
  new PeriodizationEventsRepo(db).record({ programId: userId, previousState: 'ACTIVE', newState, triggerType: 'calendar', blockId: 'b', blockNumber: 1, weekIndex: 1, evidence: { evaluationTimestamp: date }, appliedPolicy: null, reason: 't' } as any);
}

describe('strengthProgress', () => {
  it('uses the best set per session as estimated 1RM and flags a new best', () => {
    log('2026-11-02', 'close-grip-bench-press', [[50, 8], [55, 6]]);
    log('2026-11-09', 'close-grip-bench-press', [[55, 8]]);
    log('2026-11-16', 'close-grip-bench-press', [[60, 8]]);
    const [p] = strengthProgress(db, '2026-11-20');
    expect(p).toMatchObject({ exerciseId: 'close-grip-bench-press', goal: true, unit: 'kg', sessions: 3, status: 'new_best', last: 76 });
    expect(p!.points.map((x) => x.bestSet)).toEqual(['55 kg × 6', '55 kg × 8', '60 kg × 8']);
  });

  it('flags a stall: no new best in the last three sessions', () => {
    for (const [d, w] of [['2026-10-26', 60], ['2026-10-30', 60], ['2026-11-03', 58], ['2026-11-07', 60], ['2026-11-11', 59]] as const) log(d, 'flat-barbell-bench-press', [[w, 8]]);
    expect(strengthProgress(db, '2026-11-20')[0]!.status).toBe('stalled');
  });

  it('marks deload sessions and leaves them out of the status', () => {
    log('2026-11-02', 'cable-pushdown', [[30, 10]]);
    log('2026-11-05', 'cable-pushdown', [[32, 10]]);
    deloadEvent('2026-11-09', 'SCHEDULED_DELOAD');
    log('2026-11-10', 'cable-pushdown', [[20, 10]]);
    const [p] = strengthProgress(db, '2026-11-20');
    expect(p!.points.map((x) => x.deload)).toEqual([false, false, true]);
    expect(p!.status).toBe('new_best');
    expect(p!.last).toBe(42.7);
  });

  it('tracks an unloaded exercise in reps', () => {
    log('2026-11-02', 'hanging-knee-leg-raise', [[null, 10]]);
    log('2026-11-09', 'hanging-knee-leg-raise', [[null, 14]]);
    expect(strengthProgress(db, '2026-11-20')[0]).toMatchObject({ unit: 'reps', first: 10, last: 14 });
  });
});

describe('volume, consistency, check-ins, deloads', () => {
  it('volumeHistory reports done vs required per week, goal muscles first', () => {
    log('2026-11-17', 'cable-pushdown', [[30, 10], [30, 10], [30, 10]]);
    const rows = volumeHistory(db, '2026-11-20', 2, () => ({ required: new Map([['triceps', 12]]), goalLabel: new Map([['triceps', 'Goal 1']]) }));
    const triceps = rows.find((r) => r.targetId === 'triceps')!;
    expect(rows[0]!.goalLabel).toBe('Goal 1');
    // The earlier week had no logged work at all, so it is left out.
    expect(triceps.weeks).toEqual([{ weekStart: '2026-11-16', done: 3, required: 12 }]);
    log('2026-11-10', 'flat-barbell-bench-press', [[60, 8]]);
    const both = volumeHistory(db, '2026-11-20', 2, () => ({ required: new Map([['triceps', 12]]), goalLabel: new Map([['triceps', 'Goal 1']]) }));
    expect(both.find((r) => r.targetId === 'triceps')!.weeks).toEqual([{ weekStart: '2026-11-09', done: 0, required: 12 }, { weekStart: '2026-11-16', done: 3, required: 12 }]);
  });

  it('consistency counts scheduled gym days so far (Mon, Tue, Thu, Fri by Friday) and sets done vs prescribed', () => {
    log('2026-11-16', 'cable-pushdown', [[30, 10], [30, 10]], 3);
    const [, thisWeek] = consistency(db, '2026-11-20', 2);
    expect(thisWeek).toEqual({ weekStart: '2026-11-16', gymDaysScheduled: 4, gymDaysDone: 1, setsPrescribed: 3, setsDone: 2 });
  });

  it('a goal with no check-in is due now', () => {
    expect(goalCheckIns(db, '2026-11-20')).toEqual([expect.objectContaining({ lastAssessment: null, nextDue: '2026-11-20', overdue: true })]);
  });

  it('deloadHistory merges a deload stretch from the event log', () => {
    deloadEvent('2026-11-02', 'REACTIVE_DELOAD');
    deloadEvent('2026-11-03', 'REACTIVE_DELOAD');
    deloadEvent('2026-11-09', 'ACTIVE');
    expect(deloadHistory(db, '2026-10-20', '2026-11-20')).toEqual([{ start: '2026-11-02', end: '2026-11-08', kind: 'reactive' }]);
  });

  it('GET /api/insights returns every section', async () => {
    log('2026-11-16', 'cable-pushdown', [[30, 10]]);
    const body = (await request(createApp(db)).get('/api/insights').expect(200)).body;
    expect(Object.keys(body).sort()).toEqual(['asOf', 'consistency', 'deloads', 'goalCheckIns', 'strength', 'volume']);
    expect(body.volume.find((r: any) => r.targetId === 'triceps').weeks.map((w: any) => w.weekStart)).toEqual(['2026-11-16']);
    await request(createApp(db)).get('/api/insights?date=2026-13-01').expect(400);
  });
});
