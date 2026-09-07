// Programming Redesign (Step 12) §10-§13: goal-phase lifecycle + review
// recommendation — kept as its own module (never inside
// workoutBuilder.ts, per spec §12's explicit code-ownership guidance).
// This module OWNS the review decision (reviewGoalPhase, a pure
// function) and the evidence-gathering/orchestration around it
// (gatherReviewEvidence, runGoalPhaseReview, applyReviewDecision) —
// persistence itself lives in goalPhaseRepo.ts/goalPhaseReviewsRepo.ts,
// exactly as the rest of this codebase separates engine decisions from
// repository storage.
//
// Spec §12's non-negotiable: "The engine recommends. The user decides."
// reviewGoalPhase never applies its own recommendation automatically —
// applyReviewDecision only ever acts on an explicit decision a caller
// (ultimately the user, via a route) passes in.

import type Database from 'better-sqlite3';
import { GoalsRepo } from '../repositories/goalsRepo.js';
import type { Goal, Measurement, TrainingProfile } from '../contracts/types.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { MeasurementsRepo } from '../repositories/measurementsRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { TrainingProfileRepo } from '../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../repositories/usersRepo.js';
import { GoalPhaseRepo, type GoalPhase } from '../repositories/goalPhaseRepo.js';
import { GoalPhaseReviewsRepo, type GoalPhaseReview, type ReviewRecommendation } from '../repositories/goalPhaseReviewsRepo.js';
import { BadmintonSessionDetailsRepo } from '../repositories/badmintonSessionDetailsRepo.js';
import { WeekActivityOverridesRepo } from '../repositories/weekActivityOverridesRepo.js';
import { applyWeekOverrides } from '../lib/dailyActivity.js';
import { buildPriorityMap } from './goalResolver.js';
import { type AestheticProgressTrend } from './volumeEngine.js';
import { getDevelopmentReference } from './developmentReferenceEngine.js';
import { applyRecoveryConstraint } from './recoveryEngine.js';
import { aggregateExposure } from './exposureEngine.js';
import { roleFor } from './exerciseSelector.js';
import { gatherTargetTouches, gatherRecentBadmintonSignal, weekdayOfDate, programmingWeekStart } from './workoutBuilder.js';
import { daysBetween, addDays } from './dateMath.js';

export type { ReviewRecommendation } from '../repositories/goalPhaseReviewsRepo.js';

export interface GoalReviewEvidence {
  aesthetic_trend: AestheticProgressTrend;
  /** [DEFAULT], documented: for the hypertrophy/aesthetic goals this
   * app models, a real body measurement tied to this goal trending
   * UP over the phase is treated as improving (this app's whole
   * premise is muscle growth, not fat-loss, goals — see
   * docs/architecture.md's scope) — never a fat-loss-style "down is
   * good" assumption, and never applied when fewer than 2 real
   * measurements exist this phase. */
  measurement_trend: AestheticProgressTrend;
  /** Real logged working-weight trend (a simple load x (1 + reps/30)
   * proxy, oldest vs newest half of the phase) for exercises whose
   * primary role trains this goal's own target — 'insufficient_data'
   * with fewer than 2 real logged sessions in the window. */
  performance_trend: AestheticProgressTrend;
  /** Remediation (Step 12 Fix) §3: the phase's real AVERAGE weekly
   * exposure — total real primary sets across the whole elapsed phase
   * window (phase.start_date..asOfDate), divided by the real number of
   * elapsed weeks — never a single current-week snapshot. A phase still
   * in its first days has few elapsed weeks and reflects only the real
   * exposure logged so far; this never extrapolates or invents exposure
   * for the remainder of the phase. */
  actual_weekly_exposure: number;
  /** Real total primary sets across the whole elapsed phase window, for
   * transparency alongside the derived weekly average above. */
  phase_total_primary_sets: number;
  /** Real elapsed portion of the phase, in weeks (may be a fraction,
   * e.g. a phase reviewed 10 days after it started elapses ~1.43
   * weeks) — the denominator behind `actual_weekly_exposure` above. */
  phase_weeks_elapsed: number;
  /** The Complete-package weekly OBJECTIVE (see
   * developmentReferenceEngine.ts's DevelopmentReference doc comment) —
   * a target to aim for across a real week, never a literal daily
   * prescription. Compared here against `actual_weekly_exposure` (this
   * phase's real average weekly rate) only to help EXPLAIN a stagnant
   * trend — reaching or exceeding it is never itself evidence of
   * success, and falling short of it never independently drives a
   * recommendation beyond what the trend evidence already says. */
  development_reference_weekly: number | null;
  /** Final Step 12 Fix Pass §P0-3/§P0-4: how closely real completed-gym
   * days matched real training OPPORTUNITIES within the phase window —
   * exact calendar-date enumeration (see enumerateTrainingOpportunityDates),
   * honoring any real current-week override, never an approximate
   * phaseDays/7 * trainingDaysCount estimate. This answers "how closely
   * did actual behavior follow the configured plan," never "did the
   * goal succeed" — reviewGoalPhase only ever surfaces it as CONTEXT in
   * `reason`, never as an independent pass/fail gate on the
   * recommendation. Null if there were no real training opportunities
   * in the window (e.g. no training days configured). */
  adherence_ratio: number | null;
  recovery_flagged: boolean;
}

