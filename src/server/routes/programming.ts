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
  assembleAndBuildWorkout,
  assembleWeeklyPlanInput,
  buildWeeklyProgrammingPlan,
  type TargetBuildContext,
  type WeeklyPlanTargetAllocation,
} from '../../engine/workoutBuilder.js';
import { exercisesTrainingTarget } from '../../engine/exerciseSelector.js';
import { filterEquipmentFeasible } from '../../engine/constraintEngine.js';
import { addDays } from '../../engine/dateMath.js';
import { WEEKDAYS, type BlueprintId, type Weekday } from '../../contracts/types.js';
import { deriveDailyActivity } from '../../lib/dailyActivity.js';
import type { TargetType } from '../../engine/goalResolver.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { OutsideBlueprintExercisesRepo } from '../../repositories/outsideBlueprintExercisesRepo.js';
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

function defaultBudgetMinutes(database: Database.Database): number {
  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  return profile?.default_session_duration_minutes ?? 60;
}

// GET /api/programming/week — the complete real weekly plan (spec §47/§48).
// One call renders the whole week; never seven separate programming
// requests (spec §49).
programmingRouter.get('/week', (req, res) => {
  const database = db(req);
  const date = typeof req.query.date === 'string' ? req.query.date : todayForUser(database);
  const budgetMinutes = defaultBudgetMinutes(database);

  const input = assembleWeeklyPlanInput(database, date, budgetMinutes);
  const plan = buildWeeklyProgrammingPlan(input);

  const targetGoalMap = new Map<string, { goal_id: string; is_specialization: boolean }>(
    input.targets.map((t: TargetBuildContext) => [targetKey(t), { goal_id: t.goal_id, is_specialization: t.is_specialization }])
  );
  const labels = goalLabels(database);

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  const otherActivitySchedule = profile?.other_activity_schedule ?? [];

  const sessionsByDate = new Map(plan.sessions.map((s) => [s.date, s]));
  const days = WEEKDAYS.map((weekday, i) => {
    const dayDate = addDays(plan.weekStart, i);
    // Blueprint Picker/Daily Activity spec §6-§8: the real four-state
    // activity (gym/badminton/both/unselected), additive alongside the
    // existing `type` field (gym/badminton/rest/other) that other code
    // already depends on — `type` never changes meaning here. This is
    // what lets the UI show "Both" for a day that already has both a
    // real gym session (`type: 'gym'`) AND a recurring badminton entry,
    // which `type` alone cannot represent.
    const activity = deriveDailyActivity(weekday, profile?.training_days ?? [], otherActivitySchedule);
    const gymSession = sessionsByDate.get(dayDate);
    if (gymSession) {
      return {
        date: dayDate,
        weekday,
        type: 'gym' as const,
        activity,
        status: realSessionStatus(database, dayDate),
        sessionPurpose: gymSession.sessionPurpose,
        availableMinutes: gymSession.availableMinutes,
        estimatedMinutes: gymSession.estimatedMinutes,
        plannedWork: gymSession.plannedWork.map((w) => enrichPlannedWork(w, targetGoalMap, labels)),
        skipped: gymSession.skipped,
        badmintonContext: gymSession.badmintonContext,
      };
    }
    return {
      date: dayDate,
      weekday,
      type: nonGymDayType(weekday, otherActivitySchedule),
      activity,
      status: 'rest' as const,
      sessionPurpose: null,
      availableMinutes: 0,
      estimatedMinutes: 0,
      plannedWork: [] as ReturnType<typeof enrichPlannedWork>[],
      skipped: [],
      badmintonContext: null,
    };
  });

  res.json({
    weekStart: plan.weekStart,
    weekEnd: addDays(plan.weekStart, 6),
    days,
    targetAllocations: plan.targetAllocations.map((a) => enrichAllocation(a, targetGoalMap, labels)),
    activeGoals: plan.sessions[0]?.activeGoals ?? [],
  });
});

// GET /api/programming/today — today's own real slice of the SAME weekly
// plan (spec §47/§58) — via assembleAndBuildWorkout, the EXISTING
// single-day production path (never a second builder). Deliberately a
// separate code path from /week's buildWeeklyProgrammingPlan call, so
// the two genuinely prove agreement rather than trivially matching a
// single shared in-memory object sliced twice.
programmingRouter.get('/today', (req, res) => {
  const database = db(req);
  const date = typeof req.query.date === 'string' ? req.query.date : todayForUser(database);
  const budgetMinutes = defaultBudgetMinutes(database);

  const result = assembleAndBuildWorkout(database, date, budgetMinutes);
  const status = realSessionStatus(database, date);
  const loggedSessions = new WorkoutSessionsRepo(database).listSessionsByDate(date);

  // Final Surgical Fix Pass §2/§3: gym > activity > rest, using the exact
  // same canonical sources /week already uses — `training_days` decides
  // whether this weekday is a real gym day at all (identical to the
  // condition that puts a session into buildWeeklyProgrammingPlan's own
  // `sessions[]`, so this can never disagree with /week), and
  // `other_activity_schedule` (via the shared `nonGymDayType` helper)
  // supplies the real configured non-gym activity otherwise. Never a
  // second, Today-only activity configuration, and never a hard-coded
  // "Saturday = badminton".
  const profileForType = new TrainingProfileRepo(database).get(new UsersRepo(database).getOrCreateDefault().id);
  const isGymDay = profileForType?.training_days.includes(result.weekday) ?? false;
  const sessionType = isGymDay ? 'gym' : nonGymDayType(result.weekday, profileForType?.other_activity_schedule ?? []);
  // Additive alongside sessionType, for the same reason as /week's
  // `activity` field — lets a "Both" day surface its badminton component
  // even though sessionType/exercises are gym-only (spec §8: a Both day's
  // gym programming already accounts for badminton internally; this only
  // makes that visible).
  const activity = deriveDailyActivity(result.weekday, profileForType?.training_days ?? [], profileForType?.other_activity_schedule ?? []);

  // Real active_goals only carries goal_id/priority/trend (the engine
  // has no reason to track goal_type at that layer) — resolved here
  // straight from the real Goal row so a caller (e.g. "Start workout")
  // can build a real, correctly-typed GoalContext without guessing.
  const goalsRepo = new GoalsRepo(database);
  const activeGoals = result.active_goals.map((g) => ({ ...g, goal_type: goalsRepo.get(g.goal_id)?.goal_type ?? 'aesthetic' }));

  // Same real per-target goal mapping /week uses, for the identical
  // "Goal 1 — Mid Chest" style per-exercise labeling (§65) — a second,
  // harmless read (assembleWeeklyPlanInput is pure/deterministic against
  // the same unchanged DB state within this one request), never a
  // second inference mechanism.
  const goalInput = assembleWeeklyPlanInput(database, date, budgetMinutes);
  const targetGoalMap: TargetGoalMap = new Map(
    goalInput.targets.map((t: TargetBuildContext) => [targetKey(t), { goal_id: t.goal_id, is_specialization: t.is_specialization }])
  );
  const labels = goalLabels(database);

  res.json({
    date: result.date,
    weekday: result.weekday,
    sessionPurpose: result.session_purpose,
    sessionType,
    activity,
    status: loggedSessions.length > 0 ? status : 'planned',
    exercises: result.exercises.map((e) => enrichPlannedWork(e, targetGoalMap, labels)),
    estimatedMinutes: result.estimated_minutes,
    skippedTargets: result.skipped_targets,
    activeGoals,
    resourceAllocation: result.resource_allocation,
    constraints: result.constraints,
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
