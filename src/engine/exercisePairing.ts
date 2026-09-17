// Coaching Depth Batch 4 spec §3: exercise pairing (supersets), operating
// only on already-individually-selected PlannedWorkItem-like entries for
// one real session — this module never selects an exercise, it only
// decides which two already-chosen exercises may be tagged as a pair.
//
// Blueprint's own `complements` field turned out (verified against
// src/blueprint/snapshot/exercises.json) to be free-text descriptive
// phrases ("An anti-rotation movement."), never exercise ids — unusable
// as a direct pairing lookup, unlike `overlaps_with` (mostly real ids).
// Rather than inventing a synthetic relationship Blueprint doesn't
// actually encode, this module reuses this app's own existing,
// already-real PUSH_PHYSIQUE_TARGETS/PULL_PHYSIQUE_TARGETS classification
// (config.ts, already used by sessionPurpose.ts) as the one real
// antagonist-muscle-group signal: a push-target exercise paired with a
// pull-target exercise is the classic real antagonist superset pattern.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import { EXERCISE_PAIRING, PULL_PHYSIQUE_TARGETS, PUSH_PHYSIQUE_TARGETS } from './config.js';
import type { DemandLevel } from '../blueprint/types.js';
import type { BlueprintId } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import type { ExercisePreferenceLevel } from './exerciseSelector.js';

const FATIGUE_RANK: Record<DemandLevel, number> = { low: 0, medium: 1, high: 2 };
function fatigueRank(exerciseId: BlueprintId): number {
  const fatigueCost = BlueprintAdapter.getExercise(exerciseId)?.fatigue_cost;
  return FATIGUE_RANK[fatigueCost ?? 'medium'];
}

/** 'push'/'pull' only when the target is unambiguously one or the other
 * (per this app's own existing PUSH/PULL_PHYSIQUE_TARGETS classification
 * — config.ts); anything else (legs, universal, functional_goal) is
 * `null` — never forced into an antagonist classification Blueprint
 * doesn't actually support. */
function antagonistGroup(targetType: TargetType, targetId: BlueprintId): 'push' | 'pull' | null {
  if (targetType !== 'physique_target') return null;
  if (PUSH_PHYSIQUE_TARGETS.includes(targetId)) return 'push';
  if (PULL_PHYSIQUE_TARGETS.includes(targetId)) return 'pull';
  return null;
}

export interface PairingCandidateItem {
  exercise_id: BlueprintId;
  target_type: TargetType;
  target_id: BlueprintId;
}

export interface ExercisePairingResult {
  /** Symmetric: if A is paired with B, both `pairs.get(A) === B` and
   * `pairs.get(B) === A` hold. An exercise absent from this map was
   * evaluated and left unpaired (spec §3: "never force an incompatible
   * pair"). */
  pairs: ReadonlyMap<BlueprintId, BlueprintId>;
  /** One entry per real pair formed or per item that had at least one
   * candidate partner considered and rejected — spec §10 observability
   * ("pairing evaluation... fallback or bypass reason"). */
  reasoning: string[];
}

export interface EvaluateSessionPairingsInput {
  items: readonly PairingCandidateItem[];
  /** Spec §1/§3: "avoided exercises cannot enter a pair" — defensive
   * re-check even though an avoided exercise should never have reached
   * selection at all (see exerciseSelector.ts's Gate 2b). */
  preference_by_exercise_id?: ReadonlyMap<BlueprintId, ExercisePreferenceLevel>;
}

/**
 * Batch 4 spec §3/§4 step 11: evaluates every already-selected item in
 * one real session for a valid antagonist pairing partner. Deterministic
 * — iterates `items` in a stable (exercise-id-sorted) order and never
 * revisits an already-paired item. Pure: never mutates `items`, never
 * reads/writes any persisted state.
 */
export function evaluateSessionPairings(input: EvaluateSessionPairingsInput): ExercisePairingResult {
  const preferenceFor = (id: BlueprintId): ExercisePreferenceLevel => input.preference_by_exercise_id?.get(id) ?? 'neutral';

  // Spec §3: "exercises are not duplicates" / "not already assigned to
  // another pair" — dedupe defensively by exercise_id up front so a
  // caller's own duplicate-in-list bug can never produce a self-pair.
  const eligible = input.items.filter((item, index) => input.items.findIndex((other) => other.exercise_id === item.exercise_id) === index && preferenceFor(item.exercise_id) !== 'avoided');

  const ordered = [...eligible].sort((a, b) => a.exercise_id.localeCompare(b.exercise_id));
  const pairs = new Map<BlueprintId, BlueprintId>();
  const reasoning: string[] = [];

  for (const item of ordered) {
    if (pairs.has(item.exercise_id)) continue; // already paired earlier this pass

    const itemGroup = antagonistGroup(item.target_type, item.target_id);
    if (itemGroup === null) {
      reasoning.push(`${item.exercise_id}: left unpaired — its target is not classified push or pull, so no real antagonist relationship can be determined.`);
      continue;
    }
    const wantGroup = itemGroup === 'push' ? 'pull' : 'push';

    const candidates = ordered.filter(
      (other) =>
        other.exercise_id !== item.exercise_id &&
        !pairs.has(other.exercise_id) &&
        antagonistGroup(other.target_type, other.target_id) === wantGroup &&
        fatigueRank(item.exercise_id) + fatigueRank(other.exercise_id) <= EXERCISE_PAIRING.maxCombinedFatigueRank
    );

    if (candidates.length === 0) {
      reasoning.push(`${item.exercise_id}: left unpaired — no eligible antagonist (${wantGroup}) partner with acceptable combined fatigue was available this session.`);
      continue;
    }

    // Preference compatibility (spec §3 priority #6): prefer a partner
    // that is not explicitly disliked, when a non-disliked option
    // exists — never eliminates every candidate (mirrors
    // exerciseSelector.ts's own narrow() fallback safety).
    const nonDisliked = candidates.filter((c) => preferenceFor(c.exercise_id) !== 'disliked');
    const pool = nonDisliked.length > 0 ? nonDisliked : candidates;
    // Deterministic tie-break: alphabetical by exercise id.
    const partner = [...pool].sort((a, b) => a.exercise_id.localeCompare(b.exercise_id))[0]!;

    pairs.set(item.exercise_id, partner.exercise_id);
    pairs.set(partner.exercise_id, item.exercise_id);
    reasoning.push(`${item.exercise_id} paired with ${partner.exercise_id}: antagonist ${itemGroup}/${wantGroup} muscle groups, combined fatigue acceptable.`);
  }

  return { pairs, reasoning };
}
