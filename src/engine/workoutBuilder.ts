// Workout Builder — Next Phase spec §19 (the 22-step deterministic
// daily workout generation pipeline).
//
// Split like trainingState.ts (§32's pure/impure boundary): `buildWorkout`
// is pure — it takes already-gathered plain data (per-target context
// assembled by the caller) and composes the already-real engines
// (exposureEngine's numbers, volumeEngine, frequencyEngine,
// recoveryEngine, exerciseSelector) in the spec's own step order.
// `assembleWorkoutBuildInput` is the one impure function that reads the
// database (TrainingState, AestheticAssessmentsRepo,
// BadmintonSessionDetailsRepo) to build that per-target context.
//
// Consolidated Fix §7/§8: session time availability and equipment
// availability have ZERO effect on generation here — constraintEngine's
// fitToTimeBudget/filterEquipmentFeasible are real, tested utilities
// still used elsewhere (the substitution endpoint, GET
// /api/programming/substitutes), but this pipeline never calls either.
// `estimated_minutes`/`availableMinutes` are carried on the output purely
// as informational display data.
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
//     visible, documented estimate surfaced as informational
//     `estimated_minutes` only; it never filters or reduces generation
//     (Consolidated Fix §7).

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { lookupExercisePrescriptionAnyLevel, parseRange } from '../blueprint/developmentPackages.js';
import type { BadmintonIntensity, BlueprintId, Set as LoggedSet, Weekday } from '../contracts/types.js';
import { WEEKDAYS } from '../contracts/types.js';
import { EXPOSURE_COEFFICIENTS, REVIEW_CADENCE_DEFAULT_DAYS, TIME_ESTIMATION } from './config.js';
import { isBodyFocusAllowedOnDay, isLowerBodyPhysiqueTarget, type FittableItem } from './constraintEngine.js';
import { addDays, daysBetween } from './dateMath.js';
import { assignSessionPurposes, isTargetCompatibleWithPurpose, type SessionPurpose } from './sessionPurpose.js';
import { exercisesTrainingTarget, selectExercise, type ExerciseSelectionResult } from './exerciseSelector.js';
import { calculateExerciseExposure } from './exposureEngine.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';
import { computeProgression, type ProgressionResult } from './progressionEngine.js';
import { applyRecoveryConstraint, type RecentBadmintonSignal, type RecoveryConstraintResult } from './recoveryEngine.js';
import type { ResourceAllocationEntry } from './resourceAllocation.js';
import { classifyAestheticTrend, decideVolume, type AestheticProgressTrend, type VolumeDecision } from './volumeEngine.js';
import { developmentPackageLevelFor, getDevelopmentReference, type DevelopmentReference } from './developmentReferenceEngine.js';
import { buildTrainingState } from './trainingState.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { BadmintonSessionDetailsRepo } from '../repositories/badmintonSessionDetailsRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { OutsideBlueprintExercisesRepo } from '../repositories/outsideBlueprintExercisesRepo.js';
import { WeekActivityOverridesRepo } from '../repositories/weekActivityOverridesRepo.js';
import { applyWeekOverrides } from '../lib/dailyActivity.js';
import type { ExerciseTargetRole } from './exerciseSelector.js';

/** Post-v2 Corrective Fix v2 §3/§7: the rolling window (in real calendar
 * days) the maximum-frequency gate counts actual exposures within — a
 * genuine calendar-week span, matching what "N exposures per week"
 * itself means, never aligned to a Monday-Sunday boundary (a trailing
 * window ending on the real day being considered, exactly like every
 * other real-date-driven computation in this module). */
const FREQUENCY_REFERENCE_WINDOW_DAYS = 7;

/** One prior session's actual logged sets for a specific exercise —
 * ground truth, never a planned/target value (ExercisePerformance's
 * Set[] vs. ProgramSessionExercise's target_* fields stay distinct
 * everywhere in this app; see src/contracts/types.ts). */
export interface ExerciseSessionHistory {
  date: string;
  sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>;
}

/** Remediation §7.1/§14, Final Pass §6/§7/§12: every relevant target is
 * classified so the two-active-aesthetic-goal limit never means "only
 * two muscles get trained." 'specialization' = tied to an active
 * goal's own PriorityMap; 'normal_development' = not goal-tied and
 * this week's real exposure (primary 1.00 + secondary 0.33 — the same
 * weekly_exposure_units every other engine already uses) sits below
 * Blueprint's own conservative starting_point_sets threshold, i.e.
 * genuinely under-trained; 'maintenance' = not goal-tied and already
 * at/above that threshold this week, whether from direct sets or
 * substantial compound overlap. Final Pass §6/§12 is explicit:
 * `current_weekly_primary_sets === 0` must NOT be treated as "zero
 * meaningful training" — compound secondary exposure counts, so this
 * classification reads the combined exposure number, never the raw
 * primary-set count alone. See rankTarget() below for exactly how. */
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
  /** Post-v2 Corrective Fix v2 §4/§6/§7: every distinct real calendar
   * date (deduped, most-recent-first) within the loaded history window
   * on which this target actually received a real DIRECT (primary-role)
   * exposure — the raw material for the rolling-window frequency gate's
   * `actual_exposure_count_in_reference_window` (frequency is NOT just
   * minimum spacing: a target due again by spacing alone can still be
   * genuinely NOT due if it already received its full frequency
   * reference's worth of real exposures within the trailing window).
   * Optional and defaulting to `last_trained_date` alone (or `[]`) when
   * omitted, so existing callers/fixtures that only ever tracked a
   * single most-recent date keep their exact prior behavior — real
   * production data (`assembleWeeklyPlanInput`) always populates the
   * full real list. */
  recent_direct_exposure_dates?: readonly string[];
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
   * commitment (remediation §9's "session distribution... day-moving").
   * Optional; defaults to none. One-Pass Dev Spec v2 §1.2/§9: the
   * calendar-week session-spreading mechanism this used to reference
   * (frequencyEngine.allocateFrequency) was confirmed dead — zero
   * production callers anywhere in the repo — and has been removed;
   * this module's own eligible-day/exposure-cycle logic below is the
   * sole real mechanism. */
  recurring_badminton_days?: readonly Weekday[];
  /** Surgical Fix Pass §4/§5: the real session length every OTHER day
   * of this same week (besides `date`) gets when this call's own real
   * weekly plan is built internally — normally the user's own
   * TrainingProfile.default_session_duration_minutes (see
   * assembleAndBuildWorkout). Optional; defaults to `budget_minutes`
   * itself, matching this function's pre-existing single-day-only
   * behavior exactly for a caller with no other real value to supply. */
  default_session_minutes?: number;
}

/**
 * Post-v2 Corrective Fix §5/§9/§29: whether this target is due for a
 * real exposure on ONE SPECIFIC real day, decided from its own ACTUAL
 * last-trained date and a Blueprint-derived expected exposure interval
 * — never from a precomputed, calendar-week-capped list of "eligible
 * days" (the prior `WeeklyAllocationDecision`/`eligible_days_this_week`/
 * `sessions_remaining_this_week` model this replaces, which made the
 * Monday-Sunday window the authoritative container for how many
 * sessions a target could ever receive). This is computed FRESH for
 * every real day a target is considered on — unlike its predecessor, it
 * is never one value "applying on every day of this real week," because
 * due-ness genuinely differs day to day as real (or, within a single
 * generation run, already-placed-earlier-this-run) exposures accrue.
 *
 * `last_exposure_date`/`days_since_last_exposure` reflect the target's
 * real actual last-trained date, advanced only by a real placement THIS
 * SAME planning run makes on an earlier real day — never reset because
 * a new calendar week began (§5.4/§8).
 */
export interface ExposureCycleDecision {
  /** This target's PPL+Upper-compatible session purpose on this real
   * day, or null for a functional_goal (purpose-agnostic — see
   * sessionPurpose.isTargetCompatibleWithPurpose). */
  session_purpose_today: SessionPurpose | null;
  /** Whether this real day's session purpose is compatible with this
   * target at all — independent of due-ness. A physique target with
   * `compatible_today: false` cannot receive direct work today
   * regardless of how due it is. */
  compatible_today: boolean;
  /** The target's most recent known (real, or already-placed-this-run)
   * direct exposure date as of this real day, or null if never trained. */
  last_exposure_date: string | null;
  /** Real calendar days between `last_exposure_date` and this real day,
   * or null when `last_exposure_date` is null (never trained). */
  days_since_last_exposure: number | null;
  /** This target's own expected interval between real exposures, in
   * days — derived from its Blueprint development-package frequency
   * reference (`direct_sets_per_exposure`'s own
   * `sessions_per_week_reference`) when one exists, or Blueprint's
   * universal `typical_starting_range_per_week` midpoint otherwise.
   * Never a hardcoded, target-specific number. This is a MINIMUM
   * spacing heuristic only (Post-v2 Corrective Fix v2 §3) — satisfying
   * it is necessary but not sufficient for `is_due_today`; see
   * `frequency_reference_per_week`/`actual_exposure_count_in_reference_window`
   * below for the separate maximum-frequency gate. */
  expected_exposure_interval_days: number;
  /** Post-v2 Corrective Fix v2 §3/§6: this target's own real exposure
   * frequency reference (exposures per week) — the SAME number
   * `expected_exposure_interval_days` was derived from
   * (`7 / frequency_reference_per_week`, floored), kept alongside it so
   * a caller never has to re-derive it. */
  frequency_reference_per_week: number;
  /** Post-v2 Corrective Fix v2 §3/§4/§7: how many real direct exposures
   * (actual logged history, plus any already-placed-earlier-this-run
   * exposure — never a future/other target's own work) fall within the
   * trailing `FREQUENCY_REFERENCE_WINDOW_DAYS`-day window ending just
   * before this real day. Minimum spacing alone is NOT a sufficient
   * frequency gate (spec §3's own worked example: a 2/week target
   * trained Monday and Thursday must not also receive a third exposure
   * on Sunday merely because 3 days have elapsed since Thursday) — this
   * count, compared against `frequency_reference_per_week`, is the
   * separate maximum-frequency gate that catches exactly that case. */
  actual_exposure_count_in_reference_window: number;
  /** Whether this target is actually due for a real exposure on this
   * specific real day: `compatible_today` AND (never trained, or
   * `days_since_last_exposure >= expected_exposure_interval_days`) AND
   * `actual_exposure_count_in_reference_window < frequency_reference_per_week`
   * — BOTH the minimum-spacing gate and the maximum-frequency gate must
   * pass; neither alone is sufficient (Post-v2 Corrective Fix v2 §3). */
  is_due_today: boolean;
  reasoning: string;
}

