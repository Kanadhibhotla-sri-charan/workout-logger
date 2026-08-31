// Final Core-Engine Surgical Fix Pass §21 — the 13 required regression
// tests, exercising the real production weekly-programming path
// (buildWeeklyProgrammingPlan / assembleWeeklyProgrammingPlan /
// assembleAndBuildWorkout), never just an isolated helper function.
//
// Fix A: targetAllocations is rebuilt from the FINAL, post-fitting
// sessions[].plannedWork — never a pre-fitting construction-time total
// (Tests 1, 8).
// Fix B: only DELIVERED sets are ever charged against a target's
// remaining weekly need — an undelivered set stays available, never
// silently consumed (Tests 2, 3, 4).
// Fix C: Blueprint's own development-package exercise COUNT is no
// longer the hard ceiling on how many exercises a target can use — real
// remaining need and real candidate availability are (Tests 5, 6, 7, 8).
// Production-path assertions (Tests 9-13): real bench-press exposure
// math, the whole real weekly plan with today as a real slice of it,
// the Monday rule, priority, and determinism.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import {
  assembleAndBuildWorkout,
  assembleWeeklyProgrammingPlan,
  buildWeeklyProgrammingPlan,
  type TargetBuildContext,
  type WeeklyPlanInput,
} from '../../src/engine/workoutBuilder.js';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BadmintonSessionDetailsRepo } from '../../src/repositories/badmintonSessionDetailsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
// triceps-efficient's real Blueprint package (src/blueprint/snapshot/
// programming.json): close-grip-bench-press needs barbell + smith
// machine only; cable-pushdown needs cable; overhead-triceps-extension
// needs barbell + ez-bar + dumbbell. Restricting available_equipment to
// just barbell + smith machine leaves close-grip-bench-press as the
// ONLY real candidate for the "triceps" target — a deterministic,
// single-candidate scenario for the requested-vs-delivered tests below.
const SINGLE_TRICEPS_CANDIDATE_EQUIPMENT = ['barbell', 'smith machine'];

function normalDevTarget(targetId: string, overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return {
    target_type: 'physique_target',
    target_id: targetId,
    tier: 'supporting',
    is_specialization: false,
    goal_id: '__normal_development_or_maintenance__',
    goal_priority: 1000,
    current_weekly_primary_sets: 0,
    weekly_secondary_sets: 0,
    weekly_exposure_units: 0,
    rolling_exposure_units: 0,
    rolling_window_days: 14,
    most_recent_assessment: null,
    review_cadence_days: 28,
    days_since_target_last_trained: null,
    last_trained_date: null,
    recent_badminton: null,
    recent_exercise_ids: [],
    current_exercise_id: null,
    exercise_history: {},
    outside_blueprint_exercises: [],
    ...overrides,
  };
}

function weeklyInput(overrides: Partial<WeeklyPlanInput> = {}): WeeklyPlanInput {
  return {
    weekStart: '2026-08-31',
    today: '2026-08-31',
    todayWeekday: 'monday',
    todayBudgetMinutes: 300,
    defaultSessionMinutes: 300,
    available_equipment: FULL_EQUIPMENT,
    available_training_days: ['monday'],
    targets: [],
    ...overrides,
  };
}

