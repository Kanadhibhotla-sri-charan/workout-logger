// Workout Builder — Next Phase spec §19 (the 22-step deterministic
// daily workout generation pipeline).
//
// Split like trainingState.ts (§32's pure/impure boundary): `buildWorkout`
// is pure — it takes already-gathered plain data (per-target context
// assembled by the caller) and composes the already-real engines
// (exposureEngine's numbers, volumeEngine, frequencyEngine,
// recoveryEngine, exerciseSelector, constraintEngine.fitToTimeBudget) in
// the spec's own step order. `assembleWorkoutBuildInput` is the one
// impure function that reads the database (TrainingState,
// AestheticAssessmentsRepo, BadmintonSessionDetailsRepo) to build that
// per-target context.
//
// What this pipeline does NOT do, and why, is as important as what it
// does:
//   - It never invents a rep range or RIR target. Blueprint's own
//     development packages (src/blueprint/developmentPackages.ts) are
//     the only source for target_reps_min/max — a target/exercise
//     combination with no matching package entry is skipped and
//     surfaced in `skipped_targets`, never filled in with a guess
//     (spec §25).
//   - It never authorizes a volume increase from stagnation alone —
//     volumeEngine.decideVolume is always called with
//     introspection_confirmed_no_other_explanation left false here,
//     because this pipeline cannot itself verify the §11 checklist
//     (that requires human judgment or a future, richer pipeline
//     stage); "maintain"/"introspect_needed" is the correct, honest
//     outcome for a stagnant target, not a limitation to work around.
//   - It never re-derives per-set duration from Blueprint data (none
//     exists) — TIME_ESTIMATION (config.ts, [DEFAULT]) is the single,
//     visible, documented estimate used to feed constraintEngine
//     .fitToTimeBudget.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { lookupExercisePrescription, parseRange } from '../blueprint/developmentPackages.js';
import type { BadmintonIntensity, BlueprintId, Set as LoggedSet, Weekday } from '../contracts/types.js';
import { WEEKDAYS } from '../contracts/types.js';
import { REVIEW_CADENCE_DEFAULT_DAYS, TIME_ESTIMATION } from './config.js';
import { fitToTimeBudget, filterEquipmentFeasible, isBodyFocusAllowedOnDay, type FittableItem } from './constraintEngine.js';
import { daysBetween } from './dateMath.js';
import { allocateFrequency } from './frequencyEngine.js';
import { exercisesTrainingTarget, selectExercise } from './exerciseSelector.js';
import { calculateExerciseExposure } from './exposureEngine.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';
import { computeProgression, type ProgressionResult } from './progressionEngine.js';
import { applyRecoveryConstraint, type RecentBadmintonSignal } from './recoveryEngine.js';
import { classifyAestheticTrend, decideVolume, type AestheticProgressTrend } from './volumeEngine.js';
import { buildTrainingState } from './trainingState.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { BadmintonSessionDetailsRepo } from '../repositories/badmintonSessionDetailsRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';

/** One prior session's actual logged sets for a specific exercise —
 * ground truth, never a planned/target value (ExercisePerformance's
 * Set[] vs. ProgramSessionExercise's target_* fields stay distinct
 * everywhere in this app; see src/contracts/types.ts). */
export interface ExerciseSessionHistory {
  date: string;
  sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>;
}

/** Remediation §7.1/§14: every relevant target is classified so the
 * two-active-aesthetic-goal limit never means "only two muscles get
 * trained." 'specialization' = tied to an active goal's own
 * PriorityMap; 'normal_development' = not goal-tied, currently at zero
 * direct volume, needs building up; 'maintenance' = not goal-tied,
 * already carries some volume, gets upkeep work rather than
 * unnecessary extra. The last two are both derived from the SAME
 * volumeEngine.decideVolume call every target already goes through —
 * no separate classification formula, just reading its real action. */
export type TargetClassification = 'specialization' | 'normal_development' | 'maintenance';

/** Everything buildWorkout needs for one target, already gathered by
 * the caller (normally assembleWorkoutBuildInput) — no database access
 * happens below this type. */