/**
 * Remediation §16 / Final Pass §22: "every generated workout must
 * expose machine-readable reasoning" covering (the exact list): active
 * goals, goal ranking, priority layer, weekly exposure, primary/
 * secondary exposure, last-trained dates, exercise history, progression
 * result, badminton context, recovery context, session purpose,
 * equipment/time constraints, selected exercises, rejected candidates,
 * substitutions, volume decision, weekly allocation decision. Every
 * field here is a value this pipeline already computed somewhere in
 * `buildWorkout` — nothing is re-derived or invented for this object;
 * it exists so a caller/UI can read the *why* as data instead of
 * parsing `reasoning` prose (which stays, unchanged, alongside this for
 * a human-readable summary). "Active goals, rankings" and "equipment/
 * time constraints" are the two items that are necessarily whole-
 * workout (not per-exercise) concerns — see WorkoutBuildResult.
 * active_goals/resource_allocation/constraints below instead.
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
  /** Final Pass §5/§10: today's own PPL+Upper purpose (null on a day
   * with no gym session at all). Whole-day, not per-target — every
   * target processed on the same call shares the identical value — but
   * carried here per §22's explicit "session purpose" explainability
   * requirement rather than forcing a caller to a separate lookup. */
  session_purpose: SessionPurpose | null;
  /** Null when a target was skipped before the exposure-cycle decision
   * ran for any real day (e.g. an 'avoid' recovery signal, no weekly
   * volume recommended yet, or a genuine data-integrity gap discovered
   * before any day was even considered) — there is nothing genuine to
   * report yet, and this stays null rather than a fabricated
   * placeholder. When populated on a PLACED exercise, this is the
   * specific real day's own exposure decision (Post-v2 Corrective Fix
   * §5/§9) — never a single value asserted to apply to the whole week. */
  exposure_decision: ExposureCycleDecision | null;
  /** Null under the identical conditions as `exposure_decision` above,
   * plus whenever no feasible/prescribed candidate existed to select
   * from at all. */
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
  /** Post-v2 Corrective Fix §21: the scope vocabulary this decision
   * actually belongs to — never a binary "week vs session" (which
   * itself implied the calendar week was the meaningful container).
   * `'exposure'`: an exposure-cycle-level fact, computed once per target
   * per generation run and therefore identical across every session
   * this run produces (recovery, not-yet-due, adequate coverage, no
   * recommended volume) — lets a caller tell "this target isn't due
   * right now, and here's why" apart from "this specific exercise
   * didn't fit today," never presenting the same fact as an independent
   * daily discovery. `'data_integrity'`: a genuine Blueprint data defect
   * — structurally different from an ordinary programming decision, and
   * never deduplicated alongside one. `'session'`: reserved for a
   * genuinely day-specific decision; no current mechanism produces one
   * (time/equipment do not filter generation), kept for when one
   * legitimately exists. */
  scope: 'exposure' | 'data_integrity' | 'session';
  /** Post-v2 Corrective Fix §18/§22 (superseding One-Pass Dev Spec v2
   * §18/§19's slightly different framing): the structured, discriminated
   * category this skip actually belongs to — set explicitly at the
   * exact site that decided it, never inferred later by string-matching
   * `reason`. `friendlyExplanation.ts` switches on this (never on
   * substrings of `reason`) so an unhandled/future code is a
   * compile-time error, not something that can silently fall through to
   * a generic "not prescribable" bucket.
   *
   *   - `recovery`: valid target; today's direct work is prevented by
   *     recovery state (spec §18 `recovery`).
   *   - `not_current_exposure`: valid target; not due for a real
   *     exposure right now — either no real day this run considered is
   *     compatible with it at all, or it is compatible but hasn't
   *     reached its own expected exposure interval since its last real
   *     exposure yet (spec §22: "isn't due for this exposure," never
   *     framed as "not this week"). It remains available for the next
   *     appropriate target-training session.
   *   - `adequately_covered`: valid target; today's actual/planned work
   *     already provides sufficient relevant coverage (spec §18
   *     `adequately_covered`).
   *   - `no_volume_recommended`: valid target; no weekly direct-volume
   *     objective is currently recommended for it (a real, distinct
   *     volumeEngine outcome — not one of spec §18's six named examples,
   *     which the spec explicitly allows: "only use categories that
   *     correspond to real engine facts").
   *   - `blueprint_data_integrity`: a genuine malformed/missing
   *     authoritative Blueprint record (spec §18's data-integrity
   *     category) — structurally different from the four ordinary
   *     "valid but not selected today" categories above. It must never
   *     mean "not in the current package" or "lost a ranking gate" (spec
   *     §18) — both of those are already handled upstream as ordinary
   *     candidate narrowing, never a skip. */
  reason_code: 'recovery' | 'not_current_exposure' | 'adequately_covered' | 'no_volume_recommended' | 'blueprint_data_integrity';
  reason: string;
  /** As much of the same machine-readable explanation as had actually
   * been computed before this target was skipped — e.g. a target
   * skipped on an 'avoid' recovery signal carries `recovery` but null
   * `volume_decision`/`exposure_decision`/`selection`, since this
   * pipeline never fabricates a decision it didn't reach (spec §25's
   * rule applied to explainability itself, not just prescriptions). */
  decision: Omit<DecisionExplanation, 'volume_decision' | 'exposure_decision' | 'selection'> & {
    volume_decision: VolumeDecision | null;
    exposure_decision: ExposureCycleDecision | null;
    selection: DecisionExplanation['selection'];
  };
}

export interface WorkoutBuildResult {
  date: string;
  weekday: Weekday;
  /** UI Build Phase §10/§11: this exact real day's own PPL+Upper
   * session purpose (null on a real non-gym day — rest or another
   * recurring activity) — the same value already computed once per day
   * inside buildWeeklyProgrammingPlan (WeeklyPlanSession.sessionPurpose),
   * just also surfaced on this single-day slice so a caller never has to
   * re-derive "why today looks like this" from the exercise list alone
   * (a day can legitimately have real session_purpose with zero placed
   * exercises, e.g. every target skipped). */
  session_purpose: SessionPurpose | null;
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
  /** Consolidated Fix §7: always empty now that time no longer competes
   * for or filters generation — kept only for API/type back-compat with
   * existing callers of this field. */
  resource_allocation: readonly ResourceAllocationEntry[];
  /** Remediation §16's "equipment/time constraints" — the exact inputs
   * every equipment-feasibility check and the time-budget split above
   * were run against, echoed here rather than requiring a caller to
   * hold onto its own BuildWorkoutInput to know what was applied. */
  constraints: { available_equipment: readonly string[]; budget_minutes: number };
}

/**
 * Final Surgical Fix Pass §4/§5: the complete weekly context
 * buildWeeklyProgrammingPlan needs. Distinct from BuildWorkoutInput
 * (below) — a weekly plan needs to know which real calendar date is
 * "today" (for the one real time-budget override this call actually
 * carries) separately from `weekStart` (so every OTHER day of the same
 * week can be planned too, using the profile's own default session
 * length — never invented, never "today's budget applied to every
 * day"). `available_equipment` stays one list for the whole week — the
 * real TrainingProfile schema has no per-weekday equipment override, so
 * assuming otherwise would be inventing data that doesn't exist.
 */
export interface WeeklyPlanInput {
  /** The Monday (WEEKDAYS[0]) of the real week being planned. */
  weekStart: string;
  /** The one real calendar date this call's own explicit time-budget
   * override applies to — every other day in the week uses
   * `defaultSessionMinutes` instead. */
  today: string;
  todayWeekday: Weekday;
  todayBudgetMinutes: number;
  /** The real TrainingProfile default session length — used for every
   * gym day in this week OTHER than `today`, since that's the only
   * real, non-invented value this app has for "how long is a normal
   * session," short of `today`'s own explicit override. */
  defaultSessionMinutes: number;
  available_equipment: readonly string[];
  available_training_days: readonly Weekday[];
  /** As-of-`weekStart` state for every relevant target — real logged
   * history/exposure BEFORE this weekly plan places any of its own
   * work. Compound exposure this same plan places on an earlier day
   * this week is layered on top of this baseline as planning proceeds
   * (§7's "recalculate exposure from planned work"), never baked into
   * these input values themselves. */
  targets: readonly TargetBuildContext[];
  recurring_badminton_days?: readonly Weekday[];
}

/** One real exercise placed into one real session by the weekly
 * planner — §4's PlannedWorkItem. Reuses PlannedExercise's own field
 * shapes (previous_performance/progression_decision/decision) rather
 * than inventing parallel ones. */
export interface PlannedWorkItem {
  exercise_id: BlueprintId;
  target_type: TargetType;
  target_id: BlueprintId;
  role: string;
  classification: TargetClassification;
  sets: number;
  /** Surgical Fix Pass §6/§9: this exercise's own real primary/
   * secondary exposure contribution TO ITS OWN TARGET (not to other
   * targets — see `plannedExposureByTarget` inside
   * buildWeeklyProgrammingPlan for that propagation), so
   * `rebuildTargetAllocationsFromFinalSessions` can sum a target's real
   * exposure straight from the FINAL, post-fitting `plannedWork`
   * entries that actually survived, never from a pre-fitting
   * construction-time total. Exactly one of the two is non-zero for any
   * given item (an exercise is primary or secondary for its own
   * target, never both). */
  primary_exposure: number;
  secondary_exposure: number;
  reps_min: number;
  reps_max: number;
  rir_min: number;
  rir_max: number;
  estimated_minutes: number;
  previous_performance: PlannedExercise['previous_performance'];
  progression_decision: ProgressionResult | null;
  reasoning: string;
  decision: DecisionExplanation;
}

/** One real day of the week this plan covers — §4's own `sessions[]`
 * entry. Every gym day in `available_training_days` gets one of these;
 * a non-gym day is not represented (nothing was ever asked of it). */
export interface WeeklyPlanSession {
  date: string;
  weekday: Weekday;
  sessionPurpose: SessionPurpose | null;
  availableMinutes: number;
  availableEquipment: readonly string[];
  plannedWork: PlannedWorkItem[];
  estimatedMinutes: number;
  badmintonContext: RecentBadmintonSignal | null;
  /** Targets skipped at exposure-cycle scope this generation run
   * (recovery/prescription/not-yet-due/already-adequately-covered — see
   * WeeklyProgrammingPlan.decisions for the real reason), each carrying
   * `scope: 'exposure'` or `'data_integrity'` (Post-v2 Corrective Fix
   * §21) since none of them are specific to this one date — surfaced on
   * every session because each real day legitimately needs to know why
   * a target isn't in it. Time and equipment no longer produce any
   * day-specific skip at all (§7/
   * §8), so no `scope: 'session'` entry exists here today. */
  skipped: SkippedTarget[];
  activeGoals: Array<{ goal_id: string; priority: number; trend: AestheticProgressTrend }>;
  resourceAllocation: readonly ResourceAllocationEntry[];
}

/**
 * §4's own `targetAllocations[]` entry — what the weekly planner
 * actually decided for one target across the WHOLE week, independent
 * of any single day's slice. Surgical Fix Pass §4/§6: built ONLY by
 * `rebuildTargetAllocationsFromFinalSessions`, from `sessions[]
 * .plannedWork` AFTER all resource/time fitting has already run — never
 * from pre-fitting construction totals, so this can never disagree with
 * the sessions a caller would actually see. `requiredDirectSets`,
 * `deliveredDirectSets`, and `unmetDirectSets` are three genuinely
 * different numbers, named so a reader can never mistake one for
 * another (spec §6: "do not call both values plannedDirectSets").
 */
export interface WeeklyPlanTargetAllocation {
  target_type: TargetType;
  target_id: BlueprintId;
  layer: TargetClassification;
  /** What programming determined was desirable for this target this
   * week (volumeEngine's own `desiredWeekly`, retained methodology,
   * unchanged by this pass) — captured once, independent of whatever
   * later survives fitting. */
  requiredDirectSets: number;
  /** What actually survived into the final, post-fitting
   * `sessions[].plannedWork` — the authoritative final programmed
   * amount. Always <= requiredDirectSets. */
  deliveredDirectSets: number;
  /** requiredDirectSets - deliveredDirectSets. Zero when everything
   * required was actually delivered. Never negative — a target can
   * never deliver more than was actually required, since construction
   * never starts from a higher number than volumeEngine decided. */
  unmetDirectSets: number;
  /** Summed directly from the final, post-fitting `plannedWork` items'
   * own `primary_exposure`/`secondary_exposure` fields — real exposure
   * this target actually ends up with this week, not a construction-
   * time estimate that fitting might have since invalidated. */
  plannedPrimaryExposure: number;
  plannedSecondaryExposure: number;
  allocatedSessionDates: readonly string[];
}

/**
 * Final Surgical Fix Pass §4: the required first-class in-memory
 * weekly plan. Built once per generation run by
 * buildWeeklyProgrammingPlan (below) — today's workout is then a real
 * slice of THIS object (see buildWorkout), never an independently
 * re-derived allocation. Not persisted (§23 explicitly doesn't require
 * it) — it lives only for the duration of one generation call.
 */
export interface WeeklyProgrammingPlan {
  weekStart: string;
  sessions: WeeklyPlanSession[];
  targetAllocations: WeeklyPlanTargetAllocation[];
  /** The full reasoning log for this entire weekly plan — every
   * decision any session/target reasoning string was built from,
   * chronological in the order it was actually made. */
  decisions: string[];
}

function estimateMinutes(sets: number): number {
  const workMinutes = (sets * (TIME_ESTIMATION.secondsPerWorkingSet + TIME_ESTIMATION.restSecondsBetweenSets)) / 60;
  return Math.round((workMinutes + TIME_ESTIMATION.setupMinutesPerExercise) * 10) / 10;
}

