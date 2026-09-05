// UI Build Phase §47/§55: the required read-only programming API. Every
// route here only READS already-real state and calls the EXISTING,
// frozen engine (src/engine/workoutBuilder.ts) — it never recomputes,
// re-derives, or duplicates a programming decision. The only work done
// in this file beyond that is: (a) resolving a Blueprint id to its
// display name (the same kind of lookup src/engine/explanationEngine.ts
// already does), and (b) reading real, already-stored state (logged
// WorkoutSessions, the user's own TrainingProfile.other_activity_schedule,
// each Goal's own user-set priority) to label a day/target/goal for
// display. None of that is a programming decision — it is presentation
// of decisions the engine (or the user, for goal priority) already made.

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import {
  assembleWeeklyPlanInput,
  buildWeeklyProgrammingPlan,
  programmingWeekStart,
  type TargetBuildContext,
  type WeeklyPlanTargetAllocation,
} from '../../engine/workoutBuilder.js';
import { exercisesTrainingTarget } from '../../engine/exerciseSelector.js';
import { filterEquipmentFeasible } from '../../engine/constraintEngine.js';
import { addDays } from '../../engine/dateMath.js';
import { DAILY_ACTIVITIES, WEEKDAYS, type BlueprintId, type DailyActivity, type RecurringActivity, type TrainingProfile, type Weekday } from '../../contracts/types.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import type { TargetType } from '../../engine/goalResolver.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { OutsideBlueprintExercisesRepo } from '../../repositories/outsideBlueprintExercisesRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import type { PersistedWeekProgram } from '../../repositories/weeklyProgramRepo.js';
import { ensureWeekProgramGenerated, reconcileWeekProgram, type FreshDayInput } from '../../engine/weekProgramReconciliation.js';
import { todayForUser } from '../../lib/userTimezone.js';

export const programmingRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

function resolveExerciseName(exerciseId: BlueprintId): string {
  return BlueprintAdapter.getExercise(exerciseId)?.name ?? exerciseId;
}

function resolveTargetName(targetType: TargetType, targetId: BlueprintId): string {
  const resolved = targetType === 'physique_target' ? BlueprintAdapter.getTarget(targetId) : BlueprintAdapter.getFunctionalGoal(targetId);
  return resolved?.name ?? targetId;
}

function targetKey(t: { target_type: TargetType; target_id: BlueprintId }): string {
  return `${t.target_type}:${t.target_id}`;
}

/** Every active goal (aesthetic or functional), sorted by the user's own
 * real `priority` field ascending — "Goal 1" is simply position 1 in
 * that real, user-controlled ranking (spec §16/§19/§20's "Goal 1/Goal
 * 2 must be visibly distinct"), never a value this route invents. */
function goalLabels(database: Database.Database): Map<string, string> {
  const goals = new GoalsRepo(database).list({ active: true }).sort((a, b) => a.priority - b.priority);
  return new Map(goals.map((g, i) => [g.id, `Goal ${i + 1}`]));
}

/** Real per-real-gym-day status, from actually-logged WorkoutSessions —
 * never inferred from the generated plan itself (a generated plan says
 * what SHOULD happen; only a real WorkoutSession row says what actually
 * did). */
function realSessionStatus(database: Database.Database, date: string): 'planned' | 'in_progress' | 'completed' {
  const logged = new WorkoutSessionsRepo(database).listSessionsByDate(date);
  if (logged.some((s) => s.status === 'completed')) return 'completed';
  if (logged.some((s) => s.status === 'in_progress')) return 'in_progress';
  return 'planned';
}

/** The real recurring-activity type for a non-gym day, straight from the
 * user's own TrainingProfile.other_activity_schedule — 'rest' only when
 * no real recurring activity is recorded for that weekday (spec §41:
 * never assume badminton is the only possible activity). */
function nonGymDayType(weekday: Weekday, otherActivitySchedule: ReadonlyArray<{ day: Weekday; activity_type: string }>): string {
  const activity = otherActivitySchedule.find((a) => a.day === weekday);
  return activity?.activity_type ?? 'rest';
}

