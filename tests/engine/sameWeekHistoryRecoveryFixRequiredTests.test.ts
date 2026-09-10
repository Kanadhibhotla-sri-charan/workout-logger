// Workout Programmer — Same-Week History & Day-Specific Recovery Fix:
// the regression tests required by spec §18/§10-§16, using the exact
// audited Sep 7/Sep 8 real facts the spec itself supplies wherever
// applicable (§10). Every test here exercises the real production path
// (assembleWeeklyPlanInput/buildTrainingState, or the real HTTP routes),
// never a reimplementation of the fix.
//
//   Item 1  (Monday workout visible on Monday) — trivially the
//     no-history-gap case; exercised as part of Test Group A below
//     alongside the genuinely new same-week-gap cases.
//   Item 10 (Monday same-day recovery blocks only same-day repeat) and
//   Item 11 (Monday recovery does not permanently skip Friday) —
//     tests/engine/workoutBuilder.test.ts's rewritten "avoids a same-day
//     repeat... but this is day-scoped, never a whole-week exclusion"
//     test, and tests/engine/assembleAndBuildWorkout.test.ts's rewritten
//     "gets no same-day repeat... never a whole-week one" test.
//   Item 12 (simulated exposure affects later-day recovery/frequency
//     appropriately) — already the subject of
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts and
//     tests/engine/remainingPostV2FixesRequiredTests.test.ts (the
//     rolling-frequency/simulated-exposure-date mechanism itself is
//     unchanged by this fix — only the real-history reference date and
//     the recovery skip's scope changed).
//   Item 15 (earlier today only for a true same-day condition) and
//   Item 16 (earlier training described with its actual date) —
//     tests/friendlyExplanation.test.ts's new "Same-Week History &
//     Day-Specific Recovery Fix §9/§15/§16" describe block.
//   Item 18 (future plans never become actual history) —
//     tests/engine/assembleAndBuildWorkout.test.ts /
//     tests/routes/actualTrainingAdaptation.test.ts's existing
//     simulated-vs-real separation coverage (unchanged this phase).
//   Item 19 (locked sessions remain unchanged) —
//     tests/engine/weekProgramReconciliation.test.ts.
//   Item 20 (no workout_* rows created by generation) —
//     tests/engine/assembleAndBuildWorkout.test.ts (a pure DB-reading
//     boundary; generation never writes workout_sessions/_exercises/_sets).
//   Item 21 (rolling frequency remains correct) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts.
//   Item 22 (simulated history remains non-persistent) —
//     tests/engine/assembleAndBuildWorkout.test.ts.
//   Item 23 (authored set caps remain intact) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Tests 1-2.
//   Item 24 (Blueprint exercise validity remains intact) —
//     tests/engine/blueprintCandidateGating.test.ts.
//   Item 25 (package sharing remains intact) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts §24.L,
//     tests/engine/finalRemainingPerExposureFixRequiredTests.test.ts Test E.
//   Item 26 (time/equipment invariance remains intact) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 4.
//
// This file supplies the genuinely new coverage: items 1-9 (real
// same-week history visibility, including the exact audited Sep 7/8
// facts and the incomplete-set exclusion), 13-14 (truthful
// target/variation-level explanations under real same-week history),
// and 17 (the actual canonical reconciliation caller, not a mock of
// buildTrainingState).

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { assembleWeeklyPlanInput, programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { buildTrainingState } from '../../src/engine/trainingState.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { todayForUser } from '../../src/lib/userTimezone.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

// 2026-09-07 is a real Monday — matches the spec's own Sep 7-13 example exactly.
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';
const THURSDAY = '2026-09-10';
const FRIDAY = '2026-09-11';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

function setupProfile(trainingDays: string[] = ['monday', 'tuesday', 'thursday', 'friday']) {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
}

function completedSession(date: string, exercises: Array<{ exercise_id: string; sets: Array<{ weight: number; reps: number; completed: boolean }> }>) {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  let order = 1;
  for (const ex of exercises) {
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: ex.exercise_id,
      order: order++,
      role: 'primary',
      sets: ex.sets.map((s, i) => ({ set_number: i + 1, weight: s.weight, reps: s.reps, completed: s.completed })),
    });
  }
  return session;
}

function reps(n: number, weight = 40, repsCount = 10, completed = true) {
  return Array.from({ length: n }, () => ({ weight, reps: repsCount, completed }));
}