interface TargetRanking {
  target: TargetBuildContext;
  classification: TargetClassification;
  /** How far below Blueprint's own conservative starting_point_sets
   * threshold this week's REAL combined exposure (primary 1.00 +
   * secondary 0.33) sits — 0 once that threshold is met or exceeded.
   * Only meaningful for 'normal_development'; always 0 for
   * 'specialization'/'maintenance'. Final Pass §6/§12: this is the
   * real, Blueprint-grounded, data-driven signal that replaces
   * `current_weekly_primary_sets === 0` as the classification input. */
  needDeficit: number;
  /** Strict Bug-Fix §3.3's `recoveryNeed`/`recencyNeed` information
   * requirement: 0 = no recovery caution for this target today, 1 =
   * recoveryEngine flagged 'reduce', 2 = 'avoid' (already trained today
   * — this target will be skipped outright regardless of rank, but
   * still carries a real, non-zero value here so its position in
   * reasoning/explainability output is never arbitrary). A target
   * already flagged for recovery caution is genuinely less due for
   * fresh scarce-time-budget work RIGHT NOW than an equally-classified
   * target with no such flag — so higher recoveryNeed sorts LATER
   * (dropped first under a time squeeze), used only as a late tie-break
   * (see compareRankings) so it never overrides the primary
   * need/recency signal already driving each tier. */
  recoveryNeed: number;
}

/** Final Pass §6/§7/§12/§14, Strict Bug-Fix §3.3: classifies one target
 * and computes its real programming-need deficit from actual weekly
 * exposure plus its real recovery-caution level — the single source of
 * truth `orderedTargets`' sort and the per-target loop's own
 * `classification`/`recovery` both read, so the two can never drift
 * apart. `recovery` is precomputed once, before ranking, purely from
 * this target's own data (see buildWorkout's `recoveryByKey` map) — a
 * pure per-target function, so precomputing it ahead of the per-target
 * loop changes nothing about what it returns. */
/** Programming Redesign (Step 12) §3-§5: `developmentReference` is this
 * target's own Efficient-package weekly direct-set reference (only ever
 * consulted for a non-specialization/non-goal target — a specialization
 * target already short-circuits to needDeficit=0 below, exactly as
 * before) — replacing the universal `startingPointMin` (Blueprint's
 * global weekly_volume.starting_point_sets[0], the same 8 for every
 * muscle) with this specific muscle's own Blueprint-authored reference.
 * Falls back to `startingPointMin` when no package reference exists for
 * this target (e.g. a functional_goal, which Blueprint's development
 * packages don't cover). */
function rankTarget(target: TargetBuildContext, startingPointMin: number, recovery: RecoveryConstraintResult, developmentReference: DevelopmentReference | null): TargetRanking {
  const recoveryNeed = recovery.priority_adjustment === 'avoid' ? 2 : recovery.priority_adjustment === 'reduce' ? 1 : 0;
  if (target.is_specialization) return { target, classification: 'specialization', needDeficit: 0, recoveryNeed };
  const threshold = developmentReference?.weekly_direct_set_reference ?? startingPointMin;
  const needDeficit = Math.max(0, threshold - target.weekly_exposure_units);
  return { target, classification: needDeficit > 0 ? 'normal_development' : 'maintenance', needDeficit, recoveryNeed };
}

/**
 * Final Pass §7, Strict Bug-Fix §3.4: "Normal-development targets MUST
 * NOT receive artificial priority because of alphabetical ordering,
 * target ID, array position, or arbitrary numeric constants... use a
 * deterministic tie-breaker based on stable Blueprint/ID ordering only
 * after all actual programming criteria are equal." This is the ONE
 * canonical comparator (§3.4: "if the repository already has a
 * canonical rankTarget()/compareRankings(), extend and reuse it instead
 * of creating a second competing comparator") — buildWorkout's own
 * iteration order AND the real rank index fed into time-fitting (see
 * `targetRankIndex` below) both come from this single sorted order, so
 * a later stage can never silently replace it with ID/array-position
 * (Bug-Fix §3.2's "no later stage may replace programming priority").
 * Sort order, in priority:
 *   1. tier — Goal 1's own targets, then Goal 2's, then every
 *      normal_development target, then every maintenance target (the
 *      exact 4-layer hierarchy §2.3 requires);
 *   2. within normal_development — bigger real exposure deficit sorts
 *      first (more urgently under-trained);
 *   3. within maintenance — longer since the target was last
 *      meaningfully trained sorts first (more due for upkeep; never
 *      trained sorts first of all);
 *   4. recoveryNeed — a target with a live recovery-caution flag sorts
 *      after an otherwise-equal target with none (§3.3's required
 *      recoveryNeed dimension; see TargetRanking's doc comment);
 *   5. ONLY once 1-4 are genuinely tied does target_id break the tie —
 *      a stable fallback, never the deciding criterion.
 */
function compareRankings(a: TargetRanking, b: TargetRanking): number {
  const tierOf = (r: TargetRanking) => (r.target.is_specialization ? r.target.goal_priority : r.classification === 'normal_development' ? 3 : 4);
  const tierA = tierOf(a);
  const tierB = tierOf(b);
  if (tierA !== tierB) return tierA - tierB;

  if (a.classification === 'normal_development') {
    if (a.needDeficit !== b.needDeficit) return b.needDeficit - a.needDeficit;
  } else if (a.classification === 'maintenance') {
    const daysA = a.target.days_since_target_last_trained ?? Number.POSITIVE_INFINITY;
    const daysB = b.target.days_since_target_last_trained ?? Number.POSITIVE_INFINITY;
    if (daysA !== daysB) return daysB - daysA;
  }

  if (a.recoveryNeed !== b.recoveryNeed) return a.recoveryNeed - b.recoveryNeed;

  return a.target.target_id.localeCompare(b.target.target_id);
}

function targetKey(t: Pick<TargetBuildContext, 'target_type' | 'target_id'>): string {
  return `${t.target_type}:${t.target_id}`;
}

/**
 * Final Surgical Fix Pass §3-13: builds the complete real weekly plan —
 * every gym day this week, in one pass, with today's own budget
 * override applied to `input.today` only. This REPLACES
 * `desiredWeekly / sessionsRemainingThisWeek` as the mechanism that
 * decides a target's day-by-day allocation (§2/§6): instead, each
 * target's real weekly requirement is distributed session-by-session in
 * real chronological order — every eligible day except the target's
 * LAST one gets exactly one exercise, capped at that exercise's own
 * Blueprint-authored per-session `sets` figure (never an even
 * division); the target's LAST eligible day absorbs whatever genuinely
 * remains, using the full 0/1/multiple-exercise constructor (Fix C from
 * the prior pass, unchanged) so no real weekly volume is silently
 * dropped. A single-eligible-day target (the common case) has its one
 * day be both first and last, so it gets the exact same treatment as
 * before this pass — zero behavior change for that case.
 *
 * §7's "recalculate exposure from planned work; it must influence later
 * target allocation" is real here: `plannedExposureByTarget` accumulates
 * every placed exercise's real primary/secondary contribution
 * (calculateExerciseExposure — the same exposure engine every other
 * number in this app already uses) as targets are processed in their
 * fixed priority order, and a LATER (lower-priority) target's live
 * classification/need is computed against baseline-exposure PLUS
 * whatever earlier targets have already placed this same week — never
 * against a static snapshot from before this plan started running.
 * volumeEngine.decideVolume itself is untouched (§13: retained
 * methodology, real primary/direct sets only) — the exposure-aware
 * effect is a separate, explicit gate: a zero-direct-sets
 * normal_development target whose real+planned exposure already meets
 * Blueprint's own starting threshold gets no redundant direct work
 * added, exactly as §8 requires ("do not add redundant direct work
 * merely because direct sets = 0").
 */