type TargetGoalMap = Map<string, { goal_id: string; is_specialization: boolean }>;

function resolveGoalLabelAndId(
  key: string,
  classification: 'specialization' | 'normal_development' | 'maintenance',
  targetGoalMap: TargetGoalMap,
  labels: Map<string, string>
): { goal_id: string | null; goal_label: string | null } {
  const own = targetGoalMap.get(key);
  if (own && own.is_specialization) {
    return { goal_id: own.goal_id, goal_label: labels.get(own.goal_id) ?? null };
  }
  // The synthetic normal-development/maintenance bucket
  // (`__normal_development_or_maintenance__`) is not a real user Goal id.
  return { goal_id: null, goal_label: classification === 'normal_development' ? 'Normal development' : classification === 'maintenance' ? 'Maintenance' : null };
}

function enrichAllocation(allocation: WeeklyPlanTargetAllocation, targetGoalMap: TargetGoalMap, labels: Map<string, string>) {
  const { goal_id, goal_label } = resolveGoalLabelAndId(targetKey(allocation), allocation.layer, targetGoalMap, labels);
  return { ...allocation, target_name: resolveTargetName(allocation.target_type, allocation.target_id), goal_id, goal_label };
}

function enrichPlannedWork<T extends { exercise_id: BlueprintId; target_type: TargetType; target_id: BlueprintId; classification: 'specialization' | 'normal_development' | 'maintenance' }>(
  work: T,
  targetGoalMap?: TargetGoalMap,
  labels?: Map<string, string>
) {
  const goalInfo = targetGoalMap && labels ? resolveGoalLabelAndId(targetKey(work), work.classification, targetGoalMap, labels) : { goal_id: null, goal_label: null };
  return { ...work, exercise_name: resolveExerciseName(work.exercise_id), target_name: resolveTargetName(work.target_type, work.target_id), ...goalInfo };
}

/** Final Current-Week Reconciliation Fix §17: /today's `exercises` field
 * has always used `target_sets`/`target_reps_min`/`target_reps_max`/
 * `target_rir_min`/`target_rir_max` (workoutBuilder.ts's
 * `PlannedExercise` field names), while /week's `plannedWork` uses
 * `sets`/`reps_min`/`reps_max`/`rir_min`/`rir_max`
 * (`PlannedWorkItem`'s) — both describe the identical prescription, a
 * pre-existing naming difference between two independently-built
 * response shapes. Now that /today reads the SAME persisted
 * `plannedWork` /week uses (spec §17), this translates only the field
 * names for /today's response, preserving the exact contract
 * `public/logger.html` already depends on (`g.target_sets`,
 * `g.target_reps_min`, `g.target_reps_max`) — /week's own shape is
 * never touched. */
function toTodayExerciseShape(item: ReturnType<typeof enrichPlannedWork>) {
  const { sets, reps_min, reps_max, rir_min, rir_max, ...rest } = item as unknown as {
    sets: number;
    reps_min: number;
    reps_max: number;
    rir_min: number;
    rir_max: number;
  };
  return { ...rest, target_sets: sets, target_reps_min: reps_min, target_reps_max: reps_max, target_rir_min: rir_min, target_rir_max: rir_max };
}

function defaultBudgetMinutes(database: Database.Database): number {
  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  return profile?.default_session_duration_minutes ?? 60;
}

/** Current-Week Reconciliation Fix §4/§5: the real Gym/Badminton/Both/
 * Unselected activity for every day of `weekStart`'s week — the
 * recurring TrainingProfile default with that week's own overrides (if
 * any) layered on top, via the exact same pure `applyWeekOverrides`
 * `assembleWeeklyPlanInput` already used to decide THIS week's real
 * eligible gym days. Reusing it here (rather than reading `input`'s own
 * `available_training_days`/`recurring_badminton_days`, which only
 * carry Weekday[] membership, not the full RecurringActivity shape
 * `nonGymDayType` needs for its generic non-badminton fallback) is a
 * second, cheap, harmless read against the same unchanged DB state
 * within one request — never a second inference mechanism, matching
 * this file's existing "goalInput" pattern in /today below. */
