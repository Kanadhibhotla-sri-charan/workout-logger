// AI Weekly Programmer — generate_week: builds the complete context for
// a FROM-SCRATCH week from existing repositories, BlueprintAdapter, and
// the existing training engine — same non-duplication discipline as
// programmerContextBuilder.ts / reconciliationContextBuilder.ts (never a
// second, re-derived copy of exposure/history/recovery calculations).
//
// Data flow reused, not duplicated:
//   assembleWeeklyPlanInput + buildTargetContexts (programmerContextBuilder.ts)
//     -> the exact same per-target exposure/history/recovery/valid-
//        exercise shaping every other AI mode already uses
//   buildCrossWeekContext / buildIntensityTechniqueCatalogue
//     -> called with persistedProgram/persistedWeekSessions absent,
//        an already-supported case reconciliationContextBuilder.ts
//        itself exercises when no week has ever been generated yet
//   dailyActivity.applyWeekOverrides / deriveDailyActivity
//     -> the effective (override-applied) routine, identical to the
//        other two context builders' own routine section
//
// Deliberately does NOT build existingProgram/lockedDates/request/
// proposedChange — there is no existing week to preserve or diff
// against; this only ever runs when ensureWeekProgramGenerated finds no
// persisted week for weekStart at all.

import type Database from 'better-sqlite3';
import { WEEKDAYS } from '../../contracts/types.js';
import { addDays } from '../../engine/dateMath.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import { assembleWeeklyPlanInput } from '../../engine/workoutBuilder.js';
import { AestheticAssessmentsRepo } from '../../repositories/aestheticAssessmentsRepo.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { AIContextIncompleteError } from '../errors.js';
import { buildCrossWeekContext, buildIntensityTechniqueCatalogue, buildTargetContexts } from './programmerContextBuilder.js';
import { hashContext } from './programmerContextDiagnostics.js';
import type { AIProgrammerActiveGoalContext, AIProgrammerRoutineDayContext } from './programmerContextTypes.js';
import { AI_GENERATE_WEEK_CONTEXT_SCHEMA_VERSION, type AIGenerateWeekContext } from './generateWeekContextTypes.js';
import { newId } from '../../repositories/ids.js';
import { buildCoachingFoundationContext } from '../../coaching/foundationContext.js';

const NON_NEGOTIABLE_PRIORITY_HIERARCHY = [
  'Aesthetics/physique development is the primary programming objective.',
  'Athletic capability/endurance supports aesthetics unless the user explicitly prioritizes it otherwise.',
  "Active growth goals receive extra emphasis, with the user's own ranking preserved exactly as given.",
  'Maintenance of the rest of the physique remains part of every program — a goal target is never the only thing trained.',
  "When a target's realistic weekly volume across this week's own compatible sessions would make one or more sessions unrealistically long, prefer distributing/deferring the lower-priority remainder across this week's own other compatible sessions over cramming everything into one session. A real, meaningful deferral is safe — it is genuinely picked up as next week's own carryover, never silently lost.",
];

const FORBIDDEN_BEHAVIORS = [
  'Do not invent an exercise ID that is not present in the supplied validExercises catalogue for the chosen target.',
  'Do not treat Blueprint package membership as an eligibility gate — every listed validExercises entry is a valid choice.',
  "Do not inflate authored set counts beyond an exercise's authoredPrescription.sets when one is present.",
  'Do not filter exercise selection by available equipment or session time — those are informational only in this milestone.',
  'Do not return fewer or more than exactly 7 days, or any date outside this week.',
  'Do not claim to modify historical/completed performance — there is none for a brand-new week.',
  'Do not return raw HTML, executable code, SQL, or any database instruction.',
  'Do not rely on any information from a prior request — this context is fully self-contained.',
  "Keep each exercise's rationale to one short phrase (a few words), not a sentence or paragraph — a full week's worth of exercises makes verbose rationale the single largest driver of output size.",
  'Return only the requested JSON object — no prose outside it.',
];

export function buildGenerateWeekContext(db: Database.Database, weekStart: string): AIGenerateWeekContext {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) {
    throw new AIContextIncompleteError(['no TrainingProfile exists for this user yet — create one first (PUT /api/training-profile)']);
  }

  const currentDate = weekStart;
  const weekEnd = addDays(weekStart, 6);
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

  const goalsRepo = new GoalsRepo(db);
  const assessmentsRepo = new AestheticAssessmentsRepo(db);
  const activeGoals: AIProgrammerActiveGoalContext[] = goalsRepo
    .list({ active: true })
    .map((goal) => {
      let displayName = goal.blueprint_ref;
      try {
        const resolved = goalsRepo.resolveBlueprint(goal.id);
        displayName = resolved && 'display_name' in resolved ? resolved.display_name : (resolved?.name ?? goal.blueprint_ref);
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
  // historyAsOfDate = weekStart: this week has not started yet, so real
  // training history is read exactly as of its own first day — the same
  // convention computeFreshWeek uses when generating a week for the
  // first time (see its own doc comment on historyAsOfDate).
  const planInput = assembleWeeklyPlanInput(db, weekStart, budgetMinutes, currentDate);
  // No single target day exists for a whole-week generation — recovery
  // is evaluated per-day by the AI itself from routine.week, so no
  // day-specific "other activity today" signal is meaningful here
  // (matches AITargetNotEditableError's sibling paths' own explicit
  // fallback of [] when no specific day applies).
  const targets = buildTargetContexts(planInput, currentDate, [], missingData);
  const intensityTechniqueCatalogue = buildIntensityTechniqueCatalogue(targets);

  // No persisted week exists yet (the only reason this builder ever
  // runs) — both calls below already support that absence explicitly,
  // the same case reconciliationContextBuilder.ts hits whenever a week
  // is reconciled before it was ever generated.
  const crossWeek = buildCrossWeekContext(db, weekStart, planInput, undefined);
  const coachingFoundation = buildCoachingFoundationContext(db, {
    programId: user.id,
    referenceDate: currentDate,
    weekBoundary: profile.week_start_day,
    weekStart,
    targetIds: targets.map((t) => t.targetId),
    persistedWeekSessions: [],
  });

  const contextWithoutVolatileFields = {
    schemaVersion: AI_GENERATE_WEEK_CONTEXT_SCHEMA_VERSION,
    mode: 'generate_week' as const,
    weekStart,
    currentDate,
    timezone: profile.timezone,
    reportingBoundary: { weekStartsOn: 'monday' as const, weekEndsOn: 'sunday' as const, weekStart, weekEnd },
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
    routine: { week },
    targets,
    intensityTechniqueCatalogue,
    crossWeek,
    coachingFoundation,
    executionContext: {
      programmingFilteringAllowed: false as const,
      note: 'The user handles equipment/time substitutions and session truncation manually — this field is informational only, never a selection filter.',
    },
    outputRequirements: {
      outputSchemaVersion: 'ai-generate-week.v1',
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
    contextId: newId('aigwctx'),
    contextHash,
    generatedAt: new Date().toISOString(),
    diagnostics: { warnings: diagnosticsWarnings, missingData, approxContextSizeChars },
  };
}
