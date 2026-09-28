// Push Generation Architectural Fix (2026-09-24), priority 2: a real,
// deterministic feasibility calculation added to generate_session's own
// context — see docs investigation report for the full rationale. Real-
// provider testing showed the model reliably (8/8 attempts, across two
// prompt versions) fails to discover, on its own, that a single
// authored exercise cannot reach a target's adequacy floor and that it
// must add a further exercise to close the gap — even when the prompt
// explicitly instructs it to. This module performs that arithmetic
// deterministically instead, using exactly the same ingredients and the
// exact same UNDER_PRESCRIPTION_TOLERANCE the adequacy validator itself
// checks against, so the two can never silently disagree.
//
// Deliberately NOT a second, independently-invented "which exercises are
// good" ranking: `computeTargetFeasibility` only ever asks "does a real
// combination of this target's own already-real candidates clear the
// real threshold" — never which one is best, never a coaching judgment.
// The AI keeps every real judgment call (which specific exercise, order,
// rationale, intensity technique, pairing) — see this module's own
// doc comments below for the exact boundary.

import type { BlueprintId } from '../../contracts/types.js';
import type { AIProgrammerTargetContext, AIProgrammerTargetFeasibility, AIProgrammerValidExerciseContext } from './programmerContextTypes.js';
import { creditedTargetKeys } from '../validation/sharedCredit.js';

/** A candidate's real, repair-respecting per-exercise ceiling: its own
 * authored sets, never exceeding the target's own
 * directSetsPerExposureCap (exactly like repairExercise's own
 * `Math.min(authored.sets, cap)`).
 *
 * Feasibility/Completion Consistency Fix (2026-09-24): this NO LONGER
 * falls back to MAX_SETS_WITHOUT_AUTHORED_CAP for an unauthored
 * candidate. Deterministic completion (programmerAdequacyCompletion.ts)
 * is deliberately, permanently restricted to authored-only candidates —
 * it must never invent a rep/RIR range for a brand-new exercise entry.
 * Before this fix, feasibility computed its own candidate universe using
 * the looser MAX_SETS_WITHOUT_AUTHORED_CAP fallback, which could report
 * isFeasible: true using an unauthored candidate completion is not
 * permitted to add — a real, observed inconsistency (Pull's upper-traps:
 * feasibility said "1 exercise (conventional-deadlift, unauthored)
 * suffices," but completion correctly refused to add it and had nothing
 * else authored left). Feasibility's candidate universe must be a
 * SUBSET of what completion may legally act on, never a superset — see
 * this function's only caller, which now pre-filters to authored
 * candidates only. */
function effectiveCeiling(candidate: AIProgrammerValidExerciseContext, directSetsPerExposureCap: number | null): number {
  const authoredMax = candidate.authoredPrescription!.sets;
  return directSetsPerExposureCap != null ? Math.min(authoredMax, directSetsPerExposureCap) : authoredMax;
}

/** The smallest real combination of `target`'s own candidates whose
 * combined effective ceilings clear `threshold` — a simple greedy
 * largest-ceiling-first accumulation (this is a "does at least one small
 * real combination exist" check, never an optimal bin-packing search;
 * the AI still freely chooses which specific exercises to actually use).
 * Returns `{ isFeasible: false }` when even every real candidate
 * combined cannot reach `threshold` — reported explicitly rather than
 * silently assumed away. */
function computeMinimumCombination(
  candidates: readonly { exerciseId: BlueprintId; ceiling: number }[],
  threshold: number
): { isFeasible: boolean; minimumExerciseCount: number | null; combination: BlueprintId[] } {
  if (threshold <= 0) return { isFeasible: true, minimumExerciseCount: 0, combination: [] };
  const sorted = [...candidates].sort((a, b) => b.ceiling - a.ceiling);
  const combination: BlueprintId[] = [];
  let running = 0;
  for (const c of sorted) {
    if (running >= threshold) break;
    combination.push(c.exerciseId);
    running += c.ceiling;
  }
  const isFeasible = running >= threshold;
  return { isFeasible, minimumExerciseCount: isFeasible ? combination.length : null, combination: isFeasible ? combination : [] };
}

/** Every other target key ("targetType:targetId") that shares at least
 * one EXACT candidate exerciseId with `target` in Blueprint's own
 * authored sub-target scope — reuses creditedTargetKeys (sharedCredit.ts)
 * so this can never report a relationship the actual crediting logic
 * doesn't also apply. Never a fuzzy or physiologically-inferred
 * relationship (do not add heuristics here — see this file's own header
 * comment and sharedCredit.ts's). */
function sharedCreditTargetsFor(target: AIProgrammerTargetContext, allTargets: readonly AIProgrammerTargetContext[]): string[] {
  const ownKey = `${target.targetType}:${target.targetId}`;
  const shared = new Set<string>();
  for (const candidate of target.validExercises) {
    const keys = creditedTargetKeys({ exerciseId: candidate.exerciseId, targetType: target.targetType, targetId: target.targetId }, allTargets);
    for (const key of keys) {
      if (key !== ownKey) shared.add(key);
    }
  }
  return [...shared];
}

/** The full deterministic feasibility answer for one target — see
 * AIProgrammerTargetFeasibility's own doc comment for what each field
 * means and AIProgrammerMuscleGuidance.feasibility's for why this
 * exists at all. `recommendedMinimum`/`directSetsPerExposureCap` come
 * from the SAME guidance object this is attached to (never re-derived),
 * so they can never drift from what the adequacy validator itself
 * checks. */
export function computeTargetFeasibility(
  target: AIProgrammerTargetContext,
  allTargets: readonly AIProgrammerTargetContext[],
  recommendedMinimum: number,
  directSetsPerExposureCap: number | null,
  underPrescriptionTolerance: number
): AIProgrammerTargetFeasibility {
  const adequacyThreshold = recommendedMinimum * underPrescriptionTolerance;
  // Feasibility/Completion Consistency Fix (2026-09-24): only candidates
  // deterministic completion is actually permitted to add — real,
  // Blueprint-AUTHORED ones — ever count toward feasibility. An
  // unauthored candidate (no matter how generous its generic
  // application-default ceiling) can never make a target feasible here,
  // exactly matching completion's own permanent, unchanged authored-only
  // restriction (see effectiveCeiling's own doc comment above).
  const authoredCandidates = target.validExercises.filter((v) => v.authoredPrescription !== null);
  const candidates = authoredCandidates.map((v) => ({ exerciseId: v.exerciseId, ceiling: effectiveCeiling(v, directSetsPerExposureCap) }));
  const singleExerciseSufficient = candidates.some((c) => c.ceiling >= adequacyThreshold);
  const { isFeasible, minimumExerciseCount, combination } = computeMinimumCombination(candidates, adequacyThreshold);

  return {
    recommendedMinimum,
    adequacyThreshold,
    singleExerciseSufficient,
    minimumExerciseCount,
    feasibleCombinations: isFeasible ? [combination] : [],
    isFeasible,
    sharedCreditWith: sharedCreditTargetsFor(target, allTargets),
  };
}
