// Repair pass (2026-09-18, extended 2026-09-20): fixes the mechanically
// correctable problems in a model's output BEFORE domain validation, so a
// usable program is delivered whenever the model's coaching intent can be
// honoured. Every rule below has exactly one correct answer that is known
// without asking the model again:
//  1. role — always Blueprint's own truth, never the model's reading of the
//     words "primary"/"secondary".
//  2. reps/RIR — always the authored values.
//  3. sets — the authored sets (and the target's per-exposure cap) are a
//     CEILING, not an exact value. A coach may deliberately give fewer.
//       - above the ceiling      -> clamped DOWN to it;
//       - below 1 / fractional   -> rounded to a whole number of at least 1;
//       - a reduction on a GOAL muscle with no rationale -> restored to the
//         ceiling, because an unexplained cut to goal work is exactly what the
//         validator refuses; reverting it delivers a usable session instead of
//         a rejection. A reduction on a non-goal muscle, or any reduction that
//         carries a rationale, is kept as the model wrote it.
//     Repair never raises a number the model chose to lower for a stated reason.
//  4. the same exerciseId assigned twice in one session -> keep the stronger
//     claim (goal, then expected coverage, then most under-covered).
//  5. over the session's exercise / muscle-count / leg / abs ceilings -> trim
//     non-goal work first, never a goal exercise.
// Deliberately untouched: an invented/unknown exercise, or a target not in
// context. Those stay real domain-validation rejections.
//
// The same routine runs for a single generated session (generate_session) and
// for every unlocked day of a whole-week reconciliation (reconcile_week).

import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import type { SessionPurpose } from '../../engine/sessionPurpose.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIWeekReconciliationOutput } from '../contracts/weekReconciliationTypes.js';
import type { AIProgrammerContext, AIProgrammerTargetContext } from '../context/programmerContextTypes.js';
import type { AIReconciliationContext } from '../context/reconciliationContextTypes.js';
import { directSetsPerExposureCapFor } from './setCaps.js';

/** Same value the domain validator applies to an exercise with no authored
 * prescription. */
const MAX_SETS_WITHOUT_AUTHORED_CAP = 6;

function findTarget(targets: readonly AIProgrammerTargetContext[], targetType: string, targetId: string): AIProgrammerTargetContext | undefined {
  return targets.find((t) => t.targetType === targetType && t.targetId === targetId);
}

function validPurpose(purpose: string | null | undefined): SessionPurpose | null {
  return purpose === 'push' || purpose === 'pull' || purpose === 'legs' || purpose === 'upper' ? purpose : null;
}

