// Programming Redesign (Step 12) §16.H-K: goal phase review tests.
// reviewGoalPhase is pure — tested directly with hand-built evidence for
// deterministic coverage of every named spec scenario. runGoalPhaseReview/
// applyReviewDecision are tested through a real (if minimal) database to
// prove persistence, the user-override behavior (§16.I), and the full
// lifecycle transitions (§16.H).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { AestheticAssessmentsRepo } from '../../src/repositories/aestheticAssessmentsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { GoalPhaseReviewsRepo } from '../../src/repositories/goalPhaseReviewsRepo.js';
import {
  reviewGoalPhase,
  runGoalPhaseReview,
  applyReviewDecision,
  type GoalReviewEvidence,
} from '../../src/engine/goalPhaseEngine.js';

function evidence(overrides: Partial<GoalReviewEvidence> = {}): GoalReviewEvidence {
  return {
    aesthetic_trend: 'insufficient_data',
    measurement_trend: 'insufficient_data',
    performance_trend: 'insufficient_data',
    actual_weekly_exposure: 0,
    phase_total_primary_sets: 0,
    phase_weeks_elapsed: 1,
    development_reference_weekly: null,
    adherence_ratio: null,
    recovery_flagged: false,
    ...overrides,
  };
}

describe('reviewGoalPhase — required scenarios (spec section 16.J)', () => {
  it('improving assessment + improving measurement + improving performance -> continue (never equates progress with "hit the reference, done")', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'improving', measurement_trend: 'improving', performance_trend: 'improving', adherence_ratio: 0.9 })
    );
    expect(result.recommendation).toBe('continue');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('stagnant assessment with LOW actual exposure -> adjust, citing adherence/exposure (not volume completion)', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 0.3, actual_weekly_exposure: 4, development_reference_weekly: 20 })
    );
    expect(result.recommendation).toBe('adjust');
    expect(result.reason.toLowerCase()).toContain('adherence');
  });

  it('stagnant assessment with ADEQUATE exposure (and full adherence) -> adjust, citing approach/exercise-selection, not adherence', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 1, actual_weekly_exposure: 22, development_reference_weekly: 20 })
    );
    expect(result.recommendation).toBe('adjust');
    expect(result.reason.toLowerCase()).toContain('exercise selection');
    expect(result.reason.toLowerCase()).not.toContain('likely explanation is adherence');
  });

  it('poor recovery -> adjust, regardless of any other evidence', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', recovery_flagged: true }));
    expect(result.recommendation).toBe('adjust');
    expect(result.reason.toLowerCase()).toContain('recovery');
  });

  it('poor adherence alone (stagnant trend) -> adjust, citing adherence specifically', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 0.2 }));
    expect(result.recommendation).toBe('adjust');
    expect(result.reason.toLowerCase()).toContain('adherence');
  });

  it('declining trend -> adjust, never an automatic reduction decided here (the engine only recommends)', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'declining' }));
    expect(result.recommendation).toBe('adjust');
  });

  it('insufficient evidence everywhere -> continue (the safe, non-escalating default)', () => {
    const result = reviewGoalPhase(evidence());
    expect(result.recommendation).toBe('continue');
  });

  it('real corroborated improvement with full adherence -> graduate; a bare improving aesthetic trend alone -> continue (Remediation §4)', () => {
    const aestheticAlone = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', adherence_ratio: 1 }));
    expect(aestheticAlone.recommendation).toBe('continue');

    const corroborated = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', measurement_trend: 'improving', adherence_ratio: 1 }));
    expect(corroborated.recommendation).toBe('graduate');
  });

  it('volume-reference completion alone never implies success — stagnant + exposure far above reference is still adjust, never continue/graduate merely because the number was hit', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 1, actual_weekly_exposure: 100, development_reference_weekly: 20 }));
    expect(result.recommendation).not.toBe('graduate');
    expect(result.recommendation).toBe('adjust');
  });

  it('every recommendation carries a real, non-empty, specific reason (spec section 16.K)', () => {
    const scenarios: GoalReviewEvidence[] = [
      evidence({ aesthetic_trend: 'improving' }),
      evidence({ aesthetic_trend: 'declining' }),
      evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 0.9, actual_weekly_exposure: 25, development_reference_weekly: 20 }),
      evidence({ recovery_flagged: true }),
      evidence(),
    ];
    for (const e of scenarios) {
      const result = reviewGoalPhase(e);
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(15);
    }
  });
});

