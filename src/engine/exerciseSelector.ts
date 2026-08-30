// Exercise Selector — Strict Remediation Specification §3.
//
// PREVIOUSLY this module ranked candidates with an arbitrary numeric
// score (+2 primary / +1 secondary / -1 recent / +0.5 current). The
// remediation spec explicitly forbids that ("Remove them from
// production programming logic. Do not replace them with another
// arbitrary numerical scoring system.") and mandates a strict ORDERED
// hierarchy instead: each gate narrows the candidate set by category
// membership, never by a summed/weighted value. A gate that would
// eliminate every remaining candidate is skipped (the narrower set
// from the previous gate carries forward) rather than ever returning
// zero candidates because of its own preference.
//
// Gate 1 (feasibility — equipment/time/schedule/Blueprint-or-approved-
// outside-Blueprint validity) is NOT re-implemented here: it already
// happens upstream (constraintEngine.filterEquipmentFeasible,
// constraintEngine.fitToTimeBudget, constraintEngine
// .isBodyFocusAllowedOnDay, exerciseUniverse's resolution) and every id
// in candidate_exercise_ids is assumed already feasible by the time it
// reaches this module. Gates 2-6 below are this module's actual job.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import { resolveSecondaryTarget } from '../blueprint/secondaryTargetMapping.js';
import type { BlueprintId } from '../contracts/types.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';

export interface ExerciseSelectionInput {
  target_type: TargetType;
  target_id: BlueprintId;
  target_tier: TargetPriorityTier;
  /** Already equipment/time/schedule-feasible candidates (Gate 1,
   * applied upstream). This module's job starts at Gate 2. */
  candidate_exercise_ids: readonly BlueprintId[];
  /** Exercise ids used for this target within the recent history
   * window — Gate 4's "avoid inappropriate repetition" input. */
  recent_exercise_ids: readonly BlueprintId[];
  /** The exercise most recently prescribed/performed for this target,
   * if any — the one candidate with genuinely "usable prior
   * performance history" in the sense Gate 5 means (continuing it
   * enables measurable load/rep progression; see progressionEngine).
   * Never overrides Gate 2/3 — a current pick that no longer serves
   * the target at all, or is no longer feasible, was already removed
   * from candidate_exercise_ids before this module sees it. */
  current_exercise_id?: BlueprintId | null;
  /** Exercise ids already selected for a DIFFERENT target earlier in
   * the same session being built — Gate 3's "missing movement/muscle
   * coverage; avoidance of unnecessary redundancy" input. Optional;
   * defaults to none (a caller building one target in isolation, e.g.
   * a unit test, has nothing to avoid yet). */
  exercises_already_planned_today?: readonly BlueprintId[];
}

export interface ExerciseSelectionResult {
  exercise_id: BlueprintId;
  reasoning: string;
  /** Which gate actually made the final cut to one candidate — Gate 6
   * only when genuine ties survived every earlier gate. Machine-
   * readable, so a caller/UI can show *why* without parsing prose. */
  decisive_gate: 'gate2_goal_relevance' | 'gate3_programming_need' | 'gate4_historical_context' | 'gate5_progression_continuity' | 'gate6_tie_break';
  /** Candidates present after Gate 2 that did NOT win — for
   * explainability (remediation §16: "rejected candidates"). */
  rejected_candidates: BlueprintId[];
}

export class NoFeasibleExerciseError extends Error {
  constructor(public targetType: TargetType, public targetId: BlueprintId) {
    super(`No feasible candidate exercises were supplied for ${targetType} "${targetId}"`);
    this.name = 'NoFeasibleExerciseError';
  }
}

export type ExerciseTargetRole = 'primary' | 'secondary' | 'none';

/** Blueprint muscle-role data (§7's own primary/secondary split) for one
 * exercise against one target — 'none' if the exercise doesn't train
 * this target at all (by this app's own resolution rules; see
 * src/engine/exposureEngine.ts for the identical logic applied to
 * logged sets rather than a selection candidate). Exported so
 * workoutBuilder.ts can gather candidate exercise ids for a target
 * without duplicating this resolution logic. */
export function roleFor(exerciseId: BlueprintId, targetType: TargetType, targetId: BlueprintId): ExerciseTargetRole {
  const exercise = BlueprintAdapter.getExercise(exerciseId);
  if (!exercise) return 'none';

  const primaryIds = targetType === 'physique_target' ? (exercise.physique_targets ?? []) : (exercise.functional_goals ?? []);
  if (primaryIds.includes(targetId)) return 'primary';

  for (const phrase of exercise.secondary_targets ?? []) {
    const resolved = resolveSecondaryTarget(phrase);
    if (resolved && resolved.target_type === targetType && resolved.target_id === targetId) return 'secondary';
  }

  return 'none';
}

/** All Blueprint exercise ids that train `targetId` at all (primary or
 * secondary role) — the starting candidate pool for a target before
 * equipment/schedule filtering. */
export function exercisesTrainingTarget(targetType: TargetType, targetId: BlueprintId): BlueprintId[] {
  return BlueprintAdapter.getExercises()
    .filter((e) => roleFor(e.id, targetType, targetId) !== 'none')
    .map((e) => e.id);
}

