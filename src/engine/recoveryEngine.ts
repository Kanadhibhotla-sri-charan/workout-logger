// Recovery Engine — Next Phase spec §12 (declining performance / poor
// recovery: inspect first, never automatically reduce) and §15
// (badminton workload must feed combined training-load/recovery
// decisions, but never get converted into a fake hypertrophy-set
// equivalent).
//
// This module does not attempt to calculate biological recovery — it
// applies a conservative, deterministic, already-configured-threshold
// gate (RECOVERY_THRESHOLDS) to signals the caller supplies, and hands
// back a same-day priority adjustment: 'none' (no concern), 'reduce'
// (a caution signal is present — a caller like volumeEngine treats this
// as "recovery not ok", never as an automatic reduction by itself), or
// 'avoid' (already trained this target today — don't recommend it
// again in the same day).
//
// Badminton input is deliberately the raw logged categorical fields
// (intensity, post_session_fatigue) — never blended into an invented
// numeric "load score." Spec §15: "do not convert badminton into
// fake-precision hypertrophy set equivalents."

import type { ActivityType, BadmintonIntensity, BlueprintId } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import { RECOVERY_THRESHOLDS } from './config.js';

export interface RecentBadmintonSignal {
  intensity: BadmintonIntensity;
  post_session_fatigue: 1 | 2 | 3 | 4 | 5 | null;
}

export interface RecoveryConstraintInput {
  target_type: TargetType;
  target_id: BlueprintId;
  /** This target's exposure_units for the current week (see
   * TrainingState.weekly_exposure, filtered to this target). */
  weekly_exposure_units: number;
  /** This target's exposure_units over the rolling window (see
   * TrainingState.rolling_exposure, filtered to this target). */
  rolling_exposure_units: number;
  /** Length of the rolling window rolling_exposure_units was computed
   * over — needed to turn it into a comparable weekly rate. */
  rolling_window_days: number;
  /** 0 if this target was already trained earlier today; null if it
   * has never been trained (or the caller doesn't track it). */
  days_since_target_last_trained: number | null;
  /** Caller-identified recent badminton session detail (e.g. today's or
   * yesterday's), or null if none is recent enough to matter. Deciding
   * what counts as "recent" is the caller's job (a date-math question,
   * not a recovery-methodology one). */
  recent_badminton: RecentBadmintonSignal | null;
  /** What else is scheduled/happening today — surfaced for
   * explainability even though only badminton currently drives a rule
   * here. */
  other_activity_today: readonly ActivityType[];
}

export interface RecoveryConstraintResult {
  target_type: TargetType;
  target_id: BlueprintId;
  priority_adjustment: 'none' | 'reduce' | 'avoid';
  reasoning: string;
  /** True iff recent logged badminton data (not the rolling-exposure
   * spike signal) is one of the reasons behind a 'reduce' outcome —
   * remediation §9: badminton must be able to trigger real, targeted
   * programming effects (lower-body session-set trim, exercise-
   * selection fatigue preference), not just fold anonymously into a
   * generic 'reduce' a caller can't tell the cause of. Always false for
   * 'none'/'avoid'. */
  badminton_triggered: boolean;
}

/**
 * Conservative same-day recovery gate. Never returns 'avoid' or
 * 'reduce' without citing the specific triggered signal(s) in
 * `reasoning` — no opaque score (spec §20).
 */
export function applyRecoveryConstraint(input: RecoveryConstraintInput): RecoveryConstraintResult {
  const reasons: string[] = [];

  if (input.days_since_target_last_trained === 0) {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      priority_adjustment: 'avoid',
      reasoning: `This target was already trained earlier today (days_since_target_last_trained = 0) — avoid training it again in the same day.`,
      badminton_triggered: false,
    };
  }

  const rollingAverageWeeklyRate = input.rolling_window_days > 0 ? input.rolling_exposure_units / (input.rolling_window_days / 7) : 0;
  const recentHighExposure =
    rollingAverageWeeklyRate > 0 && input.weekly_exposure_units > rollingAverageWeeklyRate * RECOVERY_THRESHOLDS.recentHighExposureMultiplier;
  if (recentHighExposure) {
    reasons.push(
      `this week's exposure (${input.weekly_exposure_units.toFixed(2)} exposure_units) is more than ` +
        `RECOVERY_THRESHOLDS.recentHighExposureMultiplier (${RECOVERY_THRESHOLDS.recentHighExposureMultiplier}×) the ` +
        `${input.rolling_window_days}-day rolling average weekly rate (${rollingAverageWeeklyRate.toFixed(2)}) — a real spike, not just a normal week`
    );
  }

  const badmintonHeavy =
    input.recent_badminton !== null &&
    (input.recent_badminton.intensity === 'high' ||
      (input.recent_badminton.post_session_fatigue !== null && input.recent_badminton.post_session_fatigue >= 4));
  if (badmintonHeavy) {
    reasons.push(
      `a recent badminton session was logged as ${input.recent_badminton!.intensity} intensity` +
        (input.recent_badminton!.post_session_fatigue !== null
          ? ` with post-session fatigue ${input.recent_badminton!.post_session_fatigue}/5`
          : '') +
        ` — real systemic fatigue demand from actual logged badminton data (spec §15), not converted into a hypertrophy-set equivalent`
    );
  }

  if (reasons.length > 0) {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      priority_adjustment: 'reduce',
      reasoning: `Reduce priority for this target today: ${reasons.join('; ')}.`,
      badminton_triggered: badmintonHeavy,
    };
  }

  return {
    target_type: input.target_type,
    target_id: input.target_id,
    priority_adjustment: 'none',
    reasoning: 'No recovery caution signal triggered — normal weekly exposure rate, no same-day repeat, no heavy recent badminton demand.',
    badminton_triggered: false,
  };
}