function effectiveWeekActivity(
  database: Database.Database,
  profile: TrainingProfile | undefined,
  weekStart: string
): { trainingDays: Weekday[]; otherActivitySchedule: RecurringActivity[] } {
  if (!profile) return { trainingDays: [], otherActivitySchedule: [] };
  const overrides = new WeekActivityOverridesRepo(database).get(profile.id, weekStart);
  return applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
}

/** Final Current-Week Reconciliation Fix §4/§20: runs the UNMODIFIED
 * planner exactly once and shapes every one of the week's 7 days into
 * the input `weekProgramReconciliation.ts` needs to persist/diff them —
 * this is the ONLY function in this file that calls the planner. Every
 * other read path (a `/week` or `/today` call against an
 * already-persisted week) never reaches this function at all (spec
 * §18: a plain GET must not blindly regenerate). */
function computeFreshWeek(database: Database.Database, weekStart: string, budgetMinutes: number): { days: FreshDayInput[]; aggregates: { activeGoals: unknown; targetAllocations: unknown } } {
  const input = assembleWeeklyPlanInput(database, weekStart, budgetMinutes);
  const plan = buildWeeklyProgrammingPlan(input);

  const targetGoalMap = new Map<string, { goal_id: string; is_specialization: boolean }>(
    input.targets.map((t: TargetBuildContext) => [targetKey(t), { goal_id: t.goal_id, is_specialization: t.is_specialization }])
  );
  const labels = goalLabels(database);
  const sessionsByDate = new Map(plan.sessions.map((s) => [s.date, s]));

  const days: FreshDayInput[] = WEEKDAYS.map((weekday, i) => {
    const dayDate = addDays(plan.weekStart, i);
    const gymSession = sessionsByDate.get(dayDate);
    if (!gymSession) {
      return { dayIndex: i, date: dayDate, hasGymComponent: false, sessionPurpose: null, snapshot: { plannedWork: [] } };
    }
    const plannedWork = gymSession.plannedWork.map((w) => enrichPlannedWork(w, targetGoalMap, labels));
    return {
      dayIndex: i,
      date: dayDate,
      hasGymComponent: true,
      sessionPurpose: gymSession.sessionPurpose,
      snapshot: {
        sessionPurpose: gymSession.sessionPurpose,
        availableMinutes: gymSession.availableMinutes,
        estimatedMinutes: gymSession.estimatedMinutes,
        plannedWork,
        skipped: gymSession.skipped,
        badmintonContext: gymSession.badmintonContext,
        resourceAllocation: gymSession.resourceAllocation,
      },
    };
  });

  return {
    days,
    aggregates: {
      activeGoals: plan.sessions[0]?.activeGoals ?? [],
      targetAllocations: plan.targetAllocations.map((a) => enrichAllocation(a, targetGoalMap, labels)),
    },
  };
}

/** Builds every one of the week's 7 day objects PURELY from the
 * persisted program — gym/both days from their persisted snapshot, all
 * days' `type`/`activity`/`status` derived live (cheap — no planner
 * call, and these must always reflect the CURRENT profile/override/
 * logged-session state, never a frozen-at-generation-time value). This
 * is the read path a plain `GET /week` or `GET /today` actually uses. */
