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
    // Equipment Filter Fix: equipment is never an elimination rule
    // during generation, so restricting available_equipment can no
    // longer isolate close-grip-bench-press as the sole candidate —
    // current_exercise_id (Gate 5 — progression continuity) is what
    // keeps it, the exercise with the real declining history, as the
    // winner here. Consolidated Fix §7: session time no longer has any
    // effect on generation, so the real remaining 1 set (after this
    // exercise's own progression-driven reduction) is now genuinely
    // picked up by a second real candidate from the same triceps pool
    // (cable-pushdown/overhead-triceps-extension) rather than being left
    // unmet by time-fitting — this test group's real subject, the
    // requested-vs-delivered accounting on the FIRST (reduced) exercise,
    // is unaffected by that.
    const target = normalDevTarget('triceps', {
      current_weekly_primary_sets: 3, // 'maintain' path (nonzero) — desiredWeekly = 3, fully controlled
      weekly_exposure_units: 3,
      current_exercise_id: 'close-grip-bench-press',
      exercise_history: { 'close-grip-bench-press': decliningHistory },
    });
    return buildWeeklyProgrammingPlan(weeklyInput({ todayBudgetMinutes: 7, defaultSessionMinutes: 7, targets: [target] }));
  }

  it('Test 1: targetAllocations is rebuilt from the FINAL sessions — the reduced first exercise plus a genuine second exercise fully deliver requiredDirectSets(3), with no contradiction against the real session', () => {
    const plan = buildReducedPlan();
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    // Consolidated Fix §7: with no time-fitting to drop it, a real
    // second candidate now picks up the 1 set the first exercise's own
    // progression reduction left remaining.
    expect(tricepsWork).toHaveLength(2);
    expect(tricepsWork[0]!.sets).toBe(2); // the real, final, progression-reduced number
    expect(tricepsWork[1]!.sets).toBe(1); // the real remaining need, capped at its own authored sets

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.requiredDirectSets).toBe(3);
    expect(allocation.deliveredDirectSets).toBe(3);
    // No contradiction: the allocation's own deliveredDirectSets equals
    // exactly what the real session actually contains — never a
    // separate, disagreeing "planned" total.
    expect(allocation.deliveredDirectSets).toBe(tricepsWork.reduce((sum, w) => sum + w.sets, 0));
  });

  it('Test 2: undelivered sets are never consumed — the FIRST exercise\'s own remaining need decreases by the delivered 2, not the requested 3 (a second real exercise then covers the rest)', () => {
    const plan = buildReducedPlan();
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    expect(tricepsWork[0]!.sets).toBe(2);
    expect(tricepsWork[0]!.reasoning).toContain('requested 3, delivered 2');
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    // The 1 real set the first exercise's reduction left behind is
    // never silently written off — Consolidated Fix §7 means it's
    // picked up by a second real exercise instead of being dropped by
    // time-fitting, so the week's real need ends up fully met.
    expect(allocation.unmetDirectSets).toBe(0);
  });

  it('Test 3: progression-driven reduction — 3 requested / 2 delivered on the first exercise, distinct requiredDirectSets/deliveredDirectSets/unmetDirectSets fields (never one field standing in for both)', () => {
    const plan = buildReducedPlan();
    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    expect(tricepsWork[0]!.progression_decision?.recommendation).toBe('reduce');
    expect(tricepsWork[0]!.sets).toBe(2);

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.requiredDirectSets).toBe(3);
    expect(allocation.deliveredDirectSets).toBe(3);
    expect(allocation.unmetDirectSets).toBe(0);
  });
});

