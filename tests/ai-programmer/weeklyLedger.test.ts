// Weekly volume ledger (docs/WEEKLY_VOLUME_PLANNING_DESIGN.md): goal
// muscles per calendar week, non-goal muscles per rolling 14-day cycle
// that restarts as soon as its number is reached.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { computeLedger, currentCycle, readDailyExposure, type LedgerInput, type LedgerTargetInput } from '../../src/ai-programmer/planning/weeklyLedger.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const target = (over: Partial<LedgerTargetInput> & { targetId: string }): LedgerTargetInput => ({
  isGoal: false,
  reference: 14,
  perSessionCap: 7,
  eligibleToday: true,
  paused: false,
  ...over,
});

const exposure = (days: Record<string, Record<string, number>>) => new Map(Object.entries(days).map(([d, t]) => [d, new Map(Object.entries(t))]));

// Mon 2026-10-26 push, Tue pull, Thu push, Fri pull; next week the same.
const PPPP = ['2026-10-26:push', '2026-10-27:pull', '2026-10-29:push', '2026-10-30:pull', '2026-11-02:push', '2026-11-03:pull', '2026-11-05:push', '2026-11-06:pull'].map((s) => {
  const [date, purpose] = s.split(':') as [string, 'push' | 'pull'];
  return { date, purpose };
});

const base = (over: Partial<LedgerInput>): LedgerInput => ({
  targetDate: '2026-10-26',
  anchor: '2026-10-26',
  targets: [],
  dailyExposure: new Map(),
  futureDays: PPPP,
  ...over,
});

const entry = (input: LedgerInput, id: string) => computeLedger(input).entries.find((e) => e.targetId === id)!;

describe('goal muscles (calendar week, every suitable day)', () => {
  it('is a must on a suitable day, today getting its share of what is left this week', () => {
    const e = entry(base({ targets: [target({ targetId: 'triceps', isGoal: true, reference: 24, perSessionCap: 12 })] }), 'triceps');
    expect(e).toMatchObject({ basis: 'week', status: 'must', remaining: 24, laterSessions: 1, mustSetsToday: 12, windowEnd: '2026-11-01' });
  });

  it('is met once this week reaches its number, and counts indirect work', () => {
    const e = entry(
      base({ targetDate: '2026-10-29', targets: [target({ targetId: 'triceps', isGoal: true, reference: 24, perSessionCap: 12 })], dailyExposure: exposure({ '2026-10-26': { triceps: 22 }, '2026-10-27': { triceps: 2.97 } }) }),
      'triceps'
    );
    expect(e.status).toBe('met');
    expect(e.done).toBe(24.97);
  });

  it('ignores last week', () => {
    const e = entry(base({ targets: [target({ targetId: 'triceps', isGoal: true, reference: 24, perSessionCap: 12 })], dailyExposure: exposure({ '2026-10-23': { triceps: 30 } }) }), 'triceps');
    expect(e.done).toBe(0);
  });
});

describe('non-goal muscles (14-day cycle)', () => {
  it('can wait while later suitable days in the cycle can hold what is left', () => {
    const e = entry(base({ targets: [target({ targetId: 'side-delt' })] }), 'side-delt');
    expect(e).toMatchObject({ basis: 'cycle', status: 'can_wait', windowStart: '2026-10-26', windowEnd: '2026-11-08', laterSessions: 3, laterCapacity: 21 });
  });

  it('becomes a must when the later days in the cycle cannot hold it all', () => {
    const e = entry(base({ targetDate: '2026-11-02', targets: [target({ targetId: 'side-delt' })], dailyExposure: exposure({ '2026-10-26': { 'side-delt': 2 } }) }), 'side-delt');
    // 12 left, only Thu 11-05 is a later push day in the cycle (cap 7).
    expect(e).toMatchObject({ status: 'must', remaining: 12, laterSessions: 1, laterCapacity: 7, mustSetsToday: 5 });
  });

  it('starts the next cycle the day after the number is reached, even mid-week', () => {
    const daily = exposure({ '2026-10-26': { 'side-delt': 6 }, '2026-10-29': { 'side-delt': 5 }, '2026-11-02': { 'side-delt': 4 } });
    expect(currentCycle(daily, 'side-delt', 14, '2026-10-26', '2026-11-03')).toEqual({ start: '2026-11-03', done: 0 });
    const e = entry(base({ targetDate: '2026-11-05', targets: [target({ targetId: 'side-delt' })], dailyExposure: daily }), 'side-delt');
    expect(e).toMatchObject({ windowStart: '2026-11-03', windowEnd: '2026-11-16', remaining: 14, windowDay: 3 });
  });

  it('keeps counting past day 14 and is offered first as overdue', () => {
    const input = base({
      targetDate: '2026-11-09',
      targets: [target({ targetId: 'side-delt' }), target({ targetId: 'mid-pec', reference: 10, perSessionCap: 5 })],
      dailyExposure: exposure({ '2026-10-26': { 'side-delt': 3, 'mid-pec': 3 } }),
      futureDays: [],
    });
    const ledger = computeLedger(input);
    expect(ledger.entries.map((e) => [e.targetId, e.status])).toEqual([
      ['side-delt', 'overdue'],
      ['mid-pec', 'overdue'],
    ]);
    expect(ledger.entries[0]).toMatchObject({ remaining: 11, windowDay: 15 });
  });

  it('pulls days and pauses: not today', () => {
    const ledger = computeLedger(
      base({ targets: [target({ targetId: 'lat-width', eligibleToday: false, reference: 16, perSessionCap: 8 }), target({ targetId: 'quads', paused: true })] })
    );
    expect(ledger.entries.map((e) => e.status)).toEqual(['not_today', 'not_today']);
  });

  it('only counts later days whose purpose can train the muscle', () => {
    const e = entry(base({ targets: [target({ targetId: 'rectus-abdominis', reference: 8, perSessionCap: 4 }), target({ targetId: 'lat-width', reference: 16, perSessionCap: 8, eligibleToday: false })] }), 'rectus-abdominis');
    expect(e.laterSessions).toBe(7); // abs fit every later gym day in the cycle, push or pull
  });
});

describe('readDailyExposure', () => {
  it('counts completed sets of completed sessions, direct 1.0 and secondary 0.33', () => {
    const db = openDb(':memory:');
    const repo = new WorkoutSessionsRepo(db);
    const s = repo.createSession({ date: '2026-10-26', session_type: 'gym', status: 'completed' });
    repo.addExercisePerformance(s.session_id, {
      exercise_id: 'close-grip-bench-press',
      order: 0,
      role: 'primary',
      sets: [
        { set_number: 1, completed: true },
        { set_number: 2, completed: true },
        { set_number: 3, completed: false },
      ],
    });
    const planned = repo.createSession({ date: '2026-10-27', session_type: 'gym', status: 'planned' });
    repo.addExercisePerformance(planned.session_id, { exercise_id: 'cable-pushdown', order: 0, role: 'primary', sets: [{ set_number: 1, completed: true }] });

    const daily = readDailyExposure(db, '2026-10-26', '2026-10-28');
    expect([...daily.keys()]).toEqual(['2026-10-26']);
    expect(daily.get('2026-10-26')!.get('triceps')).toBe(2);
    expect([...daily.get('2026-10-26')!.values()].some((v) => Math.abs(v - 0.66) < 1e-9)).toBe(true);
  });
});