export interface GoalPhaseReviewResult {
  /** Final Step 12 Fix Pass §P0-2: the ENGINE never recommends
   * 'graduate' — this app's goal model has no authoritative physical
   * completion endpoint to verify against, so improving evidence alone
   * can never be strong enough to assert a goal is DONE. 'graduate'
   * stays a fully valid REVIEW DECISION (see ReviewRecommendation/
   * applyReviewDecision) — only ever chosen by the user themselves. */
  recommendation: Exclude<ReviewRecommendation, 'graduate'>;
  evidence: GoalReviewEvidence;
  reason: string;
}

/** Remediation (Step 12 Fix) §4: a strict sign comparison — any real
 * increase is 'improving', any real decrease is 'declining', an exact
 * tie is 'stagnant'. No invented percentage band: the previous 2%
 * threshold treated small real changes as if they hadn't happened, which
 * is not a real physiological or measurement-precision boundary this
 * app has any basis for asserting. */
function classifyValueTrend(oldValue: number, newValue: number): AestheticProgressTrend {
  if (newValue > oldValue) return 'improving';
  if (newValue < oldValue) return 'declining';
  return 'stagnant';
}

/** Remediation (Step 12 Fix) §6: measurement evidence must be
 * metric-specific — different metrics (e.g. a chest circumference in cm
 * and a bodyweight in kg) are never comparable to each other, so this
 * groups by `metric_name:unit` and only ever compares a metric
 * chronologically against its OWN earlier readings, never against a
 * different metric's value. A goal can have several tracked metrics at
 * once with no single canonical one, so a real decline in ANY tracked
 * metric is surfaced (never masked by an unrelated metric improving —
 * the same conservative, never-silently-optimistic posture
 * reviewGoalPhase already applies elsewhere); otherwise a real
 * improvement in any metric counts as improving; only when every
 * metric with enough data is flat is this 'stagnant'. */
function classifyMeasurementTrend(measurements: readonly Measurement[]): AestheticProgressTrend {
  const byMetric = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const key = `${m.metric_name}:${m.unit}`;
    const list = byMetric.get(key);
    if (list) list.push(m);
    else byMetric.set(key, [m]);
  }

  const metricTrends: AestheticProgressTrend[] = [];
  for (const list of byMetric.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    metricTrends.push(classifyValueTrend(sorted[0]!.value, sorted[sorted.length - 1]!.value));
  }

  if (metricTrends.length === 0) return 'insufficient_data';
  if (metricTrends.includes('declining')) return 'declining';
  if (metricTrends.includes('improving')) return 'improving';
  return 'stagnant';
}

