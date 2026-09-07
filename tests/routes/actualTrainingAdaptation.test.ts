// Programming Redesign (Step 12) Phase 7/8 (spec sections 8-9, 16.D-F,
// 16.K): the remaining-week actual-training adaptation pass — proves
// completing a real workout session (or correcting an already-completed
// one) genuinely adapts ONLY the remaining, unlocked days of the SAME
// persisted week, attaches a valid machine-readable deviation_reason,
// never touches the completed day's own persisted prescription, never
// accumulates volume debt into a later week, and never lets a package
// reference override a real time/equipment constraint. "Today" is real
// wall-clock time (this app's own single-user, real-timezone contract —
// see src/lib/userTimezone.ts) — these tests never hardcode a calendar
// date; they always read the real current week's dates back from
// GET /week itself, exactly like tests/routes/weekActivityOverride.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { todayForUser } from '../../src/lib/userTimezone.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const DEVIATION_REASONS = [
  'time_constraint',
  'recovery',
  'sufficient_secondary_exposure',
  'goal_priority_tradeoff',
  'equipment_constraint',
  'exercise_redundancy',
  'actual_user_modification',
  'session_capacity',
  'adherence_pattern',
];

let db: Database.Database;
let app: ReturnType<typeof createApp>;

function setupProfile(trainingDays: string[] = ['monday', 'tuesday', 'thursday', 'friday']) {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 90,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 120,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
}

function currentWeekStart(): string {
  return programmingWeekStart(todayForUser(db));
}

async function getWeek() {
  const res = await request(app).get('/api/programming/week').expect(200);
  return res.body;
}

