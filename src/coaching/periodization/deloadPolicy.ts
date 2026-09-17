// Coaching Depth Batch 3 spec §7: the ONE centralized deload-modifier
// policy — every planner call site that needs to reduce a deload week's
// workload reads THESE functions, never a second inline literal
// multiplier. Reuses Batch 1's own `applyRepRangeBias` for rep-range
// handling (via the caller — see workoutBuilder.ts) rather than a second
// range-narrowing implementation; this module only ever decides WHICH
// bias direction and set-count multiplier a deload uses.

import { DELOAD_POLICY, REACTIVE_TRIGGER } from '../../engine/config.js';
import { addDays } from '../../engine/dateMath.js';
import type { RepRangeBias } from '../profiles/muscleProfileTypes.js';

/** Spec §7: reduces a normal week's recommended weekly set count to its
 * deload equivalent — never below 1 (a deload reduces workload, it never
 * eliminates a target's exposure entirely — spec §7's own "preserve
 * movement patterns and important muscle exposure where practical" /
 * "minimum exposure safeguards"). Applied exactly once per target per
 * generation (see workoutBuilder.ts's own call site) — never stacked
 * with a second reduction. */
export function applyDeloadSetVolumeReduction(normalWeeklySets: number): number {
  if (normalWeeklySets <= 0) return normalWeeklySets;
  return Math.max(1, Math.round(normalWeeklySets * DELOAD_POLICY.setVolumeMultiplier));
}

/** Spec §7's rep-range handling: a deload always leans toward the
 * low-fatigue end of Blueprint's own authored range — reuses
 * `MuscleProgrammingProfile['repRangeBias']`'s own vocabulary (never a
 * second bias enum) so the exact same `applyRepRangeBias` function
 * Batch 1/2 already wired into `workoutBuilder.ts` handles it, with no
 * new range-narrowing logic. */
export const DELOAD_REP_RANGE_BIAS: RepRangeBias = DELOAD_POLICY.repRangeBias;

/** Spec §9.5/§10: the reactive deload's own end date, set ONCE at
 * trigger time — `maxReactiveDeloadDurationWeeks` is the only place this
 * duration is defined (never recomputed or re-extended later). */
export function computeReactiveDeloadEndDate(startDate: string): string {
  return addDays(startDate, DELOAD_POLICY.maxReactiveDeloadDurationWeeks * 7 - 1);
}

/** Spec §10: the cooldown window is set ONCE, at the same trigger-time
 * write as the deload's own end date — never recomputed later, and never
 * a second independent "has the deload really ended" check. */
export function computeCooldownUntil(reactiveDeloadEndDate: string): string {
  return addDays(reactiveDeloadEndDate, REACTIVE_TRIGGER.cooldownDays);
}