/** Final Step 12 Fix Pass §P0-1: a REAL trend — comparing an appropriate
 * earlier assessment against the latest one — never a single rating
 * classified in isolation (an isolated "4/5 = improving" reading
 * conflates "how do things look right now" with "did this change").
 * Phase-aware priority, most-specific first:
 *   1. Two or more assessments recorded inside the phase window
 *      (>= phase.start_date, <= asOfDate): compare the earliest-in-phase
 *      against the latest-in-phase.
 *   2. Exactly one assessment inside the phase, with at least one
 *      earlier assessment recorded before the phase started: compare
 *      that most recent PRIOR assessment against the in-phase one.
 *   3. Fewer than two comparable assessments exist at all (0 or 1
 *      total): insufficient data — a single rating is never a trend.
 * Reuses the same staleness guard classifyAestheticTrend (still used
 * as-is for the real weekly-programming pipeline's own, different
 * "how does the user feel right now" question — see workoutBuilder.ts)
 * already established: a latest usable assessment older than twice the
 * goal's own review cadence is too stale to treat as current evidence. */
function classifyAestheticTrendForReview(
  allAssessments: readonly { rating: 1 | 2 | 3 | 4 | 5; date: string }[],
  phase: GoalPhase,
  asOfDate: string,
  reviewCadenceDays: number
): AestheticProgressTrend {
  const usable = [...allAssessments].filter((a) => a.date <= asOfDate).sort((a, b) => a.date.localeCompare(b.date));
  if (usable.length === 0) return 'insufficient_data';

  const current = usable[usable.length - 1]!;
  if (daysBetween(current.date, asOfDate) > reviewCadenceDays * 2) return 'insufficient_data';

  const inPhase = usable.filter((a) => a.date >= phase.start_date);
  if (inPhase.length >= 2) {
    return classifyValueTrend(inPhase[0]!.rating, inPhase[inPhase.length - 1]!.rating);
  }
  if (inPhase.length === 1) {
    const beforePhase = usable.filter((a) => a.date < phase.start_date);
    const baseline = beforePhase[beforePhase.length - 1];
    if (baseline) return classifyValueTrend(baseline.rating, inPhase[0]!.rating);
  }
  return 'insufficient_data';
}

/** Final Step 12 Fix Pass §P0-4: exact calendar-date enumeration of this
 * phase's real training opportunities, from `startDate` to `endDate`
 * inclusive (a caller has already capped `endDate` at
 * min(asOfDate, phase.review_date) — never future dates, never beyond
 * the phase itself). For each real date this reuses the SAME per-week
 * override resolution (WeekActivityOverridesRepo + applyWeekOverrides)
 * the real weekly-programming pipeline already uses
 * (workoutBuilder.ts's assembleWeeklyPlanInput) — never a second,
 * approximate attendance model — so a day the user intentionally moved
 * OFF gym for a given week (an explicit current-week override) is
 * conservatively excluded from "real opportunity" here exactly as it
 * is in the real weekly plan, never counted as a missed one. */
function enumerateTrainingOpportunityDates(db: Database.Database, profile: TrainingProfile | undefined, startDate: string, endDate: string): string[] {
  if (!profile || startDate > endDate) return [];
  const overridesRepo = new WeekActivityOverridesRepo(db);
  const effectiveTrainingDaysByWeek = new Map<string, ReadonlyArray<TrainingProfile['training_days'][number]>>();
  const opportunityDates: string[] = [];

  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const weekStart = programmingWeekStart(date);
    let effectiveTrainingDays = effectiveTrainingDaysByWeek.get(weekStart);
    if (!effectiveTrainingDays) {
      const overrides = overridesRepo.get(profile.id, weekStart);
      effectiveTrainingDays = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides).trainingDays;
      effectiveTrainingDaysByWeek.set(weekStart, effectiveTrainingDays);
    }
    if (effectiveTrainingDays.includes(weekdayOfDate(date))) opportunityDates.push(date);
  }
  return opportunityDates;
}