function hasRationale(exercise: AIWorkoutExerciseProposal): boolean {
  return Array.isArray(exercise.rationale) && exercise.rationale.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

/** What the repair needs to know about the session it is repairing. */
interface RepairScope {
  targets: readonly AIProgrammerTargetContext[];
  purpose: SessionPurpose | null;
  isGoal: (exercise: AIWorkoutExerciseProposal) => boolean;
  /** The target's per-exposure cap, or null when it has none. */
  setCapFor: (exercise: AIWorkoutExerciseProposal) => number | null;
  duplicatePriority: (exercise: AIWorkoutExerciseProposal) => number;
}

function repairSets(exercise: AIWorkoutExerciseProposal, maxSets: number, scope: RepairScope, notes: string[]): number {
  const given = exercise.sets;
  let sets = Number.isFinite(given) ? Math.min(maxSets, Math.max(1, Math.round(given))) : maxSets;
  if (sets < maxSets && scope.isGoal(exercise) && !hasRationale(exercise)) {
    notes.push(`Restored ${exercise.exerciseId} for ${exercise.targetId} to ${maxSets} sets: goal work was reduced to ${sets} without a stated reason.`);
    sets = maxSets;
  } else if (sets < given) {
    notes.push(`Reduced ${exercise.exerciseId} for ${exercise.targetId} from ${given} to ${sets} sets to respect the authored prescription and session cap.`);
  } else if (sets !== given) {
    notes.push(`Adjusted ${exercise.exerciseId} for ${exercise.targetId} sets from ${given} to ${sets}.`);
  }
  return sets;
}

function repairExercise<T extends AIWorkoutExerciseProposal>(exercise: T, scope: RepairScope, notes: string[]): T {
  const target = findTarget(scope.targets, exercise.targetType, exercise.targetId);
  const catalogueEntry = target?.validExercises.find((v) => v.exerciseId === exercise.exerciseId);
  if (!catalogueEntry) return exercise; // unknown exercise/target pair — left for domain validation to reject

  const fixed: T = { ...exercise, role: catalogueEntry.role };
  if (exercise.role !== catalogueEntry.role) {
    notes.push(`Corrected ${exercise.exerciseId} role for ${exercise.targetId} from ${exercise.role} to ${catalogueEntry.role}.`);
  }

  const authored = catalogueEntry.authoredPrescription;
  if (authored) {
    const cap = scope.setCapFor(exercise);
    const maxSets = Math.min(authored.sets, cap ?? Number.POSITIVE_INFINITY);
    fixed.sets = repairSets(exercise, maxSets, scope, notes);
    fixed.repsMin = authored.repsMin;
    fixed.repsMax = authored.repsMax;
    fixed.rirMin = authored.rirMin;
    fixed.rirMax = authored.rirMax;
    for (const field of ['repsMin', 'repsMax', 'rirMin', 'rirMax'] as const) {
      if (exercise[field] !== fixed[field]) {
        notes.push(`Adjusted ${exercise.exerciseId} ${field} for ${exercise.targetId} to the Blueprint-authored value ${fixed[field]}.`);
      }
    }
  } else if (Number.isFinite(exercise.sets) && exercise.sets > MAX_SETS_WITHOUT_AUTHORED_CAP) {
    fixed.sets = MAX_SETS_WITHOUT_AUTHORED_CAP;
    notes.push(`Reduced ${exercise.exerciseId} for ${exercise.targetId} from ${exercise.sets} to ${MAX_SETS_WITHOUT_AUTHORED_CAP} sets (no authored prescription exists; application cap).`);
  }
  return fixed;
}

/** Removes duplicate exercise IDs. A single exercise entry can only carry
 * one targetId, so keeping both would double-count the same movement. The
 * stronger claim wins; ties keep the first occurrence. */
function repairDuplicateExercises<T extends AIWorkoutExerciseProposal>(exercises: readonly T[], scope: RepairScope): { exercises: T[]; notes: string[] } {
  const kept = new Map<string, { exercise: T; index: number; score: number }>();
  const notes: string[] = [];

  for (const exercise of exercises) {
    const existing = kept.get(exercise.exerciseId);
    if (!existing) {
      kept.set(exercise.exerciseId, { exercise, index: kept.size, score: scope.duplicatePriority(exercise) });
      continue;
    }
    const candidateScore = scope.duplicatePriority(exercise);
    if (candidateScore > existing.score) {
      kept.set(exercise.exerciseId, { exercise, index: existing.index, score: candidateScore });
      notes.push(`Removed duplicate ${exercise.exerciseId} assignment for ${existing.exercise.targetId}; retained it for ${exercise.targetId}.`);
    } else {
      notes.push(`Removed duplicate ${exercise.exerciseId} assignment for ${exercise.targetId}; retained it for ${existing.exercise.targetId}.`);
    }
  }
  return { exercises: [...kept.values()].sort((a, b) => a.index - b.index).map((entry) => entry.exercise), notes };
}

/** Removes the last exercise matching `predicate` whose own target is NOT a
 * goal — a goal exercise is never removed by this repair. Returns null when
 * nothing qualifies. */
function removeLastNonGoalMatching<T extends AIWorkoutExerciseProposal>(
  exercises: readonly T[],
  scope: RepairScope,
  predicate: (e: T) => boolean
): T[] | null {
  for (let i = exercises.length - 1; i >= 0; i--) {
    const e = exercises[i]!;
    if (!scope.isGoal(e) && predicate(e)) return [...exercises.slice(0, i), ...exercises.slice(i + 1)];
  }
  return null;
}

/** Trims a session to its real ceilings, non-goal work first. A session that
 * is still over after every non-goal exercise is gone is left for validation
 * to reject as a genuine judgment failure. */
function trimToSessionCaps<T extends AIWorkoutExerciseProposal>(exercises: readonly T[], scope: RepairScope): { exercises: T[]; notes: string[] } {
  let result = [...exercises];
  const notes: string[] = [];
  const removeWithNote = (next: T[] | null, reason: string): boolean => {
    if (!next) return false;
    const removed = result.find((e) => !next.includes(e));
    if (removed) notes.push(`Removed ${removed.exerciseId} for ${removed.targetId} to stay within the ${reason}.`);
    result = next;
    return true;
  };
  const caps = () => sessionRealismCapFor(scope.purpose, [...new Set(result.map((e) => e.targetId))]);

  while (result.length > caps().maxExercises) {
    if (!removeWithNote(removeLastNonGoalMatching(result, scope, () => true), `${caps().maxExercises}-exercise session limit`)) break;
  }

  while (new Set(result.map((e) => e.targetId)).size > caps().maxTargets) {
    const nonGoalTargetIds = [...new Set(result.map((e) => e.targetId))].filter(
      (id) => !scope.isGoal(result.find((e) => e.targetId === id)!)
    );
    const targetIdToRemove = nonGoalTargetIds[nonGoalTargetIds.length - 1];
    if (targetIdToRemove === undefined) break;
    const removed = result.filter((e) => e.targetId === targetIdToRemove);
    result = result.filter((e) => e.targetId !== targetIdToRemove);
    notes.push(`Removed ${removed.map((e) => e.exerciseId).join(', ')} for ${targetIdToRemove} to stay within the ${caps().maxTargets}-target session limit.`);
  }

  const legCap = caps().legExerciseShareMax;
  if (legCap !== null) {
    while (result.filter((e) => LEGS_PHYSIQUE_TARGETS.includes(e.targetId)).length > legCap) {
      if (!removeWithNote(removeLastNonGoalMatching(result, scope, (e) => LEGS_PHYSIQUE_TARGETS.includes(e.targetId)), `${legCap}-leg-exercise share limit`)) break;
    }
  }

  const absCap = caps().absExerciseShareMax;
  if (absCap !== null) {
    while (result.filter((e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId)).length > absCap) {
      if (!removeWithNote(removeLastNonGoalMatching(result, scope, (e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId)), `${absCap}-ab-exercise share limit`)) break;
    }
  }

  return { exercises: result, notes };
}

function repairExerciseList<T extends AIWorkoutExerciseProposal>(exercises: readonly T[], scope: RepairScope): { exercises: T[]; notes: string[] } {
  const notes: string[] = [];
  const perExercise = exercises.map((exercise) => repairExercise(exercise, scope, notes));
  const deduped = repairDuplicateExercises(perExercise, scope);
  const capped = trimToSessionCaps(deduped.exercises, scope);
  return { exercises: capped.exercises, notes: [...notes, ...deduped.notes, ...capped.notes] };
}

function isGoalTarget(targets: readonly AIProgrammerTargetContext[], exercise: AIWorkoutExerciseProposal): boolean {
  const target = findTarget(targets, exercise.targetType, exercise.targetId);
  return Boolean(target?.goalId) || Boolean(target?.isSpecialization);
}

/** Repairs one generated session. */
export function repairProposal(proposal: AIWorkoutSessionProposal, context: AIProgrammerContext): AIWorkoutSessionProposal {
  const muscles = context.programmingBrief.muscles;
  const guidanceFor = (e: AIWorkoutExerciseProposal) => muscles.find((m) => m.targetType === e.targetType && m.targetId === e.targetId);
  const scope: RepairScope = {
    targets: context.targets,
    purpose: validPurpose(context.programmingBrief.session.purpose),
    isGoal: (e) => Boolean(guidanceFor(e)?.isGoalOriented) || isGoalTarget(context.targets, e),
    setCapFor: (e) => guidanceFor(e)?.directSetsPerExposureCap ?? null,
    duplicatePriority: (e) => {
      const guidance = guidanceFor(e);
      let score = 0;
      if (guidance?.isGoalOriented) score += 3;
      if (guidance?.eligibleForThisSession && context.programmingBrief.session.expectedCoverageTargetIds.includes(e.targetId)) score += 2;
      if (guidance) score += Math.max(0, guidance.recommendedSessionSets.min - guidance.currentWeeklyDirectSets);
      return score;
    },
  };
  const repaired = repairExerciseList(proposal.exercises, scope);
  return { ...proposal, exercises: repaired.exercises, warnings: [...proposal.warnings, ...repaired.notes] };
}

/** Repairs every unlocked day of a whole-week reconciliation with the same
 * routine the single-session path uses. Locked days are never touched, and a
 * day with no session is left alone. */
export function repairWeekReconciliation(output: AIWeekReconciliationOutput, context: AIReconciliationContext): AIWeekReconciliationOutput {
  const lockedDates = new Set(context.existingProgram.filter((d) => d.locked).map((d) => d.date));
  const notes: string[] = [];

  const days = output.days.map((day) => {
    if (!day.session || lockedDates.has(day.date)) return day;
    const scope: RepairScope = {
      targets: context.targets,
      purpose: validPurpose(day.session.sessionPurpose),
      isGoal: (e) => isGoalTarget(context.targets, e),
      setCapFor: (e) => {
        const target = findTarget(context.targets, e.targetType, e.targetId);
        return target ? directSetsPerExposureCapFor(target) : null;
      },
      duplicatePriority: (e) => (isGoalTarget(context.targets, e) ? 3 : 0),
    };
    const repaired = repairExerciseList(day.session.exercises, scope);
    for (const note of repaired.notes) notes.push(`${day.date}: ${note}`);
    return { ...day, session: { ...day.session, exercises: repaired.exercises } };
  });

  return { ...output, days, reconciliation: { ...output.reconciliation, warnings: [...output.reconciliation.warnings, ...notes] } };
}
