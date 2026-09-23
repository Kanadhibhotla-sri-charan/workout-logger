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
import type { AIWeekReconciliationDay, AIWeekReconciliationExerciseProposal, AIWeekReconciliationOutput } from '../contracts/weekReconciliationTypes.js';
import type { AIProgrammerContext, AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from '../context/programmerContextTypes.js';
import type { AIReconciliationContext } from '../context/reconciliationContextTypes.js';
import { directSetsPerExposureCapFor } from './setCaps.js';
import { auditWeeklyVolume } from './weeklyVolumeAudit.js';

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

/** Superset of AIReconciliationContext carrying an OPTIONAL
 * programmingBrief — production's real reconcile_week context has none
 * (setCaps.ts's own note: "the whole-week path...has no brief"); only the
 * eval harness builds one today. auditWeeklyVolume already treats this
 * field as optional, and the goal-completion pass below reads it the exact
 * same way, so a real request without a brief still gets a "required"
 * number to work toward (the package's own deliverable figure) rather than
 * silently doing nothing. */
export type AIWeekReconciliationRepairContext = AIReconciliationContext & {
  programmingBrief?: { muscles: readonly { targetType: string; targetId: string; recommendedWeeklyPrimarySets: number }[] };
};

const MAX_GOAL_COMPLETION_ITERATIONS = 25;

/** True iff removing `exercise` would leave its own target with zero
 * exercises left in this session — the floor a completion swap must never
 * cross, so a displaced non-goal muscle keeps at least some real coverage
 * instead of being silently dropped from the session entirely. */
function wouldZeroOutCoverage(exercise: AIWeekReconciliationExerciseProposal, dayExercises: readonly AIWeekReconciliationExerciseProposal[]): boolean {
  return dayExercises.filter((e) => e.targetType === exercise.targetType && e.targetId === exercise.targetId).length <= 1;
}

/** The safest currently-selected exercise to give up its slot to a
 * deficient goal: scanning from the end (same convention as
 * removeLastNonGoalMatching), the last exercise that (a) does not itself
 * belong to an active goal — point 7: never displace another goal's work —
 * and (b) has a sibling exercise for the same target remaining afterward,
 * so that target keeps real coverage this session instead of being zeroed
 * out. Returns null when no such exercise exists. */
function findDisplaceableExercise(dayExercises: readonly AIWeekReconciliationExerciseProposal[], targets: readonly AIProgrammerTargetContext[]): AIWeekReconciliationExerciseProposal | null {
  for (let i = dayExercises.length - 1; i >= 0; i--) {
    const candidate = dayExercises[i]!;
    if (isGoalTarget(targets, candidate)) continue;
    if (wouldZeroOutCoverage(candidate, dayExercises)) continue;
    return candidate;
  }
  return null;
}

/** The first of `target`'s own authored, catalogued exercises not already
 * present in this session — the next exercise a completion swap would add.
 * Only ever drawn from the deficient target's own validExercises (never a
 * different target's list), so a swap can only ever help the target it is
 * actually for. */
function findMissingAuthoredExercise(target: AIProgrammerTargetContext, dayExercises: readonly AIWeekReconciliationExerciseProposal[]): AIProgrammerValidExerciseContext | null {
  const present = new Set(dayExercises.map((e) => e.exerciseId));
  return target.validExercises.find((v) => v.authoredPrescription && !present.has(v.exerciseId)) ?? null;
}

function buildGoalExercise(target: AIProgrammerTargetContext, catalogueEntry: AIProgrammerValidExerciseContext, cap: number | null, classification: AIWeekReconciliationExerciseProposal['classification']): AIWeekReconciliationExerciseProposal {
  const authored = catalogueEntry.authoredPrescription!;
  return {
    exerciseId: catalogueEntry.exerciseId,
    role: catalogueEntry.role,
    targetType: target.targetType,
    targetId: target.targetId,
    sets: Math.min(authored.sets, cap ?? Number.POSITIVE_INFINITY),
    repsMin: authored.repsMin,
    repsMax: authored.repsMax,
    rirMin: authored.rirMin,
    rirMax: authored.rirMax,
    rationale: [`Added by repair: ${target.targetId} was below its required weekly volume, and this authored exercise was eligible but unused.`],
    source: 'blueprint',
    classification,
  };
}

/** Goal-completion pass (2026-09-23): the repairs above fix an exercise the
 * model DID select; they cannot fix a goal that stays short only because
 * the model never selected enough of its own authored exercises at all. A
 * live eval investigation found sessions consistently full (10/10
 * exercises) with the spare slot going to a second non-goal exercise (e.g.
 * a duplicate oblique exercise) while the goal's own remaining authored
 * exercises (dip, cable pushdown for triceps) were never added — a real
 * prescription-selection gap, not an accounting bug (the shared
 * triceps/triceps-long-head crediting itself was verified correct by hand
 * against these exact numbers). This never touches creditedTargetKeys or
 * package-level scope resolution: it only swaps an already-present, safe,
 * non-goal exercise for a still-unused authored exercise of a deficient
 * goal, on a day that already trains that goal, re-auditing via the SAME
 * auditWeeklyVolume the validator itself trusts after every single swap —
 * never a second, approximate notion of "did this actually help." */
function completeGoalVolume(days: readonly AIWeekReconciliationDay[], lockedDates: ReadonlySet<string>, context: AIWeekReconciliationRepairContext): { days: AIWeekReconciliationDay[]; notes: string[] } {
  const current: AIWeekReconciliationDay[] = days.map((d) => (d.session ? { ...d, session: { ...d.session, exercises: [...d.session.exercises] } } : d));
  const notes: string[] = [];

  for (let iteration = 0; iteration < MAX_GOAL_COMPLETION_ITERATIONS; iteration++) {
    const audit = auditWeeklyVolume({ days: current }, { targets: context.targets, existingProgram: context.existingProgram, programmingBrief: context.programmingBrief });
    if (audit.goalShortfalls.length === 0) break;

    let improved = false;
    for (const row of audit.goalShortfalls) {
      const target = findTarget(context.targets, row.targetType, row.targetId);
      if (!target) continue;
      const cap = directSetsPerExposureCapFor(target);

      for (let i = 0; i < current.length; i++) {
        const day = current[i]!;
        if (!day.session || lockedDates.has(day.date)) continue;
        const exercises = day.session.exercises;
        const trainedHere = exercises.find((e) => e.targetType === target.targetType && e.targetId === target.targetId);
        if (!trainedHere) continue; // never introduce a new training day for a goal the model didn't already put there

        const missing = findMissingAuthoredExercise(target, exercises);
        if (!missing) continue; // no unused authored exercise left for this target on this day

        const displaceable = findDisplaceableExercise(exercises, context.targets);
        if (!displaceable) continue; // no safe non-goal exercise to give up — leave the goal short rather than risk another target's coverage

        const added = buildGoalExercise(target, missing, cap, trainedHere.classification);
        const nextExercises = [...exercises];
        nextExercises[exercises.indexOf(displaceable)] = added;
        current[i] = { ...day, session: { ...day.session, exercises: nextExercises } };
        notes.push(`${day.date}: replaced ${displaceable.exerciseId} (${displaceable.targetId}) with ${added.exerciseId} to work toward ${target.targetId}'s required weekly volume.`);
        improved = true;
        break; // re-audit before attempting another swap
      }
      if (improved) break;
    }
    if (!improved) break; // no eligible exercise, or no safe displacement, for any remaining deficient goal
  }

  return { days: current, notes };
}

/** Repairs every unlocked day of a whole-week reconciliation with the same
 * routine the single-session path uses. Locked days are never touched, and a
 * day with no session is left alone. */
export function repairWeekReconciliation(output: AIWeekReconciliationOutput, context: AIWeekReconciliationRepairContext): AIWeekReconciliationOutput {
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

  const completion = completeGoalVolume(days, lockedDates, context);

  return { ...output, days: completion.days, reconciliation: { ...output.reconciliation, warnings: [...output.reconciliation.warnings, ...notes, ...completion.notes] } };
}