/**
 * Programming Redesign (Step 12) §12/Final Fix Pass §P0-2/§P0-3: never
 * equates volume-reference completion with success (spec rule #27) —
 * trend evidence (aesthetic/measurement/performance) and recovery are
 * what DRIVE the recommendation; `actual_weekly_exposure`/
 * `development_reference_weekly`/`adherence_ratio` are CONTEXT that only
 * ever disambiguates WHY a stagnant trend might be happening (surfaced
 * in `reason`), never an independent decision trigger and never a
 * stand-in for the trend itself. 'continue' is always the default
 * outcome for weak/insufficient/single-dimensional evidence; 'adjust' is
 * only recommended with a specific, cited reason.
 *
 * The engine NEVER recommends 'graduate' (§P0-2 — see
 * GoalPhaseReviewResult's own type, which excludes it entirely): this
 * app's goal model has no authoritative physical completion endpoint,
 * so even the best evidence this module can gather — real, sustained,
 * multi-signal improvement — is never treated as proof a goal is DONE.
 * Graduation stays a fully valid outcome (ReviewRecommendation still
 * includes it, applyReviewDecision still handles it), reachable only by
 * an explicit user decision — "the engine recommends, the user decides."
 *
 * §P0-3: adherence answers "how closely did actual behavior follow the
 * configured plan," never "did the goal succeed" — it is never used
 * here as an automatic pass/fail gate (no `adherence_ratio < 1` branch),
 * only ever quoted as real, contextual information alongside a
 * recommendation the TREND/exposure evidence already justifies on its
 * own.
 */
export function reviewGoalPhase(evidence: GoalReviewEvidence): GoalPhaseReviewResult {
  const adherenceContext =
    evidence.adherence_ratio != null ? ` (adherence this phase: ${Math.round(evidence.adherence_ratio * 100)}% of real training opportunities)` : '';

  if (evidence.recovery_flagged) {
    return {
      recommendation: 'adjust',
      evidence,
      reason: 'Recovery has been flagged during this phase — address recovery before continuing the current programming unchanged.',
    };
  }

  if (evidence.aesthetic_trend === 'declining' || evidence.measurement_trend === 'declining') {
    return {
      recommendation: 'adjust',
      evidence,
      reason: `Declining assessment or measurement trend this phase — continuing unchanged is not justified; diagnose and adjust${adherenceContext}.`,
    };
  }

  if (evidence.aesthetic_trend === 'improving') {
    return {
      recommendation: 'continue',
      evidence,
      reason: `Improving — real progress this phase; continue the current phase unchanged${adherenceContext}. The engine does not recommend graduating a goal on its own — this app has no stored physical completion endpoint to verify against, so graduation is only ever an explicit user decision.`,
    };
  }

  if (evidence.aesthetic_trend === 'stagnant') {
    if (evidence.development_reference_weekly != null && evidence.actual_weekly_exposure >= evidence.development_reference_weekly) {
      return {
        recommendation: 'adjust',
        evidence,
        reason: `Stagnant progress despite adequate real exposure this phase — more of the same is unlikely to help; adjust exercise selection/approach rather than simply continuing${adherenceContext}.`,
      };
    }
    return {
      recommendation: 'continue',
      evidence,
      reason: `Stagnant, but with insufficient exposure evidence yet to justify a specific adjustment — continue and gather another phase of real evidence before acting on a single reading${adherenceContext}.`,
    };
  }

  return {
    recommendation: 'continue',
    evidence,
    reason: `Insufficient evidence this phase to justify any change — continuing unchanged is the safe, non-escalating default${adherenceContext}.`,
  };
}

function representativeTarget(goal: Goal): { target_type: 'physique_target' | 'functional_goal'; target_id: string } | null {
  const priorityMap = buildPriorityMap(goal);
  const primary = priorityMap.targets.find((t) => t.tier === 'primary') ?? priorityMap.targets[0];
  return primary ? { target_type: primary.target_type, target_id: primary.target_id } : null;
}

