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
import { WEEKDAYS, type ActivityType, type BlueprintId, type Weekday } from '../../contracts/types.js';
import type { TargetType } from '../../engine/goalResolver.js';
import { addDays, daysBetween, isValidCalendarDate } from '../../engine/dateMath.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import { applyRecoveryConstraint } from '../../engine/recoveryEngine.js';
import { exercisesTrainingTarget, roleFor } from '../../engine/exerciseSelector.js';
import {
  assembleWeeklyPlanInput,
  estimateMinutes,
  programmingWeekStart,
  weekdayOfDate,
  type TargetBuildContext,
  type WeeklyPlanTargetAllocation,
} from '../../engine/workoutBuilder.js';
import { developmentPackageLevelFor, getDevelopmentReference } from '../../engine/developmentReferenceEngine.js';
import { classifyAestheticTrend, decideVolume } from '../../engine/volumeEngine.js';
import { DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS, PULL_PHYSIQUE_TARGETS, PUSH_PHYSIQUE_TARGETS, SESSION_PURPOSE_TARGETS, UNIVERSAL_PHYSIQUE_TARGETS } from '../../engine/config.js';
import { applyDeloadSetVolumeReduction, DELOAD_REP_RANGE_BIAS } from '../../coaching/periodization/deloadPolicy.js';
import { getPeriodizationContext } from '../../coaching/periodization/periodizationService.js';
import { isTargetCompatibleWithPurpose, type SessionPurpose } from '../../engine/sessionPurpose.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { AestheticAssessmentsRepo } from '../../repositories/aestheticAssessmentsRepo.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo, type PersistedWeekSession } from '../../repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { AIContextIncompleteError, AITargetNotEditableError } from '../errors.js';
import { hashContext } from './programmerContextDiagnostics.js';
import { buildCoachingFoundationContext } from '../../coaching/foundationContext.js';
import { getProfile } from '../../coaching/profiles/muscleProfiles.js';
import { applyRepRangeBias } from '../../coaching/profiles/muscleProfileService.js';
import { isExerciseSuitable } from '../../engine/intensityTechniques.js';
import { ProfileFactorsRepo } from '../../repositories/profileFactorsRepo.js';
import { evaluateStructuralAdvisories, type StructuralAdvisoryTargetInput } from '../../coaching/structuralAdvisories/structuralAdvisoryService.js';
import {
  AI_PROGRAMMER_CONTEXT_SCHEMA_VERSION,
  type AICrossWeekContext,
  type AIProgrammerActiveGoalContext,
  type AIProgrammerContext,
  type AIProgrammerMuscleGuidance,
  type AIProgrammerProgrammingBrief,
  type AIProgrammerRoutineDayContext,
  type AIProgrammerTargetContext,
  type AIProgrammerValidExerciseContext,
} from './programmerContextTypes.js';
import { newId } from '../../repositories/ids.js';

const SESSION_PURPOSES: readonly SessionPurpose[] = ['push', 'pull', 'legs', 'upper'];
function isSessionPurpose(value: string): value is SessionPurpose {
  return (SESSION_PURPOSES as readonly string[]).includes(value);
}

const NON_NEGOTIABLE_PRIORITY_HIERARCHY = [
  'Aesthetics/physique development is the primary programming objective.',
  'Athletic capability/endurance supports aesthetics unless the user explicitly prioritizes it otherwise.',
  "Active growth goals receive extra emphasis, with the user's own ranking preserved exactly as given.",
  'Maintenance of the rest of the physique remains part of every program — a goal target is never the only thing trained.',
  "When a target's realistic volume for THIS session would make the session unrealistically long, prefer distributing/deferring the lower-priority remainder to that target's own next real compatible exposure (this week's other compatible day, or next week's — see crossWeek) over cramming everything into this one session. Any real, meaningful deferral is safe: unmet volume from this week is genuinely picked up as next week's own carryover, never silently lost.",
];

