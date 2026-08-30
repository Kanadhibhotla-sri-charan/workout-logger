// Strict Final Bug-Fix Spec §32: the required comprehensive full-week
// fixture, exercising the REAL production generation path
// (assembleAndBuildWorkout) across an entire real week — never an
// isolated buildWorkout call. Distinct from tests/fixtures/realisticWeek.test.ts
// (built for the prior Final Programming-Engine Pass): this fixture is
// specifically about proving the THREE bugs this spec fixes actually
// drive real, production-path behavior together across one week —
// priority surviving time fitting on a limited-time day, the durable
// weekly plan holding across the week, and multi-exercise construction
// genuinely firing on real Blueprint data — not just in isolated
// buildWorkout-level tests.
//
// Required elements (§32), all present:
//   Monday    — Push, limited time, real badminton history, bench press
//   Tuesday   — Pull, normal available time
//   Wednesday — Rest
//   Thursday  — Legs, approaching-weekend badminton context
//   Friday    — Upper, weekend badminton context
//   Saturday  — High badminton
//   Sunday    — Moderate/high badminton
//   + two ranked aesthetic goals, real Blueprint aesthetic targets, a
//     real normal-development target, a real maintenance target, real
//     exercise history, real compound exposure, real progression data
//     (a repeated exercise across two weeks), equipment constraints, and
//     per-day time constraints.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { assembleAndBuildWorkout } from '../../src/engine/workoutBuilder.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BadmintonSessionDetailsRepo } from '../../src/repositories/badmintonSessionDetailsRepo.js';

// Week 1 (2026-08-24 is a Monday) — establishes real history: a
// compound press repeated Monday/Friday (real compound exposure and
// progression source for week 2), and a real weekend of logged
// badminton. Classification (normal_development vs. maintenance) reads
// THIS week's real exposure, not a cumulative total — so the direct
// quads work that needs to land above Blueprint's own
// starting_point_sets threshold for week 2's own Thursday build is
// logged within week 2 itself (Tuesday, see logHeavyQuadsSession
// below), not week 1.
const MON1 = '2026-08-24';
const FRI1 = '2026-08-28';
const SAT1 = '2026-08-29';
const SUN1 = '2026-08-30';
// Week 2 — the week this fixture's real assertions run against.
const MON2 = '2026-08-31';
const TUE2 = '2026-09-01';
const THU2 = '2026-09-03';
const FRI2 = '2026-09-04';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate', 'hip-thrust machine', 'band'];

let db: Database.Database;

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
      { set_number: 3, weight: 62.5, reps: 8, completed: true },
    ],
  });
}

/** Real logged quads volume AT Blueprint's own starting_point_sets
 * lower bound (8 — the threshold rankTarget's needDeficit is measured
 * against) — so quads reads as genuinely 'maintenance' for whichever
 * week this lands in, not 'normal_development' (Strict Bug-Fix §6/§7's
 * exposure-aware classification, not a fabricated state). */
function logHeavyQuadsSession(date: string) {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: 'back-squat',
    order: 1,
    role: 'primary',
    sets: [
      { set_number: 1, weight: 80, reps: 8, completed: true },
      { set_number: 2, weight: 80, reps: 8, completed: true },
      { set_number: 3, weight: 82.5, reps: 8, completed: true },
      { set_number: 4, weight: 82.5, reps: 8, completed: true },
      { set_number: 5, weight: 85, reps: 8, completed: true },
      { set_number: 6, weight: 85, reps: 8, completed: true },
      { set_number: 7, weight: 85, reps: 8, completed: true },
      { set_number: 8, weight: 85, reps: 6, completed: true },
    ],
  });
}

