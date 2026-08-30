// Exercise Selector — Next Phase spec §5.
//
// Feasibility filtering (equipment/time) already happens upstream
// (constraintEngine.filterEquipmentFeasible) — every id in
// candidate_exercise_ids is assumed already feasible. This module's job
// is choosing among them for one target, using only factors §5 actually
// names that are decidable from data already in this codebase:
//   - "Blueprint muscle-role data" -> is the candidate this target's
//     primary role, or only secondary (exposureEngine's own primary/
//     secondary split, §7);
//   - "recent history" / "redundancy" -> recent_exercise_ids;
//   - "if the current exercise is best feasible option, keep it" ->
//     a same-score tie-break toward current_exercise_id, never an
//     override of a genuinely better option (§5: "do not preserve an
//     exercise merely because it has been used successfully").
//
// §5 also lists exposure, progression evidence, fatigue/recovery,
// schedule, other goals, and badminton workload as evaluation factors —
// those are volumeEngine's, progressionEngine's, recoveryEngine's,
// frequencyEngine's, and resourceAllocation's respective jobs; the
// pipeline (workoutBuilder, still a stub) is what will eventually feed
// their conclusions in as additional selection input. This module does
// not re-decide them.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import { resolveSecondaryTarget } from '../blueprint/secondaryTargetMapping.js';
import type { BlueprintId } from '../contracts/types.js';
import type { TargetPriorityTier, TargetType } from './goalResolver.js';

export interface ExerciseSelectionInput {
  target_type: TargetType;
  target_id: BlueprintId;
  target_tier: TargetPriorityTier;
  /** Already equipment/time-feasible candidates — see
   * constraintEngine.filterEquipmentFeasible. This module's job is
   * choosing among them, not filtering. */
  candidate_exercise_ids: readonly BlueprintId[];
  /** Exercise ids already used elsewhere in the session/recent history —
   * redundancy avoidance input. */
  recent_exercise_ids: readonly BlueprintId[];
  /** The exercise currently prescribed for this target/slot, if any —
   * used only as a tie-breaker (§5: keep it when it's still the best
   * feasible option; never as an automatic override of a clearly
   * better candidate). */
  current_exercise_id?: BlueprintId | null;
}

export interface ExerciseSelectionResult {
  exercise_id: BlueprintId;
  reasoning: string;
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

interface ScoredCandidate {
  exercise_id: BlueprintId;
  role: ExerciseTargetRole;
  score: number;
  isRecent: boolean;
  isCurrent: boolean;
}

/**
 * Ranks `input.candidate_exercise_ids` for `input.target_type`/`target_id`
 * and returns the single best one. Deterministic: identical inputs
 * always produce the identical output (ties broken alphabetically by
 * exercise_id, never randomly).
 *
 * Scoring (documented, not opaque — see `reasoning` on the result,
 * which names every factor that applied):
 *   +2  role === 'primary' for this target (Blueprint muscle-role data)
 *   +1  role === 'secondary'
 *    0  role === 'none' (should not occur if candidates were filtered
 *       correctly upstream; still ranked last, never selected over a
 *       real candidate, via the score itself)
 *   -1  exercise_id is in recent_exercise_ids (redundancy — §5, a mild
 *       preference for variety, not exclusion: the spec doesn't forbid
 *       ever repeating an exercise)
 * +0.5  exercise_id === current_exercise_id (§5's "if the current
 *       exercise is best feasible option, keep it" — a tie-break only,
 *       never enough to beat a genuinely higher-scoring alternative)
 *
 * Throws NoFeasibleExerciseError if given no candidates at all — this
 * module has nothing to select from, which is a caller error (upstream
 * feasibility filtering should never hand it an empty list for a target
 * that needs programming).
 */
export function selectExercise(input: ExerciseSelectionInput): ExerciseSelectionResult {
  if (input.candidate_exercise_ids.length === 0) {
    throw new NoFeasibleExerciseError(input.target_type, input.target_id);
  }

  const scored: ScoredCandidate[] = input.candidate_exercise_ids.map((exercise_id) => {
    const role = roleFor(exercise_id, input.target_type, input.target_id);
    const isRecent = input.recent_exercise_ids.includes(exercise_id);
    const isCurrent = input.current_exercise_id != null && exercise_id === input.current_exercise_id;

    let score = 0;
    if (role === 'primary') score += 2;
    else if (role === 'secondary') score += 1;
    if (isRecent) score -= 1;
    if (isCurrent) score += 0.5;

    return { exercise_id, role, score, isRecent, isCurrent };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.exercise_id.localeCompare(b.exercise_id)));
  const winner = scored[0]!;

  const exercise = BlueprintAdapter.getExercise(winner.exercise_id);
  const exerciseName = exercise?.name ?? winner.exercise_id;
  const reasonParts: string[] = [
    `Blueprint muscle-role for this target is "${winner.role}"` + (winner.role === 'primary' ? ' (direct target)' : winner.role === 'secondary' ? ' (indirect/secondary)' : ''),
  ];
  if (winner.isRecent) reasonParts.push('used recently (redundancy noted, still selected as the best-ranked option)');
  if (winner.isCurrent) reasonParts.push('is the currently prescribed exercise (kept — still the best feasible option, not replaced merely for the sake of change)');
  if (!winner.isCurrent && input.current_exercise_id) {
    const previous = BlueprintAdapter.getExercise(input.current_exercise_id)?.name ?? input.current_exercise_id;
    reasonParts.push(`replaces "${previous}" — a demonstrably better-ranked candidate was available (§5)`);
  }

  return {
    exercise_id: winner.exercise_id,
    reasoning: `Selected ${exerciseName} for ${input.target_type} "${input.target_id}" (${input.target_tier} tier): ${reasonParts.join('; ')}.`,
  };
}