/** Narrows `candidates` to the subset matching `predicate`, UNLESS
 * doing so would eliminate every candidate — in which case the
 * unnarrowed input is returned unchanged. This is the one primitive
 * every gate below is built from: category-membership narrowing,
 * never a score. */
function narrow<T>(candidates: readonly T[], predicate: (item: T) => boolean): T[] {
  const kept = candidates.filter(predicate);
  return kept.length > 0 ? kept : [...candidates];
}

/**
 * Applies Gates 2-6 to `input.candidate_exercise_ids` and returns the
 * single surviving exercise. Deterministic: identical inputs always
 * produce the identical output (Gate 6's alphabetical tie-break is the
 * final, stable fallback — never random, never a summed score).
 *
 * Throws NoFeasibleExerciseError if given no candidates at all — Gate 1
 * (feasibility) is this module's caller's job; an empty list reaching
 * here means the caller has nothing left to choose from.
 */
export function selectExercise(input: ExerciseSelectionInput): ExerciseSelectionResult {
  if (input.candidate_exercise_ids.length === 0) {
    throw new NoFeasibleExerciseError(input.target_type, input.target_id);
  }

  const allCandidates = [...input.candidate_exercise_ids];
  const plannedToday = input.exercises_already_planned_today ?? [];
  let decisiveGate: ExerciseSelectionResult['decisive_gate'] = 'gate2_goal_relevance';

  // Gate 2 — goal relevance: only exercises that actually train this
  // target (Blueprint muscle-role data) survive at all.
  let pool = allCandidates.filter((id) => roleFor(id, input.target_type, input.target_id) !== 'none');
  if (pool.length === 0) {
    // Every supplied "candidate" was actually irrelevant to this
    // target — a caller error upstream, but fail loudly rather than
    // silently picking an exercise that doesn't train the target.
    throw new NoFeasibleExerciseError(input.target_type, input.target_id);
  }

  // Gate 3 — programming need: primary role fills the target's direct
  // exposure need first; only fall back to secondary-role candidates
  // when no primary-role candidate is feasible. Then prefer an
  // exercise not already claimed for a different target today
  // (avoids redundant coverage of the same movement pattern twice in
  // one session).
  if (pool.length > 1) {
    const before = pool;
    pool = narrow(pool, (id) => roleFor(id, input.target_type, input.target_id) === 'primary');
    if (pool.length !== before.length) decisiveGate = 'gate3_programming_need';
  }
  if (pool.length > 1) {
    const before = pool;
    pool = narrow(pool, (id) => !plannedToday.includes(id));
    if (pool.length !== before.length) decisiveGate = 'gate3_programming_need';
  }

  // Gate 4 — historical context: avoid repeating an exercise that was
  // used recently for this target BUT was NOT the established current
  // pick — mechanically cycling through recently-tried-and-abandoned
  // options is the "inappropriate repetition" this gate screens for.
  // The current, ongoing exercise is deliberately exempted here: Gate 5
  // is what decides whether continuity with it is warranted.
  if (pool.length > 1) {
    const before = pool;
    pool = narrow(pool, (id) => id === input.current_exercise_id || !input.recent_exercise_ids.includes(id));
    if (pool.length !== before.length) decisiveGate = 'gate4_historical_context';
  }

  // Gate 5 — progression continuity: when multiple candidates still
  // satisfy the programming need equally, prefer the one with usable
  // prior performance history (the current/ongoing pick) — it is the
  // only candidate progressionEngine can actually progress from
  // session to session.
  if (pool.length > 1 && input.current_exercise_id && pool.includes(input.current_exercise_id)) {
    pool = [input.current_exercise_id];
    decisiveGate = 'gate5_progression_continuity';
  }

  // Gate 6 — stable tie-break: Blueprint has no stored per-exercise
  // ordering/priority field (verified against src/blueprint/types.ts),
  // so alphabetical exercise-id ordering is the documented fallback —
  // never randomness, never a new invented weight.
  if (pool.length > 1) {
    pool = [...pool].sort((a, b) => a.localeCompare(b));
    decisiveGate = 'gate6_tie_break';
  }

  const winnerId = pool[0]!;
  const winnerRole = roleFor(winnerId, input.target_type, input.target_id);
  const rejected = allCandidates.filter((id) => id !== winnerId);

  const exercise = BlueprintAdapter.getExercise(winnerId);
  const exerciseName = exercise?.name ?? winnerId;
  const reasonParts: string[] = [
    `Blueprint muscle-role for this target is "${winnerRole}"` + (winnerRole === 'primary' ? ' (direct target)' : winnerRole === 'secondary' ? ' (indirect/secondary)' : ''),
    `decisive gate: ${decisiveGate}`,
  ];
  if (winnerId === input.current_exercise_id) {
    reasonParts.push('is the currently prescribed exercise — kept for progression continuity (Gate 5), not merely for the sake of no change');
  } else if (input.current_exercise_id) {
    const previous = BlueprintAdapter.getExercise(input.current_exercise_id)?.name ?? input.current_exercise_id;
    reasonParts.push(`replaces "${previous}" — a better-ranked candidate under the gate hierarchy`);
  }

  return {
    exercise_id: winnerId,
    reasoning: `Selected ${exerciseName} for ${input.target_type} "${input.target_id}" (${input.target_tier} tier): ${reasonParts.join('; ')}.`,
    decisive_gate: decisiveGate,
    rejected_candidates: rejected,
  };
}
