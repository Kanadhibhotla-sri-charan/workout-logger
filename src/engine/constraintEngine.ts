// Constraint Engine — spec §6.2/17 (time), §4.1/18 (equipment), §16
// (the Monday-never-lower-body hard schedule rule). Only the parts of
// these constraints that are objective facts, not judgment calls, are
// implemented here: "is this equipment actually available" and "does
// this fit in the remaining time budget, given an explicit time
// estimate." What is NOT implemented: estimating how long an exercise
// takes in the first place — Blueprint has no per-set duration data
// (only a coarse setup_time: DemandLevel label), and this app has no
// approved methodology for turning that into minutes. That estimation
// step belongs to workoutBuilder (see src/engine/workoutBuilder.ts),
// which is intentionally not implemented yet — see
// docs/TRAINING_ENGINE_DESIGN.md.

import type { BlueprintExercise } from '../blueprint/adapter.js';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { Weekday } from '../contracts/types.js';
import { FORBIDDEN_BODY_FOCUS_BY_DAY } from './config.js';

/**
 * True iff every piece of equipment `exercise` requires is present in
 * `availableEquipment`. Exact string match, all-required — mirrors
 * Blueprint's own engine/equipment.ts isEquipmentFeasible exactly (see
 * docs/architecture.md §1), so this app's equipment gating agrees with
 * Blueprint's own recommendation logic rather than inventing a looser or
 * stricter rule.
 */
export function isExerciseEquipmentFeasible(exercise: Pick<BlueprintExercise, 'equipment'>, availableEquipment: readonly string[]): boolean {
  return exercise.equipment.every((item) => availableEquipment.includes(item));
}

/** Filters to only equipment-feasible exercises — the engine must never
 * recommend an exercise requiring unavailable equipment (§18). */
export function filterEquipmentFeasible<T extends Pick<BlueprintExercise, 'equipment'>>(
  exercises: readonly T[],
  availableEquipment: readonly string[]
): T[] {
  return exercises.filter((e) => isExerciseEquipmentFeasible(e, availableEquipment));
}

/**
 * Minutes left in the session budget after `elapsedMinutes` have already
 * been spent. Never negative in the return value's meaning — a negative
 * result means the budget is already exceeded, which callers must treat
 * as "stop adding work," not clamp away.
 */
export function remainingBudgetMinutes(budgetMinutes: number, elapsedMinutes: number): number {
  return budgetMinutes - elapsedMinutes;
}

/**
 * True iff adding `itemMinutes` of work to `elapsedMinutes` already spent
 * still fits within `budgetMinutes` — the hard time constraint from §17.
 * `itemMinutes` must be supplied by the caller (an explicit estimate);
 * this function does not estimate how long an exercise takes itself — see
 * this file's header comment for why that step isn't implemented yet.
 */
export function fitsWithinBudget(budgetMinutes: number, elapsedMinutes: number, itemMinutes: number): boolean {
  return elapsedMinutes + itemMinutes <= budgetMinutes;
}

/**
 * Spec §16's one hard schedule rule: "Monday must never be generated as
 * a lower-body day." Resolves `physiqueTargetId` to its Blueprint
 * `parent_region` and checks that against
 * FORBIDDEN_BODY_FOCUS_BY_DAY[day] (config.ts's
 * LOWER_BODY_PHYSIQUE_REGIONS for monday, currently the only day with
 * any forbidden regions). Returns true (allowed) for an unresolvable
 * target id — this function gates a known lower-body region, it does
 * not itself validate that the id exists.
 */
export function isBodyFocusAllowedOnDay(physiqueTargetId: string, day: Weekday): boolean {
  const forbidden = FORBIDDEN_BODY_FOCUS_BY_DAY[day];
  if (!forbidden || forbidden.length === 0) return true;

  const target = BlueprintAdapter.getTarget(physiqueTargetId);
  if (!target) return true;

  return !forbidden.includes(target.parent_region);
}
