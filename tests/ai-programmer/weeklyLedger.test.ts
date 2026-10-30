// Weekly volume ledger (docs/WEEKLY_VOLUME_PLANNING_DESIGN.md): every
// muscle per calendar week at Blueprint's own numbers (schema 2), goal
// muscles at "priority", counted as credited sets.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { computeLedger, ledgerTargets, readDailyCredit, type LedgerInput, type LedgerTargetInput } from '../../src/ai-programmer/planning/weeklyLedger.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const target = (over: Partial<LedgerTargetInput> & { targetId: string }): LedgerTargetInput => ({
  isGoal: false,
  reference: 10,
  perSessionCap: 8,
  indirectOnly: false,
  shareOf: null,
  eligibleToday: true,
  paused: false,
  trainedOn: (p) => p === 'push',
  ...over,
});

const credit = (days: Record<string, Record<string, number>>) => new Map(Object.entries(days).map(([d, t]) => [d, new Map(Object.entries(t))]));

// Mon 2026-10-26 push, Tue pull, Thu push, Fri pull.
const PPPP = ['2026-10-26:push', '2026-10-27:pull', '2026-10-29:push', '2026-10-30:pull'].map((s) => {
  const [date, purpose] = s.split(':') as [string, 'push' | 'pull'];
  return { date, purpose };
});

const base = (over: Partial<LedgerInput>): LedgerInput => ({ targetDate: '2026-10-26', targets: [], dailyCredit: new Map(), futureDays: PPPP, ...over });

const entry = (input: LedgerInput, id: string) => computeLedger(input).entries.find((e) => e.targetId === id)!;

describe('goal muscles', () => {
  it('is a must on a suitable day, today getting its share of what is left this week', () => {
    const e = entry(base({ targets: [target({ targetId: 'triceps', isGoal: true, reference: 16 })] }), 'triceps');
    expect(e).toMatchObject({ status: 'must', remaining: 16, laterSessions: 1, mustSetsToday: 8, weekEnd: '2026-11-01' });
  });

  it("may go past Blueprint's per-session maximum to reach the week", () => {
    const e = entry(base({ targetDate: '2026-10-27', targets: [target({ targetId: 'brachialis-arm-thickness', isGoal: true, reference: 14, perSessionCap: 6, trainedOn: (p) => p === 'pull' })] }), 'brachialis-arm-thickness');
    expect(e).toMatchObject({ status: 'must', laterSessions: 1, mustSetsToday: 7 });
  });

  it('is met once this week reaches its number, and counts credited indirect work', () => {
    const e = entry(
      base({ targetDate: '2026-10-29', targets: [target({ targetId: 'triceps', isGoal: true, reference: 16 })], dailyCredit: credit({ '2026-10-26': { triceps: 14 }, '2026-10-27': { triceps: 2.5 } }) }),
      'triceps'
    );
    expect(e.status).toBe('met');
    expect(e.done).toBe(16.5);
  });

  it('ignores last week', () => {
    const e = entry(base({ targets: [target({ targetId: 'triceps', isGoal: true, reference: 16 })], dailyCredit: credit({ '2026-10-23': { triceps: 30 } }) }), 'triceps');
    expect(e.done).toBe(0);
  });
});

describe('other muscles (same calendar week)', () => {
  it('can wait while later suitable days this week can hold what is left', () => {
    const e = entry(base({ targets: [target({ targetId: 'rear-delt', reference: 8 })] }), 'rear-delt');
    expect(e).toMatchObject({ status: 'can_wait', laterSessions: 1, laterCapacity: 8 });
  });

  it('asks today for only what the later days cannot hold', () => {
    const e = entry(base({ targets: [target({ targetId: 'side-delt' })] }), 'side-delt');
    expect(e).toMatchObject({ status: 'must', remaining: 10, laterCapacity: 8, mustSetsToday: 2 });
  });

  it('becomes a must when the later days this week cannot hold it all', () => {
    const e = entry(base({ targetDate: '2026-10-29', targets: [target({ targetId: 'side-delt' })], dailyCredit: credit({ '2026-10-26': { 'side-delt': 1 } }) }), 'side-delt');
    // 9 left, no later push day this week (cap 8 today).
    expect(e).toMatchObject({ status: 'must', remaining: 9, laterSessions: 0, mustSetsToday: 8 });
  });

  it('leaves indirect-only muscles to compound work unless they are goals', () => {
    const ledger = computeLedger(base({ targets: [target({ targetId: 'front-delt', indirectOnly: true, reference: 6 }), target({ targetId: 'upper-traps', indirectOnly: true, isGoal: true, reference: 12 })] }));
    expect(Object.fromEntries(ledger.entries.map((e) => [e.targetId, e.status]))).toEqual({ 'front-delt': 'indirect', 'upper-traps': 'must' });
  });

  it('pull muscles on a push day, and paused muscles: not today', () => {
    const ledger = computeLedger(base({ targets: [target({ targetId: 'lat-width', eligibleToday: false }), target({ targetId: 'quads', paused: true })] }));
    expect(ledger.entries.map((e) => e.status)).toEqual(['not_today', 'not_today']);
  });
});

