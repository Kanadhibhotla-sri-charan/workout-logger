// Lookup helpers over BlueprintAdapter.getDevelopmentPackages() — real,
// Blueprint-authored per-muscle-group exercise/sets/reps/RIR
// prescriptions (data/programming/development-packages.yaml upstream).
// This is the source workoutBuilder uses for rep-range/RIR guidance
// (spec §19 step 20) — never an app-invented default rep range.
//
// Two levels exist per muscle_group today: "efficient" (fewest
// exercises that avoid real redundancy) and "complete" (more
// thorough). This app defaults to "efficient" — [DEFAULT], not itself
// a Blueprint recommendation of one level over the other, but a
// reasonable, documented, easily-changed starting choice consistent
// with §9's "build up rather than jump" spirit (fewer exercises is the
// more conservative starting point).

import { BlueprintAdapter } from './adapter.js';
import type { BlueprintDevelopmentPackage, BlueprintDevelopmentPackageExercise, BlueprintMuscleGroup } from './types.js';

export const DEFAULT_DEVELOPMENT_PACKAGE_LEVEL = 'efficient';

export interface ParsedRange {
  min: number;
  max: number;
}

/** Parses a Blueprint range string ("6-12") into {min, max}. A bare
 * number ("10") parses to {min: 10, max: 10}. Throws on anything else —
 * this is real Blueprint data with a known, narrow shape; a format this
 * doesn't recognize is a genuine data-shape surprise worth failing
 * loudly on, not silently guessing at. */
export function parseRange(range: string): ParsedRange {
  const dashMatch = range.match(/^(\d+)\s*-\s*(\d+)$/);
  if (dashMatch) {
    return { min: Number(dashMatch[1]), max: Number(dashMatch[2]) };
  }
  const bareNumber = range.match(/^(\d+)$/);
  if (bareNumber) {
    return { min: Number(bareNumber[1]), max: Number(bareNumber[1]) };
  }
  throw new Error(`Unrecognized Blueprint range format: "${range}"`);
}

/** The BlueprintMuscleGroup containing `physiqueTargetId` in its
 * target_ids, or null if none does (e.g. `physiqueTargetId` doesn't
 * exist, or belongs to a target not yet grouped into a development
 * package muscle_group). */
export function findMuscleGroupForTarget(physiqueTargetId: string): BlueprintMuscleGroup | null {
  const { muscle_groups } = BlueprintAdapter.getDevelopmentPackages();
  return muscle_groups.find((g) => g.target_ids.includes(physiqueTargetId)) ?? null;
}

/** The development package for `physiqueTargetId`'s muscle_group at
 * `level` (default "efficient"), or null if the target isn't grouped
 * or no package exists at that level. */
export function getPackageForTarget(
  physiqueTargetId: string,
  level: string = DEFAULT_DEVELOPMENT_PACKAGE_LEVEL
): BlueprintDevelopmentPackage | null {
  const group = findMuscleGroupForTarget(physiqueTargetId);
  if (!group) return null;
  const { packages } = BlueprintAdapter.getDevelopmentPackages();
  return packages.find((p) => p.muscle_group === group.id && p.level === level) ?? null;
}

/** One exercise's Blueprint-authored prescription (sets/reps/RIR) for a
 * physique target, if `exerciseId` appears in that target's
 * development package at `level`. Returns null (never a guess) when
 * the target isn't grouped, there's no package at that level, or this
 * specific exercise isn't part of that package — src/engine/workoutBuilder.ts
 * treats a null result as a genuinely missing dependency (spec §25),
 * not something to fill in with an invented default. */
export function lookupExercisePrescription(
  physiqueTargetId: string,
  exerciseId: string,
  level: string = DEFAULT_DEVELOPMENT_PACKAGE_LEVEL
): BlueprintDevelopmentPackageExercise | null {
  const pkg = getPackageForTarget(physiqueTargetId, level);
  if (!pkg) return null;
  return pkg.exercises.find((e) => e.exercise_id === exerciseId) ?? null;
}
