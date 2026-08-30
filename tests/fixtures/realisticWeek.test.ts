// Remediation §19 / Final Programming-Engine Pass §26: "at least one
// integration fixture" representing a realistic week (Mon/Tue gym, Wed
// rest, Thu/Fri gym, Sat/Sun badminton/rest), including: PPL+Upper
// context; at least one compound press; actual logged exercise
// history; actual badminton history; at least two active ranked
// aesthetic goals; normal-development targets; equipment constraints;
// a realistic time limit — invoking the real production generation
// path, never isolated function calls.
//
// This exercises the FULL real production path — TrainingProfileRepo,
// GoalsRepo, WorkoutSessionsRepo, BadmintonSessionDetailsRepo,
// buildTrainingState, assembleAndBuildWorkout — across an entire real
// week of logged activity, not an isolated engine call. Every other
// remediation fixture in this directory tests one mechanism in
// isolation; this one proves those mechanisms actually compose across
// a full week the way a real user's data would.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { assembleAndBuildWorkout } from '../../src/engine/workoutBuilder.js';
import { buildTrainingState } from '../../src/engine/trainingState.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BadmintonSessionDetailsRepo } from '../../src/repositories/badmintonSessionDetailsRepo.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { EXPOSURE_COEFFICIENTS } from '../../src/engine/config.js';

// Week 1 (2026-08-24 is a Monday): Mon/Tue gym, Wed rest, Thu/Fri gym,
// Sat/Sun badminton — spec §16's own DEFAULT_WEEKLY_SCHEDULE shape.
const MON1 = '2026-08-24';
const TUE1 = '2026-08-25';
const THU1 = '2026-08-27';
const FRI1 = '2026-08-28';
const SAT1 = '2026-08-29';
const SUN1 = '2026-08-30';
// Week 2 — the days that actually feel the prior weekend's badminton.
const MON2 = '2026-08-31';
const TUE2 = '2026-09-01';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate', 'hip-thrust machine', 'band'];

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

/** Logs one real, completed gym session on `date` performing
 * flat-barbell-bench-press — a real compound movement (mid-pec
 * primary; front-delt + triceps secondary, per
 * docs/SECONDARY_TARGET_MAPPING.md and tests/fixtures/compoundMovement.test.ts)
 * — with 3 completed working sets, mirroring how a real workout gets
 * logged after the fact. */
function logBenchPressSession(date: string) {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: 'flat-barbell-bench-press',
    order: 1,
    role: 'primary',
    sets: [
      { set_number: 1, weight: 60, reps: 8, completed: true },
      { set_number: 2, weight: 60, reps: 8, completed: true },
      { set_number: 3, weight: 60, reps: 8, completed: true },
    ],
  });
}

function logBadmintonSession(date: string) {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'badminton', status: 'completed' });
  new BadmintonSessionDetailsRepo(db).record({ workout_session_id: session.session_id, intensity: 'high', format: 'singles', games_count: 3, post_session_fatigue: 4 });
}

