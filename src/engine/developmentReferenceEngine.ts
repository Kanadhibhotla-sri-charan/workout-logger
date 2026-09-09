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
//
// One-Pass Dev Spec v2 §1.3/§1.4/§6/§24: `weekly_direct_set_reference` is
// a WEEKLY AGGREGATE OBJECTIVE for the target, never a single exposure's
// literal prescription — see this module's own §1.3 audit finding.
// `direct_sets_per_exposure` (sum(package exercise sets) alone, without
// the frequency multiplier) is the genuinely distinct PER-EXPOSURE
// reference: the natural amount of direct work this target's own package
// composes into ONE real training session. workoutBuilder.ts's weekly
// plan construction must size each real exposure day against
// `direct_sets_per_exposure`, never against the full remaining
// `weekly_direct_set_reference` — collapsing the two is exactly the
// "assign the whole aggregate to a single exposure" defect this spec
// requires fixing (§1.3's package/target/exercise/exposure four-layer
// model, §6, §25).

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
   * this target (see module doc comment).
   *
   * Remediation (Step 12 Fix) §8: this is a WEEKLY OBJECTIVE — e.g. a
   * Complete-package value of 26 means "aim for roughly 26 real direct
   * sets across this target's real training days over the week," never
   * "today's session must deliver 26 sets," never a single day's literal
   * prescription, and never a quota whose mere completion implies
   * anything about real progress. A caller distributes real work toward
   * this weekly figure across whichever real days a target is actually
   * trained on (see workoutBuilder.ts's weekly-first allocation) — it is
   * never copied directly into one generated workout (spec §1 rules
   * #7-#8). */
  weekly_direct_set_reference: number | null;
  /** One-Pass Dev Spec v2 §1.3/§6/§25: sum(package exercise sets) for
   * this target's package at `level` — the PER-EXPOSURE reference
   * (never multiplied by frequency). This is the number a single real
   * training session's direct work for this target should be sized
   * against; `weekly_direct_set_reference` above is the aggregate across
   * the whole intended exposure cycle and must never be assigned to one
   * exposure directly. Null under the identical conditions as
   * `weekly_direct_set_reference`. */
  direct_sets_per_exposure: number | null;
  /** pkg.frequency.sessions_per_week for this target's package at
   * `level` — Blueprint's own intended exposure frequency, kept
   * alongside the two set references above so a caller never has to
   * re-derive it by dividing `weekly_direct_set_reference` by
   * `direct_sets_per_exposure` (which is exactly how it was computed).
   * Null under the identical conditions as the fields above. */
  sessions_per_week_reference: number | null;
  coverage: { muscle_group_id: string; exercise_count: number } | null;
}

/** Only physique targets are grouped into Blueprint's muscle_group
 * development packages today — a functional_goal target_id never
 * resolves to one, so this returns the explicit "no package" shape
 * for it rather than guessing at a functional-goal package that
 * doesn't exist in Blueprint's data. */
export function getDevelopmentReference(targetType: TargetType, targetId: BlueprintId, level: DevelopmentPackageLevel): DevelopmentReference {
  if (targetType !== 'physique_target') {
    return {
      target_type: targetType,
      target_id: targetId,
      level,
      package_id: null,
      weekly_direct_set_reference: null,
      direct_sets_per_exposure: null,
      sessions_per_week_reference: null,
      coverage: null,
    };
  }

  const pkg = getPackageForTarget(targetId, level);
  if (!pkg) {
    return {
      target_type: targetType,
      target_id: targetId,
      level,
      package_id: null,
      weekly_direct_set_reference: null,
      direct_sets_per_exposure: null,
      sessions_per_week_reference: null,
      coverage: null,
    };
  }

  const totalSetsPerSession = pkg.exercises.reduce((sum, e) => sum + e.sets, 0);
  return {
    target_type: targetType,
    target_id: targetId,
    level,
    package_id: pkg.id,
    weekly_direct_set_reference: totalSetsPerSession * pkg.frequency.sessions_per_week,
    direct_sets_per_exposure: totalSetsPerSession,
    sessions_per_week_reference: pkg.frequency.sessions_per_week,
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
