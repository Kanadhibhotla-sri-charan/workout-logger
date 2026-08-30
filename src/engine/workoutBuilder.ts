// Workout Builder — spec §25. NOT IMPLEMENTED: assembling target
// allocation -> exercise selection -> ordering -> sets/reps/rest targets
// -> a time estimate depends on volumeEngine, frequencyEngine,
// recoveryEngine, and exerciseSelector all being resolved first — none of
// which are. This is deliberately the last stub in the pipeline: building
// it before its dependencies are approved would mean inventing the very
// formulas the spec says not to invent. See
// docs/TRAINING_ENGINE_DESIGN.md §25 and §31 (pipeline).

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
    'volume-frequency-recovery-and-exercise-selection',
    'Depends on volumeEngine, frequencyEngine, recoveryEngine, and exerciseSelector, none of which have approved rules yet — see docs/TRAINING_ENGINE_DESIGN.md §25, §31.'
  );
}
