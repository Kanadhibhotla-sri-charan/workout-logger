// Exercise Selector — spec §19-20. Equipment/time FEASIBILITY filtering
// is already decided and implemented (src/engine/constraintEngine.ts) —
// what's NOT implemented here is RANKING among the feasible candidates
// (redundancy avoidance, fatigue, user preference, exercise rotation
// reasoning) — that requires an approved selection rule this app doesn't
// have yet. See docs/TRAINING_ENGINE_DESIGN.md §19-20.

import type { BlueprintId } from '../contracts/types.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';
import { NotApprovedError } from './errors.js';

export interface ExerciseSelectionInput {
  target_type: TargetType;
  target_id: BlueprintId;
  target_tier: TargetPriorityTier;
  /** Already equipment/time-feasible candidates — see
   * constraintEngine.filterEquipmentFeasible. This module's job is
   * choosing among them, not filtering. */
  candidate_exercise_ids: readonly BlueprintId[];
  /** Exercise ids already used elsewhere in the session/recent history —
   * redundancy avoidance input, not yet acted on. */
  recent_exercise_ids: readonly BlueprintId[];
}

export interface ExerciseSelectionResult {
  exercise_id: BlueprintId;
  reasoning: string;
}

/** Always throws NotApprovedError — see this file's header. */
export function selectExercise(_input: ExerciseSelectionInput): ExerciseSelectionResult {
  throw new NotApprovedError(
    'exerciseSelector',
    'exercise-selection-ranking',
    'Feasibility filtering exists (constraintEngine); ranking among feasible candidates (redundancy, fatigue, preference) needs an approved rule — see docs/TRAINING_ENGINE_DESIGN.md §19-20.'
  );
}