const FORBIDDEN_BEHAVIORS = [
  'Do not invent an exercise ID that is not present in the supplied validExercises catalogue for the chosen target.',
  'Do not treat Blueprint package membership as an eligibility gate — every listed validExercises entry is a valid choice.',
  'Do not inflate authored set counts beyond an exercise\'s authoredPrescription.sets when one is present.',
  'Do not filter exercise selection by available equipment or session time — those are informational only in this milestone.',
  'Do not target a date other than the exact requested targetDate.',
  'Do not describe, propose, or imply any change to a session in crossWeek.nextWeek — it is read-only context for this request, exactly one week ahead, never something this request creates, generates, or modifies.',
  'Do not claim to modify historical/completed performance.',
  'Do not return raw HTML, executable code, SQL, or any database instruction.',
  'Do not rely on any information from a prior request — this context is fully self-contained.',
  "Keep each exercise's rationale to one short phrase (a few words), not a sentence or paragraph, and do not repeat information already implied by its other fields (targetId, classification, sets/reps/rir).",
  'Return only the requested JSON object — no prose outside it.',
];

export function activityTypesForDailyActivity(activity: 'gym' | 'badminton' | 'both' | 'unselected'): ActivityType[] {
  return activity === 'badminton' || activity === 'both' ? ['badminton'] : [];
}

/** Shapes `assembleWeeklyPlanInput`'s per-target output into
 * `AIProgrammerTargetContext[]` — the exact per-target exposure/
 * history/recovery/valid-exercise shaping every AI context (single-
 * session generation AND week reconciliation) needs, extracted so
 * reconciliationContextBuilder.ts reuses this identical logic rather
 * than a second, drifting copy (spec: "do not duplicate exposure,
 * history, recovery, goal, or Blueprint calculations"). `evaluationDate`
 * is the date recovery/days-since-last-trained is evaluated as of (the
 * single session's targetDate, or a reconciliation's own targetDate);
 * `otherActivityToday` is that same date's non-gym activity, if any;
 * `missingData` is the caller's own diagnostics array, appended to in
 * place exactly as buildProgrammerContext already did inline. */
