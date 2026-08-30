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
import { fitToTimeBudget, filterEquipmentFeasible, isBodyFocusAllowedOnDay, isLowerBodyPhysiqueTarget, type FittableItem } from './constraintEngine.js';
import { daysBetween } from './dateMath.js';
import { allocateFrequency, type FrequencyAllocation } from './frequencyEngine.js';
import { exercisesTrainingTarget, selectExercise, type ExerciseSelectionResult } from './exerciseSelector.js';
import { calculateExerciseExposure } from './exposureEngine.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';
import { computeProgression, type ProgressionResult } from './progressionEngine.js';
import { applyRecoveryConstraint, type RecentBadmintonSignal, type RecoveryConstraintResult } from './recoveryEngine.js';
import { allocateResource, type ResourceAllocationEntry } from './resourceAllocation.js';
import { classifyAestheticTrend, decideVolume, type AestheticProgressTrend, type VolumeDecision } from './volumeEngine.js';
import { buildTrainingState } from './trainingState.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { BadmintonSessionDetailsRepo } from '../repositories/badmintonSessionDetailsRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { OutsideBlueprintExercisesRepo } from '../repositories/outsideBlueprintExercisesRepo.js';
import type { ExerciseTargetRole } from './exerciseSelector.js';

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

/** An approved outside-Blueprint exercise, already resolved into
 * exactly what buildWorkout needs to treat it as a real selection
 * candidate for one target — remediation §10: "the actual generation
 * path must support" Blueprint-inadequate -> approved-outside-
 * Blueprint fallback, not just an unused approval API. Only exercises
 * `OutsideBlueprintExercisesRepo.listApprovedForTarget` returns (i.e.
 * already approved AND declared for this exact target) ever appear
 * here. */
export interface OutsideBlueprintCandidate {
  id: BlueprintId;
  name: string;
  role: ExerciseTargetRole;
  equipment: string[];
  reps_range: string;
  rir_range: string;
}

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
  /** Remediation §16: "secondary exposure contributions" — this
   * target's current week's secondary-role (compound-overlap) sets,
   * straight from the same TrainingExposure record
   * current_weekly_primary_sets already comes from (total_sets =
   * primary_sets + secondary_sets always; see contracts/types.ts). No
   * separate tracking mechanism — the data was already computed by
   * exposureEngine, just not previously threaded this far. */
  weekly_secondary_sets: number;
  weekly_exposure_units: number;
  rolling_exposure_units: number;
  rolling_window_days: number;
  most_recent_assessment: { rating: 1 | 2 | 3 | 4 | 5; date: string } | null;
  review_cadence_days: number;
  days_since_target_last_trained: number | null;
  /** Remediation §16: "last-trained dates" — the raw calendar date
   * days_since_target_last_trained was itself computed from, kept
   * alongside it for the machine-readable explanation object rather
   * than forcing a consumer to re-derive a date from a day-count. Null
   * under the identical condition days_since_target_last_trained is
   * null (no real touch found in the loaded history window). */
  last_trained_date: string | null;
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
  /** Approved outside-Blueprint exercises declared for this exact
   * target — remediation §10's real fallback pool, merged alongside
   * Blueprint's own candidates during selection below. Empty for most
   * targets (no proposal has ever been approved for them). */
  outside_blueprint_exercises: readonly OutsideBlueprintCandidate[];
}

export interface BuildWorkoutInput {
  date: string;
  weekday: Weekday;
  budget_minutes: number;
  available_equipment: readonly string[];
  available_training_days: readonly Weekday[];
  targets: readonly TargetBuildContext[];
  /** Days the user's TrainingProfile marks as a recurring badminton
   * commitment (remediation §9's "session distribution... day-moving"
   * — see frequencyEngine.allocateFrequency's own soft-avoidance
   * doc). Optional; defaults to none. */
  recurring_badminton_days?: readonly Weekday[];
}

