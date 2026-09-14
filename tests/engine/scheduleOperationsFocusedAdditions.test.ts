// Two-Day Schedule Swap: focused additions to the already-extensive
// swapDayActivities/moveActivity coverage in
// tests/engine/scheduleOperations.test.ts and
// tests/routes/scheduleOperations.test.ts. A separate file so nothing
// here can affect that existing, already-passing coverage.
//
// Covers exactly the scenarios called out for this feature that weren't
// already exercised elsewhere: the literal worked example (a CHAIN of
// two DIFFERENT swaps, not the same pair repeated), a maximally
// non-adjacent day pair, an explicit spy proving the deterministic
// planner/reconciliation is never invoked, and a forced-failure atomic-
// rollback test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Mocked BEFORE any import of scheduleOperations.ts (vi.mock is
// hoisted) — keeps isDayLocked real (scheduleOperations.ts's own
// locking behavior must stay correct) while replacing
// reconcileWeekProgram with a spy that throws if ever called, proving
// a schedule swap never reaches the deterministic planner.
vi.mock('../../src/engine/weekProgramReconciliation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/weekProgramReconciliation.js')>();
  return {
    ...actual,
    reconcileWeekProgram: vi.fn(() => {
      throw new Error('reconcileWeekProgram must never be called by a schedule swap');
    }),
  };
});

import { openDb } from '../../src/db/client.js';
import { swapDayActivities } from '../../src/engine/scheduleOperations.js';
import { reconcileWeekProgram } from '../../src/engine/weekProgramReconciliation.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../src/lib/dailyActivity.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const WEEK_START = '2026-08-31'; // a real Monday

let db: Database.Database;

function setupProfile(trainingDays: string[]) {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
  return profile;
}

function effectiveActivity(day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday') {
  const profile = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!;
  const overrides = new WeekActivityOverridesRepo(db).get(profile.id, WEEK_START);
  const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
  return deriveDailyActivity(day, effective.trainingDays, effective.otherActivitySchedule);
}

function sessionNameFor(dayIndex: number): string | undefined {
  const program = new WeeklyProgramRepo(db).getByWeekStart(WEEK_START);
  return program?.sessions.find((s) => s.day_index === dayIndex)?.name;
}

beforeEach(() => {
  db = openDb(':memory:');
  vi.mocked(reconcileWeekProgram).mockClear();
});

describe('the exact required worked example — Push(Mon)/Pull(Tue)/Rest(Wed), two DIFFERENT swaps chained', () => {
  it('Mon<->Wed then Tue<->Wed produces the documented final arrangement', () => {
    setupProfile(['monday', 'tuesday']); // Monday/Tuesday are gym (Push/Pull); Wednesday starts Rest
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    programRepo.upsertSession(program.id, 0, 'push', 'gym', { plannedWork: [] }); // Monday
    programRepo.upsertSession(program.id, 1, 'pull', 'gym', { plannedWork: [] }); // Tuesday

    // Starting schedule, exactly as specified:
    expect(effectiveActivity('monday')).toBe('gym');
    expect(sessionNameFor(0)).toBe('push');
    expect(effectiveActivity('tuesday')).toBe('gym');
    expect(sessionNameFor(1)).toBe('pull');
    expect(effectiveActivity('wednesday')).toBe('unselected');
    expect(sessionNameFor(2)).toBeUndefined();

    // After Monday <-> Wednesday: Monday Rest, Tuesday Pull, Wednesday Push.
    swapDayActivities(db, WEEK_START, 'monday', 'wednesday');
    expect(effectiveActivity('monday')).toBe('unselected');
    expect(sessionNameFor(0)).toBeUndefined();
    expect(effectiveActivity('tuesday')).toBe('gym');
    expect(sessionNameFor(1)).toBe('pull');
    expect(effectiveActivity('wednesday')).toBe('gym');
    expect(sessionNameFor(2)).toBe('push');

    // After Tuesday <-> Wednesday: Monday Rest, Tuesday Push, Wednesday Pull.
    swapDayActivities(db, WEEK_START, 'tuesday', 'wednesday');
    expect(effectiveActivity('monday')).toBe('unselected');
    expect(sessionNameFor(0)).toBeUndefined();
    expect(effectiveActivity('tuesday')).toBe('gym');
    expect(sessionNameFor(1)).toBe('push');
    expect(effectiveActivity('wednesday')).toBe('gym');
    expect(sessionNameFor(2)).toBe('pull');

    expect(reconcileWeekProgram).not.toHaveBeenCalled();
  });
});