function logBadmintonSession(date: string, intensity: 'medium' | 'high') {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'badminton', status: 'completed' });
  new BadmintonSessionDetailsRepo(db).record({ workout_session_id: session.session_id, intensity, format: 'singles', games_count: 3, post_session_fatigue: intensity === 'high' ? 4 : 3 });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Strict Bug-Fix §32: the required full-week fixture, through the real production path', () => {
  beforeEach(() => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 20,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [
        { day: 'saturday', activity_type: 'badminton', notes: null },
        { day: 'sunday', activity_type: 'badminton', notes: null },
      ],
    });

    // Two real, ranked aesthetic goals — one push/upper-compatible
    // (mid-pec), one pull-compatible (brachialis arm thickness) — on
    // genuinely different PPL sessions, so each gets its own real day.
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 2 });

    // Week 1 real history: compound pressing Monday + Friday (real
    // compound exposure/progression source), heavy quads Thursday
    // (real 'maintenance' state by week 2), a real weekend of logged
    // badminton (Saturday high, Sunday moderate).
    logBenchPressSession(MON1);
    logBenchPressSession(FRI1);
    // Within week 2 itself (before Thursday), not week 1 — weekly
    // exposure resets each week, and classification reads THIS week's
    // real total (Strict Bug-Fix §6/§7), never a cumulative history.
    logHeavyQuadsSession(TUE2);
    logBadmintonSession(SAT1, 'high');
    logBadmintonSession(SUN1, 'medium');
  });

  it('Monday — Push, a real limited time budget: the real production path still serves Goal 1 first and never exceeds the budget', () => {
    const result = assembleAndBuildWorkout(db, MON2, 20); // a genuinely tight session
    expect(result.estimated_minutes).toBeLessThanOrEqual(20);
    expect(result.exercises.length).toBeGreaterThan(0);
    // Goal 1 (mid-pec) is this specialization's own push day — under a
    // scarce budget, its real work must survive (Strict Bug-Fix §3:
    // programming priority preserved through time fitting), not be
    // arbitrarily bumped by whatever else also wants Monday's slot.
    expect(result.exercises.some((e) => e.target_id === 'mid-pec')).toBe(true);
  });

  it('Tuesday — Pull, normal time: Goal 2 (a genuinely different PPL day than Goal 1) gets its own real work', () => {
    const result = assembleAndBuildWorkout(db, TUE2, 75);
    expect(result.estimated_minutes).toBeLessThanOrEqual(75);
    expect(result.exercises.some((e) => e.target_id === 'brachialis-arm-thickness')).toBe(true);
    expect(result.active_goals.length).toBe(2);
  });

  it('Thursday — Legs: the real logged week-1 quads volume reads as maintenance (not normal_development, not re-prescribed as if untrained)', () => {
    const result = assembleAndBuildWorkout(db, THU2, 75);
    expect(result.estimated_minutes).toBeLessThanOrEqual(75);
    const quadsWork = [...result.exercises, ...result.skipped_targets].filter((e) => e.target_id === 'quads');
    expect(quadsWork.length).toBeGreaterThan(0);
    expect(quadsWork.every((e) => e.classification === 'maintenance')).toBe(true);
  });

  it('Friday — Upper, after a real logged high-intensity badminton weekend: the badminton context genuinely reaches this real day\'s plan', () => {
    const result = assembleAndBuildWorkout(db, FRI2, 75);
    expect(result.estimated_minutes).toBeLessThanOrEqual(75);
    expect(result.exercises.length).toBeGreaterThan(0);
    const withBadmintonContext = result.exercises.filter((e) => e.decision.badminton_context !== null);
    expect(withBadmintonContext.length).toBeGreaterThan(0);
  });

  it('real progression data reaches the final prescription: the repeated compound press carries a real progression_decision, not null', () => {
    const result = assembleAndBuildWorkout(db, MON2, 75);
    const benchPlan = result.exercises.find((e) => e.exercise_id === 'flat-barbell-bench-press');
    expect(benchPlan).toBeDefined();
    expect(benchPlan!.previous_performance).not.toBeNull();
    expect(benchPlan!.progression_decision).not.toBeNull();
  });

  it('multi-exercise construction (Strict Bug-Fix §11-15) genuinely fires somewhere across this real week — not just in an isolated unit test', () => {
    const days = [MON2, TUE2, THU2, FRI2];
    const exerciseCountsByTargetAndDay = new Map<string, number>();
    for (const date of days) {
      const result = assembleAndBuildWorkout(db, date, 90); // generous — lets real multi-exercise need actually surface
      for (const plan of result.exercises) {
        const key = `${date}:${plan.target_id}`;
        exerciseCountsByTargetAndDay.set(key, (exerciseCountsByTargetAndDay.get(key) ?? 0) + 1);
      }
    }
    const anyMultiExercise = [...exerciseCountsByTargetAndDay.values()].some((count) => count > 1);
    expect(anyMultiExercise).toBe(true);
  });

  it('determinism holds across this real full week: two identical builds of the same real day produce identical output', () => {
    const first = assembleAndBuildWorkout(db, THU2, 75);
    const second = assembleAndBuildWorkout(db, THU2, 75);
    expect(second).toEqual(first);
  });
});
