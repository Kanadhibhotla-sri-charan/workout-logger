// Athletic drills (Blueprint 89dd2d6): records with a `training_mode`.
// Blueprint's own rule: a drill answers only the functional goals it
// carries, never a physique target or region. The app follows the same
// rule everywhere it picks or credits exercises.

import { BlueprintAdapter } from './adapter.js';
import type { BlueprintExercise, TrainingMode } from './types.js';

/** The six athletic functional goals the drills carry (badminton-oriented). */
export const ATHLETIC_GOAL_IDS = [
  'lower-body-power',
  'agility-change-of-direction',
  'landing-control',
  'ankle-resilience',
  'lower-body-mobility',
  'full-body-conditioning',
] as const;
export type AthleticGoalId = (typeof ATHLETIC_GOAL_IDS)[number];

export function isDrill(exercise: Pick<BlueprintExercise, 'training_mode'> | undefined | null): boolean {
  return !!exercise?.training_mode;
}

export function isDrillId(exerciseId: string): boolean {
  return isDrill(BlueprintAdapter.getExercise(exerciseId));
}

export function trainingModeOf(exerciseId: string): TrainingMode | null {
  return BlueprintAdapter.getExercise(exerciseId)?.training_mode ?? null;
}

/** Every drill in the library. */
export function allDrills(): BlueprintExercise[] {
  return BlueprintAdapter.getExercises().filter(isDrill);
}