describe('swapping any two days — not only adjacent pairs', () => {
  it('Monday <-> Sunday (maximally distant, wraps the whole week)', () => {
    setupProfile(['monday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    const mondaySnapshot = { plannedWork: [{ exercise_id: 'bench-press', target_id: 'mid-pec', target_type: 'physique_target', sets: 3, reps_min: 6, reps_max: 12 }] };
    programRepo.upsertSession(program.id, 0, 'push', 'gym', mondaySnapshot);
    expect(effectiveActivity('sunday')).toBe('unselected');

    swapDayActivities(db, WEEK_START, 'monday', 'sunday');

    expect(effectiveActivity('monday')).toBe('unselected');
    expect(effectiveActivity('sunday')).toBe('gym');
    expect(sessionNameFor(6)).toBe('push'); // Sunday = day_index 6
    expect(sessionNameFor(0)).toBeUndefined();
  });

  it('Wednesday <-> Saturday (neither adjacent nor week-boundary)', () => {
    setupProfile(['wednesday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    programRepo.upsertSession(program.id, 2, 'legs', 'gym', { plannedWork: [] });

    swapDayActivities(db, WEEK_START, 'wednesday', 'saturday');

    expect(effectiveActivity('wednesday')).toBe('unselected');
    expect(effectiveActivity('saturday')).toBe('gym');
    expect(sessionNameFor(5)).toBe('legs'); // Saturday = day_index 5
  });
});

describe('completed workout history is never touched by a successful swap of two other days', () => {
  it('an unrelated completed session on a third day is byte-identical after the swap', () => {
    setupProfile(['monday', 'tuesday']);
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const completed = sessionsRepo.createSession({ date: '2026-09-04', session_type: 'gym', status: 'completed' }); // Friday, uninvolved
    const before = sessionsRepo.getSession(completed.session_id)!;

    swapDayActivities(db, WEEK_START, 'monday', 'tuesday');

    const after = sessionsRepo.getSession(completed.session_id)!;
    expect(after).toEqual(before);
    expect(after.status).toBe('completed');
    expect(after.date).toBe('2026-09-04');
  });
});

describe('no AI generation or deterministic reconciliation is ever called by a schedule swap', () => {
  it('reconcileWeekProgram is never invoked across several real swap scenarios', () => {
    setupProfile(['monday', 'thursday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    programRepo.upsertSession(program.id, 0, 'push', 'gym', { plannedWork: [] });
    programRepo.upsertSession(program.id, 3, 'legs', 'gym', { plannedWork: [] });

    swapDayActivities(db, WEEK_START, 'monday', 'wednesday');
    swapDayActivities(db, WEEK_START, 'thursday', 'sunday');
    swapDayActivities(db, WEEK_START, 'wednesday', 'thursday');

    expect(reconcileWeekProgram).not.toHaveBeenCalled();
  });

  // AI generation itself is proven unreachable structurally: this file
  // never stubs `fetch`, and src/engine/scheduleOperations.ts imports no
  // AI-programmer module at all (confirmed by source inspection) — the
  // route-level suite (tests/routes/scheduleOperations.test.ts, "never
  // invokes the LLM/provider") proves the same property through the
  // real HTTP entrypoint.
});

describe('atomic failure — a mid-transaction error leaves the database completely unchanged', () => {
  it('rolls back the override writes and program-session moves if a later step in the same swap throws', () => {
    setupProfile(['monday', 'tuesday']);
    const programRepo = new WeeklyProgramRepo(db);
    const program = programRepo.create(WEEK_START, '2026-09-06');
    const mondaySnapshot = { plannedWork: [{ exercise_id: 'bench-press', target_id: 'mid-pec', target_type: 'physique_target', sets: 3, reps_min: 6, reps_max: 12 }] };
    programRepo.upsertSession(program.id, 0, 'push', 'gym', mondaySnapshot);
    const planned = new WorkoutSessionsRepo(db).createSession({ date: '2026-08-31', session_type: 'gym', status: 'planned' }); // Monday

    const beforeOverrides = new WeekActivityOverridesRepo(db).get(new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!.id, WEEK_START);
    const beforeMondaySession = programRepo.getSession(program.id, 0);
    const beforePlannedDate = new WorkoutSessionsRepo(db).getSession(planned.session_id)!.date;

    const moveDateSpy = vi.spyOn(WorkoutSessionsRepo.prototype, 'moveDate').mockImplementation(() => {
      throw new Error('simulated failure partway through the swap transaction');
    });

    expect(() => swapDayActivities(db, WEEK_START, 'monday', 'tuesday')).toThrow('simulated failure');

    moveDateSpy.mockRestore();

    // Everything the transaction touched before the forced failure —
    // both days' overrides, both program_sessions rows — must be rolled
    // back exactly, not left half-applied.
    const afterOverrides = new WeekActivityOverridesRepo(db).get(new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!.id, WEEK_START);
    expect(afterOverrides).toEqual(beforeOverrides);
    expect(programRepo.getSession(program.id, 0)).toEqual(beforeMondaySession);
    expect(new WorkoutSessionsRepo(db).getSession(planned.session_id)!.date).toBe(beforePlannedDate);
    expect(effectiveActivity('monday')).toBe('gym');
    expect(effectiveActivity('tuesday')).toBe('gym');
  });
});