describe('Tests 1-3 — Fix A (final sessions authoritative) + Fix B (delivered, not requested, is charged) via a real progression-driven reduction', () => {
  // close-grip-bench-press's own Blueprint prescription is reps "6-12"
  // (target_reps_min=6) — three consecutive real logged sessions all
  // falling short of 6 reps is a genuine RECOVERY_THRESHOLDS
  // .consecutiveDecliningSessions=3 decline pattern, so
  // progressionEngine.computeProgression really returns 'reduce' (never
  // fabricated for the test).
  const decliningHistory = [
    { date: '2026-08-24', sets: [{ weight: 60, reps: 4, completed: true, rir: 2 }] },
    { date: '2026-08-17', sets: [{ weight: 60, reps: 4, completed: true, rir: 2 }] },
    { date: '2026-08-10', sets: [{ weight: 60, reps: 4, completed: true, rir: 2 }] },
  ];

  function buildReducedPlan() {
    const target = normalDevTarget('triceps', {
      current_weekly_primary_sets: 3, // 'maintain' path (nonzero) — desiredWeekly = 3, fully controlled
      weekly_exposure_units: 3,
      exercise_history: { 'close-grip-bench-press': decliningHistory },
    });
    return buildWeeklyProgrammingPlan(weeklyInput({ available_equipment: SINGLE_TRICEPS_CANDIDATE_EQUIPMENT, targets: [target] }));
  }

  it('Test 1: targetAllocations is rebuilt from the FINAL fitted sessions — requiredDirectSets(3) > deliveredDirectSets(2), with no contradiction against the real session', () => {
    const plan = buildReducedPlan();
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    expect(tricepsWork).toHaveLength(1);
    expect(tricepsWork[0]!.sets).toBe(2); // the real, final, post-fitting number

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.requiredDirectSets).toBe(3);
    expect(allocation.deliveredDirectSets).toBe(2);
    // No contradiction: the allocation's own deliveredDirectSets equals
    // exactly what the real session actually contains — never a
    // separate, disagreeing "planned" total.
    expect(allocation.deliveredDirectSets).toBe(tricepsWork.reduce((sum, w) => sum + w.sets, 0));
  });

  it('Test 2: undelivered sets are never consumed — the week\'s remaining need decreases by the delivered 2, not the requested 3', () => {
    const plan = buildReducedPlan();
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.find((w) => w.target_id === 'triceps')!;
    expect(tricepsWork.sets).toBe(2);
    expect(tricepsWork.reasoning).toContain('requested 3, delivered 2');
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    // Required(3) - delivered(2) = exactly 1 real unmet set, never
    // silently written off and never double-subtracted.
    expect(allocation.unmetDirectSets).toBe(1);
  });

  it('Test 3: progression-driven reduction — 3 requested / 2 delivered, unmet=1, distinct requiredDirectSets/deliveredDirectSets/unmetDirectSets fields (never one field standing in for both)', () => {
    const plan = buildReducedPlan();
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.find((w) => w.target_id === 'triceps')!;
    expect(tricepsWork.progression_decision?.recommendation).toBe('reduce');
    expect(tricepsWork.sets).toBe(2);

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.requiredDirectSets).toBe(3);
    expect(allocation.deliveredDirectSets).toBe(2);
    expect(allocation.unmetDirectSets).toBe(1);
  });
});

describe('Test 4 — Fix B applies identically when TIME-FITTING (not progression) is what reduces delivery', () => {
  it('a tight session time budget drops one whole candidate exercise — required stays what construction decided, delivered is exactly what survived fitting, the gap is explicit (never silently redistributed)', () => {
    // Full equipment: triceps' real candidate pool is all 3 real
    // Blueprint package exercises (cable-pushdown 2 sets, close-grip-
    // bench-press 3 sets, overhead-triceps-extension 2 sets — see
    // triceps-efficient in programming.json). desiredWeekly=5 (via
    // 'maintain', current_weekly_primary_sets=5) is naturally satisfied
    // by exactly 2 of them (cable-pushdown + close-grip-bench-press,
    // Gate 6's alphabetical tie-break makes this deterministic), so
    // CONSTRUCTION books 5 real sets across 2 real exercises before any
    // time-fitting ever runs.
    const target = normalDevTarget('triceps', { current_weekly_primary_sets: 5, weekly_exposure_units: 5 });
    // estimateMinutes(2 sets) = 6.5, estimateMinutes(3 sets) = 8.8 — a
    // 7-minute budget fits the first (lower-priority-number, placed
    // first) exercise alone, not both.
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ todayBudgetMinutes: 7, defaultSessionMinutes: 7, targets: [target] }));

    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    // Exactly one of the two constructed exercises survived fitting.
    expect(tricepsWork).toHaveLength(1);
    const deliveredSets = tricepsWork.reduce((sum, w) => sum + w.sets, 0);
    expect(deliveredSets).toBeLessThan(5);
    expect(deliveredSets).toBeGreaterThan(0);

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.requiredDirectSets).toBe(5); // untouched by fitting — what construction actually decided
    expect(allocation.deliveredDirectSets).toBe(deliveredSets); // exactly what survived, never a disagreeing number
    expect(allocation.unmetDirectSets).toBe(5 - deliveredSets); // the real gap, explicit and non-negative

    // The dropped exercise is surfaced, not silently discarded.
    const droppedForTime = monday.skipped.find((s) => s.target_id === 'triceps' && s.reason.includes('time-fitting'));
    expect(droppedForTime).toBeDefined();
  });
});

