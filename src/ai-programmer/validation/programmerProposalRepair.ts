// Repair pass (2026-09-18): three real, mechanically-correctable issues
// found via a real model eval (Option B two-step comparison,
// GLM/DeepSeek/Mistral/Qwen3 candidates) — every one of them has exactly
// one correct answer, already known with certainty, before this repair
// ever runs:
//  1. role — the model is no longer asked for it at all (see
//     AIWorkoutExerciseProposal's own doc comment); always set here from
//     Blueprint's own truth (context's own validExercises catalogue
//     entry), never left to the model's ambiguous reading of the words
//     "primary"/"secondary".
//  2. an authored-prescription exercise's sets/repsMin/repsMax/rirMin/
//     rirMax drifting from the one correct value (rule 6) — every model
//     tested inflated at least one such exercise's sets rather than
//     reject the whole proposal over a single deterministically-known
//     number, clamp it back.
//  3. reaching a muscle's real recommendedSessionSets total by adding a
//     second/third exercise (rule 11's own new distribution guidance)
//     can push the session over its real exercise/muscle-count cap —
//     trim non-goal (maintenance) exercises first, the exact same "cut
//     supporting muscles before goal ones" precedence rule 11 itself
//     already uses, rather than reject the whole session.
// Deliberately never touches anything genuinely non-mechanical: an
// invented/unknown exercise, a duplicate exerciseId, or a target not in
// context is left exactly as the model produced it — those stay real
// domain-validation rejections, not something a repair should guess at.
// Scoped to generate_session only; reconcile_week's own repair (a larger,
// separate change) is not built here.

import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext, AIProgrammerTargetContext } from '../context/programmerContextTypes.js';

function findTarget(targets: readonly AIProgrammerTargetContext[], targetType: string, targetId: string): AIProgrammerTargetContext | undefined {
  return targets.find((t) => t.targetType === targetType && t.targetId === targetId);
}

function isGoalOriented(context: AIProgrammerContext, targetId: string): boolean {
  return context.programmingBrief.muscles.some((m) => m.targetId === targetId && m.isGoalOriented);
}

/** Removes the last exercise in `exercises` matching `predicate` whose
 * own target is NOT goal-oriented — a goal-oriented exercise is never
 * removed by this repair. Returns null (no change) when nothing
 * eligible remains, so the caller can stop rather than loop forever. */
function removeLastNonGoalMatching(
  exercises: readonly AIWorkoutExerciseProposal[],
  context: AIProgrammerContext,
  predicate: (e: AIWorkoutExerciseProposal) => boolean
): AIWorkoutExerciseProposal[] | null {
  for (let i = exercises.length - 1; i >= 0; i--) {
    const e = exercises[i]!;
    if (predicate(e) && !isGoalOriented(context, e.targetId)) {
      return [...exercises.slice(0, i), ...exercises.slice(i + 1)];
    }
  }
  return null;
}

/** Item 3 above: trims non-goal exercises/targets until the session's
 * real exercise-count, muscle-count, and (on a legs day) leg-exercise
 * caps are all satisfied, or no more non-goal exercises are left to cut
 * — whichever comes first. Never removes a goal-oriented exercise; a
 * session still over cap after every non-goal exercise is gone is left
 * for adequacy validation to reject as a genuine judgment failure, not
 * something this repair should paper over. */
function trimToSessionCaps(exercises: readonly AIWorkoutExerciseProposal[], context: AIProgrammerContext): AIWorkoutExerciseProposal[] {
  let result = [...exercises];
  const purpose = context.programmingBrief.session.purpose;
  const caps = () => sessionRealismCapFor(purpose, [...new Set(result.map((e) => e.targetId))]);

  while (result.length > caps().maxExercises) {
    const next = removeLastNonGoalMatching(result, context, () => true);
    if (!next) break;
    result = next;
  }

  while (new Set(result.map((e) => e.targetId)).size > caps().maxTargets) {
    const nonGoalTargetIds = [...new Set(result.map((e) => e.targetId))].filter((id) => !isGoalOriented(context, id));
    const targetIdToRemove = nonGoalTargetIds[nonGoalTargetIds.length - 1];
    if (targetIdToRemove === undefined) break;
    result = result.filter((e) => e.targetId !== targetIdToRemove);
  }

  const legCap = caps().legExerciseShareMax;
  if (legCap !== null) {
    while (result.filter((e) => LEGS_PHYSIQUE_TARGETS.includes(e.targetId)).length > legCap) {
      const next = removeLastNonGoalMatching(result, context, (e) => LEGS_PHYSIQUE_TARGETS.includes(e.targetId));
      if (!next) break;
      result = next;
    }
  }

  const absCap = caps().absExerciseShareMax;
  if (absCap !== null) {
    while (result.filter((e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId)).length > absCap) {
      const next = removeLastNonGoalMatching(result, context, (e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId));
      if (!next) break;
      result = next;
    }
  }

  return result;
}

/** Repairs items 1-3 above on a cloned copy of `proposal.exercises` —
 * never mutates the caller's own object. Every other field of `proposal`
 * passes through unchanged. Called after schema validation and before
 * domain validation, so the repaired shape is what domain/adequacy
 * validation actually checks (and, on success, what gets persisted). */
export function repairProposal(proposal: AIWorkoutSessionProposal, context: AIProgrammerContext): AIWorkoutSessionProposal {
  const repaired = proposal.exercises.map((exercise): AIWorkoutExerciseProposal => {
    const target = findTarget(context.targets, exercise.targetType, exercise.targetId);
    const catalogueEntry = target?.validExercises.find((v) => v.exerciseId === exercise.exerciseId);
    if (!catalogueEntry) return exercise; // unknown exercise/target pair — left for domain validation to reject

    const fixed: AIWorkoutExerciseProposal = { ...exercise, role: catalogueEntry.role };
    if (catalogueEntry.authoredPrescription) {
      fixed.sets = catalogueEntry.authoredPrescription.sets;
      fixed.repsMin = catalogueEntry.authoredPrescription.repsMin;
      fixed.repsMax = catalogueEntry.authoredPrescription.repsMax;
      fixed.rirMin = catalogueEntry.authoredPrescription.rirMin;
      fixed.rirMax = catalogueEntry.authoredPrescription.rirMax;
    }
    return fixed;
  });

  return { ...proposal, exercises: trimToSessionCaps(repaired, context) };
}