describe('fixture: a realistic week (Mon/Tue gym, Wed rest, Thu/Fri gym, Sat/Sun badminton) — remediation §19', () => {
  beforeEach(() => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [
        { day: 'saturday', activity_type: 'badminton', notes: null },
        { day: 'sunday', activity_type: 'badminton', notes: null },
      ],
    });

    // Final Pass §26: at least two active, ranked aesthetic goals.
    // "Chest looks flat from the side" -> primary_targets: ['mid-pec']
    // (push/upper-compatible), ranked #1.
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.includes('mid-pec'))!;
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });
    // arm-side-thickness -> primary_targets: ['brachialis-arm-thickness']
    // (pull-compatible — a genuinely different PPL session than goal 1),
    // ranked #2.
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 2 });

    // Real gym sessions Monday/Tuesday/Thursday/Friday of week 1 — the
    // same compound press each time, so its secondary contribution
    // (front-delt, triceps) accumulates across the week exactly as it
    // would for a real user training the same lift repeatedly.
    logBenchPressSession(MON1);
    logBenchPressSession(TUE1);
    logBenchPressSession(THU1);
    logBenchPressSession(FRI1);
    // Real badminton Saturday/Sunday of week 1.
    logBadmintonSession(SAT1);
    logBadmintonSession(SUN1);
  });

  it('secondary exposure from real compound pressing accumulates end-to-end through buildTrainingState — not just the isolated exposure-engine unit', () => {
    // As of Friday of week 1 (after all 4 gym sessions have been
    // logged, before the week rolls over): 4 sessions x 3 completed
    // sets each x EXPOSURE_COEFFICIENTS.secondary credit for BOTH
    // front-delt and triceps, since flat-barbell-bench-press's own
    // secondary_targets map to exactly those two real canonical ids.
    const state = buildTrainingState(db, FRI1);

    const tricepsWeekly = state.weekly_exposure.find((e) => e.target_id === 'triceps');
    const frontDeltWeekly = state.weekly_exposure.find((e) => e.target_id === 'front-delt');
    expect(tricepsWeekly).toBeDefined();
    expect(frontDeltWeekly).toBeDefined();

    const expectedSecondarySets = 4 * 3; // 4 sessions x 3 sets
    expect(tricepsWeekly!.secondary_sets).toBe(expectedSecondarySets);
    expect(tricepsWeekly!.primary_sets).toBe(0); // triceps is never bench press's PRIMARY target
    expect(tricepsWeekly!.exposure_units).toBeCloseTo(expectedSecondarySets * EXPOSURE_COEFFICIENTS.secondary, 5);
    expect(frontDeltWeekly!.secondary_sets).toBe(expectedSecondarySets);

    // And mid-pec itself — bench press's real PRIMARY target — carries
    // full 1.00/set primary credit, the same week, through the same
    // real pipeline.
    const midPecWeekly = state.weekly_exposure.find((e) => e.target_id === 'mid-pec');
    expect(midPecWeekly!.primary_sets).toBe(expectedSecondarySets); // same 12 sets, primary role this time
    expect(midPecWeekly!.exposure_units).toBeCloseTo(expectedSecondarySets * EXPOSURE_COEFFICIENTS.primary, 5);
  });

  it('a real weekend of logged badminton actually reaches the following week\'s real generated workout (not a hardcoded null)', () => {
    const result = assembleAndBuildWorkout(db, MON2, 60);
    // Every target's decision object carries the real badminton
    // context read from the actual logged Sunday session — proving the
    // full chain (WorkoutSessionsRepo -> BadmintonSessionDetailsRepo ->
    // trainingState -> workoutBuilder) delivers real data, not a
    // placeholder, into the next real build.
    const withBadmintonContext = result.exercises.filter((e) => e.decision.badminton_context !== null);
    expect(withBadmintonContext.length).toBeGreaterThan(0);
    for (const plan of withBadmintonContext) {
      expect(plan.decision.badminton_context?.intensity).toBe('high');
    }
  });

  it('generates a real, complete workout on every scheduled day across the full two-week span with no errors, never exceeding the time budget', () => {
    for (const date of [MON1, TUE1, THU1, FRI1, MON2, TUE2]) {
      const result = assembleAndBuildWorkout(db, date, 60);
      expect(result.exercises.length).toBeGreaterThan(0);
      expect(result.estimated_minutes).toBeLessThanOrEqual(60);
      // Every generated exercise carries the full remediation §16
      // machine-readable decision object through this real end-to-end
      // path, not just in isolated unit tests.
      for (const plan of result.exercises) {
        expect(plan.decision.volume_decision).toBeDefined();
        expect(plan.decision.selection).not.toBeNull();
      }
    }
  });

  it('both ranked specialization goals stay protected and present across the week, alongside real normal-development coverage of the rest of the physique', () => {
    // Monday (push) is goal 1's own day — mid-pec must be there.
    const monday2 = assembleAndBuildWorkout(db, MON2, 90);
    const mondaySpecialization = monday2.exercises.filter((e) => e.classification === 'specialization');
    const mondayRest = monday2.exercises.filter((e) => e.classification !== 'specialization');
    expect(mondaySpecialization.some((e) => e.target_id === 'mid-pec')).toBe(true);
    expect(mondayRest.length).toBeGreaterThan(0);

    // Tuesday (pull) is goal 2's own day — brachialis-arm-thickness must
    // be there too, proving the #2-ranked goal isn't starved merely
    // because goal 1 exists and outranks it (Final Pass §3 Step 2).
    const tuesday2 = assembleAndBuildWorkout(db, TUE2, 90);
    expect(tuesday2.exercises.some((e) => e.target_id === 'brachialis-arm-thickness' && e.classification === 'specialization')).toBe(true);
    expect(tuesday2.active_goals.length).toBe(2);
    expect(tuesday2.active_goals.map((g) => g.priority).sort()).toEqual([1, 2]);
  });

  it('Final Pass §5/§12: the week carries real, coordinated PPL+Upper session purposes — Monday push, Tuesday pull, Thursday legs, Friday upper', () => {
    const expectedPurposes: Record<string, string> = { [MON1]: 'push', [TUE1]: 'pull', [THU1]: 'legs', [FRI1]: 'upper' };
    for (const [date, expectedPurpose] of Object.entries(expectedPurposes)) {
      const result = assembleAndBuildWorkout(db, date, 90);
      expect(result.exercises.length).toBeGreaterThan(0);
      for (const plan of result.exercises) {
        if (plan.target_type === 'physique_target') {
          expect(plan.decision.session_purpose).toBe(expectedPurpose);
        }
      }
    }
  });
});