export interface TargetBuildContext {
  target_type: TargetType;
  target_id: BlueprintId;
  tier: TargetPriorityTier;
  /** True for a target reached via an active goal's own PriorityMap;
   * false for a target this pipeline is covering only because
   * remediation §7.1 requires the whole physique to stay programmed,
   * not just specialization targets. Drives `classification` below —
   * see its doc comment. */
  is_specialization: boolean;
  goal_id: string;
  goal_priority: number;
  current_weekly_primary_sets: number;
  weekly_exposure_units: number;
  rolling_exposure_units: number;
  rolling_window_days: number;
  most_recent_assessment: { rating: 1 | 2 | 3 | 4 | 5; date: string } | null;
  review_cadence_days: number;
  days_since_target_last_trained: number | null;
  recent_badminton: RecentBadmintonSignal | null;
  recent_exercise_ids: readonly BlueprintId[];
  current_exercise_id: BlueprintId | null;
  /** Real prior-session actual sets, keyed by exercise id (any
   * exercise that has ever meaningfully touched this target within
   * the loaded history window), most-recent-session-first — the
   * per-exercise input progressionEngine.computeProgression needs.
   * Remediation §6: "a progression engine that is not consumed by the
   * workout builder is incomplete." */
  exercise_history: Readonly<Record<BlueprintId, readonly ExerciseSessionHistory[]>>;
}

export interface BuildWorkoutInput {
  date: string;
  weekday: Weekday;
  budget_minutes: number;
  available_equipment: readonly string[];
  available_training_days: readonly Weekday[];
  targets: readonly TargetBuildContext[];
}

export interface PlannedExercise {
  exercise_id: BlueprintId;
  target_type: TargetType;
  target_id: BlueprintId;
  role: string;
  classification: TargetClassification;
  target_sets: number;
  target_reps_min: number;
  target_reps_max: number;
  target_rir_min: number;
  target_rir_max: number;
  estimated_minutes: number;
  /** The single most recent actual logged performance of this exact
   * exercise, if any — distinguished from the planned target above,
   * per remediation §6.2 ("the output must distinguish: planned
   * target; previous result; progression decision"). */
  previous_performance: { date: string; weight: number | null; reps: number | null } | null;
  /** Real progressionEngine.computeProgression output when usable
   * prior history for this exact exercise exists; null for a
   * first-time prescription (Blueprint's own baseline reps/RIR only —
   * there is nothing yet to progress from). */
  progression_decision: ProgressionResult | null;
  reasoning: string;
}

export interface SkippedTarget {
  target_type: TargetType;
  target_id: BlueprintId;
  classification: TargetClassification;
  reason: string;
}

export interface WorkoutBuildResult {
  date: string;
  exercises: PlannedExercise[];
  estimated_minutes: number;
  skipped_targets: SkippedTarget[];
  reasoning_log: string[];
}

function estimateMinutes(sets: number): number {
  const workMinutes = (sets * (TIME_ESTIMATION.secondsPerWorkingSet + TIME_ESTIMATION.restSecondsBetweenSets)) / 60;
  return Math.round((workMinutes + TIME_ESTIMATION.setupMinutesPerExercise) * 10) / 10;
}

/**
 * Pure pipeline: composes exposureEngine's numbers (already in each
 * TargetBuildContext), volumeEngine, frequencyEngine, recoveryEngine,
 * exerciseSelector, Blueprint's development-package rep/RIR data, and
 * constraintEngine.fitToTimeBudget into a concrete workout for one day.
 * Deterministic — identical input always produces identical output.
 */