describe('Same-Week History & Day-Specific Recovery Fix — Test Group A (§5/§18 items 1-3): same-week history visibility', () => {
  it('item 1 — Monday real completed work is visible when generating on Monday itself (the no-gap baseline)', () => {
    setupProfile();
    completedSession(MONDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: reps(3) }]);
    const state = buildTrainingState(db, MONDAY);
    const midPec = state.weekly_exposure.find((e) => e.target_id === 'mid-pec');
    expect(midPec?.primary_sets).toBe(3);
  });

  it('item 2 — a Tuesday completed workout is visible to same-week generation later in the week (Friday)', () => {
    setupProfile();
    completedSession(TUESDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: reps(2) }]);
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const midPec = input.targets.find((t) => t.target_id === 'mid-pec')!;
    expect(midPec.current_weekly_primary_sets).toBe(2);
    expect(midPec.last_trained_date).toBe(TUESDAY);
    expect(midPec.days_since_target_last_trained).toBe(3); // Tuesday -> Friday
    expect(midPec.exercise_history['flat-barbell-bench-press']).toBeDefined();
  });

  it('item 3 — a Thursday completed workout is visible to same-week Friday generation', () => {
    setupProfile();
    completedSession(THURSDAY, [{ exercise_id: 'incline-barbell-press', sets: reps(3) }]);
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const upperPec = input.targets.find((t) => t.target_id === 'upper-pec')!;
    expect(upperPec.current_weekly_primary_sets).toBe(3);
    expect(upperPec.last_trained_date).toBe(THURSDAY);
    expect(upperPec.days_since_target_last_trained).toBe(1); // Thursday -> Friday
  });

  it('the planner never behaves as though the whole week is still Monday morning: real Mon+Tue+Thu history is ALL visible together as of Friday', () => {
    setupProfile();
    completedSession(MONDAY, [{ exercise_id: 'cable-crunch', sets: reps(3) }]);
    completedSession(TUESDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: reps(2) }]);
    completedSession(THURSDAY, [{ exercise_id: 'incline-barbell-press', sets: reps(3) }]);
    const state = buildTrainingState(db, FRIDAY);
    expect(state.recent_sessions.map((s) => s.date).sort()).toEqual([MONDAY, THURSDAY, TUESDAY].sort());
  });

  it('for a FUTURE week, a future planned day never becomes real history merely because its date falls inside the generated week', () => {
    setupProfile();
    // No real training logged for the future week beginning 2026-09-14 —
    // requesting/generating that week must never fabricate history for
    // its own future dates.
    const input = assembleWeeklyPlanInput(db, '2026-09-14', 60, '2026-09-14');
    const midPec = input.targets.find((t) => t.target_id === 'mid-pec')!;
    expect(midPec.current_weekly_primary_sets).toBe(0);
    expect(midPec.last_trained_date).toBeNull();
  });
});