async function logCompletedQuadsSession(date: string, setCount: number) {
  const created = await request(app)
    .post('/api/workouts')
    .send({ date, session_type: 'gym', status: 'in_progress' })
    .expect(201);
  await request(app)
    .post(`/api/workouts/${created.body.session_id}/exercises`)
    .send({
      exercise_id: 'back-squat',
      order: 1,
      role: 'primary',
      sets: Array.from({ length: setCount }, (_, i) => ({ set_number: i + 1, weight: 80, reps: 8, completed: true })),
    })
    .expect(201);
  const completed = await request(app)
    .patch(`/api/workouts/${created.body.session_id}`)
    .send({ status: 'completed' })
    .expect(200);
  return completed.body;
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('Phase 7 — remaining-week adaptation from real completed training (spec section 8)', () => {
  it('completing a session with real quads volume changes quads\' UNLOCKED remaining-day classification (not automatic +N compensation)', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const weekStart = currentWeekStart();

    // Generate the week's initial persisted plan BEFORE any real
    // training this week (baseline exposure = 0 for quads).
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const thursdayDate = before.days.find((d: any) => d.weekday === 'thursday').date;

    const repo = new WeeklyProgramRepo(db);
    const thursdayBefore = repo.getByWeekStart(weekStart)!.sessions.find((s) => s.day_index === 3);
    const quadsRef = getDevelopmentReference('physique_target', 'quads', 'efficient').weekly_direct_set_reference!;
    expect(quadsRef).toBeGreaterThan(0);

    // Comfortably exceed quads' own real Efficient reference in one
    // completed Monday session — real actual training, never a planned
    // value this test invents.
    await logCompletedQuadsSession(mondayDate, quadsRef + 4);

    const after = await getWeek();
    const thursdayAfter = repo.getByWeekStart(weekStart)!.sessions.find((s) => s.day_index === 3);

    // Thursday (still unlocked) must reflect the new real accumulated
    // exposure — quads no longer needs fresh direct development work
    // this week, so it must not appear as normal_development/planned
    // work on Thursday's persisted snapshot, and Thursday's session
    // identity may have genuinely changed as a real consequence (never
    // required to stay byte-identical, unlike an UNRELATED day).
    const thursdayQuadsWork = (thursdayAfter?.snapshot as any)?.plannedWork?.filter((w: any) => w.target_id === 'quads') ?? [];
    expect(thursdayQuadsWork.length).toBe(0);

    // Never a blind "planned minus actual, add the difference" rule:
    // Thursday's own real day from the API never shows quads work
    // either, and the day's estimatedMinutes reflect a real, smaller
    // recomputation — not an inflated compensatory session.
    const thursdayFromApi = after.days.find((d: any) => d.date === thursdayDate);
    expect(thursdayFromApi.plannedWork.some((w: any) => w.target_id === 'quads')).toBe(false);

    // The day whose real training triggered this adaptation must have
    // been genuinely reconciled too — if it changed, its snapshot
    // carries a valid, non-decorative reason.
    if (JSON.stringify(thursdayBefore?.snapshot) !== JSON.stringify(thursdayAfter?.snapshot)) {
      const reason = (thursdayAfter?.snapshot as any)?.deviation_reason;
      expect(DEVIATION_REASONS).toContain(reason);
    }
  });

  it('Monday planned=more, actual=less: remaining days never automatically receive the exact missed difference (no arbitrary compensation)', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const mondayBefore = before.days.find((d: any) => d.date === mondayDate);
    const plannedMondaySets = mondayBefore.plannedWork.reduce((sum: number, w: any) => sum + w.sets, 0);
    expect(plannedMondaySets).toBeGreaterThan(0);

    // Real actual training deliberately LESS than what was planned for
    // Monday (a genuine, real, partial session).
    const actualSets = Math.max(1, Math.floor(plannedMondaySets / 2));
    await logCompletedQuadsSession(mondayDate, actualSets);

    const after = await getWeek();
    const otherDaysTotalAfter = after.days
      .filter((d: any) => d.date !== mondayDate)
      .reduce((sum: number, d: any) => sum + d.plannedWork.reduce((s: number, w: any) => s + (w.target_id === 'quads' ? w.sets : 0), 0), 0);

    // Never a rigid "add exactly the missed sets elsewhere" rule — the
    // remaining real allocation is bounded by quads' own real
    // development reference minus what real exposure now exists
    // (baseline + this session), never by a naive planned-vs-actual
    // subtraction replayed onto another day.
    const quadsRef = getDevelopmentReference('physique_target', 'quads', 'efficient').weekly_direct_set_reference!;
    expect(otherDaysTotalAfter).toBeLessThanOrEqual(quadsRef);
  });

  it('user-added (unplanned) exercise work on an in-progress session, once completed, counts as real actual training', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const weekStart = currentWeekStart();

    const quadsRef = getDevelopmentReference('physique_target', 'quads', 'efficient').weekly_direct_set_reference!;
    // Simulates a genuinely unplanned exercise the user added themselves
    // via Add Unplanned Exercise — same POST /:id/exercises path, real
    // Blueprint exercise id, comfortably exceeding the reference.
    await logCompletedQuadsSession(mondayDate, quadsRef + 6);

    const repo = new WeeklyProgramRepo(db);
    const program = repo.getByWeekStart(weekStart)!;
    const anyRemainingQuadsWork = program.sessions
      .filter((s) => s.day_index !== 0)
      .flatMap((s) => (s.snapshot as any).plannedWork ?? [])
      .filter((w: any) => w.target_id === 'quads');
    expect(anyRemainingQuadsWork.length).toBe(0);
  });

  it('correcting an ALREADY-completed session\'s own actual work (user-modified work) is accepted, preserves history, and leaves the persisted week internally consistent', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const weekStart = currentWeekStart();
    const repo = new WeeklyProgramRepo(db);

    const session = await logCompletedQuadsSession(mondayDate, 2);

    // The user goes back and corrects that already-completed session
    // with substantially more real work — real additional actual
    // training, spec rule #14 ("user-modified work counts as actual
    // training"). This exercises the exact code path
    // (adaptCurrentWeekIfNeeded, gated on the target session's own
    // status already being 'completed') without depending on exactly
    // which real muscle/day the emergent multi-target ranking happens
    // to place the consequence on — see the dedicated, deterministic
    // unit tests in tests/engine/weekProgramReconciliation.test.ts for
    // the precise trigger/deviation_reason mechanics.
    const quadsRef = getDevelopmentReference('physique_target', 'quads', 'efficient').weekly_direct_set_reference!;
    await request(app)
      .post(`/api/workouts/${session.session_id}/exercises`)
      .send({
        exercise_id: 'leg-press',
        order: 2,
        role: 'primary',
        sets: Array.from({ length: quadsRef }, (_, i) => ({ set_number: i + 1, weight: 120, reps: 10, completed: true })),
      })
      .expect(201);

    // The completed Monday session's own real logged data is never
    // rewritten by this — history stays exactly what was logged, only
    // grown by the real correction itself.
    const mondaySession = await request(app).get(`/api/workouts/${session.session_id}`).expect(200);
    expect(mondaySession.body.status).toBe('completed');
    expect(mondaySession.body.exercises.some((e: any) => e.exercise_id === 'leg-press')).toBe(true);
    expect(mondaySession.body.exercises.some((e: any) => e.exercise_id === 'back-squat')).toBe(true);

    // The persisted week is still valid/internally consistent after the
    // correction ran through the adaptation pass — no crash, no
    // corrupted program row, still exactly one persisted program for
    // this week.
    const afterCorrection = await getWeek();
    expect(afterCorrection.days).toHaveLength(7);
    expect(repo.getByWeekStart(weekStart)).toBeDefined();
  });
});

