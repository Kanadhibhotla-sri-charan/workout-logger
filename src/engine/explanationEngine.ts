// Explanation Engine — spec §20. Explanations are generated from actual
// decision inputs/rules, never asked from an LLM after the fact (§21).
// Functions here explain the parts of the pipeline that ARE decided
// (exposure contribution, equipment feasibility, exercise selection)
// with real, deterministic text built directly from the same data the
// decision used. Explaining a full workout-construction decision is NOT
// implemented yet, because that decision itself isn't (see
// workoutBuilder.ts) — there is nothing real yet to explain there.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { ExposureContribution } from './exposureEngine.js';
import type { ExerciseSelectionResult } from './exerciseSelector.js';
import { EXPOSURE_COEFFICIENTS } from './config.js';

/**
 * Explains one ExposureContribution in plain text, using the same
 * Blueprint data the calculation used — matches
 * docs/TRAINING_EXPOSURE_MODEL.md's "Explainability" worked example
 * exactly (target name, role, coefficient, exercise name, set count).
 */
export function explainExposureContribution(contribution: ExposureContribution): string {
  const exercise = BlueprintAdapter.getExercise(contribution.exercise_id);
  const exerciseName = exercise?.name ?? contribution.exercise_id;
  const targetName =
    contribution.target_type === 'physique_target'
      ? BlueprintAdapter.getTarget(contribution.target_id)?.name
      : BlueprintAdapter.getFunctionalGoal(contribution.target_id)?.name;
  const coefficient = contribution.role === 'primary' ? EXPOSURE_COEFFICIENTS.primary : EXPOSURE_COEFFICIENTS.secondary;
  const relationship =
    contribution.role === 'primary'
      ? `direct/primary — "${contribution.target_id}" is listed in ${exercise?.id ?? contribution.exercise_id}'s Blueprint target list`
      : `secondary — resolved from ${exercise?.id ?? contribution.exercise_id}'s Blueprint secondary_targets text via this app's curated mapping (docs/SECONDARY_TARGET_MAPPING.md, not a Blueprint canonical field)`;

  return (
    `${exerciseName} contributed ${contribution.exposure_units} exposure_units to ${targetName ?? contribution.target_id} ` +
    `(${contribution.completed_sets} completed set${contribution.completed_sets === 1 ? '' : 's'} × ${coefficient} ${contribution.role} coefficient, ${relationship}).`
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

/**
 * Explains an exercise-selection decision. exerciseSelector.selectExercise
 * already builds its own full reasoning text as part of its result (every
 * factor that mattered — Blueprint muscle role, redundancy, current-vs-
 * replaced), so this is a thin, explicit accessor rather than a second
 * formula: the explanation is generated from the same decision inputs the
 * selection itself used, never reconstructed after the fact.
 */
export function explainExerciseSelection(result: ExerciseSelectionResult): string {
  return result.reasoning;
}
