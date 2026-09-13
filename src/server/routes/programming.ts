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
import { DAILY_ACTIVITIES, WEEKDAYS, type BlueprintId, type DailyActivity, type Goal, type RecurringActivity, type TrainingProfile, type Weekday, type WorkoutSession } from '../../contracts/types.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import type { TargetType } from '../../engine/goalResolver.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { OutsideBlueprintExercisesRepo } from '../../repositories/outsideBlueprintExercisesRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo, type PersistedWeekProgram, type PersistedWeekSession } from '../../repositories/weeklyProgramRepo.js';
import { ensureWeekProgramGenerated, reconcileWeekProgram, type FreshDayInput } from '../../engine/weekProgramReconciliation.js';
import { ScheduleOperationError, moveActivity, swapDayActivities, type ScheduleOperationErrorCode } from '../../engine/scheduleOperations.js';
import { resolveSelectedSession, logSessionConflict } from '../../engine/selectedSessionResolver.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { buildFriendlyPlannedReasoning, buildFriendlySkipReasoning } from '../friendlyExplanation.js';
import type { SkippedTarget } from '../../engine/workoutBuilder.js';

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

/** Final Copy/Explanation Fixes §7: the best available human-readable
 * name for a Goal's underlying Blueprint reference. A functional goal
 * (e.g. "rotator-cuff") has a genuine clean title in Blueprint's own
 * data — BlueprintFunctionalGoal.name, e.g. "Rotator Cuff" — verified
 * directly against src/blueprint/snapshot/programming.json, so prefer
 * it. An aesthetic outcome has no equivalent: its only name-like field,
 * display_name, is a first-person problem statement (e.g. "Arms look
 * thin from the side"), not a goal title, so the raw blueprint_ref is
 * passed through unchanged and humanized downstream by
 * friendlyExplanation.ts's humanizeSlug — exactly the fallback spec §7
 * itself says is acceptable when no better representation exists. */
export function resolveGoalNameRef(goal: Pick<Goal, 'goal_type' | 'blueprint_ref'>): string {
  if (goal.goal_type === 'functional') {
    const functionalGoal = BlueprintAdapter.getFunctionalGoal(goal.blueprint_ref);
    if (functionalGoal) return functionalGoal.name;
  }
  return goal.blueprint_ref;
}

/** Every active goal (aesthetic or functional), sorted by the user's own
 * real `priority` field ascending — "Goal 1" is simply position 1 in
 * that real, user-controlled ranking (spec §16/§19/§20's "Goal 1/Goal
 * 2 must be visibly distinct"), never a value this route invents.
 * `nameRefs` is each Goal's best available name reference (see
 * resolveGoalNameRef) — the Workout Programmer UI Fix's human-
 * readable-explanation layer turns this into "your chest front width
 * goal" / "your Rotator Cuff goal" rather than exposing the positional
 * "Goal 1" label or a raw target id as the user-facing goal name
 * (spec §5, §7). */
function goalLabels(database: Database.Database): { labels: Map<string, string>; nameRefs: Map<string, string> } {
  const goals = new GoalsRepo(database).list({ active: true }).sort((a, b) => a.priority - b.priority);
  return {
    labels: new Map(goals.map((g, i) => [g.id, `Goal ${i + 1}`])),
    nameRefs: new Map(goals.map((g) => [g.id, resolveGoalNameRef(g)])),
  };
}

/** Real per-real-gym-day status, from actually-logged WorkoutSessions —
 * never inferred from the generated plan itself (a generated plan says
 * what SHOULD happen; only a real WorkoutSession row says what actually
 * did). Delegates to `resolveSelectedSession` (the same authoritative
 * resolver `resolveGymDayResolution` below uses) rather than re-deriving
 * its own completed/in_progress/planned tiering — a day's "real status"
 * and "which session is selected" must never be able to disagree.
 * Final Actionable vs Historical Session Resolution Fixes §1: a day's
 * real status now comes ONLY from `historicalSession` (a `completed` or
 * `in_progress` row) — never from `selectedPlannedWorkout`, which by
 * construction is never in either of those statuses. No real session
 * (or an unresolved `conflict`) both fall back to 'planned', matching
 * this function's pre-existing default. */
