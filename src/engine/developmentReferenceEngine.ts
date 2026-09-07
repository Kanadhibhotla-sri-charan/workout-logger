// Programming Redesign (Step 12) §3-§5: the one authoritative
// abstraction for "this target's Blueprint development-package weekly
// direct-set reference" — Active goal -> Complete package, Non-goal ->
// Efficient package (§5 non-negotiable rules #1-#8). Every caller that
// needs a per-target volume reference goes through this module instead
// of reading a single universal number
// (BlueprintAdapter.getGlobalPrinciples().weekly_volume) for every
// muscle regardless of which one it is.
//
// The weekly reference is calculated, never hardcoded:
//   sum(package exercise sets) x package frequency.sessions_per_week
// If Blueprint's package data changes, this number changes with it —
// nothing here duplicates a package's own volume numbers.
//
// A target with no matching development package (today: every
// functional_goal, and any physique_target Blueprint hasn't yet grouped
// into a muscle_group) returns package_id/weekly_direct_set_reference as
// null — an explicit, honest "no package reference exists for this
// target" rather than a guessed or defaulted number (spec §16.A
// "missing package behaviour is explicit").

import { getPackageForTarget } from '../blueprint/developmentPackages.js';
import type { BlueprintId } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';

export type DevelopmentPackageLevel = 'complete' | 'efficient';

export interface DevelopmentReference {
  target_type: TargetType;
  target_id: BlueprintId;
  /** 'complete' for an active-goal (specialization) target, 'efficient'
   * for a non-goal target — the level this reference was computed at,
   * always present even when no package was actually found (so a
   * caller can tell WHICH level was attempted). */
  level: DevelopmentPackageLevel;
  package_id: string | null;
  /** sum(exercise.sets) x frequency.sessions_per_week for this target's
   * muscle_group package at `level` — null when no package exists for
   * this target (see module doc comment). A reference point for
   * programming decisions, never a quota to hit and never copied
   * directly into a generated workout (spec §1 rules #7-#8). */
  weekly_direct_set_reference: number | null;
  coverage: { muscle_group_id: string; exercise_count: number } | null;
}

/** Only physique targets are grouped into Blueprint's muscle_group
 * development packages today — a functional_goal target_id never
 * resolves to one, so this returns the explicit "no package" shape
 * for it rather than guessing at a functional-goal package that
 * doesn't exist in Blueprint's data. */
export function getDevelopmentReference(targetType: TargetType, targetId: BlueprintId, level: DevelopmentPackageLevel): DevelopmentReference {
  if (targetType !== 'physique_target') {
    return { target_type: targetType, target_id: targetId, level, package_id: null, weekly_direct_set_reference: null, coverage: null };
  }

  const pkg = getPackageForTarget(targetId, level);
  if (!pkg) {
    return { target_type: targetType, target_id: targetId, level, package_id: null, weekly_direct_set_reference: null, coverage: null };
  }

  const totalSetsPerSession = pkg.exercises.reduce((sum, e) => sum + e.sets, 0);
  return {
    target_type: targetType,
    target_id: targetId,
    level,
    package_id: pkg.id,
    weekly_direct_set_reference: totalSetsPerSession * pkg.frequency.sessions_per_week,
    coverage: { muscle_group_id: pkg.muscle_group, exercise_count: pkg.exercises.length },
  };
}

/** §5 non-negotiable rule #2/#3, applied generically: the level a target
 * should be referenced against, given whether it's reached through an
 * active goal (`is_specialization`, matching workoutBuilder.ts's own
 * existing field of that exact name) or not. */
export function developmentPackageLevelFor(isSpecialization: boolean): DevelopmentPackageLevel {
  return isSpecialization ? 'complete' : 'efficient';
}
