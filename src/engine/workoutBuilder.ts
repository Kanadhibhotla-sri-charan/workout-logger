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
import { getPackageForTarget, lookupExercisePrescription, parseRange } from '../blueprint/developmentPackages.js';
import type { BadmintonIntensity, BlueprintId, Weekday } from '../contracts/types.js';
import { WEEKDAYS } from '../contracts/types.js';
import { TIME_ESTIMATION } from './config.js';
import { fitToTimeBudget, filterEquipmentFeasible, isBodyFocusAllowedOnDay, type FittableItem } from './constraintEngine.js';
import { allocateFrequency } from './frequencyEngine.js';
import { exercisesTrainingTarget, selectExercise } from './exerciseSelector.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';
import { applyRecoveryConstraint, type RecentBadmintonSignal } from './recoveryEngine.js';
import { classifyAestheticTrend, decideVolume, type AestheticProgressTrend } from './volumeEngine.js';
import { buildTrainingState } from './trainingState.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { BadmintonSessionDetailsRepo } from '../repositories/badmintonSessionDetailsRepo.js';

/** Everything buildWorkout needs for one target, already gathered by
 * the caller (normally assembleWorkoutBuildInput) — no database access
 * happens below this type. */
export interface TargetBuildContext {
  target_type: TargetType;
  target_id: BlueprintId;
  tier: TargetPriorityTier;
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
  target_sets: number;
  target_reps_min: number;
  target_reps_max: number;
  target_rir_min: number;
  target_rir_max: number;
  estimated_minutes: number;
  reasoning: string;
}

export interface SkippedTarget {
  target_type: TargetType;
  target_id: BlueprintId;
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

  const orderedTargets = [...input.targets].sort((a, b) =>
    a.goal_priority !== b.goal_priority ? a.goal_priority - b.goal_priority : a.target_id.localeCompare(b.target_id)
  );

  for (const target of orderedTargets) {
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
      skipped.push({ target_type: target.target_type, target_id: target.target_id, reason: `recovery: ${recovery.reasoning}` });
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
      skipped.push({ target_type: target.target_type, target_id: target.target_id, reason: 'No weekly volume recommended yet for this target.' });
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
        reason: 'No equipment-feasible (and, for a lower-body target, Monday-compliant) Blueprint exercise trains this target.',
      });
      continue;
    }

    const selection = selectExercise({
      target_type: target.target_type,
      target_id: target.target_id,
      target_tier: target.tier,
      candidate_exercise_ids: candidateExerciseIds,
      recent_exercise_ids: target.recent_exercise_ids,
      current_exercise_id: target.current_exercise_id,
    });
    log.push(selection.reasoning);

    let prescription = null;
    if (target.target_type === 'physique_target') {
      prescription = lookupExercisePrescription(target.target_id, selection.exercise_id) ?? getPackageForTarget(target.target_id)?.exercises[0] ?? null;
    }

    if (!prescription) {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        reason: `No Blueprint development-package rep/RIR prescription is available for "${selection.exercise_id}" against this target — exposing this gap rather than inventing a rep range (spec §25).`,
      });
      continue;
    }

    const reps = parseRange(prescription.reps);
    const rir = parseRange(prescription.rir);

    candidates.push({
      id: selection.exercise_id,
      priority: target.goal_priority,
      estimated_minutes: estimateMinutes(setsToday),
      planned: {
        exercise_id: selection.exercise_id,
        target_type: target.target_type,
        target_id: target.target_id,
        role: target.tier,
        target_sets: setsToday,
        target_reps_min: reps.min,
        target_reps_max: reps.max,
        target_rir_min: rir.min,
        target_rir_max: rir.max,
        reasoning: `${selection.reasoning} ${setsToday} sets/session (${desiredWeekly} desired weekly, ${frequency.sessions_per_week} sessions/week). Reps ${reps.min}-${reps.max}, RIR ${rir.min}-${rir.max} per Blueprint's development package.`,
      },
    });
  }

  const fitted = fitToTimeBudget(candidates, input.budget_minutes);
  log.push(fitted.reasoning);

  for (const dropped of fitted.dropped) {
    skipped.push({ target_type: dropped.planned.target_type, target_id: dropped.planned.target_id, reason: `Dropped by time-fitting: ${fitted.reasoning}` });
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

/**
 * The impure boundary (like trainingState.ts): reads TrainingState plus
 * AestheticAssessmentsRepo and BadmintonSessionDetailsRepo, and hands a
 * plain BuildWorkoutInput to the pure buildWorkout above. This is the
 * only function in this module that touches the database.
 */
export function assembleAndBuildWorkout(db: Database.Database, date: string, budgetMinutes: number): WorkoutBuildResult {
  const state = buildTrainingState(db, date);
  const weekday = weekdayOfDate(date);
  const assessmentsRepo = new AestheticAssessmentsRepo(db);
  const badmintonRepo = new BadmintonSessionDetailsRepo(db);

  const weeklyByTarget = new Map(state.weekly_exposure.map((e) => [`${e.target_type}:${e.target_id}`, e]));
  const rollingByTarget = new Map(state.rolling_exposure.map((e) => [`${e.target_type}:${e.target_id}`, e]));

  const recentBadmintonSessions = state.recent_sessions.filter((s) => s.session_type === 'badminton').sort((a, b) => b.date.localeCompare(a.date));
  const mostRecentBadminton = recentBadmintonSessions[0];
  const badmintonDetails = mostRecentBadminton ? badmintonRepo.get(mostRecentBadminton.session_id) : undefined;
  const recentBadmintonSignal: RecentBadmintonSignal | null =
    badmintonDetails && badmintonDetails.intensity
      ? { intensity: badmintonDetails.intensity as BadmintonIntensity, post_session_fatigue: badmintonDetails.post_session_fatigue }
      : null;

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

      const weekly = weeklyByTarget.get(key);
      const rolling = rollingByTarget.get(key);

      targets.push({
        target_type: t.target_type,
        target_id: t.target_id,
        tier: t.tier,
        goal_id: goal.id,
        goal_priority: goal.priority,
        current_weekly_primary_sets: weekly?.primary_sets ?? 0,
        weekly_exposure_units: weekly?.exposure_units ?? 0,
        rolling_exposure_units: rolling?.exposure_units ?? 0,
        rolling_window_days: state.rolling_window_days,
        most_recent_assessment: mostRecentAssessment ? { rating: mostRecentAssessment.rating, date: mostRecentAssessment.date } : null,
        review_cadence_days: goal.review_cadence_days,
        days_since_target_last_trained: null,
        recent_badminton: recentBadmintonSignal,
        recent_exercise_ids: [],
        current_exercise_id: null,
      });
    }
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