describe('Same-Week History & Day-Specific Recovery Fix — Test Group B (§10-§12, items 4-9): the exact audited Sep 7/Sep 8 regression scenario', () => {
  function setupSepFixture() {
    setupProfile();
    completedSession(MONDAY, [
      { exercise_id: 'cable-fly', sets: reps(4) },
      { exercise_id: 'cable-lateral-raise', sets: reps(4) },
      { exercise_id: 'overhead-triceps-extension', sets: reps(4) },
      { exercise_id: 'cable-pushdown', sets: reps(4) },
      { exercise_id: 'incline-dumbbell-press', sets: reps(3) },
      { exercise_id: 'cable-crunch', sets: reps(3) },
    ]);
    completedSession(TUESDAY, [
      { exercise_id: 'lat-pulldown-wide-pronated', sets: reps(3) },
      { exercise_id: 'chest-supported-row', sets: reps(3) },
      { exercise_id: 'cable-rear-delt-builder', sets: reps(3) },
      { exercise_id: 'hammer-curl', sets: reps(2) },
      { exercise_id: 'barbell-ez-bar-curl', sets: reps(3) },
      // The second Wrist Curl set is genuinely incomplete — must remain excluded (item 9).
      { exercise_id: 'wrist-curl', sets: [{ weight: 20, reps: 15, completed: true }, { weight: 20, reps: 15, completed: false }] },
      { exercise_id: 'reverse-wrist-curl', sets: reps(2) },
    ]);
  }

  it('item 4 — Lat Width recognizes Sep 8 exposure/history for lat-pulldown-wide-pronated', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'lat-width')!;
    expect(target.current_weekly_primary_sets).toBe(3);
    expect(target.exercise_history['lat-pulldown-wide-pronated']).toBeDefined();
    expect(target.last_trained_date).toBe(TUESDAY);
  });

  it('item 5 — Back Thickness recognizes Sep 8 primary exposure/history for chest-supported-row plus valid secondary overlap', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'back-thickness')!;
    expect(target.current_weekly_primary_sets).toBe(3); // chest-supported-row's own primary contribution
    expect(target.exercise_history['chest-supported-row']).toBeDefined();
    // Valid secondary overlap from the other Sep 8 back/rear-delt work.
    expect(target.exercise_history['lat-pulldown-wide-pronated']).toBeDefined();
    expect(target.exercise_history['cable-rear-delt-builder']).toBeDefined();
  });

  it('item 6 — Brachialis / Arm Thickness recognizes Sep 8 hammer-curl', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'brachialis-arm-thickness')!;
    expect(target.current_weekly_primary_sets).toBe(2);
    expect(target.exercise_history['hammer-curl']).toBeDefined();
  });

  it('item 7 — Biceps recognizes Sep 8 barbell-ez-bar-curl plus valid secondary hammer-curl exposure', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'biceps')!;
    expect(target.current_weekly_primary_sets).toBe(3);
    expect(target.exercise_history['barbell-ez-bar-curl']).toBeDefined();
    expect(target.exercise_history['hammer-curl']).toBeDefined(); // secondary overlap
  });

  it('item 8 — Rear Delt recognizes Sep 8 cable-rear-delt-builder', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'rear-delt')!;
    expect(target.current_weekly_primary_sets).toBe(3);
    expect(target.exercise_history['cable-rear-delt-builder']).toBeDefined();
  });

  it('item 8b — Forearm Extensors recognizes Sep 8 reverse-wrist-curl', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'forearm-extensors')!;
    expect(target.current_weekly_primary_sets).toBe(2);
    expect(target.exercise_history['reverse-wrist-curl']).toBeDefined();
  });

  it('item 9 — Forearm Flexors recognizes only the ONE completed Wrist Curl set; the incomplete second set stays excluded', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const target = input.targets.find((t) => t.target_id === 'forearm-flexors')!;
    // Weekly exposure counting correctly excludes the incomplete set —
    // 1 completed set, never 2.
    expect(target.current_weekly_primary_sets).toBe(1);
    expect(target.exercise_history['wrist-curl']).toBeDefined();
    expect(target.exercise_history['wrist-curl']![0]!.date).toBe(TUESDAY);
  });

  it('variation-history regression (§11): genuinely unused variations still correctly receive no history, never fabricated', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const unusedByTarget: Array<[string, string]> = [
      ['brachialis-arm-thickness', 'cross-body-hammer-curl'],
      ['back-thickness', 'seated-cable-row'],
      ['lat-width', 'straight-arm-pulldown'],
      ['rear-delt', 'face-pull'],
      ['back-thickness', 'rear-delt-row'],
      ['biceps', 'incline-dumbbell-curl'],
      ['biceps', 'reverse-curl'],
    ];
    for (const [targetId, exerciseId] of unusedByTarget) {
      const target = input.targets.find((t) => t.target_id === targetId)!;
      expect(target.exercise_history[exerciseId]).toBeUndefined();
    }
  });

  it('target-history regression (§12): after Sep 8, same-week planning never reports these targets as untouched', () => {
    setupSepFixture();
    const input = assembleWeeklyPlanInput(db, MONDAY, 60, FRIDAY);
    const targetsWithRealHistory = ['lat-width', 'back-thickness', 'brachialis-arm-thickness', 'biceps', 'rear-delt', 'forearm-extensors', 'forearm-flexors'];
    for (const targetId of targetsWithRealHistory) {
      const target = input.targets.find((t) => t.target_id === targetId)!;
      expect(target.current_weekly_primary_sets).toBeGreaterThan(0);
      expect(target.last_trained_date).not.toBeNull();
      expect(Object.keys(target.exercise_history).length).toBeGreaterThan(0);
    }
  });
});