describe('Tests 5-8 — Fix C: 0/1/multiple exercises governed by real need and real candidate availability, never by Blueprint package exercise COUNT', () => {
  it('Test 5 / Test 8a: ONE exercise fully satisfies the target\'s real need, even though its real Blueprint package has THREE exercises available', () => {
    // Full equipment: all 3 real triceps-efficient candidates are
    // feasible. desiredWeekly=2 (<= the smallest real per-exercise sets
    // figure in the package, 2) means whichever candidate Gate 6 picks
    // first fully satisfies the requirement in one placement.
    const target = normalDevTarget('triceps', { current_weekly_primary_sets: 2, weekly_exposure_units: 2 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target] }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    expect(tricepsWork).toHaveLength(1); // one exercise — never forced to use all 3 package members
    expect(tricepsWork[0]!.sets).toBe(2);
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.deliveredDirectSets).toBe(2);
    expect(allocation.unmetDirectSets).toBe(0);
  });

  it('Test 6: ZERO exercises — real compound/baseline exposure already at Blueprint\'s own starting threshold means no redundant direct work is added', () => {
    // front-delt's own as-of-weekStart real exposure already sits at
    // Blueprint's own starting_point_sets[0] (8) — this represents real
    // logged/planned exposure from elsewhere in the week, not a value
    // this pipeline invents. current_weekly_primary_sets stays 0 (no
    // direct sets of its own), which is exactly the condition the
    // "already adequately exposed" gate reads.
    const target = normalDevTarget('front-delt', { current_weekly_primary_sets: 0, weekly_exposure_units: 8 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target] }));

    // Zero exercises anywhere in the real week for this target.
    expect(plan.sessions.every((s) => s.plannedWork.every((w) => w.target_id !== 'front-delt'))).toBe(true);
    const skip = plan.sessions.flatMap((s) => s.skipped).find((sk) => sk.target_id === 'front-delt');
    expect(skip?.reason).toContain('adequately exposed');
    // Never required at all (desiredWeekly was never even computed past
    // the skip), so no fabricated zero-required entry either.
    expect(plan.targetAllocations.find((a) => a.target_id === 'front-delt')).toBeUndefined();
  });

  it('Test 7: MULTIPLE exercises — the first candidate alone is insufficient, a second real candidate exists, and the total delivered is correct', () => {
    const target = normalDevTarget('triceps', { current_weekly_primary_sets: 5, weekly_exposure_units: 5 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target] }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    expect(tricepsWork.length).toBeGreaterThanOrEqual(2);
    expect(tricepsWork.reduce((sum, w) => sum + w.sets, 0)).toBe(5);
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.deliveredDirectSets).toBe(5);
    expect(allocation.unmetDirectSets).toBe(0);
  });

  it('Test 8b: real exercise count EXCEEDS the Blueprint package\'s own exercise count (3) when real need and real (Blueprint + approved outside-Blueprint) candidates genuinely justify it', () => {
    // Two approved outside-Blueprint candidates supplement triceps-
    // efficient's 3 real Blueprint members (7 sets total). Gate 3 (goal
    // relevance -> primary role) keeps preferring the 3 real primary-
    // role Blueprint candidates over the secondary-role outside ones
    // for as long as any Blueprint candidate remains (Blueprint-first
    // selection is unchanged) — the outside candidates are only ever
    // reached once all 3 Blueprint candidates are already placed.
    const target = normalDevTarget('triceps', {
      current_weekly_primary_sets: 9,
      weekly_exposure_units: 9,
      outside_blueprint_exercises: [
        { id: 'outside-triceps-a', name: 'Outside Triceps A', role: 'secondary', equipment: [], reps_range: '10-15', rir_range: '1-3' },
        { id: 'outside-triceps-b', name: 'Outside Triceps B', role: 'secondary', equipment: [], reps_range: '10-15', rir_range: '1-3' },
      ],
    });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [target] }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');

    // Blueprint's own triceps-efficient package has exactly 3 exercises
    // — real exercise count here must exceed that, proving package
    // length is no longer the ceiling.
    expect(tricepsWork.length).toBeGreaterThan(3);
    expect(tricepsWork.reduce((sum, w) => sum + w.sets, 0)).toBe(9);
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.deliveredDirectSets).toBe(9);
    expect(allocation.unmetDirectSets).toBe(0);
    // At least one real Blueprint candidate was used before any outside
    // one — Blueprint-first selection, unchanged.
    const blueprintIds = new Set(['cable-pushdown', 'close-grip-bench-press', 'overhead-triceps-extension']);
    expect(tricepsWork.some((w) => blueprintIds.has(w.exercise_id))).toBe(true);
  });
});

