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
import type { Goal } from '../contracts/types.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { MeasurementsRepo } from '../repositories/measurementsRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { TrainingProfileRepo } from '../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../repositories/usersRepo.js';
import { GoalPhaseRepo, type GoalPhase } from '../repositories/goalPhaseRepo.js';
import { GoalPhaseReviewsRepo, type GoalPhaseReview, type ReviewRecommendation } from '../repositories/goalPhaseReviewsRepo.js';
import { buildPriorityMap } from './goalResolver.js';
import { classifyAestheticTrend, type AestheticProgressTrend } from './volumeEngine.js';
import { getDevelopmentReference } from './developmentReferenceEngine.js';
import { applyRecoveryConstraint } from './recoveryEngine.js';
import { aggregateWeeklyExposure } from './exposureEngine.js';
import { daysBetween } from './dateMath.js';

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
  actual_weekly_exposure: number;
  development_reference_weekly: number | null;
  /** Real gym days with a completed WorkoutSession, divided by real
   * configured training days, within the phase window — null if the
   * phase window hasn't started yet or the profile has no training
   * days configured. */
  adherence_ratio: number | null;
  recovery_flagged: boolean;
  /** How many of the goal's own immediately-preceding COMPLETED phases
   * were themselves reviewed as 'improving' (aesthetic_trend), reading
   * backward only until the streak breaks — 0 if this is the first
   * phase or the immediately-prior phase wasn't improving. */
  consecutive_improving_phases: number;
}

export interface GoalPhaseReviewResult {
  recommendation: ReviewRecommendation;
  evidence: GoalReviewEvidence;
  reason: string;
}

const LOW_ADHERENCE_THRESHOLD = 0.6; // [DEFAULT]
const TREND_CHANGE_THRESHOLD = 0.02; // [DEFAULT] 2% — matches this module's own documented measurement/performance trend rule

function classifyValueTrend(oldValue: number, newValue: number): AestheticProgressTrend {
  if (oldValue === 0) return newValue > 0 ? 'improving' : 'insufficient_data';
  const change = (newValue - oldValue) / Math.abs(oldValue);
  if (change > TREND_CHANGE_THRESHOLD) return 'improving';
  if (change < -TREND_CHANGE_THRESHOLD) return 'declining';
  return 'stagnant';
}

/**
 * Programming Redesign (Step 12) §12: never equates volume-reference
 * completion with success (spec rule #27) — trend evidence
 * (aesthetic/measurement), recovery, and adherence drive the
 * recommendation; `actual_weekly_exposure`/`development_reference_weekly`
 * only ever disambiguate WHY a stagnant trend might be happening, never
 * substitute for the trend itself. Diagnoses before recommending an
 * escalation (spec §12's "the review should diagnose before blindly
 * escalating volume") — 'continue' is always the default outcome for
 * weak/insufficient/positive evidence; 'adjust' is only recommended
 * with a specific, cited reason; 'graduate' requires sustained,
 * multi-phase improvement with good adherence, never a single phase.
 */
export function reviewGoalPhase(evidence: GoalReviewEvidence): GoalPhaseReviewResult {
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
      reason: 'Declining assessment or measurement trend this phase — continuing unchanged is not justified; diagnose and adjust.',
    };
  }

  if (evidence.aesthetic_trend === 'improving') {
    if (evidence.consecutive_improving_phases >= 1 && (evidence.adherence_ratio ?? 1) >= LOW_ADHERENCE_THRESHOLD) {
      return {
        recommendation: 'graduate',
        evidence,
        reason: `Sustained improvement across ${evidence.consecutive_improving_phases + 1} consecutive phases with good adherence — this goal has likely reached its target; recommend graduating it from active specialization (final decision is the user's).`,
      };
    }
    return {
      recommendation: 'continue',
      evidence,
      reason: 'Improving — phase progression does not automatically mean escalation; continue the current phase unchanged.',
    };
  }

  if (evidence.aesthetic_trend === 'stagnant') {
    if (evidence.adherence_ratio != null && evidence.adherence_ratio < LOW_ADHERENCE_THRESHOLD) {
      return {
        recommendation: 'adjust',
        evidence,
        reason: `Stagnant progress with low adherence (${Math.round(evidence.adherence_ratio * 100)}% of configured training days) this phase — the likely explanation is adherence, not volume; address that before any volume change.`,
      };
    }
    if (evidence.development_reference_weekly != null && evidence.actual_weekly_exposure >= evidence.development_reference_weekly) {
      return {
        recommendation: 'adjust',
        evidence,
        reason: 'Stagnant progress despite adequate real exposure and adherence this phase — more of the same is unlikely to help; adjust exercise selection/approach rather than simply continuing.',
      };
    }
    return {
      recommendation: 'continue',
      evidence,
      reason: 'Stagnant, but with insufficient exposure or adherence evidence yet to justify a specific adjustment — continue and gather another phase of real evidence before acting on a single reading.',
    };
  }

  return {
    recommendation: 'continue',
    evidence,
    reason: 'Insufficient evidence this phase to justify any change — continuing unchanged is the safe, non-escalating default.',
  };
}

