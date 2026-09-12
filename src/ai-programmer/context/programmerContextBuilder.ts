// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §6): builds
// the complete, explicit `generate_session` context from existing
// repositories, BlueprintAdapter, and the existing training engine —
// never a second, re-derived copy of exposure/history/recovery
// calculations (spec §6.3: "reuse existing code rather than
// reimplementing domain logic").
//
// Data flow reused, not duplicated:
//   assembleWeeklyPlanInput(db, weekStart, budgetMinutes, today)
//     -> TargetBuildContext[] (real weekly exposure, rolling exposure,
//        exercise history, recent badminton signal — the exact same
//        per-target facts workoutBuilder.ts itself programs from)
//   exerciseSelector.exercisesTrainingTarget / roleFor
//     -> the valid exercise library per target
//   developmentPackages.lookupExercisePrescriptionAnyLevel
//     -> authoritative per-(target, exercise) prescriptions
//   recoveryEngine.applyRecoveryConstraint
//     -> real per-target recovery decision, evaluated as of targetDate
//   dailyActivity.applyWeekOverrides / deriveDailyActivity
//     -> the effective (override-applied) Gym/Badminton/Both/Unselected
//        routine, the same resolution GET /api/programming/week uses

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { lookupExercisePrescriptionAnyLevel, parseRange } from '../../blueprint/developmentPackages.js';
import { WEEKDAYS, type ActivityType, type Weekday } from '../../contracts/types.js';
import { addDays, daysBetween } from '../../engine/dateMath.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import { applyRecoveryConstraint } from '../../engine/recoveryEngine.js';
import { exercisesTrainingTarget, roleFor } from '../../engine/exerciseSelector.js';
import { assembleWeeklyPlanInput, programmingWeekStart, weekdayOfDate, type TargetBuildContext } from '../../engine/workoutBuilder.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { AestheticAssessmentsRepo } from '../../repositories/aestheticAssessmentsRepo.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { AIContextIncompleteError, AITargetNotEditableError } from '../errors.js';
import { hashContext } from './programmerContextDiagnostics.js';
import {
  AI_PROGRAMMER_CONTEXT_SCHEMA_VERSION,
  type AIProgrammerActiveGoalContext,
  type AIProgrammerContext,
  type AIProgrammerRoutineDayContext,
  type AIProgrammerTargetContext,
  type AIProgrammerValidExerciseContext,
} from './programmerContextTypes.js';
import { newId } from '../../repositories/ids.js';

const NON_NEGOTIABLE_PRIORITY_HIERARCHY = [
  'Aesthetics/physique development is the primary programming objective.',
  'Athletic capability/endurance supports aesthetics unless the user explicitly prioritizes it otherwise.',
  "Active growth goals receive extra emphasis, with the user's own ranking preserved exactly as given.",
  'Maintenance of the rest of the physique remains part of every program — a goal target is never the only thing trained.',
];

const FORBIDDEN_BEHAVIORS = [
  'Do not invent an exercise ID that is not present in the supplied validExercises catalogue for the chosen target.',
  'Do not treat Blueprint package membership as an eligibility gate — every listed validExercises entry is a valid choice.',
  'Do not inflate authored set counts beyond an exercise\'s authoredPrescription.sets when one is present.',
  'Do not filter exercise selection by available equipment or session time — those are informational only in this milestone.',
  'Do not target a date other than the exact requested targetDate.',
  'Do not claim to modify historical/completed performance.',
  'Do not return raw HTML, executable code, SQL, or any database instruction.',
  'Do not rely on any information from a prior request — this context is fully self-contained.',
  'Return only the requested JSON object — no prose outside it.',
];

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function activityTypesForDailyActivity(activity: 'gym' | 'badminton' | 'both' | 'unselected'): ActivityType[] {
  return activity === 'badminton' || activity === 'both' ? ['badminton'] : [];
}

export interface BuildProgrammerContextInput {
  targetDate: string;
  /** Optional override of the resolved user's own TrainingProfile
   * timezone — used only for display/consistency-checking, never to
   * change which real day `targetDate` refers to (dates are always
   * plain YYYY-MM-DD, spec's own timezone contract). */
  timezone?: string;
}