/**
 * Remediation §16: "every generated workout must include a machine-
 * readable reasoning object" covering (its exact list): weekly
 * exposure, secondary exposure contributions, last-trained dates,
 * recent exercise history, progression input/output, badminton
 * context, selected exercises, rejected candidates, substitutions, and
 * the volume decision + reason. Every field here is a value this
 * pipeline already computed somewhere in `buildWorkout` — nothing is
 * re-derived or invented for this object; it exists so a caller/UI can
 * read the *why* as data instead of parsing `reasoning` prose (which
 * stays, unchanged, alongside this for a human-readable summary).
 * "Active goals, rankings" and "equipment/time constraints" are the two
 * §16 items that are necessarily whole-workout (not per-exercise)
 * concerns — see WorkoutBuildResult.active_goals/resource_allocation/
 * constraints below instead.
 */
export interface DecisionExplanation {
  classification: TargetClassification;
  weekly_exposure: {
    primary_sets: number;
    secondary_sets: number;
    exposure_units: number;
    rolling_exposure_units: number;
    rolling_window_days: number;
  };
  last_trained: { date: string | null; days_since: number | null };
  recent_exercise_ids: readonly BlueprintId[];
  badminton_context: RecentBadmintonSignal | null;
  recovery: RecoveryConstraintResult;
  volume_decision: VolumeDecision;
  /** Null when a target was skipped before frequency allocation ran
   * (e.g. an 'avoid' recovery signal, or no weekly volume recommended
   * yet) — there is nothing genuine to report yet, and this stays null
   * rather than a fabricated placeholder. */
  frequency: FrequencyAllocation | null;
  /** Null under the identical conditions as `frequency` above, plus
   * whenever no feasible/prescribed candidate existed to select from at
   * all. */
  selection: {
    decisive_gate: ExerciseSelectionResult['decisive_gate'];
    rejected_candidates: readonly BlueprintId[];
    /** The exercise this selection replaced, if selection landed on a
     * different exercise than the target's own current_exercise_id —
     * remediation §16's "substitutions." Null when the winner IS the
     * current exercise (continuity, not a substitution) or there was no
     * prior current exercise to replace. */
    substituted_from: BlueprintId | null;
  } | null;
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
  /** Remediation §16's machine-readable reasoning object — always
   * fully populated (never null) for a generated exercise, since every
   * step it draws from ran to completion by the time an exercise is
   * actually planned. */
  decision: DecisionExplanation;
}

export interface SkippedTarget {
  target_type: TargetType;
  target_id: BlueprintId;
  classification: TargetClassification;
  reason: string;
  /** As much of the same machine-readable explanation as had actually
   * been computed before this target was skipped — e.g. a target
   * skipped on an 'avoid' recovery signal carries `recovery` but null
   * `volume_decision`/`frequency`/`selection`, since this pipeline
   * never fabricates a decision it didn't reach (spec §25's rule
   * applied to explainability itself, not just prescriptions). */
  decision: Omit<DecisionExplanation, 'volume_decision' | 'frequency' | 'selection'> & {
    volume_decision: VolumeDecision | null;
    frequency: FrequencyAllocation | null;
    selection: DecisionExplanation['selection'];
  };
}

export interface WorkoutBuildResult {
  date: string;
  exercises: PlannedExercise[];
  estimated_minutes: number;
  skipped_targets: SkippedTarget[];
  reasoning_log: string[];
  /** Remediation §16's "active goals, rankings" — every distinct real
   * goal this build actually considered (the synthetic normal-
   * development/maintenance bucket is deliberately excluded — it is
   * not a user goal), with the same priority and aesthetic-progress
   * trend used throughout this build. */
  active_goals: Array<{ goal_id: string; priority: number; trend: AestheticProgressTrend }>;
  /** Remediation §17/§16: the real allocateResource() output that
   * decided today's goal-level time-budget split — see the "Remediation
   * §17" block below for how it's produced. */
  resource_allocation: readonly ResourceAllocationEntry[];
  /** Remediation §16's "equipment/time constraints" — the exact inputs
   * every equipment-feasibility check and the time-budget split above
   * were run against, echoed here rather than requiring a caller to
   * hold onto its own BuildWorkoutInput to know what was applied. */
  constraints: { available_equipment: readonly string[]; budget_minutes: number };
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
  const candidates: Array<FittableItem & { goal_id: string; planned: Omit<PlannedExercise, 'estimated_minutes'> }> = [];
  const plannedExerciseIdsSoFar: BlueprintId[] = [];
  // Remediation §17/resourceAllocation.ts: this target's aesthetic
  // trend is identical across every target belonging to the same real
  // goal (assembleAndBuildWorkout applies one goal-level
  // most_recent_assessment to every one of that goal's PrioritizedTargets)
  // and is always 'insufficient_data' for the synthetic non-
  // specialization bucket (no goal, so no assessment) — so it's safe to
  // just overwrite per goal_id as targets are processed, one clean
  // per-goal value falls out with no separate aggregation step.
  const goalTrend = new Map<string, AestheticProgressTrend>();

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

