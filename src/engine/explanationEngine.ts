// Explanation Engine — spec §29. Explanations are generated from actual
// decision inputs/rules, never asked from an LLM after the fact (§33).
// Functions here explain the parts of the pipeline that ARE decided
// (exposure contribution, equipment feasibility) with real, deterministic
// text built directly from the same data the decision used. Explaining a
// full exercise-selection or workout-construction decision is NOT
// implemented, because that decision itself isn't (see exerciseSelector.ts,
// workoutBuilder.ts) — there is nothing real yet to explain.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { ExposureContribution } from './exposureEngine.js';
import { NotApprovedError } from './errors.js';

/**
 * Explains one ExposureContribution in plain text, using the same
 * Blueprint data the calculation used — matches
 * docs/TRAINING_EXPOSURE_MODEL.md's "Explainability" worked example
 * exactly (target name, exercise name, set count, Strategy A note).
 */
export function explainExposureContribution(contribution: ExposureContribution): string {
  const exercise = BlueprintAdapter.getExercise(contribution.exercise_id);
  const exerciseName = exercise?.name ?? contribution.exercise_id;
  const targetName =
    contribution.target_type === 'physique_target'
      ? BlueprintAdapter.getTarget(contribution.target_id)?.name
      : BlueprintAdapter.getFunctionalGoal(contribution.target_id)?.name;

  return (
    `${exerciseName} contributed ${contribution.exposure_units} exposure_units to ${targetName ?? contribution.target_id} ` +
    `(${contribution.completed_sets} completed set${contribution.completed_sets === 1 ? '' : 's'}, direct relationship — ` +
    `"${contribution.target_id}" is listed in ${exercise?.id ?? contribution.exercise_id}'s Blueprint target list). ` +
    `Indirect contribution is not tracked (Strategy A — see docs/TRAINING_EXPOSURE_MODEL.md §B).`
  );
}

/**
 * Explains an equipment feasibility check in plain text.
 */
export function explainEquipmentFeasibility(
  exerciseId: string,
  requiredEquipment: readonly string[],
  availableEquipment: readonly string[]
): string {
  const missing = requiredEquipment.filter((item) => !availableEquipment.includes(item));
  if (missing.length === 0) {
    return `${exerciseId} is equipment-feasible: all required equipment (${requiredEquipment.join(', ') || 'none'}) is available.`;
  }
  return `${exerciseId} is NOT equipment-feasible: missing ${missing.join(', ')} (requires ${requiredEquipment.join(', ')}, available: ${availableEquipment.join(', ') || 'none'}).`;
}

/** Always throws NotApprovedError — see this file's header. Exercise
 * selection itself isn't decided yet (exerciseSelector.ts), so there is
 * no real decision to explain. */
export function explainExerciseSelection(): never {
  throw new NotApprovedError(
    'explanationEngine.explainExerciseSelection',
    'exercise-selection-ranking',
    'Cannot explain a decision that exerciseSelector does not yet make — see docs/TRAINING_ENGINE_DESIGN.md §19-20, §29.'
  );
}