export function buildProgrammerContext(db: Database.Database, input: BuildProgrammerContextInput): AIProgrammerContext {
  if (!isValidIsoDate(input.targetDate)) {
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

  const sessionsRepo = new WorkoutSessionsRepo(db);
  const existingSessionsOnTargetDate = sessionsRepo.listSessionsByDate(input.targetDate);
  const lockingSession = existingSessionsOnTargetDate.find((s) => s.status === 'completed' || s.status === 'in_progress');
  if (lockingSession) {
    throw new AITargetNotEditableError(
      input.targetDate,
      `a workout session (${lockingSession.session_id}) already exists for this date with status "${lockingSession.status}"`
    );
  }
  if (input.targetDate < currentDate) {
    throw new AITargetNotEditableError(input.targetDate, 'targetDate is in the past relative to the current date');
  }

  const diagnosticsWarnings: string[] = [];
  const missingData: string[] = [];

  // Routine: the effective (override-applied) Gym/Badminton/Both/
  // Unselected activity for every day of the target week — the exact
  // same resolution GET /api/programming/week uses.
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
  const targetDateActivity = week.find((d) => d.date === input.targetDate)?.activity ?? 'unselected';

  // Active goals, in the user's own priority order — never reordered.
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

  // Per-target real exposure/history/recovery-input data — reused
  // wholesale from the deterministic engine's own weekly plan input
  // assembly rather than re-derived.
  const budgetMinutes = profile.default_session_duration_minutes;
  const planInput = assembleWeeklyPlanInput(db, weekStart, budgetMinutes, currentDate);
  const otherActivityToday = activityTypesForDailyActivity(targetDateActivity);

  const targets: AIProgrammerTargetContext[] = planInput.targets.map((t: TargetBuildContext) => {
    const targetLabel =
      t.target_type === 'physique_target' ? BlueprintAdapter.getTarget(t.target_id) : BlueprintAdapter.getFunctionalGoal(t.target_id);
    const displayName = targetLabel?.name ?? t.target_id;
    const parentRegion = targetLabel && 'parent_region' in targetLabel ? targetLabel.parent_region : null;

    const daysSinceLastTrainedAsOfTargetDate = t.last_trained_date ? daysBetween(t.last_trained_date, input.targetDate) : null;

    const recovery = applyRecoveryConstraint({
      target_type: t.target_type,
      target_id: t.target_id,
      weekly_exposure_units: t.weekly_exposure_units,
      rolling_exposure_units: t.rolling_exposure_units,
      rolling_window_days: t.rolling_window_days,
      days_since_target_last_trained: daysSinceLastTrainedAsOfTargetDate,
      recent_badminton: t.recent_badminton,
      other_activity_today: otherActivityToday,
    });

    const exerciseHistory: Record<string, Array<{ date: string; completedSets: number }>> = {};
    for (const [exerciseId, history] of Object.entries(t.exercise_history)) {
      exerciseHistory[exerciseId] = history.slice(0, 3).map((h) => ({
        date: h.date,
        completedSets: h.sets.filter((s) => s.completed).length,
      }));
    }

    const validExercises: AIProgrammerValidExerciseContext[] = exercisesTrainingTarget(t.target_type, t.target_id).map((exerciseId) => {
      const exercise = BlueprintAdapter.getExercise(exerciseId);
      const prescriptionEntry = lookupExercisePrescriptionAnyLevel(t.target_id, exerciseId);
      let authoredPrescription: AIProgrammerValidExerciseContext['authoredPrescription'] = null;
      if (prescriptionEntry) {
        try {
          const reps = parseRange(prescriptionEntry.reps);
          const rir = parseRange(prescriptionEntry.rir);
          authoredPrescription = { sets: prescriptionEntry.sets, repsMin: reps.min, repsMax: reps.max, rirMin: rir.min, rirMax: rir.max };
        } catch {
          missingData.push(`exercise ${exerciseId} for target ${t.target_id}: malformed authored reps/rir range — omitted, not guessed`);
        }
      }
      return {
        exerciseId,
        name: exercise?.name ?? exerciseId,
        role: roleFor(exerciseId, t.target_type, t.target_id) as 'primary' | 'secondary',
        equipment: exercise?.equipment ?? [],
        authoredPrescription,
      };
    });

    if (validExercises.length === 0) {
      missingData.push(`target ${t.target_type}:${t.target_id} has no known Blueprint exercises at all`);
    }

    return {
      targetType: t.target_type,
      targetId: t.target_id,
      displayName,
      parentRegion,
      isSpecialization: t.is_specialization,
      goalId: t.is_specialization ? t.goal_id : null,
      currentWeeklyPrimarySets: t.current_weekly_primary_sets,
      weeklySecondarySets: t.weekly_secondary_sets,
      weeklyExposureUnits: t.weekly_exposure_units,
      rollingExposureUnits: t.rolling_exposure_units,
      rollingWindowDays: t.rolling_window_days,
      lastTrainedDate: t.last_trained_date,
      daysSinceLastTrainedAsOfTargetDate,
      exerciseHistory,
      recovery,
      validExercises,
    };
  });

  const weekProgramExists = new WeeklyProgramRepo(db).getByWeekStart(weekStart) !== undefined;

  const contextWithoutVolatileFields = {
    schemaVersion: AI_PROGRAMMER_CONTEXT_SCHEMA_VERSION,
    mode: 'generate_session' as const,
    currentDate,
    timezone: input.timezone ?? profile.timezone,
    reportingBoundary: { weekStartsOn: 'monday' as const, weekEndsOn: 'sunday' as const, weekStart, weekEnd },
    targetDate: input.targetDate,
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
    routine: { targetDateActivity, week },
    targets,
    currentProgram: { weekProgramExists, targetDateLocked: false, lockReason: null },
    executionContext: {
      programmingFilteringAllowed: false as const,
      note: 'The user handles equipment/time substitutions and session truncation manually — this field is informational only, never a selection filter.',
    },
    outputRequirements: {
      outputSchemaVersion: 'ai-workout-session-proposal.v1',
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
    contextId: newId('aictx'),
    contextHash,
    generatedAt: new Date().toISOString(),
    diagnostics: { warnings: diagnosticsWarnings, missingData, approxContextSizeChars },
  };
}
