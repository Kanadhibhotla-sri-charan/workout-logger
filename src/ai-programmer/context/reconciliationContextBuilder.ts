// AI-Powered Weekly Reconciliation: builds the complete, explicit
// `reconcile_week` context from existing repositories, BlueprintAdapter,
// and the existing training engine — same non-duplication discipline as
// programmerContextBuilder.ts (never a second, re-derived copy of
// exposure/history/recovery/lock calculations).
//
// Data flow reused, not duplicated:
//   assembleWeeklyPlanInput + buildTargetContexts (programmerContextBuilder.ts)
//     -> the exact same per-target exposure/history/recovery/valid-
//        exercise shaping the single-session context already uses
//   isDayLocked (weekProgramReconciliation.ts)
//     -> the exact same completed/in-progress lock definition
//        scheduleOperations.ts's swap/move already use
//   resolveSelectedSession (selectedSessionResolver.ts)
//     -> the exact same "what session is this day's real one" rule
//        /week and /today already use
//   dailyActivity.applyWeekOverrides / deriveDailyActivity
//     -> the effective (override-applied) routine, identical to
//        programmerContextBuilder.ts's own routine section

import type Database from 'better-sqlite3';
import { WEEKDAYS, type Weekday } from '../../contracts/types.js';
import { addDays, isValidCalendarDate } from '../../engine/dateMath.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import { assembleWeeklyPlanInput, programmingWeekStart, weekdayOfDate } from '../../engine/workoutBuilder.js';
import { isDayLocked } from '../../engine/weekProgramReconciliation.js';
import { resolveSelectedSession } from '../../engine/selectedSessionResolver.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { AestheticAssessmentsRepo } from '../../repositories/aestheticAssessmentsRepo.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { AIContextIncompleteError, AITargetNotEditableError } from '../errors.js';
import { activityTypesForDailyActivity, buildCrossWeekContext, buildTargetContexts } from './programmerContextBuilder.js';
import { hashContext } from './programmerContextDiagnostics.js';
import type { AIProgrammerActiveGoalContext, AIProgrammerRoutineDayContext } from './programmerContextTypes.js';
import {
  AI_RECONCILIATION_CONTEXT_SCHEMA_VERSION,
  type AIReconciliationContext,
  type AIReconciliationExistingDayContext,
  type AIReconciliationPlannedWorkItemContext,
  type ReconciliationDailyActivity,
} from './reconciliationContextTypes.js';
import { newId } from '../../repositories/ids.js';
import { buildCoachingFoundationContext } from '../../coaching/foundationContext.js';

const NON_NEGOTIABLE_PRIORITY_HIERARCHY = [
  'Aesthetics/physique development is the primary programming objective.',
  'Athletic capability/endurance supports aesthetics unless the user explicitly prioritizes it otherwise.',
  "Active growth goals receive extra emphasis, with the user's own ranking preserved exactly as given.",
  'Maintenance of the rest of the physique remains part of every program — a goal target is never the only thing trained.',
  "When a target's realistic weekly volume across THIS week's own compatible sessions would make one or more sessions unrealistically long, prefer distributing/deferring the lower-priority remainder across this week's own other compatible sessions, or genuinely to next week (see crossWeek), over cramming everything into one session. Any real, meaningful deferral is safe: unmet volume left in currentWeekAllocations is genuinely picked up as next week's own carryover, never silently lost.",
];

const FORBIDDEN_BEHAVIORS = [
  'Do not invent an exercise ID that is not present in the supplied validExercises catalogue for the chosen target.',
  'Do not treat Blueprint package membership as an eligibility gate — every listed validExercises entry is a valid choice.',
  "Do not inflate authored set counts beyond an exercise's authoredPrescription.sets when one is present.",
  'Do not filter exercise selection by available equipment or session time — those are informational only in this milestone.',
  'Do not change the activity, session content, or classification of any date in lockedDates — return it with changeType "unchanged" and identical content to existingProgram.',
  'Do not change any date outside the returned week (the 7 dates in existingProgram are the only ones you may describe) — this includes crossWeek.nextWeek, which is read-only context, never something this request creates, generates, or modifies.',
  'Do not claim to modify historical/completed performance.',
  'Do not create future training debt from missed/skipped sets.',
  'Do not return raw HTML, executable code, SQL, or any database instruction.',
  'Do not rely on any information from a prior request — this context is fully self-contained.',
  "Keep each exercise's rationale to one short phrase (a few words), not a sentence or paragraph, and do not repeat information already implied by its other fields (targetId, classification, sets/reps/rir) — a full week's worth of exercises makes verbose rationale the single largest driver of output size.",
  'Return only the requested JSON object — no prose outside it.',
];