    // Remediation §16: the machine-readable explanation object, built
    // incrementally as this target's own real decisions actually run —
    // every field below is a value already computed for this exact
    // target elsewhere in this iteration, never re-derived or invented
    // for explainability's sake. `weeklyExposure`/`lastTrained` are
    // fixed for the whole iteration; `makeSkipDecision` fills in
    // whatever downstream steps (volume/frequency/selection) had
    // actually run by the time a given skip site is reached, leaving
    // the rest null rather than fabricating a decision never made.
    const weeklyExposure: DecisionExplanation['weekly_exposure'] = {
      primary_sets: target.current_weekly_primary_sets,
      secondary_sets: target.weekly_secondary_sets,
      exposure_units: target.weekly_exposure_units,
      rolling_exposure_units: target.rolling_exposure_units,
      rolling_window_days: target.rolling_window_days,
    };
    const lastTrained: DecisionExplanation['last_trained'] = { date: target.last_trained_date, days_since: target.days_since_target_last_trained };
    const makeSkipDecision = (
      overrides: { volume_decision?: VolumeDecision | null; frequency?: FrequencyAllocation | null; selection?: DecisionExplanation['selection'] } = {}
    ): SkippedTarget['decision'] => ({
      classification,
      weekly_exposure: weeklyExposure,
      last_trained: lastTrained,
      recent_exercise_ids: target.recent_exercise_ids,
      badminton_context: target.recent_badminton,
      recovery,
      volume_decision: overrides.volume_decision ?? null,
      frequency: overrides.frequency ?? null,
      selection: overrides.selection ?? null,
    });