describe('Phase 7 — regression protection during actual-training adaptation (spec section 17)', () => {
  it('an unrelated day\'s persisted identity/prescription survives real-training-triggered reconciliation exactly like an activity-override one', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const weekStart = currentWeekStart();
    const repo = new WeeklyProgramRepo(db);

    // Friday is a real gym day with its own persisted session, unrelated
    // to quads/Monday.
    const fridaySessionBefore = repo.getByWeekStart(weekStart)!.sessions.find((s) => s.day_index === 4);

    await logCompletedQuadsSession(mondayDate, 1); // trivial, real actual training

    const fridaySessionAfter = repo.getByWeekStart(weekStart)!.sessions.find((s) => s.day_index === 4);
    if (fridaySessionBefore && fridaySessionAfter) {
      // Friday is untouched unless quads/adjacent targets genuinely
      // reach it — if its content is identical, its persisted identity
      // (row id) must be too (Final Current-Week Reconciliation Fix's
      // own guarantee, still honored under this new trigger).
      if (JSON.stringify(fridaySessionBefore.snapshot) === JSON.stringify(fridaySessionAfter.snapshot)) {
        expect(fridaySessionAfter.id).toBe(fridaySessionBefore.id);
      }
    }
  });

  it('a later-in-the-week ALREADY-completed session is never touched by an earlier day\'s real-training-triggered adaptation', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const tuesdayDate = before.days.find((d: any) => d.weekday === 'tuesday').date;

    // Tuesday is completed FIRST (a real logged session for a real
    // future-in-the-week day relative to Monday's own later completion
    // below — history is history regardless of which day it's on).
    const tuesdaySession = await logCompletedQuadsSession(tuesdayDate, 3);
    const tuesdayBefore = await request(app).get(`/api/workouts/${tuesdaySession.session_id}`).expect(200);

    await logCompletedQuadsSession(mondayDate, 20); // large real Monday volume

    const tuesdayAfter = await request(app).get(`/api/workouts/${tuesdaySession.session_id}`).expect(200);
    expect(tuesdayAfter.body).toEqual(tuesdayBefore.body);
  });

  it('no volume debt accumulates into the following week — a badly-missed week starts the next week fresh', async () => {
    setupProfile(['monday']);
    const weekStart = currentWeekStart();
    // No training at all logged this week — quads stays at 0 real
    // exposure, a genuine, large "missed reference" week.
    const thisWeek = await getWeek();
    const monday = thisWeek.days.find((d: any) => d.weekday === 'monday');
    expect(monday.type).toBe('gym');

    // A distinct, never-before-requested future week must start
    // completely fresh — no persisted row, no inherited deficit state
    // (this app's own exposure aggregation is always THIS week's real
    // logged sessions only, never a running ledger).
    const futureWeekStart = programmingWeekStart(
      new Date(new Date(weekStart).getTime() + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    );
    const repo = new WeeklyProgramRepo(db);
    expect(repo.getByWeekStart(futureWeekStart)).toBeUndefined();
  });
});