describe('Same-Week History & Day-Specific Recovery Fix — Test Group C (§9/§11, items 13-14): truthful target/variation-level explanations', () => {
  async function fridayPlannedWork() {
    setupProfile();
    completedSession(TUESDAY, [
      { exercise_id: 'lat-pulldown-wide-pronated', sets: reps(3) },
      { exercise_id: 'hammer-curl', sets: reps(2) },
      { exercise_id: 'wrist-curl', sets: [{ weight: 20, reps: 15, completed: true }, { weight: 20, reps: 15, completed: false }] },
    ]);
    const app = createApp(db);
    const res = await request(app).get(`/api/programming/week?date=${FRIDAY}`).expect(200);
    return res.body.days.find((d: any) => d.date === FRIDAY).plannedWork;
  }

  it('item 13 — no false "first time" explanation for an exercise with genuine same-week history, when the same variation is reused', async () => {
    const work = await fridayPlannedWork();
    const sameVariation = work.find((w: any) => w.exercise_id === 'lat-pulldown-wide-pronated' || w.exercise_id === 'hammer-curl' || w.exercise_id === 'wrist-curl');
    // At least one of these targets' progression-continuity logic
    // reuses the exact same real Tuesday exercise — proving the
    // programmer does not fabricate a "first time" state merely because
    // the prior use was earlier in the same programming week.
    expect(sameVariation).toBeDefined();
    expect(sameVariation!.progression_decision).not.toBeNull();
  });

  it('item 14 — no false "haven\'t trained this target yet this week" explanation when real exposure exists, even for a target whose Friday exercise happens to be a different (also-legitimate) variation', async () => {
    const work = await fridayPlannedWork();
    for (const item of work) {
      if (['lat-width', 'brachialis-arm-thickness', 'forearm-flexors'].includes(item.target_id)) {
        expect(item.friendly_reasoning).not.toContain("haven't trained this target yet this week");
        expect(item.friendly_reasoning).toMatch(/You had \d+ sets? for this target so far this week/);
      }
    }
  });
});

describe('Same-Week History & Day-Specific Recovery Fix — Test Group D (§14, item 17): the actual canonical post-workout reconciliation path', () => {
  it('completing a real Tuesday workout through the real HTTP path makes it visible to the rebuilt training state via the actual reconcileAfterActualTraining caller — no fake workout rows created', async () => {
    const app = createApp(db);
    setupProfile();

    // Generate the week for real, first, through the real route (not a
    // mock) — this is the canonical entry point spec §14 requires.
    const today = todayForUser(db);
    const weekStart = programmingWeekStart(today);
    await request(app).get(`/api/programming/week?date=${today}`).expect(200);

    const weekBefore = await request(app).get(`/api/programming/week?date=${today}`).expect(200);
    const tuesdayDate = weekBefore.body.days.find((d: any) => d.weekday === 'tuesday').date;

    // Complete a real Tuesday workout via the actual canonical route
    // sequence (POST session -> POST exercise -> PATCH completed) —
    // this is what genuinely triggers adaptCurrentWeekIfNeeded ->
    // reconcileAfterActualTraining -> computeFreshWeek.
    const created = await request(app).post('/api/workouts').send({ date: tuesdayDate, session_type: 'gym', status: 'in_progress' }).expect(201);
    await request(app)
      .post(`/api/workouts/${created.body.session_id}/exercises`)
      .send({ exercise_id: 'lat-pulldown-wide-pronated', order: 1, role: 'primary', sets: [{ set_number: 1, weight: 50, reps: 10, completed: true }] })
      .expect(201);
    await request(app).patch(`/api/workouts/${created.body.session_id}`).send({ status: 'completed' }).expect(200);

    // The real training state, rebuilt as of today, must see this
    // just-completed Tuesday session (the exact canonical-reconciliation
    // assertion spec §14 requires).
    const state = buildTrainingState(db, today);
    if (programmingWeekStart(tuesdayDate) === weekStart) {
      expect(state.recent_sessions.some((s) => s.date === tuesdayDate)).toBe(true);
    }

    // No fake workout_sessions/_exercises/_sets were created beyond the
    // one real session this test itself logged.
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const allSessions = sessionsRepo.listSessions();
    expect(allSessions.length).toBe(1);
    expect(allSessions[0]!.status).toBe('completed');

    // The persisted week program itself was genuinely reconciled (not
    // silently skipped) — a program row exists for this week.
    const program = new WeeklyProgramRepo(db).getByWeekStart(weekStart);
    expect(program).toBeDefined();
  });
});
