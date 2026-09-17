// Coaching Depth Batch 1 spec §6.5: trend states are a SENSING layer
// only. Nothing in this module — and nothing anywhere else in this
// codebase that calls it in this batch — is permitted to turn a trend
// into a deload, specialization block, volume change, frequency change,
// or exercise rotation (spec §12's explicit non-goals). A future batch
// (see docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md's Phase 4) may choose
// to act on this; this batch only computes and reports it.

import type { BasicTrendDirection, TrendDataQuality } from './historicalTypes.js';

/** Below this many real data points, no trend classification is
 * possible at all — matches the existing precedent
 * `goalPhaseEngine.ts`'s `gatherReviewEvidence` already uses
 * (`loadPoints.length >= 2`) for the identical early-half/late-half
 * comparison, generalized here rather than re-invented with a
 * different threshold. */
const MINIMUM_POINTS_FOR_TREND = 2;
const LIMITED_DATA_QUALITY_MAX_POINTS = 3;

/** A relative-change tolerance band around "stable" — deliberately loose
 * so a single unusually light or heavy session cannot, by itself, flip
 * the verdict to "down"/"up" (spec §6.5: "one bad session must not
 * imply decline"). 5% is a conservative, documented starting policy —
 * not derived from any specific Blueprint data, and adjustable later if
 * real usage shows it too loose/strict. */
const TREND_STABLE_TOLERANCE = 0.05;

export function classifyDataQuality(pointCount: number): TrendDataQuality {
  if (pointCount < MINIMUM_POINTS_FOR_TREND) return 'insufficient';
  if (pointCount <= LIMITED_DATA_QUALITY_MAX_POINTS) return 'limited';
  return 'sufficient';
}

export interface TrendLoadPoint {
  date: string;
  load: number;
}

/** Early-half vs late-half average comparison — the same methodology
 * `goalPhaseEngine.ts`'s `gatherReviewEvidence` already established for
 * turning raw logged sets into a trend, generalized to any target
 * rather than "one target per active goal, on demand only." Returns
 * `'unknown'` (never a guessed direction) whenever there are fewer than
 * `MINIMUM_POINTS_FOR_TREND` points, or the early-half average is zero
 * (a degenerate case with no meaningful relative change) — spec §6.5:
 * "missing data must not imply stagnation," so an unresolvable
 * comparison is `'unknown'`, never `'stable'`. */
export function calculateBasicTrend(loadPoints: readonly TrendLoadPoint[]): BasicTrendDirection {
  if (loadPoints.length < MINIMUM_POINTS_FOR_TREND) return 'unknown';

  const sorted = [...loadPoints].sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(sorted.length / 2);
  const early = sorted.slice(0, mid);
  const late = sorted.slice(mid);
  if (early.length === 0 || late.length === 0) return 'unknown';

  const earlyAvg = early.reduce((sum, p) => sum + p.load, 0) / early.length;
  const lateAvg = late.reduce((sum, p) => sum + p.load, 0) / late.length;
  if (earlyAvg === 0) return 'unknown';

  const relativeChange = (lateAvg - earlyAvg) / earlyAvg;
  if (relativeChange > TREND_STABLE_TOLERANCE) return 'up';
  if (relativeChange < -TREND_STABLE_TOLERANCE) return 'down';
  return 'stable';
}