function toPlannedWork(raw: unknown): AIReconciliationPlannedWorkItemContext[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { plannedWork?: unknown }).plannedWork)) return [];
  const items = (raw as { plannedWork: unknown[] }).plannedWork;
  return items
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      exerciseId: String(item.exercise_id ?? ''),
      targetType: String(item.target_type ?? ''),
      targetId: String(item.target_id ?? ''),
      classification: String(item.classification ?? ''),
      sets: typeof item.sets === 'number' ? item.sets : 0,
      repsMin: typeof item.reps_min === 'number' ? item.reps_min : null,
      repsMax: typeof item.reps_max === 'number' ? item.reps_max : null,
      rirMin: typeof item.rir_min === 'number' ? item.rir_min : null,
      rirMax: typeof item.rir_max === 'number' ? item.rir_max : null,
    }))
    .filter((item) => item.exerciseId !== '');
}

function toReconciliationActivity(activity: 'gym' | 'badminton' | 'both' | 'unselected'): ReconciliationDailyActivity {
  return activity;
}

export interface BuildReconciliationContextInput {
  targetDate: string;
  requestedActivity: 'gym';
  reason?: string;
  swapUnavailableReason?: string;
}

export function buildReconciliationContext(db: Database.Database, input: BuildReconciliationContextInput): AIReconciliationContext {
  if (!isValidCalendarDate(input.targetDate)) {
    throw new AIContextIncompleteError([`targetDate must be an ISO date (YYYY-MM-DD); received "${input.targetDate}"`]);
  }

  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) {
    throw new AIContextIncompleteError(['no TrainingProfile exists for this user yet — create one first (PUT /api/training-profile)']);
  }

  const currentDate = todayForUser(db);
  const targetWeekday = weekdayOfDate(input.targetDate);
  const weekStart = programmingWeekStart(input.targetDate);
  const weekEnd = addDays(weekStart, 6);

  // Reject exactly the same "not editable" cases buildProgrammerContext
  // does for a single session — a locked or past targetDate can never be
  // the SUBJECT of a reconciliation request, even though OTHER days in
  // the week may legitimately be locked and simply preserved.
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const existingOnTargetDate = sessionsRepo.listSessionsByDate(input.targetDate);
  const lockingTarget = existingOnTargetDate.find((s) => s.status === 'completed' || s.status === 'in_progress');
  if (lockingTarget) {
    throw new AITargetNotEditableError(
      input.targetDate,
      `a workout session (${lockingTarget.session_id}) already exists for this date with status "${lockingTarget.status}"`
    );
  }
  if (input.targetDate < currentDate) {
    throw new AITargetNotEditableError(input.targetDate, 'targetDate is in the past relative to the current date');
  }

  const diagnosticsWarnings: string[] = [];
  const missingData: string[] = [];

  const overridesRepo = new WeekActivityOverridesRepo(db);
  const overrides = overridesRepo.get(profile.id, weekStart);
  const { trainingDays: effectiveTrainingDays, otherActivitySchedule: effectiveOtherActivity } = applyWeekOverrides(
    profile.training_days,
    profile.other_activity_schedule,
    overrides
  );
  const week: AIProgrammerRoutineDayContext[] = WEEKDAYS.map((weekday, index) => {
    const date = addDays(weekStart, index);
    return { date, weekday, activity: deriveDailyActivity(weekday, effectiveTrainingDays, effectiveOtherActivity) };
  });
  const currentActivityOnTargetDate = week.find((d) => d.date === input.targetDate)?.activity ?? 'unselected';

  const goalsRepo = new GoalsRepo(db);
  const assessmentsRepo = new AestheticAssessmentsRepo(db);
  const activeGoals: AIProgrammerActiveGoalContext[] = goalsRepo
    .list({ active: true })
    .map((goal) => {
      let displayName = goal.blueprint_ref;
      try {
        const resolved = goalsRepo.resolveBlueprint(goal.id);
        displayName = resolved && 'display_name' in resolved ? resolved.display_name : resolved?.name ?? goal.blueprint_ref;
      } catch {
        missingData.push(`goal ${goal.id}: blueprint_ref "${goal.blueprint_ref}" did not resolve — using raw ref as display name`);
      }
      const assessments = assessmentsRepo.listForGoal(goal.id);
      const mostRecent = assessments[assessments.length - 1];
      return {
        goalId: goal.id,
        goalType: goal.goal_type,
        blueprintRef: goal.blueprint_ref,
        displayName,
        priority: goal.priority,
        reviewCadenceDays: goal.review_cadence_days,
        mostRecentAssessment: mostRecent ? { rating: mostRecent.rating, date: mostRecent.date } : null,
      };
    })
    .sort((a, b) => a.priority - b.priority);

  const budgetMinutes = profile.default_session_duration_minutes;
  const planInput = assembleWeeklyPlanInput(db, weekStart, budgetMinutes, currentDate);
  const otherActivityForRecovery = activityTypesForDailyActivity(input.requestedActivity === 'gym' ? 'gym' : currentActivityOnTargetDate);
  const targets = buildTargetContexts(planInput, input.targetDate, otherActivityForRecovery, missingData);

  // Existing persisted weekly program (spec §6.2 "Existing persisted
  // weekly program") — every one of the 7 days, real lock state
  // (isDayLocked, the exact rule scheduleOperations.ts/
  // weekProgramReconciliation.ts already share), the persisted
  // deterministic plannedWork snapshot (if any), and the real
  // actionable session for that date (via the shared resolver, never a
  // second "what's the session for this day" rule).
  const weeklyProgramRepo = new WeeklyProgramRepo(db);
  const persistedProgram = weeklyProgramRepo.getByWeekStart(weekStart);
  const lockedDates: string[] = [];
  const existingProgram: AIReconciliationExistingDayContext[] = WEEKDAYS.map((weekday, dayIndex) => {
    const date = addDays(weekStart, dayIndex);
    const locked = isDayLocked(db, date);
    if (locked) lockedDates.push(date);
    const persistedSession = persistedProgram?.sessions.find((s) => s.day_index === dayIndex);
    const sessionsOnDate = sessionsRepo.listSessionsByDate(date);
    const resolution = resolveSelectedSession(sessionsOnDate);
    const realSession = resolution.historicalSession ?? resolution.selectedPlannedWorkout;
    return {
      date,
      weekday,
      activity: toReconciliationActivity(week.find((d) => d.date === date)?.activity ?? 'unselected'),
      locked,
      lockReason: locked ? 'a workout session already exists for this date with status completed or in_progress' : null,
      programSessionExists: !!persistedSession,
      sessionPurpose: (persistedSession?.snapshot as { sessionPurpose?: string | null } | undefined)?.sessionPurpose ?? null,
      plannedWork: toPlannedWork(persistedSession?.snapshot),
      realSession: realSession ? { sessionId: realSession.session_id, status: realSession.status, sourceType: realSession.source_type } : null,
    };
  });

  const weekProgramExists = persistedProgram !== undefined;
  if (!weekProgramExists) {
    diagnosticsWarnings.push('no persisted week program exists yet for this week — existingProgram reflects only real workout_sessions rows, not a deterministic plan');
  }

  const crossWeek = buildCrossWeekContext(db, weekStart, planInput, persistedProgram);

  // Coaching Depth Batch 1 §7: read-only foundation data, scoped to
  // exactly the same targets this context already covers.
  const coachingFoundation = buildCoachingFoundationContext(db, {
    programId: user.id,
    referenceDate: currentDate,
    weekBoundary: profile.week_start_day,
    weekStart,
    targetIds: targets.map((t) => t.targetId),
    persistedWeekSessions: persistedProgram?.sessions ?? [],
  });

  const contextWithoutVolatileFields = {
    schemaVersion: AI_RECONCILIATION_CONTEXT_SCHEMA_VERSION,
    mode: 'reconcile_week' as const,
    request: {
      targetDate: input.targetDate,
      requestedActivity: input.requestedActivity,
      reason: input.reason ?? null,
      swapUnavailableReason: input.swapUnavailableReason ?? null,
    },
    currentDate,
    timezone: profile.timezone,
    reportingBoundary: { weekStartsOn: 'monday' as const, weekEndsOn: 'sunday' as const, weekStart, weekEnd },
    targetWeekday,
    profile: {
      trainingDays: profile.training_days,
      defaultSessionDurationMinutes: profile.default_session_duration_minutes,
      minimumSessionDurationMinutes: profile.minimum_session_duration_minutes,
      maximumSessionDurationMinutes: profile.maximum_session_duration_minutes,
      availableEquipment: profile.available_equipment,
    },
    objectives: {
      primaryObjective:
        'Build muscle, manage/reduce excess body fat, and improve athletic endurance and capability — aesthetics/physique development is primary.',
      priorityHierarchy: NON_NEGOTIABLE_PRIORITY_HIERARCHY,
    },
    activeGoals,
    routine: {
      week,
      proposedChange: { date: input.targetDate, currentActivity: currentActivityOnTargetDate, requestedActivity: input.requestedActivity },
    },
    existingProgram,
    targets,
    crossWeek,
    coachingFoundation,
    lockedDates,
    executionContext: {
      programmingFilteringAllowed: false as const,
      note: 'The user handles equipment/time substitutions and session truncation manually — this field is informational only, never a selection filter.',
    },
    outputRequirements: {
      outputSchemaVersion: 'ai-week-reconciliation.v1',
      forbiddenBehaviors: FORBIDDEN_BEHAVIORS,
    },
  };

  const contextHash = hashContext(contextWithoutVolatileFields);
  const approxContextSizeChars = JSON.stringify(contextWithoutVolatileFields).length;
  if (approxContextSizeChars > 200_000) {
    diagnosticsWarnings.push(`context is large (${approxContextSizeChars} chars) — consider narrowing targets/history window in a future pass`);
  }

  return {
    ...contextWithoutVolatileFields,
    contextId: newId('airctx'),
    contextHash,
    generatedAt: new Date().toISOString(),
    diagnostics: { warnings: diagnosticsWarnings, missingData, approxContextSizeChars },
  };
}
