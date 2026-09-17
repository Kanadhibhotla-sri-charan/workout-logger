// Coaching Depth Batch 1 spec §4.3-§4.5.

import { getProfile } from './muscleProfiles.js';
import type { RepRangeBias } from './muscleProfileTypes.js';

export { getProfile };

/** A reference value only — never actual scheduled/completed frequency
 * (spec §2 non-negotiable principle #2, §4.3: "preferred frequency
 * never masquerades as actual frequency"). `null` when this target has
 * no curated preference. */
export function getPreferredFrequencyReference(targetId: string): number | null {
  return getProfile(targetId).preferredFrequencyPerWeek ?? null;
}

export function getMinimumFrequencyReference(targetId: string): number | null {
  return getProfile(targetId).minimumFrequencyPerWeek ?? null;
}

export function getMaximumFrequencyReference(targetId: string): number | null {
  return getProfile(targetId).maximumFrequencyPerWeek ?? null;
}

/** One real day the current generated plan gives `targetId` any planned
 * direct work — a caller-normalized view of "the generated plan
 * sessions" (spec §4.3), deliberately decoupled from
 * workoutBuilder.ts's/WeeklyProgramRepo's own internal shapes so this
 * module never becomes a second, competing plan/identity system (spec
 * §3). A caller adapts whatever real plan structure it already has
 * (e.g. a persisted week's per-day `plannedWork`) into this shape. */
export interface ScheduledPlanDay {
  date: string;
  /** Every target id with at least one real planned direct-work item on
   * this date. */
  targetIds: readonly string[];
}

/** Counts the real days THIS WEEK's generated plan actually gives
 * `targetId` direct work — never a reference value, never inflated to
 * match a preference (spec §4.3/§4.4: "never claim four exposures when
 * the plan contains only three"). */
export function getActualScheduledFrequency(targetId: string, plan: readonly ScheduledPlanDay[]): number {
  return plan.filter((day) => day.targetIds.includes(targetId)).length;
}

/** One real, already-normalized historical exposure record — the exact
 * shape `historicalTypes.ts`'s `HistoricalExerciseExposure` defines;
 * declared narrowly here (only the two fields this function needs) so
 * this module does not need to import the history module just to
 * compute a frequency from its output. */
export interface CompletedExposureRecord {
  date: string;
  targetId: string;
  completionStatus: 'completed' | 'partial' | 'missed' | 'unknown';
}

/** Counts the distinct real dates `targetId` was actually COMPLETED
 * (never scheduled/partial/missed/unknown) within whatever window
 * `history` already covers. `history === null` means "no history is
 * available to answer this" and returns `null` — genuinely different
 * from a real, checked history that legitimately contains zero
 * completed exposures (spec §4.3: "no history returns null/unknown, not
 * zero"). */
export function getActualCompletedFrequency(targetId: string, history: readonly CompletedExposureRecord[] | null): number | null {
  if (history === null) return null;
  const completedDates = new Set(history.filter((h) => h.targetId === targetId && h.completionStatus === 'completed').map((h) => h.date));
  return completedDates.size;
}

/** Coaching Depth Batch 1 spec §4.5: shifts an authored [authoredMin,
 * authoredMax] rep range toward the requested end, NEVER outside it.
 *
 * Formula (matches the spec's own worked example exactly — authored
 * 8-15 -> lower 8-12, standard 8-15, higher 11-15):
 *   span = authoredMax - authoredMin
 *   shift = floor(span * 2/3)
 *   lower:   [authoredMin, authoredMin + shift]
 *   higher:  [authoredMax - shift, authoredMax]
 *   standard: [authoredMin, authoredMax] unchanged
 *
 * A range spanning fewer than three integer values (authoredMax -
 * authoredMin < 2, i.e. only 1 or 2 whole values in range) is returned
 * unchanged regardless of bias — too narrow to meaningfully shift
 * without producing a degenerate or backwards range (spec §4.5).
 *
 * This is a PURE, single-use transform: callers must apply it exactly
 * once against the true Blueprint-authored range, never chain it (e.g.
 * never call it again on its own output) — see spec §4.5 "do not apply
 * the bias twice" and §4.6's precedence order (an exercise's own
 * authored constraint, when more specific than the generic muscle
 * range, is what `authoredMin`/`authoredMax` here must already be). */
export function applyRepRangeBias(authoredMin: number, authoredMax: number, bias: RepRangeBias): { min: number; max: number } {
  if (authoredMin > authoredMax) {
    throw new RangeError(`applyRepRangeBias: authoredMin (${authoredMin}) must be <= authoredMax (${authoredMax})`);
  }
  const span = authoredMax - authoredMin;
  if (bias === 'standard' || span < 2) {
    return { min: authoredMin, max: authoredMax };
  }
  const shift = Math.floor((span * 2) / 3);
  if (bias === 'lower') {
    return { min: authoredMin, max: authoredMin + shift };
  }
  return { min: authoredMax - shift, max: authoredMax };
}