function renderWeekDays(database: Database.Database, weekStart: string, program: PersistedWeekProgram, profile: TrainingProfile | undefined) {
  const effective = effectiveWeekActivity(database, profile, weekStart);
  return WEEKDAYS.map((weekday, i) => {
    const dayDate = addDays(weekStart, i);
    const activity = deriveDailyActivity(weekday, effective.trainingDays, effective.otherActivitySchedule);
    const persisted = program.sessions.find((s) => s.day_index === i);
    if (persisted) {
      const snap = persisted.snapshot as {
        sessionPurpose: unknown;
        availableMinutes: number;
        estimatedMinutes: number;
        plannedWork: ReturnType<typeof enrichPlannedWork>[];
        skipped: unknown;
        badmintonContext: unknown;
        resourceAllocation: unknown;
      };
      return {
        date: dayDate,
        weekday,
        type: 'gym' as const,
        activity,
        status: realSessionStatus(database, dayDate),
        sessionPurpose: snap.sessionPurpose,
        availableMinutes: snap.availableMinutes,
        estimatedMinutes: snap.estimatedMinutes,
        plannedWork: snap.plannedWork,
        skipped: snap.skipped,
        badmintonContext: snap.badmintonContext,
        resourceAllocation: snap.resourceAllocation,
      };
    }
    return {
      date: dayDate,
      weekday,
      type: nonGymDayType(weekday, effective.otherActivitySchedule),
      activity,
      status: 'rest' as const,
      sessionPurpose: null,
      availableMinutes: 0,
      estimatedMinutes: 0,
      plannedWork: [] as ReturnType<typeof enrichPlannedWork>[],
      skipped: [],
      badmintonContext: null,
      resourceAllocation: [],
    };
  });
}

function buildWeekResponse(database: Database.Database, weekStart: string, program: PersistedWeekProgram, profile: TrainingProfile | undefined) {
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    days: renderWeekDays(database, weekStart, program, profile),
    targetAllocations: program.target_allocations ?? [],
    activeGoals: program.active_goals ?? [],
  };
}

// GET /api/programming/week — the complete real weekly plan (spec §47/§48).
// One call renders the whole week; never seven separate programming
// requests (spec §49). Final Current-Week Reconciliation Fix §18: reads
// the PERSISTED plan — only ever calls the planner (via
// ensureWeekProgramGenerated -> computeFreshWeek) the first time this
// specific week has ever been requested; every later call is a pure
// read, so repeated GETs never regenerate/change anything by themselves.
programmingRouter.get('/week', (req, res) => {
  const database = db(req);
  const date = typeof req.query.date === 'string' ? req.query.date : todayForUser(database);
  const budgetMinutes = defaultBudgetMinutes(database);
  const weekStart = programmingWeekStart(date);

  const program = ensureWeekProgramGenerated(database, weekStart, () => computeFreshWeek(database, weekStart, budgetMinutes));

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  res.json(buildWeekResponse(database, weekStart, program, profile));
});

// PUT /api/programming/week/days/:day/activity — Current-Week
// Reconciliation Fix §11/§19: change ONE day's activity for the CURRENT
// week only. Never touches the recurring TrainingProfile (see
// WeekActivityOverridesRepo's own doc comment). Unlike a plain GET, this
// ALWAYS recomputes via the planner (it has to, to know what changed)
// and then reconciles — writing only the days that actually need to
// change (spec §6/§20), never blindly replacing the whole persisted
// week.
programmingRouter.put('/week/days/:day/activity', (req, res) => {
  const database = db(req);
  const day = req.params.day;
  if (!WEEKDAYS.includes(day as Weekday)) {
    return res.status(400).json({ error: `day must be one of ${WEEKDAYS.join('|')}` });
  }
  const { activity } = req.body ?? {};
  if (!DAILY_ACTIVITIES.includes(activity)) {
    return res.status(400).json({ error: `activity must be one of ${DAILY_ACTIVITIES.join('|')}` });
  }

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  if (!profile) {
    return res.status(404).json({ error: 'No training profile exists for this user yet — create one first (PUT /api/training-profile)' });
  }

  const date = todayForUser(database);
  const weekStart = programmingWeekStart(date);
  new WeekActivityOverridesRepo(database).setOverride(profile.id, weekStart, day as Weekday, activity as DailyActivity);

  const budgetMinutes = defaultBudgetMinutes(database);
  const { days, aggregates } = computeFreshWeek(database, weekStart, budgetMinutes);
  const program = reconcileWeekProgram(database, weekStart, days, aggregates);

  res.json(buildWeekResponse(database, weekStart, program, profile));
});