describe('Consolidated Fix §7/§15.C: session time availability has ZERO effect on normal generation (supersedes the former Fix-B time-fitting test)', () => {
  it('a tight session time budget drops nothing — every candidate construction decided on survives, delivered equals required, no time-fitting skip is ever created', () => {
    // Full equipment, only one real gym day this week (see weeklyInput's
    // own default `available_training_days: ['monday']`) — desiredWeekly
    // =5 (via 'maintain', current_weekly_primary_sets=5) is delivered
    // via real Gate-1-6 selection across as many real triceps candidates
    // as it takes, each capped at its own authored per-session sets.
    const target = normalDevTarget('triceps', { current_weekly_primary_sets: 5, weekly_exposure_units: 5 });
    // A 7-minute budget would have dropped some of these candidates
    // under the old time-fitting mechanism. Consolidated Fix §7: this
    // budget must have zero effect — every real candidate construction
    // decided on is placed in full.
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ todayBudgetMinutes: 7, defaultSessionMinutes: 7, targets: [target] }));

    const monday = plan.sessions.find((s) => s.date === '2026-08-31')!;
    const tricepsWork = monday.plannedWork.filter((w) => w.target_id === 'triceps');
    // Every one of construction's own exercises survives — nothing
    // dropped for time — and each stays within its own authored cap
    // (2, 2, 1 — the last capped by remaining need, not its own higher
    // authored ceiling).
    expect(tricepsWork.length).toBeGreaterThanOrEqual(2);
    const deliveredSets = tricepsWork.reduce((sum, w) => sum + w.sets, 0);
    expect(deliveredSets).toBe(5);
    // The session's own estimated minutes may genuinely exceed the
    // nominal budget — informational only, never a filter (§7).
    expect(monday.estimatedMinutes).toBeGreaterThan(7);

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    expect(allocation.requiredDirectSets).toBe(5);
    expect(allocation.deliveredDirectSets).toBe(5); // fully delivered — time never reduced it
    expect(allocation.unmetDirectSets).toBe(0);

    // No time-fitting skip is ever created (spec §7/§9/§15.C).
    const droppedForTime = monday.skipped.find((s) => s.reason.includes('time-fitting'));
    expect(droppedForTime).toBeUndefined();
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
    // Programming Redesign (Step 12) §3-§5: front-delt's own real
    // Blueprint Efficient package reference (shoulders-efficient: 2
    // sessions/week x (3+2+2) sets = 14/week), not the old universal
    // starting_point_sets[0] (8) — front-delt's own as-of-weekStart real
    // exposure already sits at that reference, representing real
    // logged/planned exposure from elsewhere in the week, not a value
    // this pipeline invents. current_weekly_primary_sets stays 0 (no
    // direct sets of its own), which is exactly the condition the
    // "already adequately exposed" gate reads.
    const target = normalDevTarget('front-delt', { current_weekly_primary_sets: 0, weekly_exposure_units: 14 });
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
    // mid-pec (specialization, priority 1, processed first). Consolidated
    // Fix §3/§15.B: a single session can no longer deliver an inflated
    // 50 sets by cramming the overflow into one exercise once its real
    // candidate pool is exhausted — desiredWeekly=50 now genuinely
    // delivers only whatever its real distinct candidates' own authored
    // per-session caps sum to (here: 2 real exercises), with the rest
    // honestly unmet, never crammed. front-delt's own baseline
    // weekly_exposure_units below represents real exposure it already
    // has from elsewhere this week (e.g. other compound work already
    // logged/planned) — completely legitimate per this app's own
    // "compound secondary exposure counts even when direct sets = 0"
    // rule — chosen so that ADDING mid-pec's real (now much smaller,
    // correctly-capped) secondary contribution is what tips it over its
    // own real Blueprint Efficient package reference (Programming
    // Redesign Step 12 §3-§5: shoulders-efficient, 14/week — not the old
    // universal starting_point_sets[0] of 8). The expected front-delt
    // exposure figure is recomputed below from whichever real mid-pec
    // exercises actually got placed (never a hardcoded number tied to
    // one specific exercise) — this still proves the same thing: the
    // reasoning cites the real computed exposure figure, never a
    // fabricated one.
    const midPec = normalDevTarget('mid-pec', {
      is_specialization: true,
      goal_id: 'goal_1',
      goal_priority: 1,
      tier: 'primary',
      current_weekly_primary_sets: 50,
      weekly_exposure_units: 50,
    });
    const frontDelt = normalDevTarget('front-delt', { current_weekly_primary_sets: 0, weekly_exposure_units: 13.5 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ targets: [midPec, frontDelt] }));

    // front-delt received no direct work of its own this week — the
    // real propagated exposure (never a static zero) already satisfied
    // Blueprint's own threshold.
    expect(plan.sessions.every((s) => s.plannedWork.every((w) => w.target_id !== 'front-delt'))).toBe(true);
    const skip = plan.sessions.flatMap((s) => s.skipped).find((sk) => sk.target_id === 'front-delt');
    expect(skip).toBeDefined();

    const midPecWork = plan.sessions.flatMap((s) => s.plannedWork).filter((w) => w.target_id === 'mid-pec');
    expect(midPecWork.length).toBeGreaterThan(0);
    const midPecContribution = midPecWork.reduce((sum, w) => {
      const { contributions } = calculateExerciseExposure(
        w.exercise_id,
        Array.from({ length: w.sets }, () => ({ completed: true }))
      );
      return sum + (contributions.find((c) => c.target_id === 'front-delt')?.exposure_units ?? 0);
    }, 0);
    // front-delt's real baseline (its own weekly_exposure_units, set
    // above) plus mid-pec's real planned contribution — recomputed
    // independently here from the real placed exercises — never an
    // invented "1.32 sets" style conversion. The reasoning cites this
    // real total, not the mid-pec contribution alone.
    const expectedTotalExposure = frontDelt.weekly_exposure_units + midPecContribution;
    expect(skip!.reason).toContain(expectedTotalExposure.toFixed(2));
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