describe('ledgerTargets (Blueprint schema 2 numbers)', () => {
  const byId = (targets: LedgerTargetInput[]) => Object.fromEntries(targets.map((t) => [t.targetId, t]));

  it('goal outcomes give their priority targets the priority number; the rest get efficient', () => {
    const t = byId(ledgerTargets(['arm-side-thickness', 'triceps-back-depth'], new Set(), () => true));
    expect(t['triceps']).toMatchObject({ isGoal: true, reference: 16, perSessionCap: 8 });
    expect(t['brachialis-arm-thickness']).toMatchObject({ isGoal: true, reference: 14, perSessionCap: 6 });
    expect(t['side-delt']).toMatchObject({ isGoal: false, reference: 10 });
    expect(t['chest']).toMatchObject({ isGoal: false, reference: 10 });
    expect(t['front-delt']).toMatchObject({ indirectOnly: true, reference: 6 });
    expect(t['core-anti-extension']).toMatchObject({ reference: 6 });
  });

  it('sub-regions with a min_share get that share of the parent number', () => {
    const t = byId(ledgerTargets(['triceps-back-depth'], new Set(), () => true));
    expect(t['triceps-long-head']).toMatchObject({ shareOf: 'triceps', reference: 5.28 });
    expect(t['upper-pec']).toMatchObject({ shareOf: 'chest', reference: 3 });
    expect(t['lower-pec']).toBeUndefined();
  });

  it('a group is paused only when all its children are; neck (no session trains it) is left out', () => {
    const t = byId(ledgerTargets([], new Set(['gastrocnemius', 'soleus', 'quads']), () => true));
    expect(t['calves']!.paused).toBe(true);
    expect(t['quads']!.paused).toBe(true);
    expect(t['chest']!.paused).toBe(false);
    expect(t['neck-thickness']).toBeUndefined();
  });
});

describe('readDailyCredit', () => {
  it('counts completed sets of completed sessions x Blueprint target_credit', () => {
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

    const daily = readDailyCredit(db, '2026-10-26', '2026-10-28');
    expect([...daily.keys()]).toEqual(['2026-10-26']);
    expect(Object.fromEntries(daily.get('2026-10-26')!)).toEqual({ triceps: 2, chest: 1, 'mid-pec': 1, 'front-delt': 1 });
  });

  it('goal muscles count direct exercises only; a sub-region looks at its parent', () => {
    const db = openDb(':memory:');
    const repo = new WorkoutSessionsRepo(db);
    const s = repo.createSession({ date: '2026-10-26', session_type: 'gym', status: 'completed' });
    const add = (exercise_id: string, order: number) => repo.addExercisePerformance(s.session_id, { exercise_id, order, role: 'primary', sets: [{ set_number: 1, completed: true }, { set_number: 2, completed: true }] });
    add('incline-barbell-press', 0);
    add('lying-triceps-extension-skull-crusher', 1);
    add('dumbbell-pullover-lat-biased', 2);
    const day = Object.fromEntries(readDailyCredit(db, '2026-10-26', '2026-10-27', new Set(['triceps', 'triceps-long-head'])).get('2026-10-26')!);
    // Press and pullover give triceps nothing; the skull crusher gives triceps 2 and its long head 1.
    expect(day['triceps']).toBe(2);
    expect(day['triceps-long-head']).toBe(1);
    // Non-goal muscles keep partial credit.
    expect(day['front-delt']).toBeGreaterThan(0);
  });
});

describe('GET /api/insights/volume', () => {
  it('reports every muscle against this week, without paused legs', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../../src/server/app.js');
    const { UsersRepo } = await import('../../src/repositories/usersRepo.js');
    const { TrainingProfileRepo } = await import('../../src/repositories/trainingProfileRepo.js');
    const { GoalsRepo } = await import('../../src/repositories/goalsRepo.js');
    const { InjuryPausesRepo } = await import('../../src/repositories/injuryPausesRepo.js');
    const db = openDb(':memory:');
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata', week_start_day: 'monday', training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
      default_session_duration_minutes: 60, minimum_session_duration_minutes: 30, maximum_session_duration_minutes: 90,
      available_equipment: ['barbell', 'dumbbell', 'cable', 'machine', 'bench'], other_activity_schedule: [],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    new InjuryPausesRepo(db).pause('legs', '2026-10-01', null);
    const body = (await request(createApp(db)).get('/api/insights/volume').expect(200)).body;
    const find = (id: string) => body.muscles.find((m: any) => m.targetId === id);
    expect(find('triceps')).toMatchObject({ isGoal: true, number: 16 });
    expect(find('triceps-long-head')).toMatchObject({ isGoal: true, shareOf: 'triceps' });
    expect(find('side-delt')).toMatchObject({ isGoal: false, number: 10 });
    expect(find('chest')).toMatchObject({ name: 'Chest', number: 10 });
    expect(find('front-delt')).toMatchObject({ indirect: true });
    expect(find('quads')).toBeUndefined();
  });
});