export function buildWorkout(input: BuildWorkoutInput): WorkoutBuildResult {
  const log: string[] = [];
  const skipped: SkippedTarget[] = [];
  const candidates: Array<FittableItem & { planned: Omit<PlannedExercise, 'estimated_minutes'> }> = [];
  const plannedExerciseIdsSoFar: BlueprintId[] = [];

  const orderedTargets = [...input.targets].sort((a, b) =>
    a.goal_priority !== b.goal_priority ? a.goal_priority - b.goal_priority : a.target_id.localeCompare(b.target_id)
  );

  for (const target of orderedTargets) {
    // Remediation §7.1/§14: classification is derived once, up front,
    // from data already on the target — not a separate formula, and
    // not something later steps can silently override. A
    // specialization target is always 'specialization' regardless of
    // its current volume; a non-goal target is 'normal_development'
    // when it currently has zero direct volume (this pipeline's only
    // path to volumeEngine returning 'increase' for a non-specialization
    // target — see volumeEngine.decideVolume's §9 starting-volume
    // branch) and 'maintenance' otherwise.
    const classification: TargetClassification = target.is_specialization
      ? 'specialization'
      : target.current_weekly_primary_sets === 0
        ? 'normal_development'
        : 'maintenance';

    const recovery = applyRecoveryConstraint({
      target_type: target.target_type,
      target_id: target.target_id,
      weekly_exposure_units: target.weekly_exposure_units,
      rolling_exposure_units: target.rolling_exposure_units,
      rolling_window_days: target.rolling_window_days,
      days_since_target_last_trained: target.days_since_target_last_trained,
      recent_badminton: target.recent_badminton,
      other_activity_today: [],
    });

    if (recovery.priority_adjustment === 'avoid') {
      skipped.push({ target_type: target.target_type, target_id: target.target_id, classification, reason: `recovery: ${recovery.reasoning}` });
      continue;
    }

    const trend: AestheticProgressTrend = classifyAestheticTrend(target.most_recent_assessment, input.date, target.review_cadence_days);
    const volumeDecision = decideVolume({
      target_type: target.target_type,
      target_id: target.target_id,
      goal_priority: target.goal_priority,
      current_weekly_primary_sets: target.current_weekly_primary_sets,
      aesthetic_progress_trend: trend,
      recovery_ok: recovery.priority_adjustment !== 'reduce',
      // This pipeline cannot itself verify the §11 introspection
      // checklist (exercise selection quality, redundancy, compound
      // overlap — several of those require cross-target comparison a
      // per-target loop doesn't have). "introspect_needed" is therefore
      // the correct, honest outcome here for a stagnant target, not a
      // gap to paper over.
      introspection_confirmed_no_other_explanation: false,
    });
    log.push(`${target.target_type} "${target.target_id}": ${volumeDecision.reasoning}`);

    const desiredWeekly = volumeDecision.action === 'increase' ? volumeDecision.recommended_weekly_primary_sets : target.current_weekly_primary_sets;
    if (desiredWeekly <= 0) {
      skipped.push({ target_type: target.target_type, target_id: target.target_id, classification, reason: 'No weekly volume recommended yet for this target.' });
      continue;
    }

    const frequency = allocateFrequency({
      target_type: target.target_type,
      target_id: target.target_id,
      desired_weekly_exposure_units: desiredWeekly,
      available_training_days: input.available_training_days,
    });
    log.push(`${target.target_type} "${target.target_id}": ${frequency.reasoning}`);

    if (!frequency.assigned_days.includes(input.weekday)) {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: `Not scheduled for ${input.weekday} — assigned days are ${frequency.assigned_days.join(', ') || 'none'}.`,
      });
      continue;
    }

    const setsToday = Math.max(1, Math.ceil(desiredWeekly / frequency.sessions_per_week));

    let candidateExerciseIds = exercisesTrainingTarget(target.target_type, target.target_id);
    candidateExerciseIds = filterEquipmentFeasible(
      candidateExerciseIds.map((id) => BlueprintAdapter.getExercise(id)!),
      input.available_equipment
    ).map((e) => e.id);
    // Defensive double-check of §16's Monday rule: frequencyEngine
    // already refuses to assign a lower-body target to Monday (so the
    // "not scheduled for {weekday}" skip above should already have
    // caught this), but this guards against reaching here anyway.
    if (target.target_type === 'physique_target' && !isBodyFocusAllowedOnDay(target.target_id, input.weekday)) {
      candidateExerciseIds = [];
    }

    if (candidateExerciseIds.length === 0) {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: 'No equipment-feasible (and, for a lower-body target, Monday-compliant) Blueprint exercise trains this target.',
      });
      continue;
    }

    // Narrow to candidates that actually have a real Blueprint
    // development-package prescription for this target BEFORE ranking
    // — otherwise the top-ranked candidate could be one with no
    // prescription data, forcing an avoidable skip when a
    // still-legitimate, still-feasible alternative candidate does have
    // one (spec §5: substitute when the preferred pick doesn't work
    // out; §25: never invent a substitute prescription instead).
    if (target.target_type === 'physique_target') {
      const withPrescription = candidateExerciseIds.filter((id) => lookupExercisePrescription(target.target_id, id) !== null);
      if (withPrescription.length === 0) {
        skipped.push({
          target_type: target.target_type,
          target_id: target.target_id,
          classification,
          reason: 'None of the equipment-feasible candidates have a Blueprint development-package rep/RIR prescription for this target — exposing this gap rather than inventing one (spec §25).',
        });
        continue;
      }
      candidateExerciseIds = withPrescription;
    }

    const selection = selectExercise({
      target_type: target.target_type,
      target_id: target.target_id,
      target_tier: target.tier,
      candidate_exercise_ids: candidateExerciseIds,
      recent_exercise_ids: target.recent_exercise_ids,
      current_exercise_id: target.current_exercise_id,
      exercises_already_planned_today: plannedExerciseIdsSoFar,
    });
    log.push(selection.reasoning);

    // Only an exact (target, exercise) match against a real Blueprint
    // development package counts — falling back to some other
    // exercise's prescription within the same package would mean
    // applying one exercise's reps/RIR to a different one, which is
    // exactly the kind of invented substitute spec §25 forbids.
    const prescription = target.target_type === 'physique_target' ? lookupExercisePrescription(target.target_id, selection.exercise_id) : null;

    if (!prescription) {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: `No Blueprint development-package rep/RIR prescription is available for "${selection.exercise_id}" against this target — exposing this gap rather than inventing a rep range (spec §25).`,
      });
      continue;
    }

    const reps = parseRange(prescription.reps);
    const rir = parseRange(prescription.rir);
    plannedExerciseIdsSoFar.push(selection.exercise_id);

    // Remediation §6: a progression engine that is not consumed by the
    // workout builder is incomplete. Only exercises with usable prior
    // history for THIS exact exercise (not merely this target) get a
    // real progression decision — a first-time prescription has
    // nothing to progress from yet, and stays at Blueprint's own
    // baseline reps/RIR (progression_decision: null is the honest
    // answer, not a gap).
    const exerciseHistory = target.exercise_history[selection.exercise_id] ?? [];
    let sessionSets = setsToday;
    let progressionDecision: ProgressionResult | null = null;
    let previousPerformance: PlannedExercise['previous_performance'] = null;

    if (exerciseHistory.length > 0) {
      const mostRecent = exerciseHistory[0]!;
      const lastCompletedSet = [...mostRecent.sets].reverse().find((s) => s.completed) ?? null;
      previousPerformance = { date: mostRecent.date, weight: lastCompletedSet?.weight ?? null, reps: lastCompletedSet?.reps ?? null };

      progressionDecision = computeProgression({
        exercise_id: selection.exercise_id,
        target_reps_min: reps.min,
        target_reps_max: reps.max,
        recent_sessions_actual_sets: exerciseHistory.map((h) => h.sets),
      });
      log.push(progressionDecision.reasoning);

      // 'reduce' is the one progression outcome with a real, bounded
      // session-level effect here: one fewer set than the weekly-volume
      // math alone would call for, floored at 1 — never touching the
      // weekly volume decision itself (that stays volumeEngine's job).
      if (progressionDecision.recommendation === 'reduce') {
        sessionSets = Math.max(1, sessionSets - 1);
      }
    }

    candidates.push({
      id: selection.exercise_id,
      priority: target.goal_priority,
      estimated_minutes: estimateMinutes(sessionSets),
      planned: {
        exercise_id: selection.exercise_id,
        target_type: target.target_type,
        target_id: target.target_id,
        role: target.tier,
        classification,
        target_sets: sessionSets,
        target_reps_min: reps.min,
        target_reps_max: reps.max,
        target_rir_min: rir.min,
        target_rir_max: rir.max,
        previous_performance: previousPerformance,
        progression_decision: progressionDecision,
        reasoning:
          `${selection.reasoning} ${sessionSets} sets/session (${desiredWeekly} desired weekly, ${frequency.sessions_per_week} sessions/week). ` +
          `Reps ${reps.min}-${reps.max}, RIR ${rir.min}-${rir.max} per Blueprint's development package.` +
          (progressionDecision ? ` Progression: ${progressionDecision.recommendation} — ${progressionDecision.reasoning}` : ' First-time prescription — no prior performance of this exact exercise to progress from.'),
      },
    });
  }

  const fitted = fitToTimeBudget(candidates, input.budget_minutes);
  log.push(fitted.reasoning);

  for (const dropped of fitted.dropped) {
    skipped.push({
      target_type: dropped.planned.target_type,
      target_id: dropped.planned.target_id,
      classification: dropped.planned.classification,
      reason: `Dropped by time-fitting: ${fitted.reasoning}`,
    });
  }

  const exercises: PlannedExercise[] = fitted.kept.map((c) => ({ ...c.planned, estimated_minutes: c.estimated_minutes }));

  return {
    date: input.date,
    exercises,
    estimated_minutes: fitted.total_minutes,
    skipped_targets: skipped,
    reasoning_log: log,
  };
}

