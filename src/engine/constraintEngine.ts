// Constraint Engine — spec §6.2/17 (time), §4.1/18 (equipment), §16
// (the Monday-never-lower-body hard schedule rule). Only the parts of
// these constraints that are objective facts, not judgment calls, are
// implemented here: "is this equipment actually available," "does this
// fit in the remaining time budget, given an explicit time estimate,"
// and (fitToTimeBudget) "which already-estimated candidates fit,
// preserving higher-priority work first." What is NOT implemented:
// estimating how long an exercise takes in the first place — Blueprint
// has no per-set duration data (only a coarse setup_time: DemandLevel
// label), and this app has no approved methodology for turning that
// into minutes. Every function below that deals with time takes an
// already-estimated minutes figure from its caller; none of them
// invent that estimate themselves. That estimation step belongs to
// workoutBuilder (see src/engine/workoutBuilder.ts), which is
// intentionally not implemented yet — see docs/TRAINING_ENGINE_DESIGN.md.

import type { BlueprintExercise } from '../blueprint/adapter.js';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { Weekday } from '../contracts/types.js';
import { FORBIDDEN_BODY_FOCUS_BY_DAY, LOWER_BODY_PHYSIQUE_REGIONS } from './config.js';

/**
 * True iff `physiqueTargetId` resolves to one of
 * config.ts's LOWER_BODY_PHYSIQUE_REGIONS — the same body-region
 * classification the Monday hard rule (isBodyFocusAllowedOnDay, below)
 * already uses, reused here (remediation §9) so badminton's real
 * programming effects (workoutBuilder's session-set trim and exercise-
 * selection fatigue preference, frequencyEngine's day-avoidance) share
 * one single "what counts as lower body" definition rather than each
 * inventing its own. False for an unresolvable id, like
 * isBodyFocusAllowedOnDay's own unresolvable-id handling.
 */
export function isLowerBodyPhysiqueTarget(physiqueTargetId: string): boolean {
  const target = BlueprintAdapter.getTarget(physiqueTargetId);
  if (!target) return false;
  return LOWER_BODY_PHYSIQUE_REGIONS.includes(target.parent_region);
}

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

export interface FittableItem {
  id: string;
  /** Lower number = higher priority — mirrors goalResolver/
   * resourceAllocation's convention throughout this app. Two items at
   * the same priority are further ordered by `redundant`, then by
   * `id`, never by original array position. */
  priority: number;
  /** Caller-supplied estimate, not computed here (see this file's
   * header). */
  estimated_minutes: number;
  /** Caller-flagged: this item's work meaningfully overlaps with
   * something else already included (e.g. two exercises hitting the
   * same target at the same tier). Redundant items are dropped ahead
   * of non-redundant items at the same priority — spec §6.2 rule 2
   * ("remove/reduce lower-priority OR redundant work"). */
  redundant?: boolean;
}

export interface FitToTimeBudgetResult<T extends FittableItem> {
  kept: T[];
  dropped: T[];
  total_minutes: number;
  reasoning: string;
}

/**
 * Spec §6.2: "When the ideal workout does not fit: (1) preserve
 * higher-priority goal work; (2) remove/reduce lower-priority or
 * redundant work; ... (4) never exceed the time limit. Do not truncate
 * arbitrarily."
 *
 * Greedily keeps items in priority order (lowest `priority` number
 * first; redundant items ordered after non-redundant ones at the same
 * priority; ties broken by `id` for full determinism) as long as the
 * running total stays within `budgetMinutes`. Never exceeds the
 * budget by construction (rule 4). Never truncates by original list
 * order (rule "do not truncate arbitrarily") — what gets dropped is
 * always the lowest-priority/most-redundant tail of the sorted list,
 * named explicitly in `reasoning`, never an arbitrary cut.
 *
 * Rule 3 ("substitute exercises where this improves feasibility") is
 * not this function's job — it decides keep/drop among already-chosen
 * candidates with already-known estimates; finding a shorter
 * alternative for a dropped item is exerciseSelector's/the caller's
 * job, re-invoked with a tighter constraint if it chooses to.
 */
export function fitToTimeBudget<T extends FittableItem>(items: readonly T[], budgetMinutes: number): FitToTimeBudgetResult<T> {
  const ordered = [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (!!a.redundant !== !!b.redundant) return a.redundant ? 1 : -1;
    return a.id.localeCompare(b.id);
  });

  const kept: T[] = [];
  const dropped: T[] = [];
  let total = 0;

  for (const item of ordered) {
    if (fitsWithinBudget(budgetMinutes, total, item.estimated_minutes)) {
      kept.push(item);
      total += item.estimated_minutes;
    } else {
      dropped.push(item);
    }
  }

  const reasoning =
    dropped.length === 0
      ? `All ${kept.length} item(s) fit within the ${budgetMinutes}-minute budget (${total} minutes used) — nothing dropped.`
      : `Kept ${kept.length} item(s) totaling ${total}/${budgetMinutes} minutes, in priority order. Dropped ${dropped.length} ` +
        `lower-priority/redundant item(s) that would have exceeded the budget: ${dropped.map((d) => d.id).join(', ')}.`;

  return { kept, dropped, total_minutes: total, reasoning };
}
