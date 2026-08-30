// Progression Engine — spec §26-27. NOT IMPLEMENTED: deciding when/how to
// progress load, reps, or sets from actual performance requires rep-range,
// load-increment, performance-threshold, RIR/RPE-interpretation, and
// deload rules this app does not have approved yet — see
// docs/TRAINING_ENGINE_DESIGN.md §26-27. What IS already true in this
// codebase, and must stay true once this module is implemented: planned
// and actual performance are distinct (ProgramSessionExercise's
// target_sets/target_reps_min/target_reps_max vs. ExercisePerformance's
// logged Set[] — see src/contracts/types.ts) — this module must read the
// actual Set[] history, never assume planned sets were completed.

import type { BlueprintId } from '../contracts/types.js';
import type { Set as LoggedSet } from '../contracts/types.js';
import { NotApprovedError } from './errors.js';

export interface ProgressionInput {
  exercise_id: BlueprintId;
  /** Actual logged sets from the most recent prior session performing
   * this exercise — never the plan, always what actually happened. */
  previous_actual_sets: readonly Pick<LoggedSet, 'weight' | 'reps' | 'completed'>[];
}

export type ProgressionRecommendation = 'increase_load' | 'increase_reps' | 'maintain' | 'reduce' | 'unknown';

export interface ProgressionResult {
  exercise_id: BlueprintId;
  recommendation: ProgressionRecommendation;
  reasoning: string;
}

/** Always throws NotApprovedError — see this file's header. */
export function computeProgression(_input: ProgressionInput): ProgressionResult {
  throw new NotApprovedError(
    'progressionEngine',
    'progression-methodology',
    'Needs approved rep-range/load-increment/performance-threshold/RIR-RPE/deload rules first — see docs/TRAINING_ENGINE_DESIGN.md §26-27.'
  );
}