const WEEKDAY_INDEX: Record<Weekday, number> = Object.fromEntries(WEEKDAYS.map((d, i) => [d, i])) as Record<Weekday, number>;

function weekdayOfDate(dateIso: string): Weekday {
  // dateIso is a plain YYYY-MM-DD date string (no time component) — see
  // docs/architecture.md's timezone contract: this app never derives a
  // weekday via a Date object's own (potentially UTC-shifted) day-of-week,
  // it parses the calendar date fields directly.
  const [year, month, day] = dateIso.split('-').map(Number);
  const utcDay = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay(); // 0=Sunday
  const mondayFirstIndex = (utcDay + 6) % 7; // 0=Monday..6=Sunday
  return WEEKDAYS[mondayFirstIndex]!;
}

interface TargetTouch {
  date: string;
  exercise_id: BlueprintId;
  sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>;
}

/**
 * Remediation §4-5: builds a `target_type:target_id` -> chronological
 * (most-recent-first) list of every REAL exercise performance that gave
 * that target meaningful exposure — spec §5.1's definition exactly:
 * primary direct work OR secondary compound exposure (the same
 * primary/secondary resolution `calculateExerciseExposure` already
 * uses for the exposure numbers themselves, so "meaningfully trained"
 * means the identical thing here as it does everywhere else in this
 * app). An uncompleted set contributes nothing (rule D), matching
 * exposure accounting — `calculateExerciseExposure` only returns
 * contributions for completed sets, so this falls out for free.
 *
 * One pass over every recent session's real logged performances — the
 * production data flow the remediation spec requires
 * (`workout history -> history aggregation -> muscle exposure +
 * exercise history -> programming context -> exercise selection`),
 * not a placeholder.
 */