export function buildWeeklyProgrammingPlan(input: WeeklyPlanInput): WeeklyProgrammingPlan {
  const log: string[] = [];
  const weekLevelSkips: SkippedTarget[] = [];
  const candidates: Array<FittableItem & { goal_id: string; goal_priority: number; planned: Omit<PlannedWorkItem, 'estimated_minutes'>; date: string }> = [];
  // `priority` (below, `FittableItem`'s field) carries the real,
  // per-target compareRankings-derived rank (Strict Bug-Fix §3.5).
  // Consolidated Fix §7: nothing sorts by it anymore now that
  // fitToTimeBudget is no longer called — `candidates` already comes out
  // in the correct final order for free, since `rankedTargets` (line
  // ~750) and this per-target loop both iterate in that exact same
  // compareRankings order, so pushing each target's exercises as they're
  // constructed already yields priority order. `goal_priority` remains a
  // distinct field (real goal rank 1/2/... or the flat
  // NON_SPECIALIZATION_PRIORITY sentinel) so it's never confused with
  // this per-target rank.
  const plannedExerciseIdsByDate = new Map<string, BlueprintId[]>();
  // §7: real primary/secondary exposure_units every already-processed
  // (higher-priority) target's own placed work has contributed to EVERY
  // target it touches (itself included) — the mechanism that makes
  // "already adequately exposed via compound work" a live, per-target
  // fact a later target's own allocation actually reads, not just a
  // static snapshot from before this plan started running.
  const plannedExposureByTarget = new Map<string, number>();
  // Post-v2 Corrective Fix v2 §12/§13: several distinct target_ids can
  // share the exact same Blueprint development package (e.g. chest's
  // upper-pec/mid-pec/lower-pec all sharing "chest-efficient") — that
  // package's own weekly_direct_set_reference is the combined objective
  // for the WHOLE muscle group, never each sharing target's own
  // independent full quota. Keyed by package_id, this accumulates real
  // DELIVERED direct sets (never the naive per-target desired amount)
  // from every target sharing a package this run, so whichever target is
  // processed later (per the same fixed priority order everything else
  // uses) sees how much of the shared budget genuinely remains — never
  // duplicating the package aggregate as if it belonged to each target
  // in full.
  const plannedDirectSetsByPackage = new Map<string, number>();
  const goalTrend = new Map<string, AestheticProgressTrend>();
  // Surgical Fix Pass §4/§5: targetAllocations is NOT accumulated here
  // during construction — construction can request more than final
  // fitting actually delivers, and exposing that raw total as though it
  // were the final result is exactly the contradiction §3/§4 forbid.
  // `requiredDirectSetsByTarget` and `classificationByTarget` capture
  // the two pieces of real, construction-time-only information
  // (what programming decided was desirable, and this target's live
  // classification) that genuinely can't be recovered from the final
  // sessions alone; the real, authoritative targetAllocations[] is
  // rebuilt from `sessions[].plannedWork` AFTER fitting — see
  // rebuildTargetAllocationsFromFinalSessions below.
  const requiredDirectSetsByTarget = new Map<string, number>();
  const classificationByTarget = new Map<string, TargetClassification>();

  const orderedGymDays = WEEKDAYS.filter((d) => input.available_training_days.includes(d));
  const { purposes: sessionPurposes, reasoning: purposeReasoning } = assignSessionPurposes(orderedGymDays, input.recurring_badminton_days ?? []);
  if (orderedGymDays.length > 0) log.push(purposeReasoning);

  const dateForWeekday = new Map<Weekday, string>(WEEKDAYS.map((d, i) => [d, addDays(input.weekStart, i)]));

  const { starting_point_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;
  const { typical_starting_range_per_week } = BlueprintAdapter.getGlobalPrinciples().frequency;
  // Post-v2 Corrective Fix §9/§10: the fallback expected exposure
  // frequency for a target with no Blueprint development-package
  // reference of its own (a functional_goal, or a physique_target
  // Blueprint hasn't grouped yet) — Blueprint's own universal frequency
  // guidance, midpoint of its range, never a per-target hardcoded
  // number. Used only to derive an expected exposure INTERVAL (see
  // expectedExposureIntervalDays below); no longer used to cap a
  // precomputed "eligible days this week" count, which no longer exists.
  const [globalFrequencyRangeMin, globalFrequencyRangeMax] = typical_starting_range_per_week;
  const globalFallbackSessionsPerWeek = (globalFrequencyRangeMin + globalFrequencyRangeMax) / 2;

  const recoveryByKey = new Map<string, RecoveryConstraintResult>(
    input.targets.map((target) => [
      targetKey(target),
      applyRecoveryConstraint({
        target_type: target.target_type,
        target_id: target.target_id,
        weekly_exposure_units: target.weekly_exposure_units,
        rolling_exposure_units: target.rolling_exposure_units,
        rolling_window_days: target.rolling_window_days,
        days_since_target_last_trained: target.days_since_target_last_trained,
        recent_badminton: target.recent_badminton,
        other_activity_today: [],
      }),
    ])
  );

  // Programming Redesign (Step 12) §3-§5: one DevelopmentReference per
  // target, computed once — Complete level for a specialization
  // (active-goal) target, Efficient for every other target — reused by
  // both rankTarget/classification below AND decideVolume further down,
  // so the two can never read a different reference for the same
  // target within one run.
  const developmentReferenceByKey = new Map<string, DevelopmentReference>(
    input.targets.map((target) => [
      targetKey(target),
      getDevelopmentReference(target.target_type, target.target_id, developmentPackageLevelFor(target.is_specialization)),
    ])
  );

  // Fixed processing order — Goal 1's own targets, then Goal 2's, then
  // every normal_development target, then every maintenance target,
  // using this week's real BASELINE exposure (never re-sorted mid-run:
  // §7's dynamic exposure update changes how MUCH work a later target
  // gets, never WHEN it's considered — a stable, non-cascading design).
  const rankedTargets = input.targets.map((t) => rankTarget(t, starting_point_sets[0], recoveryByKey.get(targetKey(t))!, developmentReferenceByKey.get(targetKey(t)) ?? null)).sort(compareRankings);
  const targetRankIndex = new Map<string, number>(rankedTargets.map((r, i) => [targetKey(r.target), i]));
  // Real per-target exercise count never gets anywhere near this many
  // (bounded by the target's own real candidate pool — Blueprint
  // package members plus any approved outside-Blueprint exercises,
  // realistically well under 10; Surgical Fix Pass §12/§13 removed the
  // package-length CEILING on exercise count, but this headroom number
  // is just a safe upper bound for rank-band spacing, never a
  // programming decision) — generous headroom so a target's own
  // additional-exercise ordering (first exercise = most essential) can
  // never spill into the next target's rank band.
  const EXERCISE_ORDER_SPAN = 100;

  for (const { target } of rankedTargets) {
    const tKey = targetKey(target);
    const recovery = recoveryByKey.get(tKey)!;

    // Strict Surgical Fix Pass §7: this target's LIVE need, computed
    // against real baseline exposure PLUS whatever earlier
    // (higher-priority) targets in THIS SAME weekly plan have already
    // placed — never the static snapshot alone. Specialization targets
    // are exempt (they always get their own dedicated direct work,
    // exactly as rankTarget's own needDeficit=0 already establishes).
    const developmentReference = developmentReferenceByKey.get(tKey) ?? null;
    // Programming Redesign (Step 12) §3-§5: the SAME per-target
    // reference rankTarget already used for this target above (its own
    // Efficient package weekly reference, falling back to Blueprint's
    // universal starting_point_sets[0] only when no package exists) —
    // never a second, independently-derived threshold that could drift
    // from the one that already decided this target's rank.
    const developmentThreshold = developmentReference?.weekly_direct_set_reference ?? starting_point_sets[0];
    const plannedSoFar = plannedExposureByTarget.get(tKey) ?? 0;
    const effectiveExposureUnits = target.weekly_exposure_units + plannedSoFar;
    const liveNeedDeficit = target.is_specialization ? 0 : Math.max(0, developmentThreshold - effectiveExposureUnits);
    const classification: TargetClassification = target.is_specialization ? 'specialization' : liveNeedDeficit > 0 ? 'normal_development' : 'maintenance';

    classificationByTarget.set(tKey, classification);

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
      overrides: { volume_decision?: VolumeDecision | null; exposure_decision?: ExposureCycleDecision | null; selection?: DecisionExplanation['selection'] } = {},
      sessionPurposeOverride: SessionPurpose | null = sessionPurposes.get(input.todayWeekday) ?? null
    ): SkippedTarget['decision'] => ({
      classification,
      weekly_exposure: weeklyExposure,
      last_trained: lastTrained,
      recent_exercise_ids: target.recent_exercise_ids,
      badminton_context: target.recent_badminton,
      recovery,
      volume_decision: overrides.volume_decision ?? null,
      session_purpose: target.target_type === 'physique_target' ? sessionPurposeOverride : null,
      exposure_decision: overrides.exposure_decision ?? null,
      selection: overrides.selection ?? null,
    });

    if (recovery.priority_adjustment === 'avoid') {
      weekLevelSkips.push({
        target_type: target.target_type,
        scope: 'exposure' as const,
        reason_code: 'recovery',
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

    const trend: AestheticProgressTrend = classifyAestheticTrend(target.most_recent_assessment, input.today, target.review_cadence_days);
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
      // Programming Redesign (Step 12) §3-§5: Complete package for a
      // specialization (active-goal) target, Efficient otherwise — the
      // same reference already used above for this target's own
      // classification, so decideVolume's starting-point/ceiling and
      // rankTarget's/classification's threshold can never disagree.
      development_reference: developmentReference,
    });
    log.push(`${target.target_type} "${target.target_id}": ${volumeDecision.reasoning}`);

    const desiredWeekly = volumeDecision.action === 'increase' ? volumeDecision.recommended_weekly_primary_sets : target.current_weekly_primary_sets;

    // Strict Surgical Fix Pass §7/§8: "if a muscle already has adequate
    // exposure through compounds, do not add redundant direct work
    // merely because direct sets = 0." decideVolume itself (retained,
    // §13) always answers 'increase' for a zero-direct-sets target
    // regardless of exposure — this is the separate, explicit gate that
    // actually honors §8, using the SAME real (baseline + already-
    // planned-this-week) exposure number as classification, never
    // touching decideVolume's own methodology.
    if (!target.is_specialization && target.current_weekly_primary_sets === 0 && liveNeedDeficit <= 0) {
      weekLevelSkips.push({
        target_type: target.target_type,
        scope: 'exposure' as const,
        reason_code: 'adequately_covered',
        target_id: target.target_id,
        classification,
        reason: `Already adequately covered via compound work (${effectiveExposureUnits.toFixed(2)} real+planned exposure_units this week, at/above this target's own ${developmentThreshold}-set ${developmentReference?.weekly_direct_set_reference != null ? `Blueprint ${developmentReference.level} package` : 'Blueprint universal starting'} threshold) — no redundant direct work added merely because direct sets = 0 (One-Pass Dev Spec v2 §18 adequately_covered).`,
        decision: makeSkipDecision({ volume_decision: volumeDecision }),
      });
      continue;
    }

    if (desiredWeekly <= 0) {
      weekLevelSkips.push({
        target_type: target.target_type,
        scope: 'exposure' as const,
        reason_code: 'no_volume_recommended',
        target_id: target.target_id,
        classification,
        reason: 'No weekly volume recommended yet for this target.',
        decision: makeSkipDecision({ volume_decision: volumeDecision }),
      });
      continue;
    }

    // Post-v2 Corrective Fix v2 §12/§13: this target's real, fair-share
    // ceiling once whatever OTHER target(s) sharing the same Blueprint
    // package have already claimed this run is subtracted — never the
    // full package aggregate duplicated as if it belonged to this target
    // alone (see plannedDirectSetsByPackage's own doc comment above).
    // packageId is null for a target with no package reference, in which
    // case there is nothing to share and the budget is unbounded.
    //
    // Scoped deliberately narrow: this cap only ever applies when
    // `desiredWeekly` itself IS the package's own recommended starting
    // figure (current_weekly_primary_sets === 0, decideVolume's zero-
    // branch) — never when a target already has genuine, real MAINTAINED
    // volume from actual training history (decideVolume's 'maintain'/
    // 'introspect_needed' outcomes always return `current_weekly_primary_sets`
    // itself, real user data this fix must never suppress just because it
    // happens to exceed a package's own baseline reference — §11's "never
    // an exact workout template," applied here). The genuine duplication
    // risk this fix targets is specifically several simultaneously-
    // untrained sibling targets each independently adopting the same
    // package's own recommended starting point.
    const isPackageDerivedRecommendation = target.current_weekly_primary_sets === 0 && volumeDecision.action === 'increase';
    const packageId = developmentReference?.package_id ?? null;
    const packageWeeklyReference = developmentReference?.weekly_direct_set_reference ?? null;
    const alreadyClaimedForPackage = packageId ? (plannedDirectSetsByPackage.get(packageId) ?? 0) : 0;
    const packageRemainingBudget =
      packageId && packageWeeklyReference !== null && isPackageDerivedRecommendation ? Math.max(0, packageWeeklyReference - alreadyClaimedForPackage) : Number.POSITIVE_INFINITY;

    if (packageId && packageWeeklyReference !== null && isPackageDerivedRecommendation && packageRemainingBudget <= 0) {
      weekLevelSkips.push({
        target_type: target.target_type,
        scope: 'exposure' as const,
        reason_code: 'adequately_covered',
        target_id: target.target_id,
        classification,
        reason: `This target shares Blueprint's "${packageId}" development package with other target(s) in the same muscle group — that package's own ${packageWeeklyReference}-set weekly reference has already been fully claimed by higher-priority sibling target(s) this run, so no additional direct work is added on top of it (Post-v2 Corrective Fix v2 §12: a shared package aggregate is never duplicated as each target's own complete objective).`,
        decision: makeSkipDecision({ volume_decision: volumeDecision }),
      });
      continue;
    }

    // Surgical Fix Pass §6 / Post-v2 Corrective Fix v2 §12: the real
    // requirement — captured once, here, independent of whatever
    // construction/fitting later actually manages to deliver. Already
    // capped at whatever fair share of a shared package's budget genuinely
    // remains for this target, so it is never confused with the naive,
    // pre-sharing per-target reference. Never touched again for this
    // target.
    const fairShareWeekly = Math.min(desiredWeekly, packageRemainingBudget);
    requiredDirectSetsByTarget.set(tKey, fairShareWeekly);

    // Strict Bug-Fix §4/§7/§22: the weekly plan must be durable within
    // this generation run — "when generating Friday for the same week,
    // use the SAME deterministic weeklyPlan... do not derive Friday's
    // intended allocation from weekly target requirement / remaining
    // number of days alone." Eligibility is therefore computed over the
    // WHOLE real week (every gym day this target's PPL+Upper purpose is
    // compatible with), never filtered to "today forward" — that
    // filtering was the exact bug §22 forbids: it silently shrank the
    // eligible-day denominator as the week progressed, so calling this
    // function for Monday vs. Friday of the identical week (identical
    // stored exposure/goals/schedule) could compute a DIFFERENT
    // sessions_remaining_this_week, and therefore a different setsToday,
    // for the same target's same weekly requirement — a real day-count
    // spread mechanism wearing eligibility-filter clothing. A
    // physique_target may only train on a day whose PPL+Upper purpose
    // it's actually compatible with (sessionPurpose.ts); a
    // functional_goal isn't purpose-gated, just gym-day-gated.
    const isPhysique = target.target_type === 'physique_target';

    // Equipment Filter Fix: equipment availability is NEVER a candidate-
    // elimination rule during program generation — the full Blueprint
    // exercise library for this target is the candidate universe, exactly
    // as for the "outside-Blueprint" pool merged in below. A user whose
    // equipment happens to be unavailable for a given session substitutes
    // manually (the real per-target candidate list, equipment-gated, is
    // still served separately by GET /api/programming/substitutes for
    // exactly that purpose — constraintEngine.filterEquipmentFeasible is
    // untouched and still used there). Removing this from generation means
    // a good real Blueprint exercise is never discarded here merely
    // because the user's usual equipment list doesn't happen to list it.
    let candidateExerciseIds = exercisesTrainingTarget(target.target_type, target.target_id);

    const outsideCandidatesById = new Map(target.outside_blueprint_exercises.map((e) => [e.id, e]));
    for (const outside of target.outside_blueprint_exercises) {
      if (!candidateExerciseIds.includes(outside.id)) candidateExerciseIds.push(outside.id);
    }

    if (candidateExerciseIds.length === 0) {
      weekLevelSkips.push({
        target_type: target.target_type,
        scope: 'data_integrity' as const,
        reason_code: 'blueprint_data_integrity',
        target_id: target.target_id,
        classification,
        reason: 'Genuine Blueprint data gap: no Blueprint or approved outside-Blueprint exercise trains this target at all — a content/authoring gap in Blueprint itself, not a normal programming decision (One-Pass Dev Spec v2 §18 blueprint_data_integrity).',
        decision: makeSkipDecision({ volume_decision: volumeDecision }),
      });
      continue;
    }

    // Blueprint Candidate Fix: a physique-target candidate is NEVER
    // pre-filtered by package-listed prescription before ranking.
    // Efficient/Complete development packages are development-VOLUME
    // reference data (see developmentReferenceEngine.ts) — never an
    // exercise menu or an eligibility/prescription-existence gate. A
    // real Blueprint exercise that simply isn't listed in either
    // package for this muscle_group (e.g. Blueprint's own
    // "rear-delt-fly"/"rear-delt-row" curation choices) must remain a
    // real candidate for Gate 1-6 ranking; only the ACTUAL selected
    // winner's own prescription is resolved (see attemptSelection
    // below), and only a genuine absence of any real prescription for
    // EVERY remaining real candidate is ever treated as a data gap
    // (spec §5: substitute when the preferred pick doesn't work out —
    // implemented as a real per-attempt retry in the day-construction
    // loop below, never as a pre-ranking exclusion; §25: never invent a
    // substitute prescription instead).
    if (target.target_type !== 'physique_target') {
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

    // Strict Bug-Fix §11-15 (retained) / Surgical Fix Pass §8-16: 0/1/
    // multiple exercises per target, each one's own sets sized from
    // Blueprint's own development-package `sets` figure when it has
    // one — never an app-invented split. Surgical Fix Pass §12/§13:
    // Blueprint's package EXERCISE COUNT is deliberately not read here
    // at all anymore — how many exercises a target can use is governed
    // purely by real remaining need and real candidate availability
    // (see the day-construction loop below), never by how many
    // exercises happen to be listed in a package.

    // Surgical Fix Pass §2/§6: this target's real weekly requirement is
    // distributed session-by-session across its real eligible days, in
    // real chronological order — NEVER `desiredWeekly /
    // sessionsRemainingThisWeek`. Badminton's session-level trim is a
    // real reduction to the target's TOTAL weekly work, applied once up
    // front (before any day is planned) so a later day can never
    // silently backfill it.
    let remainingWeeklySets = badmintonLowerBodyReduce ? Math.max(1, fairShareWeekly - 1) : fairShareWeekly;
    let globalExerciseIndex = 0;

    /** One real Gate-1-6 selection attempt, restricted to `pool`, plus
     * this exercise's own real prescription and (when usable history
     * exists) real progression — everything needed BEFORE this
     * exercise's own sets figure can be decided. Returns null only when
     * the winner genuinely has no prescription (should not happen given
     * the upstream pre-filter; handled defensively). */
    const attemptSelection = (pool: readonly BlueprintId[], alreadyPlannedTodayForThisTarget: readonly BlueprintId[], plannedTodayIds: readonly BlueprintId[]) => {
      const selection = selectExercise({
        target_type: target.target_type,
        target_id: target.target_id,
        target_tier: target.tier,
        candidate_exercise_ids: pool,
        recent_exercise_ids: target.recent_exercise_ids,
        current_exercise_id: target.current_exercise_id,
        exercises_already_planned_today: [...plannedTodayIds, ...alreadyPlannedTodayForThisTarget],
        outside_blueprint_candidates: new Map([...outsideCandidatesById].map(([id, e]) => [id, { role: e.role, name: e.name }])),
        prefer_lower_fatigue_cost: badmintonLowerBodyReduce,
      });
      log.push(selection.reasoning);

      const outsideSelection = outsideCandidatesById.get(selection.exercise_id);
      // `sets` (this exercise's own Blueprint-authored per-session
      // figure) is null for an outside-Blueprint candidate — there is
      // no Blueprint data to size a multi-exercise/multi-day split
      // against it.
      const outsidePrescription = outsideSelection ? { reps: outsideSelection.reps_range, rir: outsideSelection.rir_range, sets: null as number | null } : null;
      const blueprintPrescription = !outsideSelection && target.target_type === 'physique_target' ? lookupExercisePrescriptionAnyLevel(target.target_id, selection.exercise_id) : null;
      const prescription = outsidePrescription ?? (blueprintPrescription ? { reps: blueprintPrescription.reps, rir: blueprintPrescription.rir, sets: blueprintPrescription.sets } : null);
      if (!prescription) return { selection, prescription: null as null };

      const exerciseHistory = target.exercise_history[selection.exercise_id] ?? [];
      let progressionDecision: ProgressionResult | null = null;
      let previousPerformance: PlannedExercise['previous_performance'] = null;
      if (exerciseHistory.length > 0) {
        const mostRecent = exerciseHistory[0]!;
        const lastCompletedSet = [...mostRecent.sets].reverse().find((s) => s.completed) ?? null;
        previousPerformance = { date: mostRecent.date, weight: lastCompletedSet?.weight ?? null, reps: lastCompletedSet?.reps ?? null };
        const reps = parseRange(prescription.reps);
        progressionDecision = computeProgression({
          exercise_id: selection.exercise_id,
          target_reps_min: reps.min,
          target_reps_max: reps.max,
          recent_sessions_actual_sets: exerciseHistory.map((h) => h.sets),
        });
        log.push(progressionDecision.reasoning);
      }
      return { selection, prescription, progressionDecision, previousPerformance };
    };

    /** Finalizes one already-decided (exercise, sets) placement: books
     * it into the target's own weekly totals, propagates its real
     * primary/secondary exposure to every target it touches (§7 — the
     * mechanism that lets a LATER target's own allocation see it),
     * records it into this date's real session candidates for later
     * time-fitting, and advances the shared exercise-order counter. */
    const finalizePlacement = (
      date: string,
      purposeThisDay: SessionPurpose | null,
      selection: ExerciseSelectionResult,
      prescription: { reps: string; rir: string },
      progressionDecision: ProgressionResult | null,
      previousPerformance: PlannedExercise['previous_performance'],
      sets: number,
      exposureDecision: ExposureCycleDecision,
      requested: number = sets
    ) => {
      const reps = parseRange(prescription.reps);
      const rir = parseRange(prescription.rir);
      const exerciseIndex = globalExerciseIndex;

      const selectionDecision: NonNullable<DecisionExplanation['selection']> = {
        decisive_gate: selection.decisive_gate,
        rejected_candidates: selection.rejected_candidates,
        substituted_from: exerciseIndex === 0 && target.current_exercise_id && target.current_exercise_id !== selection.exercise_id ? target.current_exercise_id : null,
      };

      plannedExerciseIdsByDate.set(date, [...(plannedExerciseIdsByDate.get(date) ?? []), selection.exercise_id]);

      // §7: this exact real exposure (calculateExerciseExposure — the
      // same engine every logged-history number in this app already
      // uses) is added to EVERY target the exercise touches, including
      // this one — a later, lower-priority target's own live need
      // reads this via plannedExposureByTarget. An approved outside-
      // Blueprint exercise isn't in Blueprint's own exercise pool at
      // all, so calculateExerciseExposure can't resolve it — its own
      // human-approved role still tells us its real contribution to
      // THIS target (never invented), but it has no Blueprint
      // secondary_targets data to propagate to any OTHER target.
      // `ownPrimaryExposure`/`ownSecondaryExposure` are this exercise's
      // own real contribution TO ITS OWN TARGET specifically — carried
      // on the PlannedWorkItem itself (Surgical Fix Pass §4/§6) so
      // rebuildTargetAllocationsFromFinalSessions can sum a target's
      // real exposure straight from whichever items actually survive
      // fitting, never from this construction-time running total.
      let ownPrimaryExposure = 0;
      let ownSecondaryExposure = 0;
      const syntheticSets = Array.from({ length: sets }, () => ({ completed: true as const }));
      const isKnownBlueprintExercise = BlueprintAdapter.getExercise(selection.exercise_id) !== undefined;
      if (isKnownBlueprintExercise) {
        const { contributions } = calculateExerciseExposure(selection.exercise_id, syntheticSets);
        for (const c of contributions) {
          const ck = targetKey(c);
          plannedExposureByTarget.set(ck, (plannedExposureByTarget.get(ck) ?? 0) + c.exposure_units);
          if (ck === tKey) {
            if (c.role === 'primary') ownPrimaryExposure += c.exposure_units;
            else ownSecondaryExposure += c.exposure_units;
          }
        }
      } else {
        const outsideRole = outsideCandidatesById.get(selection.exercise_id)?.role ?? 'primary';
        if (outsideRole !== 'none') {
          const exposureUnits = sets * EXPOSURE_COEFFICIENTS[outsideRole];
          plannedExposureByTarget.set(tKey, (plannedExposureByTarget.get(tKey) ?? 0) + exposureUnits);
          if (outsideRole === 'primary') ownPrimaryExposure += exposureUnits;
          else ownSecondaryExposure += exposureUnits;
        }
      }

      const planned: Omit<PlannedWorkItem, 'estimated_minutes'> = {
        exercise_id: selection.exercise_id,
        target_type: target.target_type,
        target_id: target.target_id,
        role: target.tier,
        classification,
        sets,
        primary_exposure: ownPrimaryExposure,
        secondary_exposure: ownSecondaryExposure,
        reps_min: reps.min,
        reps_max: reps.max,
        rir_min: rir.min,
        rir_max: rir.max,
        previous_performance: previousPerformance,
        progression_decision: progressionDecision,
        reasoning:
          `${selection.reasoning} ${sets} sets on ${date} (exercise ${exerciseIndex + 1} of this target's own real weekly plan)` +
          // Surgical Fix Pass §9: explicit requested-vs-delivered
          // accounting whenever they genuinely differ — never silently
          // presenting a reduced delivery as though it were the full
          // request.
          (requested !== sets ? ` — requested ${requested}, delivered ${sets} (reason: progression/recovery constraint)` : '') +
          ` (${desiredWeekly} desired weekly reference; a real due exposure — expected every ~${exposureDecision.expected_exposure_interval_days} day(s), ` +
          `${exposureDecision.last_exposure_date ? `previous exposure ${exposureDecision.last_exposure_date}` : 'no prior exposure known'} — Post-v2 Corrective Fix §5/§9, never desiredWeekly/eligible-days division). ` +
          `Reps ${reps.min}-${reps.max}, RIR ${rir.min}-${rir.max} per Blueprint's development package.` +
          (progressionDecision ? ` Progression: ${progressionDecision.recommendation} — ${progressionDecision.reasoning}` : ' First-time prescription — no prior performance of this exact exercise to progress from.') +
          (exerciseIndex === 0 && badmintonLowerBodyReduce ? ` Badminton (remediation §9): ${recovery.reasoning}` : ''),
        decision: {
          classification,
          weekly_exposure: weeklyExposure,
          last_trained: lastTrained,
          recent_exercise_ids: target.recent_exercise_ids,
          badminton_context: target.recent_badminton,
          recovery,
          volume_decision: volumeDecision,
          session_purpose: purposeThisDay,
          exposure_decision: exposureDecision,
          selection: selectionDecision,
        },
      };

      candidates.push({
        id: selection.exercise_id,
        priority: targetRankIndex.get(tKey)! * EXERCISE_ORDER_SPAN + exerciseIndex,
        estimated_minutes: estimateMinutes(sets),
        goal_id: target.goal_id,
        goal_priority: target.goal_priority,
        planned,
        date,
      });

      globalExerciseIndex++;
    };

    // One-Pass Dev Spec v2 §1.3/§6: this target's own per-exposure
    // reference (sum of its Blueprint package's own exercise sets, never
    // multiplied by frequency) — null for a target with no package
    // reference (functional_goal, or a physique target Blueprint hasn't
    // grouped yet). Only the target's LAST real eligible day this week
    // is ever bounded by it (see that branch below) — every OTHER
    // eligible day already gets exactly one exercise regardless
    // (unchanged from before this spec), so only the last day's
    // multi-exercise absorption could ever cram more than one real
    // exposure's worth of volume into a single session.
    // Post-v2 Corrective Fix §5/§9/§29: this target's own expected
    // exposure interval, in days — derived from its Blueprint
    // development-package frequency reference when one exists, or
    // Blueprint's universal typical_starting_range_per_week midpoint
    // otherwise. This — never a precomputed, calendar-week-capped list
    // of "eligible days" — is what decides whether the target is due
    // for another real exposure on any given real day, so its ACTUAL
    // cadence (checked against its own real last-trained date) places
    // it, never "how many compatible days exist in this Monday-Sunday
    // window."
    const sessionCap = developmentReference?.direct_sets_per_exposure ?? null;
    const sessionsPerWeekForInterval = developmentReference?.sessions_per_week_reference ?? globalFallbackSessionsPerWeek;
    // floor, not round: this is a MINIMUM real spacing, not an average —
    // a 2x/week target trained Monday and again Thursday (a 3-day gap)
    // is the textbook-correct real-world cadence for that frequency, and
    // rounding up to 4 would incorrectly mark Thursday not yet due.
    const expectedExposureIntervalDays = Math.max(1, Math.floor(7 / Math.max(sessionsPerWeekForInterval, 0.1)));

    // The target's most recent known direct-exposure date, as of the
    // start of this generation run — real history only. Advances ONLY
    // when THIS SAME run places a real exposure on an earlier real day
    // this week, so a later real day correctly sees it; never reset
    // because a new calendar week began (§5.4/§8).
    let simulatedLastExposureDate: string | null = target.last_trained_date;
    // Post-v2 Corrective Fix v2 §3/§4/§7: every real direct-exposure date
    // known so far — real logged history (deduped with `last_trained_date`,
    // in case that most-recent-touch happened to be a secondary-role
    // touch not already in `recent_direct_exposure_dates`), plus any
    // exposure THIS SAME run places on an earlier real day. This is the
    // raw material for the separate maximum-frequency gate below; it is
    // pure per-run planning state (§8) — never written back, never
    // treated as real history itself.
    const knownDirectExposureDates = new Set<string>(target.recent_direct_exposure_dates ?? []);
    if (target.last_trained_date) knownDirectExposureDates.add(target.last_trained_date);
    const exposureDatesThisRun: string[] = [...knownDirectExposureDates];
    let everCompatibleThisRun = false;
    let lastAttemptedExerciseId: BlueprintId | null = null;
    let everAttemptedARealCandidate = false;
    // The most recently computed real exposure-cycle decision — kept so
    // the end-of-run summary skip (when nothing was ever placed) can
    // carry real, structured `last_exposure_date`/`days_since_last_exposure`
    // facts (spec §43) rather than nothing at all.
    let lastComputedExposureDecision: ExposureCycleDecision | null = null;

    for (const day of orderedGymDays) {
      if (remainingWeeklySets <= 0) break;
      const date = dateForWeekday.get(day)!;
      const purposeThisDay = isPhysique ? (sessionPurposes.get(day) ?? null) : null;
      const compatibleToday = !isPhysique || (purposeThisDay !== null && isTargetCompatibleWithPurpose(target.target_type, target.target_id, purposeThisDay));
      const daysSinceLastExposure = simulatedLastExposureDate ? daysBetween(simulatedLastExposureDate, date) : null;
      const spacingOk = daysSinceLastExposure === null || daysSinceLastExposure >= expectedExposureIntervalDays;
      // Post-v2 Corrective Fix v2 §3/§4/§7: the SEPARATE maximum-frequency
      // gate — minimum spacing alone is not sufficient (a 2/week target
      // trained Monday+Thursday must not also get a 3rd exposure on
      // Sunday merely because 3 days have elapsed since Thursday; Monday
      // and Thursday are BOTH still within the trailing 7-day window
      // ending Sunday, so this count already sits at the frequency
      // reference and blocks a 3rd). Counts real logged history AND any
      // exposure already placed earlier THIS SAME run — never a future
      // day, never another target's own exposures.
      const actualExposureCountInReferenceWindow = exposureDatesThisRun.filter((d) => daysBetween(d, date) < FREQUENCY_REFERENCE_WINDOW_DAYS).length;
      const withinFrequencyReference = actualExposureCountInReferenceWindow < sessionsPerWeekForInterval;
      const isDueToday = spacingOk && withinFrequencyReference;
      const exposureDecision: ExposureCycleDecision = {
        session_purpose_today: purposeThisDay,
        compatible_today: compatibleToday,
        last_exposure_date: simulatedLastExposureDate,
        days_since_last_exposure: daysSinceLastExposure,
        expected_exposure_interval_days: expectedExposureIntervalDays,
        frequency_reference_per_week: sessionsPerWeekForInterval,
        actual_exposure_count_in_reference_window: actualExposureCountInReferenceWindow,
        is_due_today: compatibleToday && isDueToday,
        reasoning: !compatibleToday
          ? `${target.target_type} "${target.target_id}": ${date} (${day}) is not a compatible training day for this target (session purpose: ${purposeThisDay ?? 'none'}).`
          : !spacingOk
            ? `${target.target_type} "${target.target_id}": not yet due for another real exposure on ${date} — last real exposure ${simulatedLastExposureDate}, ${daysSinceLastExposure} day(s) ago (expected interval ~${expectedExposureIntervalDays} day(s)).`
            : !withinFrequencyReference
              ? `${target.target_type} "${target.target_id}": minimum spacing alone would allow ${date}, but this target's own frequency reference (~${sessionsPerWeekForInterval}/week) is already satisfied by ${actualExposureCountInReferenceWindow} real/planned exposure(s) within the trailing ${FREQUENCY_REFERENCE_WINDOW_DAYS}-day window — minimum spacing is a floor, not the complete frequency gate (Post-v2 Corrective Fix v2 §3).`
              : `${target.target_type} "${target.target_id}": due for a real exposure on ${date} — ${simulatedLastExposureDate ? `last real exposure ${simulatedLastExposureDate}, ${daysSinceLastExposure} day(s) ago` : 'never trained before'} (expected interval ~${expectedExposureIntervalDays} day(s); ${actualExposureCountInReferenceWindow}/${sessionsPerWeekForInterval} exposures so far in the trailing ${FREQUENCY_REFERENCE_WINDOW_DAYS}-day window).`,
      };
      lastComputedExposureDecision = exposureDecision;
      log.push(exposureDecision.reasoning);
      if (compatibleToday) everCompatibleThisRun = true;
      if (!exposureDecision.is_due_today) continue;

      // §16's Monday rule, enforced per real day — assignSessionPurposes
      // already keeps 'legs' off Monday, so this only ever fires for a
      // target whose compatible purposes somehow still included an
      // actually-forbidden slot.
      const dayCandidatePool = isPhysique && !isBodyFocusAllowedOnDay(target.target_id, day) ? [] : candidateExerciseIds;
      if (dayCandidatePool.length === 0) continue;

      const plannedTodayIds = plannedExerciseIdsByDate.get(date) ?? [];

      // Post-v2 Corrective Fix §9.2/§13: every DUE real exposure gets
      // 0/1/multiple exercise construction, bounded at TWO independent
      // ceilings: (a) every placed exercise stays capped at its own
      // authored per-session `sets` figure (Consolidated Fix §3/§15.B,
      // unchanged), and (b) the day's own total delivery is also capped
      // at `sessionCap` (this target's natural per-exposure amount) when
      // a per-exposure reference exists — so no single real exposure can
      // ever absorb more than one exposure's natural worth, regardless
      // of how many real due days occur this week. There is no more
      // "only the last eligible day may use multiple exercises" special
      // case: since due-ness now genuinely gates WHICH days receive any
      // work at all, every day that clears the gate IS its own complete,
      // independent exposure.
      let pool = [...dayCandidatePool];
      const placedTodayIds: BlueprintId[] = [];
      let sessionRemaining = sessionCap === null ? remainingWeeklySets : Math.min(remainingWeeklySets, sessionCap);
      let placedAnyToday = false;
      // Surgical Fix Pass §12-16 (retained): Blueprint's own package
      // exercise count is NOT the ceiling here — the loop continues
      // purely on real remaining need, real candidate availability, and
      // this exposure's own natural per-exposure budget. `pool` already
      // shrinks by one real candidate per iteration, so this is bounded
      // by the real number of feasible/prescribed candidates for this
      // target, never an invented cap.
      while (remainingWeeklySets > 0 && sessionRemaining > 0 && pool.length > 0) {
        const attempt = attemptSelection(pool, placedTodayIds, plannedTodayIds);
        everAttemptedARealCandidate = true;
        lastAttemptedExerciseId = attempt.selection.exercise_id;
        if (!attempt.prescription) {
          // Blueprint Candidate Fix: this specific candidate has no
          // resolvable Blueprint prescription (checked at any package
          // level, or an outside-Blueprint one) — remove ONLY this one
          // and retry with the next-best real candidate still in the
          // pool (spec §5's "substitute when the preferred pick doesn't
          // work out"), rather than giving up on the whole target. A
          // genuine data gap is reported only once, after every real day
          // this run has been tried with nothing ever placed for this
          // target (see after the outer day loop below).
          pool = pool.filter((id) => id !== attempt.selection.exercise_id);
          continue;
        }
        pool = pool.filter((id) => id !== attempt.selection.exercise_id);
        placedTodayIds.push(attempt.selection.exercise_id);
        // Surgical Fix Pass §7-10 / Consolidated Fix §3: charge both the
        // week's remaining reference AND today's own per-exposure budget
        // by the DELIVERED amount, never the pre-reduction natural cap —
        // an undelivered set was never actually placed, so it must stay
        // available for a later exposure to genuinely deliver (never
        // silently written off). This exercise's own authored
        // per-session cap (attempt.prescription.sets) is ALWAYS a
        // ceiling here too — never bypassed (Consolidated Fix §3/§15.B).
        const requested = attempt.prescription.sets === null ? sessionRemaining : Math.min(sessionRemaining, attempt.prescription.sets);
        const reduceThisExercise = globalExerciseIndex === 0 && attempt.progressionDecision?.recommendation === 'reduce';
        const delivered = reduceThisExercise ? Math.max(1, requested - 1) : requested;
        remainingWeeklySets -= delivered;
        sessionRemaining -= delivered;
        // Post-v2 Corrective Fix v2 §12: credit this target's real
        // delivered sets toward its shared package's own running total —
        // whichever sibling target this same run processes next reads
        // this via `packageRemainingBudget`, above.
        if (packageId) plannedDirectSetsByPackage.set(packageId, (plannedDirectSetsByPackage.get(packageId) ?? 0) + delivered);
        finalizePlacement(date, purposeThisDay, attempt.selection, attempt.prescription, attempt.progressionDecision ?? null, attempt.previousPerformance ?? null, delivered, exposureDecision, requested);
        placedAnyToday = true;
        if (attempt.prescription.sets === null) break;
      }

      // §5.4/§8: this real placement — not a calendar boundary — is what
      // advances this target's exposure state for any LATER real day
      // this same run considers.
      if (placedAnyToday) {
        simulatedLastExposureDate = date;
        exposureDatesThisRun.push(date);
      }
    }

    // Post-v2 Corrective Fix §18/§21/§22: exactly one of two genuinely
    // distinct outcomes when nothing was ever placed for this target
    // this run — never confused with each other, and never reported
    // mid-run (a later real day may still succeed).
    if (globalExerciseIndex === 0) {
      if (everAttemptedARealCandidate) {
        // A real candidate was actually attempted at least once (this
        // target WAS due on some real day) but nothing had a resolvable
        // Blueprint prescription anywhere — a genuine data gap, distinct
        // from an ordinary "not due yet" programming decision.
        weekLevelSkips.push({
          target_type: target.target_type,
          scope: 'data_integrity' as const,
          reason_code: 'blueprint_data_integrity',
          target_id: target.target_id,
          classification,
          reason: `Genuine Blueprint data gap: no candidate for this target has a resolvable Blueprint prescription (development-package rep/RIR at any level, or an approved outside-Blueprint one) on any real day this target was due — exposing this data gap rather than inventing one (spec §18 blueprint_data_integrity). Last attempted: "${lastAttemptedExerciseId}".`,
          decision: makeSkipDecision({ volume_decision: volumeDecision }),
        });
      } else {
        // Post-v2 Corrective Fix §22: valid target, simply not due for
        // this exposure — either no real day this run considered was
        // compatible with it at all, or it is compatible but hasn't
        // reached its own expected exposure interval yet. Never framed
        // as "not this week" — it remains available for the next
        // appropriate target-training session, which may fall in a
        // later calendar week this same run doesn't cover.
        weekLevelSkips.push({
          target_type: target.target_type,
          scope: 'exposure' as const,
          reason_code: 'not_current_exposure',
          target_id: target.target_id,
          classification,
          reason: everCompatibleThisRun
            ? lastComputedExposureDecision && lastComputedExposureDecision.actual_exposure_count_in_reference_window >= lastComputedExposureDecision.frequency_reference_per_week
              ? `Not due for this exposure — this target's own frequency reference (~${lastComputedExposureDecision.frequency_reference_per_week}/week) is already satisfied by ${lastComputedExposureDecision.actual_exposure_count_in_reference_window} real/planned exposure(s) within the trailing ${FREQUENCY_REFERENCE_WINDOW_DAYS}-day window (Post-v2 Corrective Fix v2 §3: minimum spacing alone is not the complete frequency gate). It remains available for the next appropriate target-training session.`
              : `Not due for this exposure yet — last real exposure ${target.last_trained_date ?? 'unknown'}, expected interval ~${expectedExposureIntervalDays} day(s). It remains available for the next appropriate target-training session.`
            : `No real training day considered this run is compatible with this target. It remains available for the next appropriate target-training session.`,
          decision: makeSkipDecision({ volume_decision: volumeDecision, exposure_decision: lastComputedExposureDecision }),
        });
      }
    }
  }

  // Consolidated Fix §7/§15.C: session time availability has ZERO effect
  // on normal program generation. A prior architecture ("Remediation §17
  // / Surgical Fix Pass §11") had goals literally compete for each
  // session's own estimated time budget via allocateResource +
  // fitToTimeBudget, dropping whichever candidates didn't fit and
  // recording a "dropped by time-fitting" skip — exactly the candidate
  // elimination the consolidated fix spec forbids. Every candidate this
  // pipeline already decided to place for a given date is now placed,
  // full stop; `estimated_minutes`/`availableMinutes` remain on the
  // response purely as informational display data (spec §7: "estimated
  // time may remain informational in the UI, but it must not alter
  // candidate eligibility/allocation/selection/count/generated program
  // contents").
  const candidatesByDate = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const list = candidatesByDate.get(c.date) ?? [];
    list.push(c);
    candidatesByDate.set(c.date, list);
  }

  // Remediation §16's "active goals, rankings" — every distinct real
  // (is_specialization) goal among the targets this plan actually
  // received, regardless of whether any of its targets ended up
  // skipped. The synthetic normal-development/maintenance bucket is
  // excluded here via the same is_specialization flag every other
  // classification decision already reads. Shared across every real
  // session this plan covers (this week's active goals don't vary
  // day-to-day).
  const activeGoalIds = [...new Set(input.targets.filter((t) => t.is_specialization).map((t) => t.goal_id))];
  const activeGoals = activeGoalIds.map((goalId) => ({
    goal_id: goalId,
    priority: Math.min(...input.targets.filter((t) => t.goal_id === goalId).map((t) => t.goal_priority)),
    trend: goalTrend.get(goalId) ?? ('insufficient_data' as AestheticProgressTrend),
  }));

  const sessions: WeeklyPlanSession[] = [];
  for (const day of orderedGymDays) {
    const date = dateForWeekday.get(day)!;
    const availableMinutes = date === input.today ? input.todayBudgetMinutes : input.defaultSessionMinutes;
    const dayCandidates = candidatesByDate.get(date) ?? [];

    // Consolidated Fix §7: every real candidate already constructed for
    // this date is placed unconditionally — no goal-vs-goal time
    // competition, no time-based drop. `estimatedMinutes` below is
    // computed straight from the full, unfiltered set for informational
    // display only.
    const sessionWork: PlannedWorkItem[] = dayCandidates.map((c) => ({ ...c.planned, estimated_minutes: c.estimated_minutes }));
    const sessionMinutes = dayCandidates.reduce((sum, c) => sum + c.estimated_minutes, 0);

    sessions.push({
      date,
      weekday: day,
      sessionPurpose: sessionPurposes.get(day) ?? null,
      availableMinutes,
      availableEquipment: input.available_equipment,
      plannedWork: sessionWork,
      estimatedMinutes: sessionMinutes,
      badmintonContext: input.targets.find((t) => t.recent_badminton !== null)?.recent_badminton ?? null,
      // Consolidated Fix §12: every current skip is a whole-week fact
      // (scope: 'week') computed once per target above — surfaced on
      // every session because each real day legitimately needs to know
      // "this target isn't getting worked this week, and here's why,"
      // never because it was freshly, independently discovered today.
      // Time/equipment no longer produce any day-specific ('session'
      // scope) skip at all now that neither filters generation (§7/§8).
      skipped: weekLevelSkips,
      activeGoals,
      resourceAllocation: [],
    });
  }

  assertNoContradictoryProgramState(sessions);

  return {
    weekStart: input.weekStart,
    sessions,
    targetAllocations: rebuildTargetAllocationsFromFinalSessions(sessions, requiredDirectSetsByTarget, classificationByTarget),
    decisions: log,
  };
}

/**
 * One-Pass Dev Spec v2 §20: "A target/exercise cannot be generated
 * successfully today and simultaneously unprescribable today... before
 * returning a session, reconcile/validate programmed exercises vs
 * excluded/skipped exercises/targets and ensure there is no semantic
 * contradiction." By construction, the per-target loop above always
 * `continue`s immediately after pushing a week-level skip for a target
 * (never falling through to construction afterward), and the
 * `blueprint_data_integrity` skip is only ever pushed when
 * `globalExerciseIndex === 0` (nothing was ever placed for that target
 * this whole week) — so this should never actually find a contradiction.
 * It is a real, executable safety net rather than only a passing test:
 * a target_id appearing in both a session's `plannedWork` and `skipped`
 * is a genuine programming-engine bug, and this fails loudly (matching
 * this codebase's existing "fail loudly on a data/logic surprise"
 * convention — see NoFeasibleExerciseError, parseRange) rather than
 * silently returning contradictory state to a caller/UI.
 */
function assertNoContradictoryProgramState(sessions: readonly WeeklyPlanSession[]): void {
  for (const session of sessions) {
    const plannedTargetKeys = new Set(session.plannedWork.map((w) => targetKey(w)));
    for (const skip of session.skipped) {
      const key = targetKey(skip);
      if (plannedTargetKeys.has(key)) {
        throw new Error(
          `Contradictory program state (One-Pass Dev Spec v2 §20): ${skip.target_type} "${skip.target_id}" is both ` +
            `programmed and marked skipped (reason_code: ${skip.reason_code}) on ${session.date}. This indicates a real ` +
            `programming-engine defect, not a normal outcome.`
        );
      }
    }
  }
}

/**
 * Surgical Fix Pass §3-6: the ONLY place `WeeklyPlanTargetAllocation[]`
 * is ever produced — deterministically, from the FINAL, already-fitted
 * `sessions[].plannedWork` (never from a pre-fitting construction-time
 * total), so it can never disagree with what a caller would actually
 * see in the real sessions. `requiredDirectSetsByTarget` supplies the
 * one real number the final sessions alone can't recover (what
 * programming decided was desirable before fitting ever ran);
 * everything else is summed straight from the survived work itself.
 */
function rebuildTargetAllocationsFromFinalSessions(
  sessions: readonly WeeklyPlanSession[],
  requiredDirectSetsByTarget: ReadonlyMap<string, number>,
  classificationByTarget: ReadonlyMap<string, TargetClassification>
): WeeklyPlanTargetAllocation[] {
  interface Accumulator {
    target_type: TargetType;
    target_id: BlueprintId;
    deliveredDirectSets: number;
    plannedPrimaryExposure: number;
    plannedSecondaryExposure: number;
    allocatedSessionDates: string[];
  }
  const byTarget = new Map<string, Accumulator>();

  for (const session of sessions) {
    for (const work of session.plannedWork) {
      const key = targetKey(work);
      let acc = byTarget.get(key);
      if (!acc) {
        acc = { target_type: work.target_type, target_id: work.target_id, deliveredDirectSets: 0, plannedPrimaryExposure: 0, plannedSecondaryExposure: 0, allocatedSessionDates: [] };
        byTarget.set(key, acc);
      }
      acc.deliveredDirectSets += work.sets;
      acc.plannedPrimaryExposure += work.primary_exposure;
      acc.plannedSecondaryExposure += work.secondary_exposure;
      if (!acc.allocatedSessionDates.includes(session.date)) acc.allocatedSessionDates.push(session.date);
    }
  }

  // Every target that ever had a real requirement this week gets a real
  // entry here too, even one that ended up with zero delivered sets
  // (dropped entirely by fitting, or never had a feasible/prescribed
  // candidate) — §6's "record any unmet work explicitly" applies
  // whether or not any of it survived into a real session.
  for (const key of requiredDirectSetsByTarget.keys()) {
    if (!byTarget.has(key)) {
      const [target_type, target_id] = key.split(':') as [TargetType, BlueprintId];
      byTarget.set(key, { target_type, target_id, deliveredDirectSets: 0, plannedPrimaryExposure: 0, plannedSecondaryExposure: 0, allocatedSessionDates: [] });
    }
  }

  const allocations: WeeklyPlanTargetAllocation[] = [...byTarget.entries()].map(([key, acc]) => {
    const requiredDirectSets = requiredDirectSetsByTarget.get(key) ?? 0;
    return {
      target_type: acc.target_type,
      target_id: acc.target_id,
      layer: classificationByTarget.get(key) ?? 'maintenance',
      requiredDirectSets,
      deliveredDirectSets: acc.deliveredDirectSets,
      unmetDirectSets: Math.max(0, requiredDirectSets - acc.deliveredDirectSets),
      plannedPrimaryExposure: acc.plannedPrimaryExposure,
      plannedSecondaryExposure: acc.plannedSecondaryExposure,
      allocatedSessionDates: acc.allocatedSessionDates,
    };
  });

  // Deterministic order — target_id, the same stable fallback every
  // other comparator in this module already uses once real criteria
  // are exhausted (there is no real "priority" left to sort by once
  // fitting has already happened; this is purely presentational).
  allocations.sort((a, b) => a.target_id.localeCompare(b.target_id));
  return allocations;
}

/**
 * Pure per-day pipeline (unchanged public shape): builds the complete
 * real weekly plan (buildWeeklyProgrammingPlan, above) and returns
 * `input.date`'s own real slice of it — the dependency direction §7
 * requires (weekly plan -> today's workout), never the reverse. A
 * caller that only ever wants one day's own output (every existing
 * caller of this function) sees byte-identical field names/shapes to
 * before this pass; the only thing that changed is HOW that one day's
 * numbers were actually produced.
 */
export function buildWorkout(input: BuildWorkoutInput): WorkoutBuildResult {
  const weekStart = addDays(input.date, -WEEKDAYS.indexOf(input.weekday));
  const plan = buildWeeklyProgrammingPlan({
    weekStart,
    today: input.date,
    todayWeekday: input.weekday,
    todayBudgetMinutes: input.budget_minutes,
    // No separate "normal session length" is available to a caller
    // using this older, single-day-shaped input (BuildWorkoutInput has
    // no such field) — the only honest default is today's own budget,
    // matching this function's pre-existing single-day behavior
    // exactly (see assembleAndBuildWorkout for the real
    // TrainingProfile-backed default used by the production path).
    defaultSessionMinutes: input.default_session_minutes ?? input.budget_minutes,
    available_equipment: input.available_equipment,
    available_training_days: input.available_training_days,
    targets: input.targets,
    recurring_badminton_days: input.recurring_badminton_days,
  });

  const today = plan.sessions.find((s) => s.date === input.date);
  const exercises: PlannedExercise[] = (today?.plannedWork ?? []).map((w) => ({
    exercise_id: w.exercise_id,
    target_type: w.target_type,
    target_id: w.target_id,
    role: w.role,
    classification: w.classification,
    target_sets: w.sets,
    target_reps_min: w.reps_min,
    target_reps_max: w.reps_max,
    target_rir_min: w.rir_min,
    target_rir_max: w.rir_max,
    estimated_minutes: w.estimated_minutes,
    previous_performance: w.previous_performance,
    progression_decision: w.progression_decision,
    reasoning: w.reasoning,
    decision: w.decision,
  }));

  return {
    date: input.date,
    weekday: input.weekday,
    session_purpose: today?.sessionPurpose ?? null,
    exercises,
    estimated_minutes: today?.estimatedMinutes ?? 0,
    skipped_targets: today?.skipped ?? [],
    reasoning_log: plan.decisions,
    active_goals: today?.activeGoals ?? [],
    resource_allocation: today?.resourceAllocation ?? [],
    constraints: { available_equipment: input.available_equipment, budget_minutes: input.budget_minutes },
  };
}

// UI Build Phase §47: exported (was module-private) so the read-only
// `/api/programming` route can label each real calendar date with its
// real weekday using this app's own existing timezone-safe rule, rather
// than re-implementing (or worse, re-deriving via a local Date object)
// the identical calculation a second time.
export function weekdayOfDate(dateIso: string): Weekday {
  // dateIso is a plain YYYY-MM-DD date string (no time component) — see
  // docs/architecture.md's timezone contract: this app never derives a
  // weekday via a Date object's own (potentially UTC-shifted) day-of-week,
  // it parses the calendar date fields directly.
  const [year, month, day] = dateIso.split('-').map(Number);
  const utcDay = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay(); // 0=Sunday
  const mondayFirstIndex = (utcDay + 6) % 7; // 0=Monday..6=Sunday
  return WEEKDAYS[mondayFirstIndex]!;
}

/** Current-Week Reconciliation Fix §4/§11: the Monday-anchored week-start
 * date containing `dateIso` — the exact same value
 * `assembleWeeklyPlanInput` returns as `WeeklyPlanInput.weekStart` (this
 * function replaces that computation's former inline duplicate) and
 * therefore the correct key for "this week"'s activity overrides.
 * Deliberately independent of the user's configured `week_start_day`,
 * which only affects weekly EXPOSURE aggregation (see
 * TrainingProfile.week_start_day's own doc comment) — the generated
 * weekly plan itself, and now current-week overrides on top of it, are
 * always Monday-anchored. */
export function programmingWeekStart(dateIso: string): string {
  return addDays(dateIso, -WEEKDAYS.indexOf(weekdayOfDate(dateIso)));
}

export interface TargetTouch {
  date: string;
  exercise_id: BlueprintId;
  sets: ReadonlyArray<Pick<LoggedSet, 'weight' | 'reps' | 'completed' | 'rir'>>;
  /** Post-v2 Corrective Fix v2 §4/§7: whether this specific touch was a
   * DIRECT (primary-role) exposure of the target, or merely compound
   * overlap (secondary role) from an exercise trained for a different
   * target. `last_trained_date`/`current_exercise_id` elsewhere in this
   * module deliberately keep the pre-existing combined-role "most
   * recently touched at all" semantics unchanged; this field exists so
   * the rolling-window frequency gate can count only genuine direct
   * exposures, never inflate its count with secondary overlap. */
  role: 'primary' | 'secondary';
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
 *
 * Exported so goalPhaseEngine.ts's review evidence can reuse this exact
 * "real last trained" computation (Step 12 Remediation §5) instead of a
 * second, simplified one built from a session's own free-text `role`
 * field.
 */
export function gatherTargetTouches(sessionsRepo: WorkoutSessionsRepo, recentSessions: readonly { session_id: string; date: string }[]): Map<string, TargetTouch[]> {
  const byTarget = new Map<string, TargetTouch[]>();
  for (const session of recentSessions) {
    for (const performance of sessionsRepo.getExercisePerformances(session.session_id)) {
      const { contributions } = calculateExerciseExposure(performance.exercise_id, performance.sets);
      for (const c of contributions) {
        const key = `${c.target_type}:${c.target_id}`;
        const list = byTarget.get(key) ?? [];
        list.push({ date: session.date, exercise_id: performance.exercise_id, sets: performance.sets, role: c.role });
        byTarget.set(key, list);
      }
    }
  }
  for (const list of byTarget.values()) {
    list.sort((a, b) => b.date.localeCompare(a.date));
  }
  return byTarget;
}

/** The real most-recent logged badminton session's intensity/fatigue, if
 * any is within the given session window — the same real signal
 * recovery decisions elsewhere already use. Exported so
 * goalPhaseEngine.ts's review evidence can reuse this exact computation
 * (Step 12 Remediation §5) instead of a hardcoded `null`. */
export function gatherRecentBadmintonSignal(
  badmintonRepo: BadmintonSessionDetailsRepo,
  recentSessions: readonly { session_id: string; date: string; session_type: string }[]
): RecentBadmintonSignal | null {
  const recentBadmintonSessions = recentSessions.filter((s) => s.session_type === 'badminton').sort((a, b) => b.date.localeCompare(a.date));
  const mostRecentBadminton = recentBadmintonSessions[0];
  const badmintonDetails = mostRecentBadminton ? badmintonRepo.get(mostRecentBadminton.session_id) : undefined;
  return badmintonDetails && badmintonDetails.intensity
    ? { intensity: badmintonDetails.intensity as BadmintonIntensity, post_session_fatigue: badmintonDetails.post_session_fatigue }
    : null;
}

/** The one real, shared impure data-gathering step (like
 * trainingState.ts's own pure/impure split) both assembleAndBuildWorkout
 * and assembleWeeklyProgrammingPlan use — never duplicated between them
 * (Surgical Fix Pass §25: "do not duplicate programming logic in a
 * second builder"), so the two can never drift into gathering the same
 * real DB state (TrainingState, AestheticAssessmentsRepo,
 * BadmintonSessionDetailsRepo, real exercise-performance history)
 * differently. This is the only function in this module that touches
 * the database.
 *
 * UI Build Phase §47/§55: exported (was module-private) so the read-only
 * `/api/programming` route can build the identical real `targets[]`
 * (each with its own real `goal_id`/`goal_priority`/`is_specialization`)
 * the engine itself used, to enrich a `WeeklyProgrammingPlan`'s
 * `targetAllocations` with which real goal a target belongs to for
 * display (spec §16) — never a second, re-derived goal/target mapping. */
export function assembleWeeklyPlanInput(db: Database.Database, date: string, budgetMinutes: number): WeeklyPlanInput {
  const state = buildTrainingState(db, date);
  const weekday = weekdayOfDate(date);
  const assessmentsRepo = new AestheticAssessmentsRepo(db);
  const badmintonRepo = new BadmintonSessionDetailsRepo(db);
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const outsideRepo = new OutsideBlueprintExercisesRepo(db);

  const weeklyByTarget = new Map(state.weekly_exposure.map((e) => [`${e.target_type}:${e.target_id}`, e]));
  const rollingByTarget = new Map(state.rolling_exposure.map((e) => [`${e.target_type}:${e.target_id}`, e]));
  const touchesByTarget = gatherTargetTouches(sessionsRepo, state.recent_sessions);

  const recentBadmintonSignal = gatherRecentBadmintonSignal(badmintonRepo, state.recent_sessions);

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

    // Post-v2 Corrective Fix v2 §4/§7: every distinct real date this
    // target was DIRECTLY (primary-role) exposed, most-recent-first —
    // touches is already sorted most-recent-first, so the first
    // occurrence of each date via Set preserves that order.
    const recentDirectExposureDates = [...new Set(touches.filter((t) => t.role === 'primary').map((t) => t.date))];

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
      recent_direct_exposure_dates: recentDirectExposureDates,
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
  // still gets programmed here.
  //
  // Final Pass §7 explicitly forbids `1000 + index` (or any array-
  // position/alphabetical/ID-based mechanism) driving WHICH of these
  // targets gets resources first — so every one of them shares the
  // exact same flat, non-differentiating goal_priority number. That
  // number still needs to sort after every real user goal (so
  // specialization is always protected first — see tierOf()/
  // compareRankings above, which read this exact flat sentinel), but
  // WITHIN this bucket, real ordering comes entirely from
  // buildWorkout's own rankTarget()/compareRankings() — actual exposure
  // deficit for normal-development, actual days-since-trained for
  // maintenance, target_id only as the final tie-break once those are
  // genuinely equal.
  const NON_SPECIALIZATION_GOAL_ID = '__normal_development_or_maintenance__';
  const NON_SPECIALIZATION_PRIORITY = 1000;
  for (const physiqueTarget of BlueprintAdapter.getTargets()) {
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
        NON_SPECIALIZATION_PRIORITY,
        REVIEW_CADENCE_DEFAULT_DAYS.aesthetic,
        null // no goal, so no aesthetic-assessment history applies
      )
    );
  }

  const weekStart = programmingWeekStart(date);

  // Current-Week Reconciliation Fix §4/§5/§11: the user's own real
  // Gym/Badminton/Both/Unselected activity for EACH day of THIS
  // specific week — the recurring TrainingProfile default
  // (training_days/other_activity_schedule) with any current-week
  // override layered on top, via the same pure applyWeekOverrides
  // function the write endpoint and TrainingProfileRepo.setDailyActivity
  // both use. This is the ONLY place buildWeeklyProgrammingPlan's/
  // buildWorkout's eligible-gym-days input is computed — neither of
  // those functions themselves changed at all; they still just consume
  // whatever `available_training_days`/`recurring_badminton_days` they
  // are handed, exactly as before this fix.
  const weekOverrides = state.training_profile ? new WeekActivityOverridesRepo(db).get(state.training_profile.id, weekStart) : new Map();
  const effective = applyWeekOverrides(state.training_profile?.training_days ?? [], state.training_profile?.other_activity_schedule ?? [], weekOverrides);

  // Remediation §9: the recurring badminton days this user's own
  // TrainingProfile already records (`other_activity_schedule` —
  // "reduced training/recovery capacity, not just ignore," per that
  // field's own doc comment) are the real input frequencyEngine's
  // soft day-avoidance needs — never re-derived or guessed here. Now
  // reads the EFFECTIVE (override-applied) schedule above, so a
  // current-week-only badminton change is honored here too.
  const recurringBadmintonDays = effective.otherActivitySchedule
    .filter((a) => a.activity_type === 'badminton')
    .map((a) => a.day);

  return {
    weekStart,
    today: date,
    todayWeekday: weekday,
    todayBudgetMinutes: budgetMinutes,
    // Surgical Fix Pass §4/§5: every OTHER real day this week's weekly
    // plan covers uses the user's own real configured session length —
    // never `date`'s own explicit `budgetMinutes` override applied to
    // every day, and never an invented number.
    defaultSessionMinutes: state.training_profile?.default_session_duration_minutes ?? budgetMinutes,
    available_equipment: state.training_profile?.available_equipment ?? [],
    available_training_days: effective.trainingDays,
    targets,
    recurring_badminton_days: recurringBadmintonDays,
  };
}