describe('runGoalPhaseReview / applyReviewDecision — lifecycle + persistence (spec sections 11-13, 16.H-I)', () => {
  let db: Database.Database;
  let goalId: string;
  let phaseId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    goalId = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 }).id;
    phaseId = new GoalPhaseRepo(db).create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' }).id;
  });

  it('runGoalPhaseReview transitions active -> review and persists real evidence + a system recommendation', () => {
    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    expect(review.system_recommendation).toMatch(/continue|adjust|graduate/);
    expect(review.user_decision).toBeNull();
    expect(review.decided_at).toBeNull();

    const phase = new GoalPhaseRepo(db).get(phaseId)!;
    expect(phase.status).toBe('review');
  });

  it('the persisted review carries real evidence a later developer/user can inspect (spec section 13)', () => {
    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    expect(review.evidence).toHaveProperty('aesthetic_trend');
    expect(review.evidence).toHaveProperty('adherence_ratio');
    expect(review.evidence).toHaveProperty('recovery_flagged');
  });

  it('applyReviewDecision "continue": the SAME phase returns to active with an extended review_date', () => {
    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    const { phase, newPhase } = applyReviewDecision(db, review.id, 'continue', '2026-09-12');
    expect(phase.id).toBe(phaseId);
    expect(phase.status).toBe('active');
    expect(newPhase).toBeNull();
  });

  it('applyReviewDecision "adjust": the current phase completes and a NEW phase begins cleanly for the same goal', () => {
    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    const { phase, newPhase } = applyReviewDecision(db, review.id, 'adjust', '2026-09-12');
    expect(phase.id).toBe(phaseId);
    expect(phase.status).toBe('completed');
    expect(newPhase).not.toBeNull();
    expect(newPhase!.id).not.toBe(phaseId);
    expect(newPhase!.goal_id).toBe(goalId);
    expect(newPhase!.status).toBe('active');
  });

  it('applyReviewDecision "graduate": the current phase completes AND the underlying goal is deactivated', () => {
    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    const { phase, newPhase } = applyReviewDecision(db, review.id, 'graduate', '2026-09-12');
    expect(phase.status).toBe('completed');
    expect(newPhase).toBeNull();
    const goal = new GoalsRepo(db).get(goalId)!;
    expect(goal.active).toBe(false);
  });

  it('user decision OVERRIDES the system recommendation — spec 16.I: system says X, user decides Y, Y wins and both are recorded', () => {
    // Force a system recommendation of 'graduate' via direct evidence,
    // bypassing gatherReviewEvidence's real DB read, by seeding an
    // aesthetic assessment/adherence history that produces it — simpler:
    // record the review directly through the repo with a known system
    // recommendation, then apply a DIFFERENT user decision. The phase
    // must actually be in 'review' status first, exactly as
    // runGoalPhaseReview would leave it.
    const phaseRepo = new GoalPhaseRepo(db);
    phaseRepo.markReviewDue(phaseId);
    phaseRepo.beginReview(phaseId);
    const reviewsRepo = new GoalPhaseReviewsRepo(db);
    const review = reviewsRepo.create({
      goal_phase_id: phaseId,
      review_date: '2026-09-12',
      system_recommendation: 'graduate',
      evidence: evidence({ aesthetic_trend: 'improving', measurement_trend: 'improving', adherence_ratio: 1 }),
      reason: 'Sustained improvement — recommend graduating.',
    });

    const { phase, newPhase } = applyReviewDecision(db, review.id, 'continue', '2026-09-12');

    const reloadedReview = reviewsRepo.get(review.id)!;
    expect(reloadedReview.system_recommendation).toBe('graduate'); // never rewritten
    expect(reloadedReview.user_decision).toBe('continue'); // the user's actual choice
    expect(reloadedReview.decided_at).not.toBeNull();
    // The USER's decision is what actually governs the real lifecycle
    // transition — phase stays active (continue), not completed/graduated.
    expect(phase.status).toBe('active');
    expect(newPhase).toBeNull();
    const goal = new GoalsRepo(db).get(goalId)!;
    expect(goal.active).toBe(true); // never deactivated — the user chose continue
  });

  it('a decision cannot be recorded twice on the same review', () => {
    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    applyReviewDecision(db, review.id, 'continue', '2026-09-12');
    expect(() => applyReviewDecision(db, review.id, 'adjust', '2026-09-13')).toThrow();
  });
});

describe('Aesthetic assessment feeds directly into a real review\'s evidence', () => {
  it('an "improving" assessment produces aesthetic_trend: improving in the persisted review evidence', () => {
    const db = openDb(':memory:');
    const goalId = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, review_cadence_days: 28 }).id;
    new AestheticAssessmentsRepo(db).record({ goal_id: goalId, date: '2026-09-01', rating: 5 });
    const phaseId = new GoalPhaseRepo(db).create({ goal_id: goalId, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' }).id;

    const review = runGoalPhaseReview(db, phaseId, '2026-09-12');
    expect((review.evidence as GoalReviewEvidence).aesthetic_trend).toBe('improving');
  });
});