function representativeTarget(goal: Goal): { target_type: 'physique_target' | 'functional_goal'; target_id: string } | null {
  const priorityMap = buildPriorityMap(goal);
  const primary = priorityMap.targets.find((t) => t.tier === 'primary') ?? priorityMap.targets[0];
  return primary ? { target_type: primary.target_type, target_id: primary.target_id } : null;
}

function countConsecutiveImprovingPhases(db: Database.Database, goalId: string, beforePhaseId: string): number {
  const phaseRepo = new GoalPhaseRepo(db);
  const reviewsRepo = new GoalPhaseReviewsRepo(db);
  const priorCompleted = phaseRepo
    .listForGoal(goalId)
    .filter((p) => p.status === 'completed' && p.id !== beforePhaseId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  let streak = 0;
  for (const phase of priorCompleted) {
    const reviews = reviewsRepo.listForPhase(phase.id);
    const latest = reviews[0];
    const trend = (latest?.evidence as { aesthetic_trend?: AestheticProgressTrend } | undefined)?.aesthetic_trend;
    if (trend === 'improving') streak += 1;
    else break;
  }
  return streak;
}

/** Real evidence, assembled from actually-stored data — never a value
 * this module invents. `asOfDate` is normally today; a caller reviewing
 * historically can pass an earlier date. */
export function gatherReviewEvidence(db: Database.Database, goal: Goal, phase: GoalPhase, asOfDate: string): GoalReviewEvidence {
  const assessments = new AestheticAssessmentsRepo(db).listForGoal(goal.id);
  const mostRecentAssessment = assessments[assessments.length - 1];
  const aesthetic_trend = classifyAestheticTrend(
    mostRecentAssessment ? { rating: mostRecentAssessment.rating, date: mostRecentAssessment.date } : null,
    asOfDate,
    goal.review_cadence_days
  );

  const phaseMeasurements = new MeasurementsRepo(db)
    .listForGoal(goal.id)
    .filter((m) => m.date >= phase.start_date && m.date <= asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const measurement_trend: AestheticProgressTrend =
    phaseMeasurements.length >= 2 ? classifyValueTrend(phaseMeasurements[0]!.value, phaseMeasurements[phaseMeasurements.length - 1]!.value) : 'insufficient_data';

  const target = representativeTarget(goal);

  const sessionsRepo = new WorkoutSessionsRepo(db);
  const recentSessions = sessionsRepo.listSessions().filter((s) => s.date >= phase.start_date && s.date <= asOfDate && s.status === 'completed');

  let performance_trend: AestheticProgressTrend = 'insufficient_data';
  if (target) {
    type LoadPoint = { date: string; load: number };
    const loadPoints: LoadPoint[] = [];
    for (const session of recentSessions) {
      for (const exercise of sessionsRepo.getExercisePerformances(session.session_id)) {
        if (exercise.role !== 'primary') continue;
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

  const weeklyExposure = target
    ? aggregateWeeklyExposure(
        recentSessions.map((s) => ({
          date: s.date,
          exercises: sessionsRepo.getExercisePerformances(s.session_id).map((e) => ({ exercise_id: e.exercise_id, sets: e.sets })),
        })),
        asOfDate,
        'monday'
      ).find((e) => e.target_type === target.target_type && e.target_id === target.target_id)
    : undefined;
  const actual_weekly_exposure = weeklyExposure?.primary_sets ?? 0;

  const development_reference_weekly = target ? getDevelopmentReference(target.target_type, target.target_id, 'complete').weekly_direct_set_reference : null;

  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  const trainingDaysCount = profile?.training_days.length ?? 0;
  const phaseDays = Math.max(1, daysBetween(phase.start_date, asOfDate));
  const configuredTrainingDaysInWindow = trainingDaysCount > 0 ? Math.round((phaseDays / 7) * trainingDaysCount) : 0;
  const completedGymDaysInWindow = new Set(recentSessions.filter((s) => s.session_type === 'gym').map((s) => s.date)).size;
  const adherence_ratio = configuredTrainingDaysInWindow > 0 ? Math.min(1, completedGymDaysInWindow / configuredTrainingDaysInWindow) : null;

  let recovery_flagged = false;
  if (target) {
    const touchDates = recentSessions
      .filter((s) => sessionsRepo.getExercisePerformances(s.session_id).some((e) => e.role === 'primary'))
      .map((s) => s.date)
      .sort((a, b) => b.localeCompare(a));
    const mostRecentTouch = touchDates[0] ? { date: touchDates[0] } : undefined;
    const recovery = applyRecoveryConstraint({
      target_type: target.target_type,
      target_id: target.target_id,
      weekly_exposure_units: actual_weekly_exposure,
      rolling_exposure_units: actual_weekly_exposure,
      rolling_window_days: 14,
      days_since_target_last_trained: mostRecentTouch ? daysBetween(mostRecentTouch.date, asOfDate) : null,
      recent_badminton: null,
      other_activity_today: [],
    });
    recovery_flagged = recovery.priority_adjustment !== 'none';
  }

  const consecutive_improving_phases = countConsecutiveImprovingPhases(db, goal.id, phase.id);

  return {
    aesthetic_trend,
    measurement_trend,
    performance_trend,
    actual_weekly_exposure,
    development_reference_weekly,
    adherence_ratio,
    recovery_flagged,
    consecutive_improving_phases,
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