/** Real evidence, assembled from actually-stored data — never a value
 * this module invents. `asOfDate` is normally today; a caller reviewing
 * historically can pass an earlier date. */
export function gatherReviewEvidence(db: Database.Database, goal: Goal, phase: GoalPhase, asOfDate: string): GoalReviewEvidence {
  const assessments = new AestheticAssessmentsRepo(db).listForGoal(goal.id);
  const aesthetic_trend = classifyAestheticTrendForReview(assessments, phase, asOfDate, goal.review_cadence_days);

  const phaseMeasurements = new MeasurementsRepo(db)
    .listForGoal(goal.id)
    .filter((m) => m.date >= phase.start_date && m.date <= asOfDate);
  const measurement_trend: AestheticProgressTrend = classifyMeasurementTrend(phaseMeasurements);

  const target = representativeTarget(goal);

  const sessionsRepo = new WorkoutSessionsRepo(db);
  const recentSessions = sessionsRepo.listSessions().filter((s) => s.date >= phase.start_date && s.date <= asOfDate && s.status === 'completed');

  let performance_trend: AestheticProgressTrend = 'insufficient_data';
  if (target) {
    type LoadPoint = { date: string; load: number };
    const loadPoints: LoadPoint[] = [];
    for (const session of recentSessions) {
      for (const exercise of sessionsRepo.getExercisePerformances(session.session_id)) {
        // Remediation (Step 12 Fix) §2: relevance is this exercise's real
        // Blueprint target relationship to THIS goal's own target
        // (roleFor — the same authoritative primary/secondary lookup
        // exerciseSelector.ts already uses, never a second mapping) —
        // never the logged session's own free-text `role` field, which
        // only describes that exercise's role WITHIN its session (e.g.
        // "primary lift of the day"), not which target it trains. An
        // exercise with only a SECONDARY relationship to this target is
        // deliberately excluded here too — secondary work is real
        // exposure (tracked separately, at 0.33), but it is never
        // treated as equivalent direct performance evidence for this
        // goal (spec §2 "Important").
        if (roleFor(exercise.exercise_id, target.target_type, target.target_id) !== 'primary') continue;
        const completedSets = exercise.sets.filter((s) => s.completed && s.weight != null && s.reps != null);
        for (const set of completedSets) {
          loadPoints.push({ date: session.date, load: set.weight! * (1 + set.reps! / 30) });
        }
      }
    }
    if (loadPoints.length >= 2) {
      loadPoints.sort((a, b) => a.date.localeCompare(b.date));
      const mid = Math.floor(loadPoints.length / 2);
      const earlyAvg = loadPoints.slice(0, mid).reduce((s, p) => s + p.load, 0) / mid;
      const lateAvg = loadPoints.slice(mid).reduce((s, p) => s + p.load, 0) / (loadPoints.length - mid);
      performance_trend = classifyValueTrend(earlyAvg, lateAvg);
    }
  }

  // Remediation (Step 12 Fix) §3: phase-level exposure spans the WHOLE
  // elapsed phase window (phase.start_date..asOfDate), never a single
  // current week — aggregateWeeklyExposure silently discards every
  // session outside the week containing asOfDate, which is exactly the
  // "current-week value masquerading as phase-level exposure" bug named
  // in the remediation spec. aggregateExposure takes an explicit
  // [periodStart, periodEnd] range instead.
  const phaseDays = Math.max(1, daysBetween(phase.start_date, asOfDate));
  const phase_weeks_elapsed = phaseDays / 7;
  const phaseExposure = target
    ? aggregateExposure(
        recentSessions.map((s) => ({
          date: s.date,
          exercises: sessionsRepo.getExercisePerformances(s.session_id).map((e) => ({ exercise_id: e.exercise_id, sets: e.sets })),
        })),
        phase.start_date,
        asOfDate
      ).find((e) => e.target_type === target.target_type && e.target_id === target.target_id)
    : undefined;
  // Never invent future exposure: the average divides the real total by
  // the real elapsed portion of the phase so far, not by the phase's
  // full planned length.
  const phase_total_primary_sets = phaseExposure?.primary_sets ?? 0;
  const actual_weekly_exposure = phase_total_primary_sets / phase_weeks_elapsed;

  const development_reference_weekly = target ? getDevelopmentReference(target.target_type, target.target_id, 'complete').weekly_direct_set_reference : null;

  // Final Step 12 Fix Pass §P0-4: exact calendar-date enumeration, never
  // an approximate phaseDays/7 * trainingDaysCount estimate — the
  // adherence window never extends past the phase's own boundary
  // (review_date) even if asOfDate is later, and never into the future.
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  const adherenceEndDate = asOfDate < phase.review_date ? asOfDate : phase.review_date;
  const opportunityDates = enumerateTrainingOpportunityDates(db, profile, phase.start_date, adherenceEndDate);
  const completedGymDates = new Set(recentSessions.filter((s) => s.session_type === 'gym').map((s) => s.date));
  const attendedOpportunities = opportunityDates.filter((d) => completedGymDates.has(d)).length;
  const adherence_ratio = opportunityDates.length > 0 ? Math.min(1, attendedOpportunities / opportunityDates.length) : null;

  // Remediation (Step 12 Fix) §5: reuse the SAME real "last trained"/
  // "recent badminton" computations the actual weekly-programming
  // pipeline uses (workoutBuilder.ts's gatherTargetTouches/
  // gatherRecentBadmintonSignal) — never a second, simplified snapshot.
  // The old code here checked a logged session's own free-text `role`
  // field (the same bug class Pass 1 fixed for performance evidence);
  // gatherTargetTouches instead uses calculateExerciseExposure's real
  // Blueprint target relationship, counting primary OR secondary real
  // exposure as "touched" — the correct notion for recovery (unlike
  // performance evidence, secondary compound stress is real physical
  // stimulus). `other_activity_today: []` matches this app's one real
  // implementation of that input everywhere it's used (workoutBuilder.ts
  // passes the same empty list) — not a simplification unique to review.
  let recovery_flagged = false;
  if (target) {
    const touchesByTarget = gatherTargetTouches(sessionsRepo, recentSessions);
    const mostRecentTouch = touchesByTarget.get(`${target.target_type}:${target.target_id}`)?.[0];
    const recentBadminton = gatherRecentBadmintonSignal(new BadmintonSessionDetailsRepo(db), recentSessions);
    const recovery = applyRecoveryConstraint({
      target_type: target.target_type,
      target_id: target.target_id,
      weekly_exposure_units: actual_weekly_exposure,
      rolling_exposure_units: actual_weekly_exposure,
      rolling_window_days: 14,
      days_since_target_last_trained: mostRecentTouch ? daysBetween(mostRecentTouch.date, asOfDate) : null,
      recent_badminton: recentBadminton,
      other_activity_today: [],
    });
    recovery_flagged = recovery.priority_adjustment !== 'none';
  }

  return {
    aesthetic_trend,
    measurement_trend,
    performance_trend,
    actual_weekly_exposure,
    phase_total_primary_sets,
    phase_weeks_elapsed,
    development_reference_weekly,
    adherence_ratio,
    recovery_flagged,
  };
}