describe('Test 9 — real bench-press exposure math, and later programming genuinely accounting for it (never a fabricated direct-set equivalence)', () => {
  it('flat-barbell-bench-press at 4 sets: chest=4.00 primary, triceps=1.32 secondary, front-delt=1.32 secondary — exact Blueprint-grounded exposure coefficients (1.00/0.33), never invented numbers', () => {
    const { contributions } = calculateExerciseExposure('flat-barbell-bench-press', [
      { completed: true },
      { completed: true },
      { completed: true },
      { completed: true },
    ]);
    const chest = contributions.find((c) => c.target_id === 'mid-pec')!;
    const triceps = contributions.find((c) => c.target_id === 'triceps')!;
    const frontDelt = contributions.find((c) => c.target_id === 'front-delt')!;
    expect(chest.role).toBe('primary');
    expect(chest.exposure_units).toBeCloseTo(4.0, 5);
    expect(triceps.role).toBe('secondary');
    expect(triceps.exposure_units).toBeCloseTo(1.32, 5);
    expect(frontDelt.role).toBe('secondary');
    expect(frontDelt.exposure_units).toBeCloseTo(1.32, 5);
  });

  it('later, lower-priority front-delt programming genuinely accounts for mid-pec\'s real planned bench exposure — the real computed number, never a fabricated direct-set equivalence', () => {
    // mid-pec (specialization, priority 1, processed first) restricted
    // to flat-barbell-bench-press only (equipment excludes cable-fly's
    // 'cable'), with enough real desired weekly volume that its own
    // real 0.33/set secondary contribution to front-delt genuinely
    // crosses Blueprint's own starting_point_sets[0]=8 threshold: 25
    // sets * 0.33 = 8.25 >= 8.
    const midPec = normalDevTarget('mid-pec', {
      is_specialization: true,
      goal_id: 'goal_1',
      goal_priority: 1,
      tier: 'primary',
      current_weekly_primary_sets: 25,
      weekly_exposure_units: 25,
    });
    const frontDelt = normalDevTarget('front-delt', { current_weekly_primary_sets: 0, weekly_exposure_units: 0 });
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({ available_equipment: ['barbell', 'bench', 'rack'], targets: [midPec, frontDelt] })
    );

    // front-delt received no direct work of its own this week — the
    // real propagated exposure (never a static zero) already satisfied
    // Blueprint's own threshold.
    expect(plan.sessions.every((s) => s.plannedWork.every((w) => w.target_id !== 'front-delt'))).toBe(true);
    const skip = plan.sessions.flatMap((s) => s.skipped).find((sk) => sk.target_id === 'front-delt');
    expect(skip).toBeDefined();
    // The reasoning cites the real computed exposure figure (25 sets *
    // 0.33/set = 8.25), never an invented "1.32 sets" style conversion.
    expect(skip!.reason).toContain('8.25');
  });
});

