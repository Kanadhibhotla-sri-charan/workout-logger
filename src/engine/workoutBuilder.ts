// Workout Builder — Next Phase spec §19 (the 22-step pipeline).
// NOT IMPLEMENTED YET: volumeEngine, frequencyEngine, recoveryEngine,
// progressionEngine, and exerciseSelector are all real now — what this
// module still needs before it can assemble them into an actual workout
// is (a) resourceAllocation (§17: competing-goal time/volume/exercise-slot
// allocation respecting user ranking) and (b) the actual time-fitting
// algorithm (§6.2: preserve higher-priority work, substitute/trim without
// truncating arbitrarily) — constraintEngine currently only has the
// budget-check primitives, not that algorithm. Building the full pipeline
// before those two exist would mean inventing the very allocation logic
// the spec says not to invent. See docs/TRAINING_ENGINE_DESIGN.md §19.

import type { BlueprintId, ExerciseRole, SessionType } from '../contracts/types.js';
import { NotApprovedError } from './errors.js';

export interface WorkoutBuildInput {
  date: string;
  session_type: SessionType;
  budget_minutes: number;
  goal_id: string;
}

export interface PlannedExercise {
  exercise_id: BlueprintId;
  role: ExerciseRole | string;
  target_sets: number;
  target_reps_min: number;
  target_reps_max: number;
  reasoning: string;
}

export interface WorkoutBuildResult {
  exercises: PlannedExercise[];
  estimated_minutes: number;
  reasoning: string;
}

/** Always throws NotApprovedError — see this file's header. */
export function buildWorkout(_input: WorkoutBuildInput): WorkoutBuildResult {
  throw new NotApprovedError(
    'workoutBuilder',
    'resource-allocation-and-time-fitting',
    'Depends on resourceAllocation (§17) and a real time-fitting algorithm (§6.2, constraintEngine currently only has budget-check primitives), neither of which exist yet — see docs/TRAINING_ENGINE_DESIGN.md §19.'
  );
}
