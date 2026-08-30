// Frequency Engine — Next Phase spec §16.
//
// Uses Blueprint's own frequency.typical_starting_range_per_week
// (BlueprintAdapter.getGlobalPrinciples().frequency) as the target
// session count range, clamped to how many training days are actually
// available — never invents a session count outside Blueprint's own
// guidance. Distributes the chosen number of sessions evenly across the
// available days (an app-level spacing choice, not a Blueprint field:
// Blueprint's text only "distinguishes how often a muscle can be
// trained from how it's typically useful to distribute its weekly
// volume," it doesn't prescribe an exact spacing algorithm — see
// docs/TRAINING_ENGINE_DESIGN.md and this file's `spreadDays`).
//
// Enforces spec §16's one hard rule for physique targets: Monday must
// never be generated as a lower-body day (constraintEngine
// .isBodyFocusAllowedOnDay) — a forbidden Monday slot is swapped for
// the next available day rather than silently dropped.

import type { BlueprintId, Weekday } from '../contracts/types.js';
import { WEEKDAYS } from '../contracts/types.js';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { TargetType } from './goalResolver.js';
import { isBodyFocusAllowedOnDay } from './constraintEngine.js';

export interface FrequencyAllocationInput {
  target_type: TargetType;
  target_id: BlueprintId;
  desired_weekly_exposure_units: number;
  available_training_days: readonly Weekday[];
}

export interface FrequencyAllocation {
  target_type: TargetType;
  target_id: BlueprintId;
  sessions_per_week: number;
  assigned_days: Weekday[];
  reasoning: string;
}

/** Picks `count` days spread as evenly as possible across `days`
 * (already in week order), by index — days[round(i * days.length / count)]
 * for i in [0, count). Deterministic, no randomness. */
function spreadDays(days: readonly Weekday[], count: number): Weekday[] {
  if (count <= 0 || days.length === 0) return [];
  const picked: Weekday[] = [];
  const seen = new Set<Weekday>();
  for (let i = 0; i < count; i++) {
    const index = Math.min(days.length - 1, Math.round((i * days.length) / count));
    const day = days[index]!;
    if (!seen.has(day)) {
      seen.add(day);
      picked.push(day);
    }
  }
  return picked;
}

/**
 * Spec §16. `sessions_per_week` is Blueprint's own
 * typical_starting_range_per_week clamped to actual day availability
 * (and to the desired volume — never more sessions than there are
 * desired exposure_units to spread, when that's smaller than the
 * range). `assigned_days` are spread evenly across the available days
 * in week order, with any Monday slot forbidden for a lower-body
 * physique_target swapped for the next available day (required test 12).
 */
export function allocateFrequency(input: FrequencyAllocationInput): FrequencyAllocation {
  const orderedAvailable = WEEKDAYS.filter((d) => input.available_training_days.includes(d));

  if (input.desired_weekly_exposure_units <= 0 || orderedAvailable.length === 0) {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      sessions_per_week: 0,
      assigned_days: [],
      reasoning:
        input.desired_weekly_exposure_units <= 0
          ? 'No desired weekly exposure for this target — nothing to schedule.'
          : 'No training days are available to schedule this target into.',
    };
  }

  const { typical_starting_range_per_week } = BlueprintAdapter.getGlobalPrinciples().frequency;
  const [rangeMin, rangeMax] = typical_starting_range_per_week;

  const byAvailability = Math.min(orderedAvailable.length, rangeMax);
  const byVolume = Math.max(1, Math.floor(input.desired_weekly_exposure_units));
  const sessionsPerWeek = Math.max(1, Math.min(byAvailability, byVolume));

  let assignedDays = spreadDays(orderedAvailable, sessionsPerWeek);

  if (input.target_type === 'physique_target') {
    const otherDays = orderedAvailable.filter((d) => !assignedDays.includes(d));
    assignedDays = assignedDays.map((day) => {
      if (isBodyFocusAllowedOnDay(input.target_id, day)) return day;
      const replacement = otherDays.find((d) => isBodyFocusAllowedOnDay(input.target_id, d) && !assignedDays.includes(d));
      if (replacement) {
        otherDays.splice(otherDays.indexOf(replacement), 1);
        return replacement;
      }
      return day; // no other day available — nothing to swap to (surfaced in reasoning below)
    });
  }

  const droppedMonday = input.target_type === 'physique_target' && !assignedDays.every((d) => isBodyFocusAllowedOnDay(input.target_id, d));

  return {
    target_type: input.target_type,
    target_id: input.target_id,
    sessions_per_week: assignedDays.length,
    assigned_days: assignedDays,
    reasoning:
      `${assignedDays.length} session(s)/week within Blueprint's typical_starting_range_per_week [${rangeMin}, ${rangeMax}] ` +
      `(clamped to ${orderedAvailable.length} available day(s) and ${byVolume} desired weekly exposure_units), spread evenly across: ` +
      `${assignedDays.join(', ')}.` +
      (droppedMonday
        ? ' Could not fully honor the Monday-never-lower-body rule — no alternative day was available to swap into.'
        : input.target_type === 'physique_target' && orderedAvailable.includes('monday')
          ? ' Monday-never-lower-body (§16) checked and respected.'
          : ''),
  };
}
