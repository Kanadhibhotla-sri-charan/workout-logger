// 2026-11-09: goal sets lagged (brachialis 5-8 of 14 a week) because its
// direct exercises were cut from the shortlist and capped at 2 sets each;
// sessions ran 85-97 min with nothing deciding what gives way. Covers the
// goal shortlist rule, the goal 3-set allowance, the session time budget
// and shoulder care.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { applyWeeklyLedger, GOAL_EXERCISE_MAX_SETS } from '../../src/ai-programmer/planning/ledgerBrief.js';
import { buildWeeklyLedger } from '../../src/ai-programmer/planning/weeklyLedger.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { MINUTES_PER_SET, planSessionTime } from '../../src/ai-programmer/planning/sessionTime.js';
import { planShoulderCare, SHOULDER_CARE_MIN_RIR, SHOULDER_CARE_SETS } from '../../src/athletic/shoulderCare.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const HAMMER_FAMILY = ['hammer-curl', 'cross-body-hammer-curl', 'cable-hammer-curl-rope'];
const TUESDAY = '2099-03-03';
const MONDAY = '2099-03-02';
const FRIDAY = '2099-03-06';
let db: Database.Database;

function setup(goals: string[]) {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata', week_start_day: 'monday', training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60, minimum_session_duration_minutes: 30, maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'dumbbell', 'cable', 'machine', 'bench', 'ez-bar', 'pull-up bar'], other_activity_schedule: [],
  });
  for (const [i, ref] of goals.entries()) new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: ref, priority: i + 1 });
}

const context = (date: string, purpose: 'pull' | 'push' | 'upper') => buildProgrammerContext(db, { targetDate: date, requestedSessionPurpose: purpose, exercisePoolMode: 'wide' });
const target = (c: ReturnType<typeof context>, id: string) => c.targets.find((t) => t.targetId === id)!;
const prescribed = (c: ReturnType<typeof context>, id: string) => target(c, id).validExercises.filter((v) => v.authoredPrescription);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2099-03-01T03:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('goal muscles get the exercises and sets their week needs', () => {
  it('the shortlist keeps every direct brachialis exercise (all three hammer curls)', () => {
    setup(['arm-side-thickness']);
    const ids = prescribed(context(TUESDAY, 'pull'), 'brachialis-arm-thickness').map((v) => v.exerciseId);
    expect(ids).toEqual(expect.arrayContaining(HAMMER_FAMILY));
    expect(ids.length).toBeLessThanOrEqual(4);
  });

  it('Tuesday: three hammer curls at 2 sets hold the ask, so sets stay at 2 and the plan asks for 6, not 4', () => {
    setup(['arm-side-thickness']);
    const c = context(TUESDAY, 'pull');
    const applied = applyWeeklyLedger(c, buildWeeklyLedger(db, c));
    expect(prescribed(applied, 'brachialis-arm-thickness').every((v) => v.authoredPrescription!.sets <= 2)).toBe(true);
    expect(planSession(applied).targets.find((t) => t.targetId === 'brachialis-arm-thickness')!.plannedMinimumSets).toBeGreaterThan(4);
  });

  it('Friday, nothing done yet: the ask passes what 2 sets each hold, so the direct exercises may take 3', () => {
    setup(['arm-side-thickness']);
    const c = context(FRIDAY, 'upper');
    const applied = applyWeeklyLedger(c, buildWeeklyLedger(db, c));
    const brachialis = applied.programmingBrief.muscles.find((m) => m.targetId === 'brachialis-arm-thickness')!;
    expect(brachialis.recommendedSessionSets.min).toBeGreaterThan(6);
    for (const v of prescribed(applied, 'brachialis-arm-thickness').filter((x) => HAMMER_FAMILY.includes(x.exerciseId))) {
      expect(v.authoredPrescription!.sets).toBe(GOAL_EXERCISE_MAX_SETS);
    }
    expect(planSession(applied).targets.find((t) => t.targetId === 'brachialis-arm-thickness')!.plannedMinimumSets).toBeGreaterThan(6);
    // Other muscles keep their usual sets.
    expect(prescribed(applied, 'biceps').every((v) => v.authoredPrescription!.sets <= 2)).toBe(true);
  });

  it('a goal its exercises already hold keeps 2 sets per exercise (triceps has many)', () => {
    setup(['triceps-back-depth']);
    const c = context(MONDAY, 'push');
    const applied = applyWeeklyLedger(c, buildWeeklyLedger(db, c));
    expect(prescribed(applied, 'triceps').every((v) => v.authoredPrescription!.sets === prescribed(c, 'triceps').find((x) => x.exerciseId === v.exerciseId)!.authoredPrescription!.sets)).toBe(true);
  });
});

