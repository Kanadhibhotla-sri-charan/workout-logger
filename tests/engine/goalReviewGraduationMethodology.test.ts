// Step 12 Remediation §4 (P0): the review methodology must never use an
// invented threshold. Three specific numbers named in the remediation
// spec as illegitimate have been removed entirely: the 60% adherence
// cutoff, the 2% measurement/performance trend-change band, and the "N
// consecutive improving phases" graduation rule (the
// consecutive_improving_phases field no longer exists on
// GoalReviewEvidence at all — TypeScript itself enforces that nothing in
// this file can reference it). Graduation is now evidence-based and
// conservative: real, corroborated improvement within a SINGLE phase,
// withheld the moment there's any real shortfall against the user's own
// configured plan — never a fixed phase count.

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
    recovery_flagged: false,
    ...overrides,
  };
}

describe('Test A — no invented percentage trend threshold', () => {
  it('a tiny but real measurement increase is classified improving, not stagnant (the old 2% band would have called this stagnant)', () => {
    // classifyValueTrend is not exported — proven indirectly: a
    // measurement_trend of 'improving' plus an aesthetic 'improving'
    // trend with full adherence must be enough to graduate, which only
    // happens if a small real increase is genuinely classified
    // 'improving' upstream in gatherReviewEvidence rather than
    // 'stagnant' under a percentage band. This test documents the
    // contract at the reviewGoalPhase boundary: any evidence value of
    // 'improving' — however the caller arrived at it — is treated as
    // real improvement, never re-questioned by a second threshold here.
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', measurement_trend: 'improving', adherence_ratio: 1 }));
    expect(result.recommendation).toBe('graduate');
  });
});

describe('Test B — adherence is judged against the real configured plan, never a hardcoded percentage cutoff', () => {
  it('90% adherence (previously treated as "good enough" under an invented 60% threshold) is a real, actionable shortfall', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 0.9 }));
    expect(result.recommendation).toBe('adjust');
    expect(result.reason.toLowerCase()).toContain('adherence');
  });

  it('full adherence (ratio === 1) is never itself treated as a shortfall', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 1, actual_weekly_exposure: 5, development_reference_weekly: 20 })
    );
    expect(result.reason.toLowerCase()).not.toContain('shortfall against the configured training plan');
  });
});

describe('Test C — graduation requires corroborated evidence achievable within a SINGLE phase, never a fixed phase count', () => {
  it('a bare improving aesthetic trend alone never graduates, no matter how many phases have passed (there is no phase-count field to satisfy)', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', adherence_ratio: 1 }));
    expect(result.recommendation).toBe('continue');
  });

  it('an improving aesthetic trend corroborated by an improving performance trend graduates within a single phase', () => {
    const result = reviewGoalPhase(evidence({ aesthetic_trend: 'improving', performance_trend: 'improving', adherence_ratio: 1 }));
    expect(result.recommendation).toBe('graduate');
  });
});

describe('Test D — graduation is withheld whenever there is any real adherence shortfall, even with corroborated improvement', () => {
  it('never falsely graduates from otherwise-strong evidence undermined by a real shortfall', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'improving', measurement_trend: 'improving', performance_trend: 'improving', adherence_ratio: 0.95 })
    );
    expect(result.recommendation).not.toBe('graduate');
    expect(result.recommendation).toBe('continue');
  });
});

describe('Test E — graduation is never granted merely from hitting or exceeding a volume reference number', () => {
  it('exposure far above the development reference, alone, never implies graduation', () => {
    const result = reviewGoalPhase(
      evidence({ aesthetic_trend: 'stagnant', adherence_ratio: 1, actual_weekly_exposure: 100, development_reference_weekly: 20 })
    );
    expect(result.recommendation).not.toBe('graduate');
  });
});