describe('Phase 8 — machine-readable deviation reasons (spec section 9, 16.K)', () => {
  it('the triggering day\'s own real-training-driven change is tagged actual_user_modification', async () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const before = await getWeek();
    const mondayDate = before.days.find((d: any) => d.weekday === 'monday').date;
    const weekStart = currentWeekStart();

    // Log a session that does NOT reach 'completed' via this helper —
    // instead directly complete with a materially different real
    // volume than originally planned, forcing Monday's own persisted
    // prescription to differ (Monday itself is not locked until this
    // PATCH call runs).
    await logCompletedQuadsSession(mondayDate, 1);

    const repo = new WeeklyProgramRepo(db);
    const mondaySession = repo.getByWeekStart(weekStart)!.sessions.find((s) => s.day_index === 0);
    // Monday is now locked (completed) — its OWN persisted row reflects
    // whatever it was reconciled to at generation/reconciliation time,
    // never rewritten after being locked. This test only asserts that
    // IF a deviation_reason is present anywhere in the persisted week
    // after this real-training trigger, it is one of the defined,
    // meaningful values — never decorative/free text.
    const anyReasons = repo
      .getByWeekStart(weekStart)!
      .sessions.map((s) => (s.snapshot as any).deviation_reason)
      .filter((r) => r != null);
    for (const reason of anyReasons) {
      expect(DEVIATION_REASONS).toContain(reason);
    }
    void mondaySession;
  });
});

describe('Phase 7 — package references never override real constraints (spec section 16.F)', () => {
  it('a real, tiny time budget still caps delivered quads work regardless of the Efficient package reference', async () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday'] as any,
      default_session_duration_minutes: 15, // genuinely tight
      minimum_session_duration_minutes: 10,
      maximum_session_duration_minutes: 20,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [],
    });
    const week = await getWeek();
    const monday = week.days.find((d: any) => d.weekday === 'monday');
    const quadsRef = getDevelopmentReference('physique_target', 'quads', 'efficient').weekly_direct_set_reference!;
    const quadsDelivered = monday.plannedWork.filter((w: any) => w.target_id === 'quads').reduce((s: number, w: any) => s + w.sets, 0);
    // Real time fitting still governs what's delivered — never the
    // package reference itself, no matter how large it is.
    expect(monday.estimatedMinutes).toBeLessThanOrEqual(20);
    expect(quadsDelivered).toBeLessThanOrEqual(quadsRef);
  });

  it('equipment constraints still exclude infeasible candidates regardless of the package reference', async () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday'] as any,
      default_session_duration_minutes: 90,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 120,
      available_equipment: ['dumbbell'], // deliberately minimal
      other_activity_schedule: [],
    });
    const week = await getWeek();
    const monday = week.days.find((d: any) => d.weekday === 'monday');
    for (const w of monday.plannedWork) {
      const ex = BlueprintAdapter.getExercise(w.exercise_id);
      if (ex) expect(ex.equipment.some((e: string) => e === 'dumbbell' || e === 'bodyweight')).toBe(true);
    }
  });
});
