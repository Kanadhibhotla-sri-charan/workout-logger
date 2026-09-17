// Coaching Depth Batch 5 spec §5 (Phase 7, Structural Balance
// Advisories). Read-only by design: this module produces advisories,
// never a program adjustment (spec §2.4/§5.6 "By default, advisories
// should not directly alter the program" — no adjustment rule is
// implemented in this batch, so none ever fire). It never reads the
// database itself and never depends on workoutBuilder.ts's own types
// (mirrors exercisePairing.ts's own decoupling) — a caller supplies the
// same real, already-assembled per-target facts
// (assembleWeeklyPlanInput's own `targets`) that the rest of the planner
// already uses, so this can never drift into a second, independently
// computed notion of "how much has this target really been trained."
//
// Only two categories are implemented, both derivable entirely from
// real, already-computed rolling-window exposure data (spec §5.2: "Only
// categories supported by the project roadmap and available data should
// be implemented") — no new tables, no new tracking:
//   - `push_pull_imbalance`: push vs pull physique-target rolling
//     exposure share, using the same PUSH_PHYSIQUE_TARGETS/
//     PULL_PHYSIQUE_TARGETS classification Batch 4's pairing already
//     reuses.
//   - `persistent_target_coverage_gap`: a real specialization (goal)
//     target with ZERO rolling exposure across its ENTIRE rolling
//     window — a sustained, multi-week fact, never a single missed
//     session (spec §5.3).

import { PULL_PHYSIQUE_TARGETS, PUSH_PHYSIQUE_TARGETS, STRUCTURAL_ADVISORY_POLICY } from '../../engine/config.js';
import type { BlueprintId } from '../../contracts/types.js';
import type { TargetType } from '../../engine/goalResolver.js';

export type StructuralAdvisorySeverity = 'INFO' | 'WATCH' | 'REVIEW';
export type StructuralAdvisoryCategory = 'push_pull_imbalance' | 'persistent_target_coverage_gap';

export interface StructuralAdvisory {
  id: string;
  category: StructuralAdvisoryCategory;
  severity: StructuralAdvisorySeverity;
  /** Spec §5.5 "Evidence used" — a plain description of the real numbers
   * behind this advisory, never a bare score. */
  evidence: string;
  time_window_days: number;
  affected_targets: readonly BlueprintId[];
  explanation: string;
  suggested_review_action: string;
  /** Always false in this batch — no documented adjustment rule exists
   * yet (spec §5.6's default), so an advisory is purely informational. */
  affects_prescription: false;
  generated_at: string;
}

/** The minimal, real per-target facts this module needs — a subset of
 * `TargetBuildContext`'s own fields, named identically so a caller can
 * pass `WeeklyPlanInput.targets` straight through without remapping. */
export interface StructuralAdvisoryTargetInput {
  target_type: TargetType;
  target_id: BlueprintId;
  is_specialization: boolean;
  rolling_exposure_units: number;
  rolling_window_days: number;
}

function pushPullImbalanceAdvisory(targets: readonly StructuralAdvisoryTargetInput[], asOf: string): StructuralAdvisory | null {
  const physiqueTargets = targets.filter((t) => t.target_type === 'physique_target');
  const pushTotal = physiqueTargets.filter((t) => PUSH_PHYSIQUE_TARGETS.includes(t.target_id)).reduce((sum, t) => sum + t.rolling_exposure_units, 0);
  const pullTotal = physiqueTargets.filter((t) => PULL_PHYSIQUE_TARGETS.includes(t.target_id)).reduce((sum, t) => sum + t.rolling_exposure_units, 0);
  const rollingWindowDays = physiqueTargets[0]?.rolling_window_days ?? 0;

  const combinedTotal = pushTotal + pullTotal;
  // Spec §5.3: insufficient evidence (a fresh program with little/no
  // real accumulated exposure yet) never produces a strong advisory.
  if (combinedTotal < 4) return null;

  const [lowerTotal, lowerTargetIds] =
    pushTotal <= pullTotal
      ? [pushTotal, physiqueTargets.filter((t) => PUSH_PHYSIQUE_TARGETS.includes(t.target_id)).map((t) => t.target_id)]
      : [pullTotal, physiqueTargets.filter((t) => PULL_PHYSIQUE_TARGETS.includes(t.target_id)).map((t) => t.target_id)];
  const higherTotal = Math.max(pushTotal, pullTotal);
  if (higherTotal === 0) return null;
  const share = lowerTotal / higherTotal;

  let severity: StructuralAdvisorySeverity;
  if (share < STRUCTURAL_ADVISORY_POLICY.pushPullReviewShareBelow) severity = 'REVIEW';
  else if (share < STRUCTURAL_ADVISORY_POLICY.pushPullWatchShareBelow) severity = 'WATCH';
  else return null;

  const lowerSide = pushTotal <= pullTotal ? 'push' : 'pull';
  const higherSide = lowerSide === 'push' ? 'pull' : 'push';
  return {
    id: 'push_pull_imbalance',
    category: 'push_pull_imbalance',
    severity,
    evidence: `${lowerSide}-side rolling exposure (${lowerTotal.toFixed(2)} units) is ${Math.round(share * 100)}% of ${higherSide}-side exposure (${higherTotal.toFixed(2)} units) over the trailing ${rollingWindowDays} days.`,
    time_window_days: rollingWindowDays,
    affected_targets: lowerTargetIds,
    explanation: `Training volume has leaned toward ${higherSide} movements relative to ${lowerSide} movements over the last ${rollingWindowDays} days. This is worth a look, not a diagnosis — it may reflect a real goal priority rather than an unintentional gap.`,
    suggested_review_action: `Consider whether more ${lowerSide}-side direct work fits your current goals.`,
    affects_prescription: false,
    generated_at: asOf,
  };
}

function coverageGapAdvisories(targets: readonly StructuralAdvisoryTargetInput[], asOf: string): StructuralAdvisory[] {
  return targets
    .filter((t) => t.target_type === 'physique_target' && t.is_specialization && t.rolling_exposure_units === 0 && t.rolling_window_days > 0)
    .map((t) => ({
      id: `persistent_target_coverage_gap:${t.target_id}`,
      category: 'persistent_target_coverage_gap' as const,
      severity: 'WATCH' as const,
      evidence: `Zero recorded direct exposure for this active goal target across the entire trailing ${t.rolling_window_days}-day window.`,
      time_window_days: t.rolling_window_days,
      affected_targets: [t.target_id],
      explanation: `This target is part of an active goal but has not received any real direct training in the last ${t.rolling_window_days} days.`,
      suggested_review_action: 'Confirm this target is still a real priority, or check whether it is being crowded out this program block.',
      affects_prescription: false as const,
      generated_at: asOf,
    }));
}

/**
 * Pure, deterministic — the same `targets` input always produces the
 * same advisories. Never mutates its input, never reads the database.
 */
export function evaluateStructuralAdvisories(targets: readonly StructuralAdvisoryTargetInput[], asOf: string): StructuralAdvisory[] {
  const advisories: StructuralAdvisory[] = [];
  const pushPull = pushPullImbalanceAdvisory(targets, asOf);
  if (pushPull) advisories.push(pushPull);
  advisories.push(...coverageGapAdvisories(targets, asOf));
  return advisories;
}