function realSessionStatus(database: Database.Database, date: string): 'planned' | 'in_progress' | 'completed' {
  const logged = new WorkoutSessionsRepo(database).listSessionsByDate(date);
  const status = resolveSelectedSession(logged).historicalSession?.status;
  return status === 'completed' || status === 'in_progress' ? status : 'planned';
}

/** Final Selected Session Resolution and AI/Deterministic Precedence
 * Fixes §1, extended by the Actionable vs Historical fix: the full
 * resolver answer for `date`'s real gym `workout_sessions` rows — a thin
 * wrapper over `resolveSelectedSession`, the ONE authoritative resolver
 * (`src/engine/selectedSessionResolver.ts`), shared by every read path
 * in this file. */
function resolveGymDayResolution(database: Database.Database, date: string) {
  return resolveSelectedSession(new WorkoutSessionsRepo(database).listSessionsByDate(date));
}

function toSessionField(session: WorkoutSession | null): { id: string; source: WorkoutSession['source_type']; status: 'planned' | 'in_progress' | 'completed' } | null {
  if (!session) return null;
  return { id: session.session_id, source: session.source_type, status: session.status as 'planned' | 'in_progress' | 'completed' };
}

/** Final AI-Deterministic Precedence and Scheduling Fixes §1/§2/§8,
 * extended by the Actionable vs Historical fix: the ONE shared rule
 * `renderWeekDays` (and therefore every read path built on it — GET
 * /week, GET /today) uses to decide what a gym day's `plannedWork`
 * should show, given that BOTH a deterministic `program_sessions`
 * prescription and a real `workout_sessions` row can exist for the same
 * date at once.
 *
 * `combinedSession` is whichever real session the resolver considers
 * relevant for this date — its `historicalSession` if one exists
 * (completed/in-progress always wins for display purposes, per the
 * resolver's own precedence), else its `selectedPlannedWorkout`
 * (actionable, or a conflict's deterministic recovery candidate). A
 * `source_type` other than `'deterministic'` on that session SUPERSEDES
 * the deterministic snapshot for display (Option 1, "AI replacement/
 * supersession" — the deterministic row is never deleted, only display
 * precedence changes). `plannedWork` is left empty rather than
 * fabricated in that case (workout_exercises does not retain
 * target_type/target_id/classification); the real exercises remain
 * fully visible via the session's own detail endpoint.
 *
 * Never used to decide whether a day IS a gym day (`isGymActivity`
 * alone still decides that, from the profile/override layer only —
 * Non-Goal: never infer activity from workout-session rows). */