describe('Test 10 — the whole real weekly plan, with today a real slice of it (never four independently generated workouts)', () => {
  const MON = '2026-08-31';
  const TUE = '2026-09-01';
  const WED = '2026-09-02';
  const THU = '2026-09-03';
  const FRI = '2026-09-04';
  const SAT = '2026-09-05';
  const SUN = '2026-09-06';
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
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
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 }); // Goal 1 -> mid-pec
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 2 }); // Goal 2 -> brachialis
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const satSession = sessionsRepo.createSession({ date: '2026-08-29', session_type: 'badminton', status: 'completed' }); // real high-intensity Saturday before this week
    new BadmintonSessionDetailsRepo(db).record({ workout_session_id: satSession.session_id, intensity: 'high', format: 'singles', games_count: 3, post_session_fatigue: 5 });
  });

  it('one production call (assembleWeeklyProgrammingPlan) builds Mon Push/Tue Pull/Wed rest/Thu Legs/Fri Upper with Goal1, Goal2, normal-development, maintenance, and badminton all present', () => {
    const plan = assembleWeeklyProgrammingPlan(db, MON, 75);
    expect(plan.weekStart).toBe(MON);
    const byDate = new Map(plan.sessions.map((s) => [s.date, s]));
    expect(byDate.get(MON)?.sessionPurpose).toBe('push');
    expect(byDate.get(TUE)?.sessionPurpose).toBe('pull');
    expect(byDate.has(WED)).toBe(false); // real rest day — no session object at all
    expect(byDate.get(THU)?.sessionPurpose).toBe('legs');
    expect(byDate.get(FRI)?.sessionPurpose).toBe('upper');
    expect(byDate.has(SAT)).toBe(false); // badminton day, not a gym day
    expect(byDate.has(SUN)).toBe(false);

    expect(plan.sessions.some((s) => s.plannedWork.some((w) => w.target_id === 'mid-pec'))).toBe(true); // Goal 1
    expect(plan.sessions.some((s) => s.plannedWork.some((w) => w.target_id === 'brachialis-arm-thickness'))).toBe(true); // Goal 2
    const goalTargetIds = new Set(['mid-pec', 'brachialis-arm-thickness']);
    expect(plan.sessions.some((s) => s.plannedWork.some((w) => !goalTargetIds.has(w.target_id)))).toBe(true); // normal-dev/maintenance, the whole physique
    expect(byDate.get(FRI)?.badmintonContext).not.toBeNull(); // real badminton programming effect
  });

  it("§22: today's own workout (assembleAndBuildWorkout) is the real slice of THIS SAME weekly plan — never an independently re-derived allocation", () => {
    const plan = assembleWeeklyProgrammingPlan(db, MON, 75);
    const workout = assembleAndBuildWorkout(db, MON, 75);
    const mondaySession = plan.sessions.find((s) => s.date === MON)!;
    expect(workout.exercises.map((e) => e.exercise_id).sort()).toEqual(mondaySession.plannedWork.map((w) => w.exercise_id).sort());
    expect(workout.exercises.length).toBe(mondaySession.plannedWork.length);
    for (const exercise of workout.exercises) {
      const sliceItem = mondaySession.plannedWork.find((w) => w.exercise_id === exercise.exercise_id && w.target_id === exercise.target_id)!;
      expect(sliceItem).toBeDefined();
      expect(exercise.target_sets).toBe(sliceItem.sets);
      expect(exercise.reasoning).toBe(sliceItem.reasoning);
    }
  });
});

describe('Test 11 — Monday rule holds in the real weekly plan even under extreme lower-body need', () => {
  it('quads gets zero Monday work despite maximal real need, when Monday is the only gym day this week', () => {
    const quads = normalDevTarget('quads', { current_weekly_primary_sets: 0, weekly_exposure_units: 0 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday'], targets: [quads] }));
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    expect(monday.sessionPurpose).not.toBe('legs');
    expect(monday.plannedWork.some((w) => w.target_id === 'quads')).toBe(false);
  });
});

describe('Test 12 — real programming priority survives into the final weekly plan, never overridden by an alphabetically-earlier id', () => {
  it('higher real need (triceps, id sorts last alphabetically) beats lower real need (front-delt, id sorts first) under a tight time budget', () => {
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({
        todayBudgetMinutes: 10, // tight enough that only the highest-need target's own work fits
        defaultSessionMinutes: 10,
        available_training_days: ['monday'],
        targets: [
          normalDevTarget('triceps', { weekly_exposure_units: 0 }), // highest real need
          normalDevTarget('front-delt', { weekly_exposure_units: 6 }), // lowest real need, id sorts FIRST alphabetically
        ],
      })
    );
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const plannedIds = monday.plannedWork.map((w) => w.target_id);
    expect(plannedIds).toContain('triceps');
    expect(plannedIds).not.toContain('front-delt');
  });
});

describe('Test 13 — determinism', () => {
  it('buildWeeklyProgrammingPlan(context) called twice against identical input produces identical output', () => {
    const input = weeklyInput({
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [normalDevTarget('triceps', { current_weekly_primary_sets: 5, weekly_exposure_units: 5 }), normalDevTarget('front-delt', { current_weekly_primary_sets: 2, weekly_exposure_units: 2 })],
    });
    const planA = buildWeeklyProgrammingPlan(input);
    const planB = buildWeeklyProgrammingPlan(input);
    expect(planB).toEqual(planA);
  });

  it("today's own workout is identical across two identical real production calls against identical stored state", () => {
    const db = openDb(':memory:');
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const workoutA = assembleAndBuildWorkout(db, '2026-08-31', 75);
    const workoutB = assembleAndBuildWorkout(db, '2026-08-31', 75);
    expect(workoutB).toEqual(workoutA);

    const planA = assembleWeeklyProgrammingPlan(db, '2026-08-31', 75);
    const planB = assembleWeeklyProgrammingPlan(db, '2026-08-31', 75);
    expect(planB).toEqual(planA);
  });
});