export function buildTargetContexts(
  planInput: { targets: readonly TargetBuildContext[] },
  evaluationDate: string,
  otherActivityToday: ActivityType[],
  missingData: string[],
  // Rule 6 fix (2026-09-19): whether a deload is currently active — the
  // SAME real signal getPeriodizationContext already computes for
  // buildProgrammingBrief, reused here (never a second, independently
  // read deload flag) so rep-range bias can be baked into
  // authoredPrescription the exact same deterministic way deload
  // set-volume already is. Defaults to false so every existing call
  // site (tests) keeps its prior behavior.
  deloadActive = false
): AIProgrammerTargetContext[] {
  return planInput.targets.map((t: TargetBuildContext) => {
    const targetLabel = t.target_type === 'physique_target' ? BlueprintAdapter.getTarget(t.target_id) : BlueprintAdapter.getFunctionalGoal(t.target_id);
    const displayName = targetLabel?.name ?? t.target_id;
    const parentRegion = targetLabel && 'parent_region' in targetLabel ? targetLabel.parent_region : null;

    const daysSinceLastTrainedAsOfTargetDate = t.last_trained_date ? daysBetween(t.last_trained_date, evaluationDate) : null;

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

    // Rule 6 fix (2026-09-19): deload's own bias overrides this muscle's
    // curated preference while active — the exact same precedence
    // workoutBuilder.ts's own rep-range-bias call site uses (never a
    // second, independently-decided precedence rule).
    const effectiveRepRangeBias = deloadActive ? DELOAD_REP_RANGE_BIAS : (getProfile(t.target_id).repRangeBias ?? 'standard');

    // Rule 6 fix: a flattened, most-recent-first timeline of every real
    // logged use of ANY exercise for this target — built once per
    // target, reused by every one of its exercises below — so
    // "recentConsecutiveSessionsUsed" reflects genuine session-to-
    // session sequence, never just a per-exercise entry count.
    const targetTimelineMostRecentFirst = Object.entries(t.exercise_history)
      .flatMap(([exId, entries]) => entries.map((e) => ({ exerciseId: exId, date: e.date })))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const validExercises: AIProgrammerValidExerciseContext[] = exercisesTrainingTarget(t.target_type, t.target_id).map((exerciseId) => {
      const exercise = BlueprintAdapter.getExercise(exerciseId);
      const prescriptionEntry = lookupExercisePrescriptionAnyLevel(t.target_id, exerciseId);
      let authoredPrescription: AIProgrammerValidExerciseContext['authoredPrescription'] = null;
      if (prescriptionEntry) {
        try {
          const reps = parseRange(prescriptionEntry.reps);
          const rir = parseRange(prescriptionEntry.rir);
          const biasedReps = applyRepRangeBias(reps.min, reps.max, effectiveRepRangeBias);
          authoredPrescription = { sets: prescriptionEntry.sets, repsMin: biasedReps.min, repsMax: biasedReps.max, rirMin: rir.min, rirMax: rir.max };
        } catch {
          missingData.push(`exercise ${exerciseId} for target ${t.target_id}: malformed authored reps/rir range — omitted, not guessed`);
        }
      }

      const plausibleIntensityTechniques = exercise
        ? BlueprintAdapter.listIntensityTechniques()
            .filter((technique) => isExerciseSuitable(exerciseId, technique))
            .map((technique) => ({
              id: technique.id,
              name: technique.name,
              what: technique.what,
              whenToUse: technique.when_it_may_help,
              whenNotToUse: technique.when_not_to_use,
              fatigueImplications: technique.fatigue_time_implications,
            }))
        : [];

      let recentConsecutiveSessionsUsed = 0;
      for (const entry of targetTimelineMostRecentFirst) {
        if (entry.exerciseId !== exerciseId) break;
        recentConsecutiveSessionsUsed++;
      }

      return {
        exerciseId,
        name: exercise?.name ?? exerciseId,
        role: roleFor(exerciseId, t.target_type, t.target_id) as 'primary' | 'secondary',
        equipment: exercise?.equipment ?? [],
        authoredPrescription,
        plausibleIntensityTechniques,
        recentConsecutiveSessionsUsed,
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
}

/** Repair: closes the gap where AI generation independently invented
 * muscle allocation/set counts from raw exposure data instead of
 * reusing the deterministic engine's own "how much" logic. Every
 * number here comes from calling the EXISTING deterministic functions
 * (developmentReferenceEngine.ts, volumeEngine.ts, sessionPurpose.ts,
 * workoutBuilder.ts's estimateMinutes) with the exact same per-target
 * facts buildTargetContexts already gathered — never a second,
 * independently-derived volume system, and never re-deriving session
 * purpose (that's read from the already-persisted WeeklyProgramRepo
 * row, not recomputed).
 *
 * `weeklyProgramSessions` is every gym day's OWN persisted session for
 * this week (name = sessionPurpose, written verbatim by
 * weekProgramReconciliation.ts) — used only to count how many of this
 * week's REAL gym days are compatible with a given physique target
 * (via the same isTargetCompatibleWithPurpose the deterministic engine
 * itself uses), so a target's weekly recommendation can be divided into
 * a sensible per-session range rather than assigned wholesale to every
 * session. This mirrors, at reduced fidelity, workoutBuilder.ts's own
 * per-exposure derivation (its `compatibleDaysThisRun`/`fairShareWeekly`
 * — see docs from the read-only investigation) without duplicating that
 * function's cross-target running-state bookkeeping, which a single
 * one-session generation does not need. */
export function buildProgrammingBrief(
  targets: readonly AIProgrammerTargetContext[],
  activeGoals: readonly AIProgrammerActiveGoalContext[],
  sessionPurpose: SessionPurpose | null,
  weeklyProgramSessions: readonly Pick<PersistedWeekSession, 'name'>[],
  asOfDate: string,
  budgetMinutes: number,
  // Fix: deload's set-volume reduction was previously never applied
  // here at all — `recommendedWeeklyPrimarySets`/`recommendedSessionSets`
  // were always the FULL, non-deload numbers, leaving the AI to notice
  // "we're in a deload" (from coachingFoundation.programState) and guess
  // its own reduction, entirely unchecked. `applyDeloadSetVolumeReduction`
  // is the exact same function/formula workoutBuilder.ts's own
  // deterministic path already applies at this exact point (weekly,
  // before the per-session floor/cap math below) — never a second,
  // independently-derived reduction. Defaults to inactive so every
  // existing call site (tests, programmerAdequacyValidator.ts's own
  // comment reference) that doesn't pass this keeps its prior behavior.
  periodization: { deloadActive: boolean } = { deloadActive: false }
): AIProgrammerProgrammingBrief {
  const expectedCoverageTargetIds: readonly BlueprintId[] = sessionPurpose
    ? [...SESSION_PURPOSE_TARGETS[sessionPurpose], ...UNIVERSAL_PHYSIQUE_TARGETS]
    : [];

  const compatibleGymDaysThisWeek = (targetType: TargetType, targetId: BlueprintId): number => {
    if (targetType !== 'physique_target') return Math.max(1, weeklyProgramSessions.length);
    const count = weeklyProgramSessions.filter((s) => isSessionPurpose(s.name) && isTargetCompatibleWithPurpose(targetType, targetId, s.name)).length;
    return Math.max(1, count);
  };

  const muscles: AIProgrammerMuscleGuidance[] = targets.map((t) => {
    const level = t.targetType === 'physique_target' ? developmentPackageLevelFor(t.isSpecialization) : 'efficient';
    const developmentReference = getDevelopmentReference(t.targetType, t.targetId, level);

    const goal = t.goalId ? activeGoals.find((g) => g.goalId === t.goalId) ?? null : null;
    const trend = classifyAestheticTrend(goal?.mostRecentAssessment ?? null, asOfDate, goal?.reviewCadenceDays ?? 30);

    const volumeDecision = decideVolume({
      target_type: t.targetType,
      target_id: t.targetId,
      goal_priority: goal?.priority ?? Number.MAX_SAFE_INTEGER,
      current_weekly_primary_sets: t.currentWeeklyPrimarySets,
      aesthetic_progress_trend: trend,
      recovery_ok: t.recovery.priority_adjustment !== 'reduce',
      // Same honest limitation workoutBuilder.ts itself accepts — this
      // pipeline cannot verify the §11 introspection checklist either.
      introspection_confirmed_no_other_explanation: false,
      development_reference: developmentReference,
    });

    const recommendedWeeklyPrimarySetsBeforeDeload = volumeDecision.action === 'increase' ? volumeDecision.recommended_weekly_primary_sets : t.currentWeeklyPrimarySets;
    // Fix: the ONE place this deload reduction is applied — exactly once,
    // before any downstream floor/cap/min/max math reads it (matching
    // workoutBuilder.ts's own "avoid applying deload reduction twice"
    // discipline for its analogous `desiredWeekly`). volumeDecision's own
    // methodology is untouched — this reduces the OUTCOME, never the
    // decision logic. The AI's system instruction (rule 13) states this
    // number already reflects any active deload — the AI must never
    // apply a second reduction of its own on top of it.
    const recommendedWeeklyPrimarySets = periodization.deloadActive
      ? applyDeloadSetVolumeReduction(recommendedWeeklyPrimarySetsBeforeDeload)
      : recommendedWeeklyPrimarySetsBeforeDeload;

    const daysThisWeek = compatibleGymDaysThisWeek(t.targetType, t.targetId);
    const perExposureFloor = Math.max(0, Math.ceil(recommendedWeeklyPrimarySets / daysThisWeek));
    const cap = developmentReference.direct_sets_per_exposure;
    const max = cap ?? Math.max(perExposureFloor, recommendedWeeklyPrimarySets);
    const min = Math.min(perExposureFloor, max);

    const eligibleForThisSession =
      sessionPurpose === null || t.targetType !== 'physique_target' || isTargetCompatibleWithPurpose(t.targetType, t.targetId, sessionPurpose);

    // Rule 6 fix (2026-09-19): the exact same push/pull classification
    // the deterministic engine's own antagonist-pairing logic uses
    // (exercisePairing.ts's antagonistGroup) — never a second,
    // independently-derived taxonomy.
    const antagonistGroup: 'push' | 'pull' | null =
      t.targetType === 'physique_target'
        ? PUSH_PHYSIQUE_TARGETS.includes(t.targetId)
          ? 'push'
          : PULL_PHYSIQUE_TARGETS.includes(t.targetId)
            ? 'pull'
            : null
        : null;

    return {
      targetType: t.targetType,
      targetId: t.targetId,
      developmentLevel: developmentReference.package_id ? developmentReference.level : null,
      isGoalOriented: t.isSpecialization,
      weeklyDevelopmentReference: developmentReference.weekly_direct_set_reference,
      directSetsPerExposureCap: developmentReference.direct_sets_per_exposure,
      currentWeeklyDirectSets: t.currentWeeklyPrimarySets,
      currentWeeklySecondarySets: t.weeklySecondarySets,
      volumeAction: volumeDecision.action,
      recommendedWeeklyPrimarySets,
      recommendedSessionSets: { min, max },
      recoveryAdjustment: t.recovery.priority_adjustment,
      eligibleForThisSession,
      reasoning: volumeDecision.reasoning,
      antagonistGroup,
    };
  });

  // estimateMinutes(sets) is workoutBuilder.ts's own real per-set time
  // model — reused, never re-derived, to check whether the sum of every
  // eligible target's own MINIMUM guidance actually fits the session's
  // real time budget. Guidance only: when it doesn't fit, this reports
  // the largest total that does (via simple proportional scaling, never
  // an invented per-target reallocation — the adequacy validator and/or
  // the AI decide which targets absorb the reduction), rather than
  // silently asking for more time than the user actually has.
  const totalRecommendedSessionSets = muscles.filter((m) => m.eligibleForThisSession).reduce((sum, m) => sum + m.recommendedSessionSets.min, 0);
  const idealMinutes = estimateMinutes(totalRecommendedSessionSets);
  const approxSessionSetBudget =
    totalRecommendedSessionSets === 0
      ? muscles.length
      : idealMinutes <= budgetMinutes
        ? totalRecommendedSessionSets
        : Math.max(1, Math.floor(totalRecommendedSessionSets * (budgetMinutes / idealMinutes)));

  return {
    session: { purpose: sessionPurpose, expectedCoverageTargetIds },
    muscles,
    approxSessionSetBudget,
  };
}

/** Cross-Week Programming Intelligence Fix: shapes the bounded, read-
 * only cross-week picture both `generate-session` and `reconcile-week`
 * need — see AICrossWeekContext's own doc comment for why each field
 * exists. Reuses `planInput.nextWeekOrderedGymDays`/
 * `nextWeekSessionPurposes`/`carryoverByTarget` (assembleWeeklyPlanInput
 * already computes these for the deterministic engine's own generation
 * — never a second, independently-derived cross-week calculation here),
 * plus a single extra read-only `WeeklyProgramRepo` lookup each for next
 * week (lookahead) and this week's own already-persisted allocations
 * (forward-looking "what becomes next week's carryover"). `weekStart` is
 * THIS context's own week (never next week's), so this function derives
 * next week's date exactly as assembleWeeklyPlanInput itself does. */
export function buildCrossWeekContext(
  db: Database.Database,
  weekStart: string,
  planInput: {
    nextWeekOrderedGymDays?: readonly Weekday[];
    nextWeekSessionPurposes?: ReadonlyMap<Weekday, SessionPurpose>;
    carryoverByTarget?: ReadonlyMap<string, number>;
  },
  currentWeekProgram: { target_allocations: unknown } | undefined
): AICrossWeekContext {
  const nextWeekStart = addDays(weekStart, 7);
  const nextWeekOrderedGymDays = planInput.nextWeekOrderedGymDays ?? [];
  const nextWeekSessionPurposes = planInput.nextWeekSessionPurposes ?? new Map<Weekday, SessionPurpose>();
  const nextWeekProgram = new WeeklyProgramRepo(db).getByWeekStart(nextWeekStart);

  const days = WEEKDAYS.map((weekday, i) => {
    const date = addDays(nextWeekStart, i);
    const isGymDay = nextWeekOrderedGymDays.includes(weekday);
    const persistedPurpose = nextWeekProgram?.sessions.find((s) => s.day_index === i)?.name;
    const purpose = persistedPurpose && isSessionPurpose(persistedPurpose) ? persistedPurpose : isGymDay ? (nextWeekSessionPurposes.get(weekday) ?? null) : null;
    return { date, weekday, isGymDay, sessionPurpose: purpose };
  });

  const carryoverFromPriorWeek = Array.from(planInput.carryoverByTarget ?? new Map<string, number>(), ([key, unmet]) => {
    const separatorIndex = key.indexOf(':');
    return {
      targetType: key.slice(0, separatorIndex) as TargetType,
      targetId: key.slice(separatorIndex + 1) as BlueprintId,
      unmetDirectSetsFromPriorWeek: unmet,
    };
  });

  const currentWeekAllocationsRaw = currentWeekProgram?.target_allocations as WeeklyPlanTargetAllocation[] | null | undefined;
  const currentWeekAllocations = Array.isArray(currentWeekAllocationsRaw)
    ? currentWeekAllocationsRaw.map((a) => ({
        targetType: a.target_type,
        targetId: a.target_id,
        requiredDirectSets: a.requiredDirectSets,
        deliveredDirectSets: a.deliveredDirectSets,
        unmetDirectSets: a.unmetDirectSets,
      }))
    : null;

  return {
    carryoverFromPriorWeek,
    currentWeekAllocations,
    nextWeek: { weekStart: nextWeekStart, days, programAlreadyExists: nextWeekProgram !== undefined },
  };
}

/** Correction pass §5 (Option A): the user's stored
 * `TrainingProfile.timezone` is the single authoritative timezone for
 * every date-sensitive operation in a request — current-date
 * calculation, weekday derivation, editability, and the context's own
 * displayed `timezone` field. A request-level override was removed
 * entirely: it previously changed only the displayed `context.timezone`
 * field while `currentDate`/editability kept using the stored profile
 * timezone regardless, producing an internally inconsistent context. */
export interface BuildProgrammerContextInput {
  targetDate: string;
}

export function buildProgrammerContext(db: Database.Database, input: BuildProgrammerContextInput): AIProgrammerContext {
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

  // Fix: the same real periodization read every other planner call site
  // (workoutBuilder.ts, and per periodizationService.ts's own doc
  // comment, this "AI foundation context" too) already goes through —
  // needed so both buildTargetContexts (rep-range bias) and
  // buildProgrammingBrief (set-volume reduction) can apply the exact
  // same deload adjustments the deterministic engine applies, rather
  // than leaving either to the AI's own unchecked judgment. Moved
  // before buildTargetContexts (Rule 6 fix, 2026-09-19) specifically so
  // rep-range bias has it available. Safe to call on every generation
  // attempt (including a retried one) — a fresh reactive-trend
  // evaluation is itself rate-limited to once per real calendar day; a
  // same-day re-read never re-evaluates.
  const periodization = getPeriodizationContext(db, {
    programId: user.id,
    referenceDate: currentDate,
    weekBoundary: profile.week_start_day,
    defaultBlockLengthWeeks: DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS,
  });

  const targets: AIProgrammerTargetContext[] = buildTargetContexts(
    planInput,
    input.targetDate,
    otherActivityToday,
    missingData,
    periodization.deloadActive
  );

  // Session identity (repair): read the day's ALREADY-DECIDED purpose
  // from the persisted WeeklyProgramRepo row — `name` is exactly the
  // sessionPurpose value weekProgramReconciliation.ts wrote — rather
  // than recomputing session-purpose assignment here. null for a
  // badminton/rest/unselected day, or before any program row exists yet
  // for this week (targetDateActivity !== 'gym'/'both' in that case
  // anyway).
  const weeklyProgram = new WeeklyProgramRepo(db).getByWeekStart(weekStart);
  const weekProgramExists = weeklyProgram !== undefined;
  const targetDayIndex = WEEKDAYS.indexOf(targetWeekday);
  const targetDaySessionName = weeklyProgram?.sessions.find((s) => s.day_index === targetDayIndex)?.name;
  const sessionPurpose = targetDaySessionName && isSessionPurpose(targetDaySessionName) ? targetDaySessionName : null;

  const programmingBrief = buildProgrammingBrief(targets, activeGoals, sessionPurpose, weeklyProgram?.sessions ?? [], currentDate, budgetMinutes, {
    deloadActive: periodization.deloadActive,
  });
  const crossWeek = buildCrossWeekContext(db, weekStart, planInput, weeklyProgram);

  // Rule 6 fix (2026-09-19): the user's confirmed training-experience
  // level, when one exists — same real profile-factor read
  // workoutBuilder.ts's own WeeklyPlanInput assembly already uses
  // (ProfileFactorsRepo), never a second, independently-read source.
  const rawTrainingExperience = new ProfileFactorsRepo(db).effectiveValue(user.id, 'training_experience', currentDate);
  const trainingExperience: 'novice' | 'intermediate' | 'advanced' | null =
    rawTrainingExperience === 'novice' || rawTrainingExperience === 'intermediate' || rawTrainingExperience === 'advanced' ? rawTrainingExperience : null;

  // Rule 6 fix: real, already-computed structural-balance advisories —
  // the exact same evaluateStructuralAdvisories the deterministic
  // planner uses, fed the same real per-target facts already gathered
  // in `targets` above (never a second, independently-derived notion of
  // "how much has this target really been trained").
  const structuralAdvisoryInputs: StructuralAdvisoryTargetInput[] = targets.map((t) => ({
    target_type: t.targetType,
    target_id: t.targetId,
    is_specialization: t.isSpecialization,
    rolling_exposure_units: t.rollingExposureUnits,
    rolling_window_days: t.rollingWindowDays,
  }));
  const structuralAdvisories = evaluateStructuralAdvisories(structuralAdvisoryInputs, currentDate);

  // Coaching Depth Batch 1 §7: read-only foundation data, scoped to
  // exactly the same targets this context already covers — never a
  // second, wider target enumeration.
  const coachingFoundation = buildCoachingFoundationContext(db, {
    programId: user.id,
    referenceDate: currentDate,
    weekBoundary: profile.week_start_day,
    weekStart,
    targetIds: targets.map((t) => t.targetId),
    persistedWeekSessions: weeklyProgram?.sessions ?? [],
  });

  const contextWithoutVolatileFields = {
    schemaVersion: AI_PROGRAMMER_CONTEXT_SCHEMA_VERSION,
    mode: 'generate_session' as const,
    currentDate,
    timezone: profile.timezone,
    reportingBoundary: { weekStartsOn: 'monday' as const, weekEndsOn: 'sunday' as const, weekStart, weekEnd },
    targetDate: input.targetDate,
    targetWeekday,
    profile: {
      trainingDays: profile.training_days,
      defaultSessionDurationMinutes: profile.default_session_duration_minutes,
      minimumSessionDurationMinutes: profile.minimum_session_duration_minutes,
      maximumSessionDurationMinutes: profile.maximum_session_duration_minutes,
    },
    objectives: {
      primaryObjective:
        'Build muscle, manage/reduce excess body fat, and improve athletic endurance and capability — aesthetics/physique development is primary.',
      priorityHierarchy: NON_NEGOTIABLE_PRIORITY_HIERARCHY,
    },
    activeGoals,
    routine: { targetDateActivity, week },
    targets,
    programmingBrief,
    crossWeek,
    coachingFoundation,
    currentProgram: { weekProgramExists, targetDateLocked: false, lockReason: null },
    trainingExperience,
    structuralAdvisories,
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