function resolveGymDaySelection(
  persistedSnapshot: PersistedWeekSession | undefined,
  resolution: ReturnType<typeof resolveGymDayResolution>
): { showDeterministic: boolean; combinedSession: WorkoutSession | null } {
  const combinedSession = resolution.historicalSession ?? resolution.selectedPlannedWorkout;
  const supersedes = !!combinedSession && combinedSession.source_type !== 'deterministic';
  // Final Conflict Selection Safety Fix: an ambiguous active-planned-
  // session state (`source: 'conflict'`) must never fall through to
  // showing the deterministic snapshot as if it were the valid, current
  // plan — `combinedSession` is `null` in this state (neither field is
  // populated, by design), which would otherwise make `supersedes` false
  // and silently resurrect `plannedWork` right alongside the very
  // `selectionConflict` warning that says the day's real state is
  // unresolved. Suppress it explicitly instead.
  const showDeterministic = !!persistedSnapshot && resolution.source !== 'conflict' && !supersedes;
  return { showDeterministic, combinedSession };
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

function enrichPlannedWork<
  T extends {
    exercise_id: BlueprintId;
    target_type: TargetType;
    target_id: BlueprintId;
    classification: 'specialization' | 'normal_development' | 'maintenance';
    role: string;
    sets: number;
    reps_min: number;
    reps_max: number;
    rir_min: number;
    rir_max: number;
    progression_decision: { recommendation: string } | null;
    decision: { weekly_exposure: { primary_sets: number } };
  }
>(work: T, targetGoalMap?: TargetGoalMap, labels?: Map<string, string>, nameRefs?: Map<string, string>) {
  const goalInfo = targetGoalMap && labels ? resolveGoalLabelAndId(targetKey(work), work.classification, targetGoalMap, labels) : { goal_id: null, goal_label: null };
  const exercise_name = resolveExerciseName(work.exercise_id);
  const target_name = resolveTargetName(work.target_type, work.target_id);
  const goalNameRef = goalInfo.goal_id ? (nameRefs?.get(goalInfo.goal_id) ?? null) : null;
  return {
    ...work,
    exercise_name,
    target_name,
    ...goalInfo,
    friendly_reasoning: buildFriendlyPlannedReasoning({ ...work, exercise_name, target_name }, goalNameRef),
  };
}

function enrichSkip(skip: SkippedTarget, targetGoalMap?: TargetGoalMap, labels?: Map<string, string>) {
  const goalInfo = targetGoalMap && labels ? resolveGoalLabelAndId(targetKey(skip), skip.classification, targetGoalMap, labels) : { goal_id: null, goal_label: null };
  const target_name = resolveTargetName(skip.target_type, skip.target_id);
  return {
    ...skip,
    target_name,
    ...goalInfo,
    friendly_reason: buildFriendlySkipReasoning({ ...skip, target_name }),
  };
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

export function defaultBudgetMinutes(database: Database.Database): number {
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
 * §18: a plain GET must not blindly regenerate).
 *
 * Same-Week History & Day-Specific Recovery Fix §3/§4: `weekStart`
 * (always that week's own Monday) anchors WHICH CALENDAR WEEK is being
 * generated; `historyAsOfDate` (defaults to `weekStart` only for a
 * caller that hasn't been updated to pass the real one) is the SEPARATE
 * real reference date the planner's own real training history is read
 * through. Every canonical caller below now passes its own real current
 * date here, so real Tue-Sun training already logged in THIS SAME
 * programming week remains visible to later same-week
 * generation/reconciliation — the planner no longer behaves as though
 * it is still Monday morning once real training has happened later in
 * the week. */
export function computeFreshWeek(
  database: Database.Database,
  weekStart: string,
  budgetMinutes: number,
  historyAsOfDate: string = weekStart
): { days: FreshDayInput[]; aggregates: { activeGoals: unknown; targetAllocations: unknown } } {
  const input = assembleWeeklyPlanInput(database, weekStart, budgetMinutes, historyAsOfDate);
  const plan = buildWeeklyProgrammingPlan(input);

  const targetGoalMap = new Map<string, { goal_id: string; is_specialization: boolean }>(
    input.targets.map((t: TargetBuildContext) => [targetKey(t), { goal_id: t.goal_id, is_specialization: t.is_specialization }])
  );
  const { labels, nameRefs } = goalLabels(database);
  const sessionsByDate = new Map(plan.sessions.map((s) => [s.date, s]));

  const days: FreshDayInput[] = WEEKDAYS.map((weekday, i) => {
    const dayDate = addDays(plan.weekStart, i);
    const gymSession = sessionsByDate.get(dayDate);
    if (!gymSession) {
      return { dayIndex: i, date: dayDate, hasGymComponent: false, sessionPurpose: null, snapshot: { plannedWork: [] } };
    }
    const plannedWork = gymSession.plannedWork.map((w) => enrichPlannedWork(w, targetGoalMap, labels, nameRefs));
    const skipped = gymSession.skipped.map((s) => enrichSkip(s, targetGoalMap, labels));
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
        skipped,
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
 * is the read path a plain `GET /week` or `GET /today` actually uses.
 *
 * AI Activity Alignment / Non-Regenerative Schedule Fixes (Part 3/5):
 * `type`/`status` are now driven by the AUTHORITATIVE `activity`
 * (profile + this week's overrides) whenever it says Gym/Both, not only
 * by "a deterministic `program_sessions` snapshot happens to exist" —
 * closing the exact contradiction the task describes (weekly activity
 * says Gym via an AI-commit alignment override, but no deterministic
 * snapshot exists, so the day used to fall through to the non-gym
 * branch and silently report 'rest'). This does NOT invert the
 * Non-Goal "do not make /week infer activity from workout-session
 * rows": `activity` here still comes ONLY from the profile/override
 * layer, exactly as before — a real `workout_sessions` row is
 * consulted only to report which such day's REAL status is (as
 * `realSessionStatus` already did for every persisted gym day), never
 * to decide whether the day itself IS a gym day. */
function renderWeekDays(database: Database.Database, weekStart: string, program: PersistedWeekProgram, profile: TrainingProfile | undefined) {
  const effective = effectiveWeekActivity(database, profile, weekStart);
  return WEEKDAYS.map((weekday, i) => {
    const dayDate = addDays(weekStart, i);
    const activity = deriveDailyActivity(weekday, effective.trainingDays, effective.otherActivitySchedule);
    const isGymActivity = activity === 'gym' || activity === 'both';
    const persisted = program.sessions.find((s) => s.day_index === i);
    const resolution = isGymActivity || persisted ? resolveGymDayResolution(database, dayDate) : null;
    const { showDeterministic, combinedSession } = resolution
      ? resolveGymDaySelection(persisted, resolution)
      : { showDeterministic: false, combinedSession: null };
    const historicalSession = toSessionField(resolution?.historicalSession ?? null);
    const selectedPlannedWorkout = toSessionField(resolution?.selectedPlannedWorkout ?? null);
    const selectionConflict = resolution?.selectionConflict ?? null;
    if (selectionConflict) {
      logSessionConflict({
        operation: 'GET /week (or /today) day resolution',
        date: dayDate,
        sessionType: 'gym',
        code: selectionConflict.code,
        conflictingSessionIds: selectionConflict.sessionIds,
      });
    }

    if (showDeterministic && persisted) {
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
        plannedSession: toSessionField(combinedSession),
        historicalSession,
        selectedPlannedWorkout,
        selectionConflict,
        supersedesProgramSessionId: null,
      };
    }
    if (isGymActivity) {
      // Either no deterministic prescription is persisted for this day
      // at all (an AI proposal was committed directly here via
      // aiProposalLifecycle.ts's 'replace_day_activity' intent, which
      // creates a real workout_sessions row but intentionally never
      // writes a program_sessions snapshot — Part 5's own schema note),
      // or one WAS persisted but a real non-deterministic-sourced
      // session now SUPERSEDES it (Final AI-Deterministic Precedence
      // and Scheduling Fixes §1 — `fill_existing_gym_day` committed on
      // a day that already had a generated prescription). Either way,
      // `plannedWork` is left empty rather than reconstructed from
      // workout_exercises — that table does not retain
      // target_type/target_id/classification, so a fabricated
      // PlannedWorkItem would misrepresent the real prescription.
      // `plannedSession` is the truthful, UI-consumed signal that a
      // real workout exists here — the real exercises remain fully
      // visible via the session's own detail endpoint (logger.html's
      // "Open planned workout" link, driven by `plannedSession.id`).
      return {
        date: dayDate,
        weekday,
        type: 'gym' as const,
        activity,
        status: realSessionStatus(database, dayDate),
        sessionPurpose: null,
        availableMinutes: 0,
        estimatedMinutes: 0,
        plannedWork: [] as ReturnType<typeof enrichPlannedWork>[],
        skipped: [],
        badmintonContext: null,
        resourceAllocation: [],
        plannedSession: toSessionField(combinedSession),
        historicalSession,
        selectedPlannedWorkout,
        selectionConflict,
        // Explicit provenance (spec §1's own suggested field) — only
        // meaningful when a persisted deterministic snapshot actually
        // existed for this slot and is being superseded by the real
        // session above; null otherwise (nothing to supersede).
        supersedesProgramSessionId: persisted ? persisted.id : null,
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
      plannedSession: null,
      historicalSession: null,
      selectedPlannedWorkout: null,
      selectionConflict: null,
      supersedesProgramSessionId: null,
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

  const program = ensureWeekProgramGenerated(database, weekStart, () => computeFreshWeek(database, weekStart, budgetMinutes, date));

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  res.json(buildWeekResponse(database, weekStart, program, profile));
});

const PRESCRIPTION_POLICIES = ['reuse', 'regenerate', 'schedule-only'] as const;
type PrescriptionPolicy = (typeof PRESCRIPTION_POLICIES)[number];

// PUT /api/programming/week/days/:day/activity — Current-Week
// Reconciliation Fix §11/§19: change ONE day's activity for the CURRENT
// week only. Never touches the recurring TrainingProfile (see
// WeekActivityOverridesRepo's own doc comment). This is the "replace"
// operation of AI Activity Alignment / Non-Regenerative Schedule Fixes
// Part 1 / Activity Scheduling and AI Alignment Fixes Fix 7 / Final
// AI-Deterministic Precedence and Scheduling Fixes §3/§6 — unlike
// `swap`/`move` (which only ever rearrange already-persisted content
// and NEVER call the planner), replacing a single day's activity with
// something the week has no other copy of genuinely may need a new
// prescription, so this endpoint requires the caller to be explicit
// about which of three modes it wants via `prescriptionPolicy`. Each
// value is valid ONLY for the direction of change it makes sense for —
// an invalid combination is a `400`, never silently reinterpreted:
//
//   'reuse'         — Gym/Both target activity ONLY. Never calls the
//                     planner. Precise meaning (§3 of this task):
//                     "use the prescription ALREADY ASSIGNED TO THE
//                     TARGET DATE. It does not search for, move, or
//                     borrow a prescription from another date." If this
//                     exact day already has a persisted gym prescription
//                     (this week's own program_sessions row for its
//                     day_index), the override is written and that
//                     existing content is kept as-is. If no such
//                     prescription exists to reuse — even if some OTHER
//                     day this week has one — nothing is written and a
//                     clear "generation required" response is returned
//                     instead of silently generating one (Rule 2: "do
//                     not silently fall back from reuse to regenerate").
//                     Moving a prescription IN from another date is a
//                     genuinely different operation with its own
//                     explicit source/destination semantics — that is
//                     `/week/move`'s job (§4), never this endpoint's.
//   'regenerate'    — Gym/Both target activity ONLY. Explicit,
//                     caller-approved generation: calls the planner and
//                     reconciles exactly as this endpoint always has,
//                     writing only the days that actually need to
//                     change (spec §6/§20), never blindly replacing the
//                     whole persisted week.
//   'schedule-only' — non-Gym target activity ONLY (Rest/Badminton).
//                     Changes only the activity/override assignment;
//                     there is no prescription decision to make when
//                     leaving Gym, so 'reuse'/'regenerate' are rejected
//                     for this direction as unsupported combinations
//                     (§6: "reject unsupported combinations rather than
//                     silently falling back"). The planner MAY still run
//                     afterward to redistribute OTHER days whose
//                     eligibility genuinely changed as a consequence
//                     (reconcileWeekProgram's own "only write what
//                     actually changed" rule) — it never generates a
//                     prescription for THIS (now non-Gym) day.
//
// `prescriptionPolicy` is REQUIRED (mirroring Fix 1's `intent` — the
// same "reject unsafe ambiguous operations rather than silently
// guessing" principle) so there is no silently-regenerating default;
// every caller must say which it means. The response echoes
// `appliedPrescriptionPolicy` so the effective policy is always
// traceable (§6: "the API response reports the effective policy").
programmingRouter.put('/week/days/:day/activity', (req, res) => {
  const database = db(req);
  const day = req.params.day;
  if (!WEEKDAYS.includes(day as Weekday)) {
    return res.status(400).json({ error: `day must be one of ${WEEKDAYS.join('|')}` });
  }
  const { activity, prescriptionPolicy } = req.body ?? {};
  if (!DAILY_ACTIVITIES.includes(activity)) {
    return res.status(400).json({ error: `activity must be one of ${DAILY_ACTIVITIES.join('|')}` });
  }
  if (!PRESCRIPTION_POLICIES.includes(prescriptionPolicy)) {
    return res.status(400).json({ error: `prescriptionPolicy is required and must be one of ${PRESCRIPTION_POLICIES.join('|')}` });
  }
  const wantsGym = activity === 'gym' || activity === 'both';
  if (wantsGym && prescriptionPolicy === 'schedule-only') {
    return res.status(400).json({ error: `prescriptionPolicy "schedule-only" is not valid when changing to activity "${activity}" — use "reuse" or "regenerate".` });
  }
  if (!wantsGym && prescriptionPolicy !== 'schedule-only') {
    return res.status(400).json({ error: `prescriptionPolicy must be "schedule-only" when changing to activity "${activity}" — there is no prescription decision to make when leaving Gym.` });
  }

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  if (!profile) {
    return res.status(404).json({ error: 'No training profile exists for this user yet — create one first (PUT /api/training-profile)' });
  }

  const date = todayForUser(database);
  const weekStart = programmingWeekStart(date);
  const dayIndex = WEEKDAYS.indexOf(day as Weekday);
  const targetDate = addDays(weekStart, dayIndex);
  const sessionsRepo = new WorkoutSessionsRepo(database);

  // Part 4 "In-progress session": reject the conflicting change with a
  // clear explanation, rather than applying an override that now
  // contradicts a workout the user is actively in the middle of. A
  // completed session is deliberately NOT rejected here — its own
  // historical fields are never touched regardless of this override
  // (reconcileWeekProgram's own locked-day skip already guarantees
  // that); only this week's forward-looking activity representation
  // changes for a completed day, exactly as this endpoint has always
  // allowed.
  const inProgress = sessionsRepo.listSessionsByDate(targetDate).find((s) => s.status === 'in_progress');
  if (inProgress) {
    return res.status(409).json({
      error: `${targetDate} has a workout currently in progress and its activity cannot be changed until that workout is finished.`,
      conflictingSessionId: inProgress.session_id,
    });
  }

  // Fix 3 (supersedes the prior release's confirmReplacePlanned escape
  // hatch): moving a day AWAY from a gym-having activity must not leave
  // a real, still-planned AI-committed session (workout_sessions)
  // contradicting the new activity. This endpoint has no cancellation
  // workflow (none exists in this codebase, and building one is outside
  // this task's scope — see its own Non-Goals) and no way to MOVE that
  // session elsewhere (that is `/week/swap`'s job, not this endpoint's),
  // so there is no safe way to proceed — the change is REJECTED
  // unconditionally, never silently detaching the session while leaving
  // it looking active (Invariant 3). The caller must move the planned
  // session (via `/week/swap`, onto a day it can occupy) or implement a
  // cancellation workflow before this activity change can succeed.
  if (!wantsGym) {
    const plannedSession = sessionsRepo.listSessionsByDate(targetDate).find((s) => s.status === 'planned');
    if (plannedSession) {
      return res.status(409).json({
        error: `${targetDate} has an active planned workout session (${plannedSession.session_id}). Move or cancel that session before changing the activity.`,
        conflictingSessionId: plannedSession.session_id,
      });
    }
  }

  // Fix 7: under 'reuse', never call the planner — either this exact
  // day already has a persisted gym prescription to keep as-is (the
  // override alone is written), or there is nothing to reuse and the
  // caller is told generation is required, instead of one being
  // silently produced.
  if (wantsGym && (prescriptionPolicy as PrescriptionPolicy) === 'reuse') {
    const existingProgram = new WeeklyProgramRepo(database).getByWeekStart(weekStart);
    const existingSession = existingProgram?.sessions.find((s) => s.day_index === dayIndex);
    if (!existingSession) {
      return res.status(409).json({
        error: `${targetDate} has no existing gym prescription to reuse. Pass prescriptionPolicy: "regenerate" to explicitly generate a new one for this day.`,
        generationRequired: true,
      });
    }
    new WeekActivityOverridesRepo(database).setOverride(profile.id, weekStart, day as Weekday, activity as DailyActivity);
    return res.json({ ...buildWeekResponse(database, weekStart, existingProgram!, profile), appliedPrescriptionPolicy: prescriptionPolicy });
  }

  new WeekActivityOverridesRepo(database).setOverride(profile.id, weekStart, day as Weekday, activity as DailyActivity);

  const budgetMinutes = defaultBudgetMinutes(database);
  const { days, aggregates } = computeFreshWeek(database, weekStart, budgetMinutes, date);
  const program = reconcileWeekProgram(database, weekStart, days, aggregates, { kind: 'activity_override', dayIndex });

  res.json({ ...buildWeekResponse(database, weekStart, program, profile), appliedPrescriptionPolicy: prescriptionPolicy });
});

function weekOperationErrorStatus(code: ScheduleOperationErrorCode): number {
  if (code === 'DAY_LOCKED' || code === 'DESTINATION_OCCUPIED') return 409;
  if (code === 'NO_TRAINING_PROFILE') return 404;
  return 400;
}

/** Backs `POST /week/swap` — see src/engine/scheduleOperations.ts's
 * swapDayActivities for the full contract (never calls the planner,
 * never the LLM, atomic, reversible). `operation` is echoed on the
 * response so API responses/logs can always distinguish `swap` from
 * `move`/`regenerate` (Final AI-Deterministic Precedence and Scheduling
 * Fixes §4's own acceptance criteria). */
function respondToSwap(database: Database.Database, dayA: unknown, dayB: unknown, res: import('express').Response): void {
  if (!WEEKDAYS.includes(dayA as Weekday) || !WEEKDAYS.includes(dayB as Weekday)) {
    res.status(400).json({ error: `dayA and dayB must each be one of ${WEEKDAYS.join('|')}` });
    return;
  }
  if (dayA === dayB) {
    res.status(400).json({ error: `dayA and dayB must be different weekdays.` });
    return;
  }

  const date = todayForUser(database);
  const weekStart = programmingWeekStart(date);

  let result;
  try {
    result = swapDayActivities(database, weekStart, dayA as Weekday, dayB as Weekday);
  } catch (err) {
    if (err instanceof ScheduleOperationError) {
      res.status(weekOperationErrorStatus(err.code)).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  const program =
    new WeeklyProgramRepo(database).getByWeekStart(weekStart) ??
    ({ id: '', start_date: weekStart, end_date: addDays(weekStart, 6), active_goals: null, target_allocations: null, sessions: [] } satisfies PersistedWeekProgram);

  res.json({ ...buildWeekResponse(database, weekStart, program, profile), operation: 'swap', movedPlannedSessionIds: result.movedPlannedSessionIds });
}

// POST /api/programming/week/swap — body { dayA, dayB } (each a
// Weekday). AI Activity Alignment / Non-Regenerative Schedule Fixes
// Part 1/2: exchanges two days' activity AND, wherever a data-model
// artifact already exists for either day (a persisted deterministic
// prescription, or a real planned AI-committed session), moves it along
// instead of regenerating anything. Never calls the planner, never the
// LLM. Idempotent/reversible: calling this again with the same two days
// restores the original state (a swap is its own inverse).
programmingRouter.post('/week/swap', (req, res) => {
  const { dayA, dayB } = req.body ?? {};
  respondToSwap(db(req), dayA, dayB, res);
});

/** Backs `POST /week/move` — see src/engine/scheduleOperations.ts's
 * moveActivity for the full contract (true asymmetric move semantics —
 * Final AI-Deterministic Precedence and Scheduling Fixes §4 Option B;
 * never calls the planner, never the LLM). */
function respondToMove(database: Database.Database, fromDay: unknown, toDay: unknown, res: import('express').Response): void {
  if (!WEEKDAYS.includes(fromDay as Weekday) || !WEEKDAYS.includes(toDay as Weekday)) {
    res.status(400).json({ error: `fromDay and toDay must each be one of ${WEEKDAYS.join('|')}` });
    return;
  }
  if (fromDay === toDay) {
    res.status(400).json({ error: `fromDay and toDay must be different weekdays.` });
    return;
  }

  const date = todayForUser(database);
  const weekStart = programmingWeekStart(date);

  let result;
  try {
    result = moveActivity(database, weekStart, fromDay as Weekday, toDay as Weekday);
  } catch (err) {
    if (err instanceof ScheduleOperationError) {
      res.status(weekOperationErrorStatus(err.code)).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    throw err;
  }

  const user = new UsersRepo(database).getOrCreateDefault();
  const profile = new TrainingProfileRepo(database).get(user.id);
  const program =
    new WeeklyProgramRepo(database).getByWeekStart(weekStart) ??
    ({ id: '', start_date: weekStart, end_date: addDays(weekStart, 6), active_goals: null, target_allocations: null, sessions: [] } satisfies PersistedWeekProgram);

  res.json({ ...buildWeekResponse(database, weekStart, program, profile), operation: 'move', movedPlannedSessionIds: result.movedPlannedSessionIds });
}

// POST /api/programming/week/move — body { fromDay, toDay } (each a
// Weekday). Final AI-Deterministic Precedence and Scheduling Fixes §4
// (Option B): a TRUE, asymmetric move — fromDay's activity/prescription
// relocates onto toDay, fromDay itself becomes Rest, and toDay's own
// PRIOR activity/prescription is discarded (never swapped back onto
// fromDay — see moveActivity's own doc comment for the exact
// distinguishing example). Never calls the planner, never the LLM.
// Replaces the prior release's `/week/move`, which was only a
// misleadingly-named alias for `/week/swap`.
programmingRouter.post('/week/move', (req, res) => {
  const { fromDay, toDay } = req.body ?? {};
  respondToMove(db(req), fromDay, toDay, res);
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

  const program = ensureWeekProgramGenerated(database, weekStart, () => computeFreshWeek(database, weekStart, budgetMinutes, date));

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
    // Fix 8 / Final AI-Deterministic Precedence Fixes §8: the SAME
    // fields /week's own day objects carry (built by the same
    // renderWeekDays/resolveGymDaySelection this route reuses, never a
    // second independent computation) — lets a gym-day-with-no-
    // deterministic-`exercises` view (an AI-committed or superseded
    // day) still say "a planned workout exists" and link to it.
    plannedSession: today.plannedSession,
    historicalSession: today.historicalSession,
    selectedPlannedWorkout: today.selectedPlannedWorkout,
    selectionConflict: today.selectionConflict,
    supersedesProgramSessionId: today.supersedesProgramSessionId,
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