// GET /api/programming/today — today's own real slice of the SAME
// PERSISTED weekly plan /week reads (spec §17/§47/§58): built from the
// identical `buildWeekResponse`/`renderWeekDays` this file's /week route
// uses, sliced to `date`'s own day — never a second, independently
// reconstructed computation, so the two can never disagree (spec §17's
// explicit "must not independently reconstruct a contradictory
// version"). Like /week, this only ever calls the planner
// (ensureWeekProgramGenerated -> computeFreshWeek) the first time this
// week has been requested; a normal read is a pure, cheap lookup.
programmingRouter.get('/today', (req, res) => {
  const database = db(req);
  const date = typeof req.query.date === 'string' ? req.query.date : todayForUser(database);
  const budgetMinutes = defaultBudgetMinutes(database);
  const weekStart = programmingWeekStart(date);

  const program = ensureWeekProgramGenerated(database, weekStart, () => computeFreshWeek(database, weekStart, budgetMinutes));

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  const week = buildWeekResponse(database, weekStart, program, profile);
  const today = week.days.find((d) => d.date === date)!;

  const status = realSessionStatus(database, date);
  const loggedSessions = new WorkoutSessionsRepo(database).listSessionsByDate(date);

  // Real active_goals only carries goal_id/priority/trend (the engine
  // has no reason to track goal_type at that layer) — resolved here
  // straight from the real Goal row so a caller (e.g. "Start workout")
  // can build a real, correctly-typed GoalContext without guessing.
  const goalsRepo = new GoalsRepo(database);
  const activeGoals = (week.activeGoals as Array<{ goal_id: string; priority: number; trend: unknown }>).map((g) => ({
    ...g,
    goal_type: goalsRepo.get(g.goal_id)?.goal_type ?? 'aesthetic',
  }));

  res.json({
    date: today.date,
    weekday: today.weekday,
    sessionPurpose: today.sessionPurpose,
    sessionType: today.type,
    activity: today.activity,
    status: loggedSessions.length > 0 ? status : 'planned',
    exercises: today.plannedWork.map(toTodayExerciseShape),
    estimatedMinutes: today.estimatedMinutes,
    skippedTargets: today.skipped,
    activeGoals,
    resourceAllocation: today.resourceAllocation,
    // Remediation §16's "equipment/time constraints" — trivial inputs,
    // never derived from exercise selection, so no planner call is
    // needed to reconstruct this.
    constraints: { available_equipment: profile?.available_equipment ?? [], budget_minutes: budgetMinutes },
    loggedSessions,
  });
});

// GET /api/programming/substitutes?target_type=&target_id= — spec §29's
// real substitution candidate list: Blueprint-approved candidates for
// this exact target first, then any approved outside-Blueprint
// candidates — both filtered by the user's own real available equipment
// (TrainingProfile), reusing the exact same functions the engine itself
// uses to gather a target's candidate pool
// (exercisesTrainingTarget/filterEquipmentFeasible/
// listApprovedForTarget). Never a second, browser-side selection
// algorithm.
programmingRouter.get('/substitutes', (req, res) => {
  const database = db(req);
  const targetType = req.query.target_type;
  const targetId = req.query.target_id;
  if ((targetType !== 'physique_target' && targetType !== 'functional_goal') || typeof targetId !== 'string' || !targetId) {
    return res.status(400).json({ error: 'target_type ("physique_target" | "functional_goal") and target_id are required' });
  }

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  const availableEquipment = profile?.available_equipment ?? [];

  const blueprintIds = exercisesTrainingTarget(targetType, targetId);
  const blueprintCandidates = filterEquipmentFeasible(
    blueprintIds.map((id) => BlueprintAdapter.getExercise(id)).filter((e): e is NonNullable<typeof e> => !!e),
    availableEquipment
  ).map((e) => ({ id: e.id, name: e.name, equipment: e.equipment }));

  const outsideApproved = new OutsideBlueprintExercisesRepo(database).listApprovedForTarget(targetType, targetId);
  const outsideCandidates = filterEquipmentFeasible(outsideApproved, availableEquipment).map((e) => ({ id: e.id, name: e.name, equipment: e.equipment }));

  res.json({ blueprint: blueprintCandidates, outsideBlueprint: outsideCandidates });
});