/**
 * The impure boundary (like trainingState.ts): reads TrainingState plus
 * AestheticAssessmentsRepo, BadmintonSessionDetailsRepo, and real
 * exercise-performance history, and hands a plain BuildWorkoutInput to
 * the pure buildWorkout above. This is the production path every
 * caller that only wants ONE day's own workout uses.
 */
export function assembleAndBuildWorkout(db: Database.Database, date: string, budgetMinutes: number): WorkoutBuildResult {
  const input = assembleWeeklyPlanInput(db, date, budgetMinutes);
  return buildWorkout({
    date,
    weekday: input.todayWeekday,
    budget_minutes: budgetMinutes,
    available_equipment: input.available_equipment,
    available_training_days: input.available_training_days,
    targets: input.targets,
    recurring_badminton_days: input.recurring_badminton_days,
    default_session_minutes: input.defaultSessionMinutes,
  });
}

/**
 * Surgical Fix Pass §16: the real production path for inspecting the
 * COMPLETE weekly plan itself — every real session this week, not just
 * one day's own slice. Reads the identical real DB state
 * assembleAndBuildWorkout does (assembleWeeklyPlanInput, shared, never
 * duplicated) and hands it straight to buildWeeklyProgrammingPlan.
 */
export function assembleWeeklyProgrammingPlan(db: Database.Database, date: string, budgetMinutes: number): WeeklyProgrammingPlan {
  return buildWeeklyProgrammingPlan(assembleWeeklyPlanInput(db, date, budgetMinutes));
}
