// Exercise Universe Resolver — spec §4. Blueprint is the default, trusted
// exercise pool (§4.1); an outside-Blueprint exercise is only usable once
// explicitly approved (§4.2, enforced by
// OutsideBlueprintExercisesRepo.approve — never automatic). This module
// is the single point every write path (WorkoutSessionsRepo,
// ProgramsRepo) checks before accepting an exercise_id, so "known
// exercise" always means the same thing everywhere in this app.
//
// Impure by necessity (like src/engine/trainingState.ts): resolving an
// outside-Blueprint id requires a database read.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { OutsideBlueprintExercisesRepo } from '../repositories/outsideBlueprintExercisesRepo.js';

export type ExerciseSource = 'blueprint' | 'outside_blueprint';

export interface ResolvedExercise {
  source: ExerciseSource;
  exercise_id: string;
  name: string;
}

/**
 * Resolves `exerciseId` against Blueprint first (§4.1: the default,
 * trusted pool), then approved outside-Blueprint proposals. Returns null
 * if it's neither a real Blueprint exercise nor an approved outside
 * proposal — a merely-proposed-but-not-yet-approved outside exercise
 * resolves to null too, exactly the point of the approval gate.
 */
export function resolveExercise(db: Database.Database, exerciseId: string): ResolvedExercise | null {
  const blueprintExercise = BlueprintAdapter.getExercise(exerciseId);
  if (blueprintExercise) {
    return { source: 'blueprint', exercise_id: exerciseId, name: blueprintExercise.name };
  }

  const outside = new OutsideBlueprintExercisesRepo(db).get(exerciseId);
  if (outside && outside.approved) {
    return { source: 'outside_blueprint', exercise_id: exerciseId, name: outside.name };
  }

  return null;
}

export function isKnownExercise(db: Database.Database, exerciseId: string): boolean {
  return resolveExercise(db, exerciseId) !== null;
}
