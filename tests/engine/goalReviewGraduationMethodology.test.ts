// Final Step 12 Fix Pass §P0-2/§P0-3: the review methodology must never
// let the ENGINE recommend graduation, and must never treat adherence as
// a universal pass/fail gate. This app's goal model has no authoritative
// physical completion endpoint, so even the strongest possible evidence
// (multi-signal, sustained improvement, perfect adherence) is never
// enough for the engine itself to assert a goal is DONE — 'graduate'
// stays a fully valid REVIEW DECISION, reachable only by an explicit
// user choice (see GoalPhaseReviewResult's own type, which excludes
// 'graduate' from what reviewGoalPhase can return, and
// applyReviewDecision, which still handles a user's explicit 'graduate'
// decision exactly as before — see tests/engine/goalPhaseEngine.test.ts's
// "applyReviewDecision 'graduate'" and "user decision OVERRIDES the
// system recommendation" tests for that end-to-end coverage, not
// duplicated here).

import { describe, expect, it } from 'vitest';
import { reviewGoalPhase, type GoalReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

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
    rolling_exposure_units: 0,
    recovery_flagged: false,
    ...overrides,
  };
}

describe('Test A — the engine never recommends graduate, no matter how strong the evidence', () => {
  it('real, corroborated, multi-signal improvement with perfect adherence still returns continue, never graduate', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'improving', measurement_trend: 'improving', performance_trend: 'improving', adherence_ratio: 1 })
    );
    expect(result.recommendation).toBe('continue');
    expect(result.recommendation).not.toBe('graduate');
  });

  it('a bare improving aesthetic trend alone never graduates either', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', adherence_ratio: 1 }));
    expect(result.recommendation).toBe('continue');
  });

  it("TypeScript itself enforces this: reviewGoalPhase's own return type excludes 'graduate'", () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving' }));
    // If reviewGoalPhase could ever return 'graduate', assigning its
    // recommendation to this narrower local type would be a compile-time
    // error (GoalPhaseReviewResult.recommendation is
    // Exclude<ReviewRecommendation, 'graduate'>).
    const recommendation: 'continue' | 'adjust' = result.recommendation;
    expect(['continue', 'adjust']).toContain(recommendation);
  });
});

describe('Test B — adherence is contextual evidence, never a universal pass/fail gate', () => {
  it('90% adherence with improving evidence still recommends continue — a real shortfall never overrides real improvement', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', adherence_ratio: 0.9 }));
    expect(result.recommendation).toBe('continue');
  });

  it('a real adherence shortfall alone (stagnant trend, no exposure evidence) never automatically triggers adjust', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 0.3 }));
    expect(result.recommendation).toBe('continue');
    expect(result.reason.toLowerCase()).toContain('adherence'); // still real, contextual information
  });

  it('100% adherence with stagnant evidence is never itself treated as success', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 1 }));
    expect(result.recommendation).toBe('continue');
    expect(result.reason.toLowerCase()).not.toContain('success');
  });
});

describe('Test C — graduation is never granted merely from hitting or exceeding a volume reference number', () => {
  it('exposure far above the development reference, alone, never implies graduation', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 1, actual_weekly_exposure: 100, development_reference_weekly: 20 })
    );
    expect(result.recommendation).not.toBe('graduate');
    expect(result.recommendation).toBe('adjust'); // a real diagnostic signal (exposure), never a success/completion claim
  });
});