    if (recovery.priority_adjustment === 'avoid') {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: `recovery: ${recovery.reasoning}`,
        decision: makeSkipDecision(),
      });
      continue;
    }

    // Remediation §9: badminton must produce real, targeted programming
    // effects — never a blanket weekly-volume cut (that stays gated by
    // recovery_ok below, exactly as before). Scoped deliberately narrow:
    // only a lower-body physique target, and only when recent logged
    // badminton data (not e.g. a pure rolling-exposure spike) is the
    // actual trigger — badminton itself is a lower-body-dominant
    // activity, so this is where real "already loaded" overlap exists.
    const badmintonLowerBodyReduce =
      target.target_type === 'physique_target' &&
      recovery.priority_adjustment === 'reduce' &&
      recovery.badminton_triggered &&
      isLowerBodyPhysiqueTarget(target.target_id);
    if (badmintonLowerBodyReduce) {
      log.push(`${target.target_type} "${target.target_id}": recent badminton already loaded this lower-body target — trimming today's session by one set and preferring a lower-fatigue_cost exercise.`);
    }

    const trend: AestheticProgressTrend = classifyAestheticTrend(target.most_recent_assessment, input.date, target.review_cadence_days);
    goalTrend.set(target.goal_id, trend);
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
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: 'No weekly volume recommended yet for this target.',
        decision: makeSkipDecision({ volume_decision: volumeDecision }),
      });
      continue;
    }

    const frequency = allocateFrequency({
      target_type: target.target_type,
      target_id: target.target_id,
      desired_weekly_exposure_units: desiredWeekly,
      available_training_days: input.available_training_days,
      recurring_badminton_days: input.recurring_badminton_days,
    });
    log.push(`${target.target_type} "${target.target_id}": ${frequency.reasoning}`);

    if (!frequency.assigned_days.includes(input.weekday)) {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: `Not scheduled for ${input.weekday} — assigned days are ${frequency.assigned_days.join(', ') || 'none'}.`,
        decision: makeSkipDecision({ volume_decision: volumeDecision, frequency }),
      });
      continue;
    }

    const setsToday = Math.max(1, Math.ceil(desiredWeekly / frequency.sessions_per_week));

    let candidateExerciseIds = exercisesTrainingTarget(target.target_type, target.target_id);
    candidateExerciseIds = filterEquipmentFeasible(
      candidateExerciseIds.map((id) => BlueprintAdapter.getExercise(id)!),
      input.available_equipment
    ).map((e) => e.id);

    // Remediation §10: an approved outside-Blueprint exercise is a
    // real fallback candidate, merged in alongside Blueprint's own —
    // equipment-gated exactly like a Blueprint exercise (its own
    // `equipment` field satisfies the same Pick<BlueprintExercise,
    // 'equipment'> shape filterEquipmentFeasible already checks).
    const feasibleOutside = filterEquipmentFeasible(target.outside_blueprint_exercises, input.available_equipment);
    const outsideCandidatesById = new Map(feasibleOutside.map((e) => [e.id, e]));
    for (const outside of feasibleOutside) {
      if (!candidateExerciseIds.includes(outside.id)) candidateExerciseIds.push(outside.id);
    }

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
        reason: 'No equipment-feasible (and, for a lower-body target, Monday-compliant) Blueprint or approved outside-Blueprint exercise trains this target.',
        decision: makeSkipDecision({ volume_decision: volumeDecision, frequency }),
      });
      continue;
    }

    // Narrow to candidates that actually have a usable rep/RIR
    // prescription for this target BEFORE ranking — either Blueprint's
    // own development-package data, or (for an outside-Blueprint
    // candidate) the range the human supplied and this repo already
    // validated at proposal time — otherwise the top-ranked candidate
    // could be one with no prescription data, forcing an avoidable
    // skip when a still-legitimate, still-feasible alternative
    // candidate does have one (spec §5: substitute when the preferred
    // pick doesn't work out; §25: never invent a substitute
    // prescription instead).
    if (target.target_type === 'physique_target') {
      const withPrescription = candidateExerciseIds.filter((id) => outsideCandidatesById.has(id) || lookupExercisePrescription(target.target_id, id) !== null);
      if (withPrescription.length === 0) {
        skipped.push({
          target_type: target.target_type,
          target_id: target.target_id,
          classification,
          reason: 'None of the equipment-feasible candidates have a Blueprint development-package rep/RIR prescription (or an approved outside-Blueprint one) for this target — exposing this gap rather than inventing one (spec §25).',
          decision: makeSkipDecision({ volume_decision: volumeDecision, frequency }),
        });
        continue;
      }
      candidateExerciseIds = withPrescription;
    } else {
      // A functional_goal target has no Blueprint development-package
      // prescription source at all — an approved outside-Blueprint
      // exercise (with its own reps_range/rir_range) is the only real
      // candidate remediation §15 permits; Blueprint-only candidates
      // with nothing to prescribe are dropped here rather than reaching
      // selection just to be skipped afterward with no explanation of
      // why.
      const withPrescription = candidateExerciseIds.filter((id) => outsideCandidatesById.has(id));
      if (withPrescription.length > 0) candidateExerciseIds = withPrescription;
    }

    const selection = selectExercise({
      target_type: target.target_type,
      target_id: target.target_id,
      target_tier: target.tier,
      candidate_exercise_ids: candidateExerciseIds,
      recent_exercise_ids: target.recent_exercise_ids,
      current_exercise_id: target.current_exercise_id,
      exercises_already_planned_today: plannedExerciseIdsSoFar,
      outside_blueprint_candidates: new Map([...outsideCandidatesById].map(([id, e]) => [id, { role: e.role, name: e.name }])),
      prefer_lower_fatigue_cost: badmintonLowerBodyReduce,
    });
    log.push(selection.reasoning);

    // Remediation §16's "substitutions": the prior exercise this pick
    // actually replaced, distinct from mere continuity (winner === the
    // target's own current_exercise_id) or a genuinely first-time pick
    // (no current_exercise_id to replace at all).
    const selectionDecision: NonNullable<DecisionExplanation['selection']> = {
      decisive_gate: selection.decisive_gate,
      rejected_candidates: selection.rejected_candidates,
      substituted_from: target.current_exercise_id && target.current_exercise_id !== selection.exercise_id ? target.current_exercise_id : null,
    };

    const outsideSelection = outsideCandidatesById.get(selection.exercise_id);

    // Only an exact (target, exercise) match against a real Blueprint
    // development package (or an approved outside-Blueprint exercise's
    // own human-supplied range) counts — falling back to some other
    // exercise's prescription within the same package would mean
    // applying one exercise's reps/RIR to a different one, which is
    // exactly the kind of invented substitute spec §25 forbids.
    const prescription = outsideSelection
      ? { reps: outsideSelection.reps_range, rir: outsideSelection.rir_range }
      : target.target_type === 'physique_target'
        ? lookupExercisePrescription(target.target_id, selection.exercise_id)
        : null;

    if (!prescription) {
      skipped.push({
        target_type: target.target_type,
        target_id: target.target_id,
        classification,
        reason: `No Blueprint development-package rep/RIR prescription is available for "${selection.exercise_id}" against this target — exposing this gap rather than inventing a rep range (spec §25).`,
        decision: makeSkipDecision({ volume_decision: volumeDecision, frequency, selection: selectionDecision }),
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

    // Remediation §9's session-level badminton effect (see the
    // badmintonLowerBodyReduce computation above) — bounded to one set,
    // floored at 1, and stacks independently of (never replaces) the
    // progression-driven 'reduce' below; the weekly volume decision
    // itself (desiredWeekly) is never touched by either.
    if (badmintonLowerBodyReduce) {
      sessionSets = Math.max(1, sessionSets - 1);
    }

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
      goal_id: target.goal_id,
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
          (progressionDecision ? ` Progression: ${progressionDecision.recommendation} — ${progressionDecision.reasoning}` : ' First-time prescription — no prior performance of this exact exercise to progress from.') +
          (badmintonLowerBodyReduce ? ` Badminton (remediation §9): ${recovery.reasoning}` : ''),
        decision: {
          classification,
          weekly_exposure: weeklyExposure,
          last_trained: lastTrained,
          recent_exercise_ids: target.recent_exercise_ids,
          badminton_context: target.recent_badminton,
          recovery,
          volume_decision: volumeDecision,
          frequency,
          selection: selectionDecision,
        },
      },
    });
  }

  // Remediation §17: goals literally compete for the day's time budget
  // — allocateResource (resourceAllocation.ts) is the real, tested
  // module for exactly this ("use the user's explicit ranking... a
  // well-progressing #1 goal should remain protected... scarce
  // resources can be allocated to a stagnant lower-ranked goal"),
  // previously built but never called from here. Level 1: split
  // budget_minutes across goal buckets — every real active goal, plus
  // the single synthetic bucket every non-specialization target shares
  // (they all carry the same NON_SPECIALIZATION_GOAL_ID goal_id) — in
  // strict priority order, each capped at its own desired_amount (the
  // total minutes its own already-selected candidates would need).
  // Level 2: within each bucket's own capped sub-budget,
  // fitToTimeBudget picks which of that goal's own candidates actually
  // fit, using their original priority for internal tie-break exactly
  // as before this change (so within the synthetic bucket, each
  // individual non-specialization target's own 1000+index priority
  // still governs which of THOSE get dropped first).
  const candidatesByGoal = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const list = candidatesByGoal.get(c.goal_id) ?? [];
    list.push(c);
    candidatesByGoal.set(c.goal_id, list);
  }

  const allocation = allocateResource({
    resource_name: 'session_minutes',
    total_available: input.budget_minutes,
    goals: [...candidatesByGoal.entries()].map(([goalId, group]) => ({
      goal_id: goalId,
      priority: Math.min(...group.map((c) => c.priority)),
      desired_amount: group.reduce((sum, c) => sum + c.estimated_minutes, 0),
      progress_status: goalTrend.get(goalId),
    })),
  });
  if (allocation.allocations.length > 0) {
    log.push(`Goal-level time allocation (spec §17): ${allocation.allocations.map((a) => a.reasoning).join(' ')}`);
  }

  const exercises: PlannedExercise[] = [];
  let totalMinutes = 0;
  for (const entry of allocation.allocations) {
    const group = candidatesByGoal.get(entry.goal_id) ?? [];
    const fitted = fitToTimeBudget(group, entry.allocated_amount);
    log.push(fitted.reasoning);
    totalMinutes += fitted.total_minutes;
    exercises.push(...fitted.kept.map((c) => ({ ...c.planned, estimated_minutes: c.estimated_minutes })));
    for (const dropped of fitted.dropped) {
      skipped.push({
        target_type: dropped.planned.target_type,
        target_id: dropped.planned.target_id,
        classification: dropped.planned.classification,
        reason: `Dropped by time-fitting within its goal's allocated budget: ${fitted.reasoning}`,
        decision: dropped.planned.decision,
      });
    }
  }

  // Remediation §16's "active goals, rankings" — every distinct real
  // (is_specialization) goal among the targets this build actually
  // received, regardless of whether any of its targets ended up
  // skipped. The synthetic normal-development/maintenance bucket is
  // excluded here via the same is_specialization flag every other
  // classification decision already reads — no separate sentinel-id
  // check needed.
  const activeGoalIds = [...new Set(input.targets.filter((t) => t.is_specialization).map((t) => t.goal_id))];
  const activeGoals = activeGoalIds.map((goalId) => ({
    goal_id: goalId,
    priority: Math.min(...input.targets.filter((t) => t.goal_id === goalId).map((t) => t.goal_priority)),
    trend: goalTrend.get(goalId) ?? ('insufficient_data' as AestheticProgressTrend),
  }));

  return {
    date: input.date,
    exercises,
    estimated_minutes: totalMinutes,
    skipped_targets: skipped,
    reasoning_log: log,
    active_goals: activeGoals,
    resource_allocation: allocation.allocations,
    constraints: { available_equipment: input.available_equipment, budget_minutes: input.budget_minutes },
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
  const outsideRepo = new OutsideBlueprintExercisesRepo(db);

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
      weekly_secondary_sets: weekly?.secondary_sets ?? 0,
      weekly_exposure_units: weekly?.exposure_units ?? 0,
      rolling_exposure_units: rolling?.exposure_units ?? 0,
      rolling_window_days: state.rolling_window_days,
      most_recent_assessment: mostRecentAssessment,
      review_cadence_days: reviewCadenceDays,
      days_since_target_last_trained: mostRecentTouch ? daysBetween(mostRecentTouch.date, date) : null,
      last_trained_date: mostRecentTouch?.date ?? null,
      recent_badminton: recentBadmintonSignal,
      recent_exercise_ids: [...new Set(touches.map((t) => t.exercise_id))],
      current_exercise_id: mostRecentTouch?.exercise_id ?? null,
      exercise_history: exerciseHistory,
      outside_blueprint_exercises: outsideRepo.listApprovedForTarget(targetType, targetId).map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
        equipment: e.equipment,
        reps_range: e.reps_range,
        rir_range: e.rir_range,
      })),
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

  // Remediation §9: the recurring badminton days this user's own
  // TrainingProfile already records (`other_activity_schedule` —
  // "reduced training/recovery capacity, not just ignore," per that
  // field's own doc comment) are the real input frequencyEngine's
  // soft day-avoidance needs — never re-derived or guessed here.
  const recurringBadmintonDays = (state.training_profile?.other_activity_schedule ?? [])
    .filter((a) => a.activity_type === 'badminton')
    .map((a) => a.day);

  return buildWorkout({
    date,
    weekday,
    budget_minutes: budgetMinutes,
    available_equipment: state.training_profile?.available_equipment ?? [],
    available_training_days: state.training_profile?.training_days ?? [],
    targets,
    recurring_badminton_days: recurringBadmintonDays,
  });
}