export class GoalPhaseNotFoundError extends Error {
  constructor(public goalPhaseId: string) {
    super(`No goal phase found with id "${goalPhaseId}"`);
  }
}

export class GoalPhaseAlreadyCompletedError extends Error {
  constructor(public goalPhaseId: string) {
    super(`Goal phase "${goalPhaseId}" is already completed — it cannot be reviewed again`);
  }
}

export class GoalPhaseReviewNotFoundError extends Error {
  constructor(public reviewId: string) {
    super(`No goal phase review found with id "${reviewId}"`);
  }
}

/** Runs a real review for `goalPhaseId` against current real evidence,
 * persists it, and transitions the phase toward 'review' (from
 * 'active'/'review_due') so the persisted state reflects that a review
 * has actually happened. Never applies the recommendation itself — spec
 * §12: "the engine recommends, the user decides" (see
 * applyReviewDecision). */
export function runGoalPhaseReview(db: Database.Database, goalPhaseId: string, asOfDate: string): GoalPhaseReview {
  const phaseRepo = new GoalPhaseRepo(db);
  const phase = phaseRepo.get(goalPhaseId);
  if (!phase) throw new GoalPhaseNotFoundError(goalPhaseId);
  if (phase.status === 'completed') throw new GoalPhaseAlreadyCompletedError(goalPhaseId);

  const goal = new GoalsRepo(db).get(phase.goal_id);
  if (!goal) throw new GoalPhaseNotFoundError(goalPhaseId);

  if (phase.status === 'active') phaseRepo.markReviewDue(goalPhaseId);
  if (phaseRepo.get(goalPhaseId)!.status === 'review_due') phaseRepo.beginReview(goalPhaseId);

  const evidence = gatherReviewEvidence(db, goal, phase, asOfDate);
  const { recommendation, reason } = reviewGoalPhase(evidence);

  return new GoalPhaseReviewsRepo(db).create({
    goal_phase_id: goalPhaseId,
    review_date: asOfDate,
    system_recommendation: recommendation,
    evidence,
    reason,
  });
}

