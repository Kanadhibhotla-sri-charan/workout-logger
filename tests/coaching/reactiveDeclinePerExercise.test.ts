// Reactive-deload evidence fix (2026-10-11): a decline is measured per
// exercise (estimated 1RM, each exercise against itself), never by
// averaging different exercises, and sessions done during a deload are
// ignored. Production case: seated cable row (~80 kg e1RM) swapped for
// chest-supported DB row (~14 kg) read as an 80% back-thickness "decline".

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { PeriodizationEventsRepo } from '../../src/coaching/periodization/periodizationEventsRepo.js';
import { deloadDatesInRange, evaluateReactiveDeloadTrigger, targetDeclineEvidence } from '../../src/coaching/periodization/reactiveTrendEvaluator.js';

let db: Database.Database;
let programId: string;

beforeEach(() => {
  db = openDb(':memory:');
  programId = new UsersRepo(db).getOrCreateDefault().id;
});

function seed(date: string, exerciseId: string, weight: number, reps = 10) {
  const repo = new WorkoutSessionsRepo(db);
  const s = repo.createSession({ date, session_type: 'gym', status: 'completed' });
  repo.addExercisePerformance(s.session_id, { exercise_id: exerciseId, order: 0, role: 'primary', target_sets: 3, sets: [1, 2, 3].map((n) => ({ set_number: n, weight, reps, completed: true, rir: null })) });
}

function deloadEvent(date: string, newState: 'SCHEDULED_DELOAD' | 'REACTIVE_DELOAD' | 'ACTIVE', previousState: 'SCHEDULED_DELOAD' | 'REACTIVE_DELOAD' | 'ACTIVE') {
  new PeriodizationEventsRepo(db).record({
    programId, previousState, newState, triggerType: 'calendar', blockId: 'b', blockNumber: 1, weekIndex: 4,
    evidence: { evaluationTimestamp: date }, appliedPolicy: null, reason: 'test',
  } as any);
}

const evaluate = (referenceDate: string) => evaluateReactiveDeloadTrigger(db, { programId, referenceDate, isInCooldown: false, isAlreadyInReactiveDeload: false });

describe('per-exercise decline', () => {
  it('swapping to a lighter exercise is not a decline', () => {
    for (const d of ['2026-11-02', '2026-11-05', '2026-11-08']) seed(d, 'seated-cable-row', 70);
    for (const d of ['2026-11-11', '2026-11-14', '2026-11-17']) seed(d, 'chest-supported-row', 14);
    const e = targetDeclineEvidence(db, 'back-thickness', '2026-11-01', '2026-11-20', new Set());
    expect(e.trend).not.toBe('down');
    expect(e.exercises.map((x) => [x.exerciseId, x.trend])).toEqual([['seated-cable-row', 'stable'], ['chest-supported-row', 'stable']]);
  });

  it('the same exercise falling across 3+ sessions is a decline', () => {
    for (const [d, w] of [['2026-11-02', 70], ['2026-11-05', 70], ['2026-11-08', 60], ['2026-11-11', 58]] as const) seed(d, 'seated-cable-row', w);
    expect(targetDeclineEvidence(db, 'back-thickness', '2026-11-01', '2026-11-20', new Set()).trend).toBe('down');
  });

  it('two sessions of one exercise are not enough evidence', () => {
    seed('2026-11-02', 'seated-cable-row', 70);
    seed('2026-11-05', 'seated-cable-row', 50);
    expect(targetDeclineEvidence(db, 'back-thickness', '2026-11-01', '2026-11-20', new Set()).trend).not.toBe('down');
  });

  it('one light middle session is not a decline when the exercise ends higher', () => {
    for (const [d, w] of [['2026-11-02', 30], ['2026-11-05', 15], ['2026-11-08', 33]] as const) seed(d, 'overhead-triceps-extension', w);
    expect(targetDeclineEvidence(db, 'triceps', '2026-11-01', '2026-11-20', new Set()).trend).not.toBe('down');
  });

  it('one declining exercise that credits two targets is one piece of evidence', () => {
    // Overhead extension trains triceps and triceps-long-head; it alone must not make "2 targets".
    for (const [d, w] of [['2026-11-02', 30], ['2026-11-04', 30], ['2026-11-06', 24], ['2026-11-08', 22], ['2026-11-10', 20], ['2026-11-12', 20]] as const) seed(d, 'overhead-triceps-extension', w);
    const r = evaluate('2026-11-13');
    expect(r.signals).toHaveLength(1);
    expect(r.triggered).toBe(false);
  });

  it('a target is down only when most of its exercises are down', () => {
    for (const [d, w] of [['2026-11-02', 70], ['2026-11-05', 70], ['2026-11-08', 60], ['2026-11-11', 58]] as const) seed(d, 'seated-cable-row', w);
    for (const [d, w] of [['2026-11-03', 14], ['2026-11-06', 14], ['2026-11-09', 16], ['2026-11-12', 16]] as const) seed(d, 'chest-supported-row', w);
    expect(targetDeclineEvidence(db, 'back-thickness', '2026-11-01', '2026-11-20', new Set()).trend).toBe('stable');
  });
});

describe('deload sessions are ignored', () => {
  it('reads deload dates from the periodization event log', () => {
    deloadEvent('2026-11-09', 'SCHEDULED_DELOAD', 'ACTIVE');
    deloadEvent('2026-11-16', 'ACTIVE', 'SCHEDULED_DELOAD');
    const dates = deloadDatesInRange(db, programId, '2026-11-01', '2026-11-20');
    expect([...dates].sort()[0]).toBe('2026-11-09');
    expect(dates.has('2026-11-15')).toBe(true);
    expect(dates.has('2026-11-16')).toBe(false);
  });

  it('lighter deload-week sessions do not trigger a reactive deload', () => {
    // Steady before the scheduled deload, lighter during it, on two targets.
    for (const d of ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-08']) {
      seed(d, 'seated-cable-row', 70);
      seed(d, 'lat-pulldown-wide-pronated', 60);
    }
    deloadEvent('2026-11-09', 'SCHEDULED_DELOAD', 'ACTIVE');
    for (const d of ['2026-11-10', '2026-11-12', '2026-11-14']) {
      seed(d, 'seated-cable-row', 45);
      seed(d, 'lat-pulldown-wide-pronated', 40);
    }
    const r = evaluate('2026-11-15');
    expect(r.signals).toEqual([]);
    expect(r.triggered).toBe(false);
  });

  it('a genuine decline on two targets outside deloads still triggers, with per-exercise evidence', () => {
    for (const [d, a, b] of [['2026-11-02', 70, 60], ['2026-11-04', 70, 60], ['2026-11-06', 60, 50], ['2026-11-08', 58, 48]] as const) {
      seed(d, 'seated-cable-row', a);
      seed(d, 'lat-pulldown-wide-pronated', b);
    }
    const r = evaluate('2026-11-09');
    expect(r.triggered).toBe(true);
    expect(r.signals.find((s) => s.targetId === 'back-thickness')!.exercises![0]).toMatchObject({ exerciseId: 'seated-cable-row', trend: 'down', points: 4 });
  });
});