describe('session time budget', () => {
  const base = { aimMinutes: 60, maxMinutes: 90, goalSets: 6, otherMustSets: 4, flexibilityMinutes: 10, addOnMinutes: 8 };

  it('fits as planned when there is room: nothing cut, the rest goes to muscles that can wait', () => {
    const t = planSessionTime({ ...base, goalSets: 4, otherMustSets: 2 });
    expect(t).toMatchObject({ addOnMinutes: 8, flexibilityMinutes: 10, otherMustSetsToCut: 0, cuts: [] });
    expect(t.canWaitSets).toBe(Math.floor((60 - 6 * MINUTES_PER_SET - 18) / MINUTES_PER_SET));
  });

  it('cuts in the owner\'s order: add-on, then flexibility down to 5 min, then can-wait muscles', () => {
    const t = planSessionTime(base); // 35 min of due sets + 10 + 8 = 53: fits
    expect(t.addOnMinutes).toBe(8);
    const long = planSessionTime({ ...base, goalSets: 8, otherMustSets: 6 }); // 49 + 10 + 8 = 67: the add-on alone goes
    expect(long).toMatchObject({ addOnMinutes: 0, flexibilityMinutes: 10 });
    expect(long.cuts[0]).toMatch(/add-on dropped/);
    const mid = planSessionTime({ ...base, goalSets: 9, otherMustSets: 6 }); // 52.5 + 10 = 62.5: flexibility down to 8
    expect(mid).toMatchObject({ addOnMinutes: 0, flexibilityMinutes: 8 });
    const longer = planSessionTime({ ...base, goalSets: 10, otherMustSets: 8 }); // 63 min
    expect(longer).toMatchObject({ addOnMinutes: 0, flexibilityMinutes: 5, canWaitSets: 0, otherMustSetsToCut: 0 });
    expect(longer.cuts).toEqual(['athletic add-on dropped (8 min)', 'flexibility shortened from 10 to 5 min', 'muscles that can wait get no sets today']);
    expect(t.cuts).toEqual([]);
  });

  it('only past the maximum are other muscles cut, never goal sets', () => {
    const t = planSessionTime({ ...base, goalSets: 14, otherMustSets: 12 }); // 91 min of due sets
    expect(t.otherMustSetsToCut).toBe(Math.ceil((91 + 5 - 90) / MINUTES_PER_SET));
    expect(t.liftSetBudget).toBe(14 + 12 - t.otherMustSetsToCut);
    const goalsOnly = planSessionTime({ ...base, goalSets: 30, otherMustSets: 0 });
    expect(goalsOnly.otherMustSetsToCut).toBe(0);
    expect(goalsOnly.liftSetBudget).toBe(30);
  });

  it('shoulder care minutes count but are never cut', () => {
    const t = planSessionTime({ ...base, goalSets: 4, otherMustSets: 2, fixedMinutes: 5 });
    expect(t.estimatedMinutes).toBeGreaterThanOrEqual(5);
    expect(t.canWaitSets).toBe(Math.floor((60 - 6 * MINUTES_PER_SET - 5 - 18) / MINUTES_PER_SET));
  });
});

describe('shoulder care on Push and Upper days', () => {
  it('one easy exercise, the least recently done; none on Pull', () => {
    setup([]);
    const first = planShoulderCare(db, MONDAY, 'push')!;
    expect(first.exercises).toHaveLength(1);
    expect(first.exercises[0]).toMatchObject({ exerciseId: 'cable-band-external-rotation', sets: SHOULDER_CARE_SETS, rirMin: SHOULDER_CARE_MIN_RIR, targetType: 'functional_goal', targetId: 'rotator-cuff' });
    const repo = new WorkoutSessionsRepo(db);
    const s = repo.createSession({ date: '2099-02-27', session_type: 'gym', status: 'completed', duration_minutes: 60 } as any);
    repo.addExercisePerformance(s.session_id, { exercise_id: 'cable-band-external-rotation', order: 0, role: 'accessory', sets: [{ set_number: 1, completed: true }] });
    expect(planShoulderCare(db, MONDAY, 'upper')!.exercises[0]!.exerciseId).toBe('push-up-plus');
    expect(planShoulderCare(db, MONDAY, 'pull')).toBeNull();
  });
});