export class ReviewAlreadyDecidedError extends Error {
  constructor(public reviewId: string) {
    super(`Review "${reviewId}" already has a recorded user decision`);
  }
}

/** Spec §11's lifecycle transitions, applied only once the USER (never
 * the engine on its own) has decided:
 *   continue -> the SAME phase returns to 'active' with review_date
 *     extended by the phase's own original cadence.
 *   adjust   -> this phase completes; a NEW phase begins cleanly for
 *     the same goal (spec rule: "no volume debt transfers... a new
 *     phase does not automatically escalate volume").
 *   graduate -> this phase completes; the goal itself is deactivated
 *     (GoalsRepo.deactivate, which already records its own real
 *     'deactivated' goal_event — reused, not duplicated).
 */
export function applyReviewDecision(
  db: Database.Database,
  reviewId: string,
  decision: ReviewRecommendation,
  asOfDate: string
): { phase: GoalPhase; newPhase: GoalPhase | null } {
  const reviewsRepo = new GoalPhaseReviewsRepo(db);
  const review = reviewsRepo.get(reviewId);
  if (!review) throw new GoalPhaseReviewNotFoundError(reviewId);
  const recorded = reviewsRepo.recordUserDecision(reviewId, decision);
  if (!recorded) throw new ReviewAlreadyDecidedError(reviewId);

  const phaseRepo = new GoalPhaseRepo(db);
  const phase = phaseRepo.get(review.goal_phase_id);
  if (!phase) throw new GoalPhaseNotFoundError(review.goal_phase_id);

  if (decision === 'continue') {
    const cadenceDays = Math.max(1, daysBetween(phase.start_date, phase.review_date));
    const newReviewDate = new Date(new Date(asOfDate).getTime() + cadenceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const updated = phaseRepo.continueActive(phase.id, newReviewDate)!;
    return { phase: updated, newPhase: null };
  }

  const completedPhase = phaseRepo.complete(phase.id)!;

  if (decision === 'graduate') {
    new GoalsRepo(db).deactivate(phase.goal_id, 'graduated from active specialization');
    return { phase: completedPhase, newPhase: null };
  }

  // 'adjust' — a new phase begins cleanly, same goal, no carried-over
  // volume/emphasis state.
  const cadenceDays = Math.max(1, daysBetween(phase.start_date, phase.review_date));
  const newPhase = phaseRepo.create({
    goal_id: phase.goal_id,
    start_date: asOfDate,
    review_date: new Date(new Date(asOfDate).getTime() + cadenceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    package_level: phase.package_level,
    priority_snapshot: phase.priority_snapshot,
    emphasis: phase.emphasis,
  });
  return { phase: completedPhase, newPhase };
}