function gatherTargetTouches(sessionsRepo: WorkoutSessionsRepo, recentSessions: readonly { session_id: string; date: string }[]): Map<string, TargetTouch[]> {
  const byTarget = new Map<string, TargetTouch[]>();
  for (const session of recentSessions) {
    for (const performance of sessionsRepo.getExercisePerformances(session.session_id)) {
      const { contributions } = calculateExerciseExposure(performance.exercise_id, performance.sets);
      for (const c of contributions) {
        const key = `${c.target_type}:${c.target_id}`;
        const list = byTarget.get(key) ?? [];
        list.push({ date: session.date, exercise_id: performance.exercise_id, sets: performance.sets });
        byTarget.set(key, list);
      }
    }
  }
  for (const list of byTarget.values()) {
    list.sort((a, b) => b.date.localeCompare(a.date));
  }
  return byTarget;
}

/**
 * The impure boundary (like trainingState.ts): reads TrainingState plus
 * AestheticAssessmentsRepo, BadmintonSessionDetailsRepo, and real
 * exercise-performance history, and hands a plain BuildWorkoutInput to
 * the pure buildWorkout above. This is the only function in this
 * module that touches the database.
 */
export function assembleAndBuildWorkout(db: Database.Database, date: string, budgetMinutes: number): WorkoutBuildResult {
  const state = buildTrainingState(db, date);
  const weekday = weekdayOfDate(date);
  const assessmentsRepo = new AestheticAssessmentsRepo(db);
  const badmintonRepo = new BadmintonSessionDetailsRepo(db);
  const sessionsRepo = new WorkoutSessionsRepo(db);

  const weeklyByTarget = new Map(state.weekly_exposure.map((e) => [`${e.target_type}:${e.target_id}`, e]));
  const rollingByTarget = new Map(state.rolling_exposure.map((e) => [`${e.target_type}:${e.target_id}`, e]));
  const touchesByTarget = gatherTargetTouches(sessionsRepo, state.recent_sessions);

  const recentBadmintonSessions = state.recent_sessions.filter((s) => s.session_type === 'badminton').sort((a, b) => b.date.localeCompare(a.date));
  const mostRecentBadminton = recentBadmintonSessions[0];
  const badmintonDetails = mostRecentBadminton ? badmintonRepo.get(mostRecentBadminton.session_id) : undefined;
  const recentBadmintonSignal: RecentBadmintonSignal | null =
    badmintonDetails && badmintonDetails.intensity
      ? { intensity: badmintonDetails.intensity as BadmintonIntensity, post_session_fatigue: badmintonDetails.post_session_fatigue }
      : null;

  /** Builds one TargetBuildContext from real exposure/history data —
   * shared by both the goal-linked loop below and the remediation
   * §7.1 normal-development/maintenance loop that follows it, so the
   * two paths can never drift into gathering data differently. */
  function makeTargetContext(
    targetType: TargetType,
    targetId: BlueprintId,
    tier: TargetPriorityTier,
    isSpecialization: boolean,
    goalId: string,
    goalPriority: number,
    reviewCadenceDays: number,
    mostRecentAssessment: { rating: 1 | 2 | 3 | 4 | 5; date: string } | null
  ): TargetBuildContext {
    const key = `${targetType}:${targetId}`;
    const weekly = weeklyByTarget.get(key);
    const rolling = rollingByTarget.get(key);
    const touches = touchesByTarget.get(key) ?? [];
    const mostRecentTouch = touches[0];

    // Group this target's touches by exercise id — the per-exercise
    // (not per-target) history progressionEngine actually needs.
    // touches is already most-recent-first (gatherTargetTouches sorts
    // it), so each exercise's list stays most-recent-first too.
    const exerciseHistory: Record<BlueprintId, ExerciseSessionHistory[]> = {};
    for (const touch of touches) {
      (exerciseHistory[touch.exercise_id] ??= []).push({ date: touch.date, sets: touch.sets });
    }

    return {
      target_type: targetType,
      target_id: targetId,
      tier,
      is_specialization: isSpecialization,
      goal_id: goalId,
      goal_priority: goalPriority,
      current_weekly_primary_sets: weekly?.primary_sets ?? 0,
      weekly_exposure_units: weekly?.exposure_units ?? 0,
      rolling_exposure_units: rolling?.exposure_units ?? 0,
      rolling_window_days: state.rolling_window_days,
      most_recent_assessment: mostRecentAssessment,
      review_cadence_days: reviewCadenceDays,
      days_since_target_last_trained: mostRecentTouch ? daysBetween(mostRecentTouch.date, date) : null,
      recent_badminton: recentBadmintonSignal,
      recent_exercise_ids: [...new Set(touches.map((t) => t.exercise_id))],
      current_exercise_id: mostRecentTouch?.exercise_id ?? null,
      exercise_history: exerciseHistory,
    };
  }

  const targets: TargetBuildContext[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < state.active_goals.length; i++) {
    const goal = state.active_goals[i]!;
    const priorityMap = state.priority_maps[i]!;
    const assessments = assessmentsRepo.listForGoal(goal.id);
    const mostRecentAssessment = assessments[assessments.length - 1];

    for (const t of priorityMap.targets) {
      const key = `${t.target_type}:${t.target_id}`;
      if (seen.has(key)) continue; // first (highest-priority) goal to touch a target wins
      seen.add(key);

      targets.push(
        makeTargetContext(
          t.target_type,
          t.target_id,
          t.tier,
          true,
          goal.id,
          goal.priority,
          goal.review_cadence_days,
          mostRecentAssessment ? { rating: mostRecentAssessment.rating, date: mostRecentAssessment.date } : null
        )
      );
    }
  }

  // Remediation §7.1/§14: "the two-goal limit controls specialization
  // priority — it does NOT remove chest, back, legs, shoulders, arms,
  // other relevant musculature from normal programming." Every real
  // Blueprint physique target not already covered by an active goal
  // still gets programmed here, at a synthetic priority number that
  // sorts after every real goal (1000+) so specialization work is
  // always protected first by the exact same priority-ordering
  // mechanism buildWorkout and fitToTimeBudget already use — no
  // separate "protect specialization" rule needed.
  const NON_SPECIALIZATION_GOAL_ID = '__normal_development_or_maintenance__';
  const allPhysiqueTargets = [...BlueprintAdapter.getTargets()].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, physiqueTarget] of allPhysiqueTargets.entries()) {
    const key = `physique_target:${physiqueTarget.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    targets.push(
      makeTargetContext(
        'physique_target',
        physiqueTarget.id,
        'supporting',
        false,
        NON_SPECIALIZATION_GOAL_ID,
        1000 + index,
        REVIEW_CADENCE_DEFAULT_DAYS.aesthetic,
        null // no goal, so no aesthetic-assessment history applies
      )
    );
  }

  return buildWorkout({
    date,
    weekday,
    budget_minutes: budgetMinutes,
    available_equipment: state.training_profile?.available_equipment ?? [],
    available_training_days: state.training_profile?.training_days ?? [],
    targets,
  });
}
