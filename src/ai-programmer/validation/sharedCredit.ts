// Shared-credit source of truth (extracted 2026-09-24 from
// weeklyVolumeAudit.ts, behavior byte-for-byte unchanged — Push
// Generation Architectural Fix, priority 1): the ONE function that
// decides which target(s) a given exercise's sets count toward, reusing
// Blueprint's own human-authored sub-target exercise scope
// (subTargetExerciseScope.ts) — never a second, independently-derived
// notion of "shared muscle." Originally used only by the week-level
// goal-completion volume audit; now also the real crediting logic behind
// generate_session's own adequacy check (programmerAdequacyValidator.ts),
// so a set assigned to an exercise Blueprint's own package explicitly
// scopes to multiple targets (e.g. overhead-triceps-extension counting
// toward both `triceps` and `triceps-long-head`) is credited identically
// everywhere in this codebase, not just in the week-level audit.
//
// IMPORTANT (documented 2026-09-24 Push architectural investigation):
// this credits ONLY exact exerciseId membership in Blueprint's own
// per-target sub-scope (getSubTargetExerciseIds) — never a fuzzy or
// physiological inference. A muscle_group with no entry in
// SUB_TARGET_EXERCISE_SCOPE (today: shoulders, back, forearms, core)
// falls back to crediting only the exercise's own literally-assigned
// target, exactly as before this module existed. In particular, the
// `core` package (obliques/rectus-abdominis) has no scope entry today,
// so an ab exercise's sets are NOT automatically credited to both
// targets by this function — see docs/PUSH_ARCHITECTURAL_FIX_REPORT.md
// (or the equivalent investigation report) for why adding one, done
// honestly from Blueprint's own authored contribution text, would not
// change that (cable-crunch/hanging-knee-leg-raise are specifically
// rectus-abdominis text; pallof-press/cable-woodchop are specifically
// oblique text — no exercise's text names both).

import { getSubTargetExerciseIds } from '../../blueprint/subTargetExerciseScope.js';
import { developmentPackageLevelFor, getDevelopmentReference } from '../../engine/developmentReferenceEngine.js';
import type { TargetType } from '../../engine/goalResolver.js';
import type { AIProgrammerTargetContext } from '../context/programmerContextTypes.js';

export interface CreditableExercise {
  exerciseId: string;
  targetType: string;
  targetId: string;
}

export const keyOf = (targetType: string, targetId: string): string => `${targetType}:${targetId}`;

function referenceFor(target: AIProgrammerTargetContext) {
  return getDevelopmentReference(target.targetType as TargetType, target.targetId, developmentPackageLevelFor(target.isSpecialization));
}

/** Every target whose own Blueprint-scoped exercise list contains
 * `exercise.exerciseId`; the exercise's own literally-assigned target
 * when none does (including every target whose muscle_group package has
 * no scope entry at all — see this file's own header comment). Never
 * returns an empty array. */
export function creditedTargetKeys(exercise: CreditableExercise, targets: readonly AIProgrammerTargetContext[]): string[] {
  const credited: string[] = [];
  for (const target of targets) {
    if (target.targetType !== 'physique_target') continue;
    const packageId = referenceFor(target).package_id;
    if (!packageId) continue;
    if (getSubTargetExerciseIds(packageId, target.targetId)?.includes(exercise.exerciseId)) credited.push(keyOf(target.targetType, target.targetId));
  }
  return credited.length > 0 ? credited : [keyOf(exercise.targetType, exercise.targetId)];
}

/** Push Generation Architectural Fix (2026-09-24), priority 3
 * (deterministic completion): the ONE place that sums a proposal's real
 * CREDITED sets per target — used by both programmerAdequacyValidator.ts
 * (to decide pass/fail) and programmerAdequacyCompletion.ts (to decide
 * whether/how much completion is needed). Sharing this single function
 * guarantees completion always sees the exact same numbers adequacy will
 * check afterward — they can never silently disagree. */
export function creditedSetsByTarget<T extends CreditableExercise & { sets: number }>(exercises: readonly T[], targets: readonly AIProgrammerTargetContext[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const ex of exercises) {
    for (const key of creditedTargetKeys(ex, targets)) {
      totals.set(key, (totals.get(key) ?? 0) + ex.sets);
    }
  }
  return totals;
}
