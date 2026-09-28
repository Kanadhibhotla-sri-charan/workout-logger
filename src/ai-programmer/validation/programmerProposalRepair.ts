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
import type { AIGenerateWeekDay, AIGenerateWeekExerciseProposal, AIGenerateWeekOutput } from '../contracts/generateWeekTypes.js';
import type { AIProgrammerContext, AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from '../context/programmerContextTypes.js';
import type { AIReconciliationContext } from '../context/reconciliationContextTypes.js';
import type { AIGenerateWeekContext } from '../context/generateWeekContextTypes.js';
import { directSetsPerExposureCapFor } from './setCaps.js';
import { auditWeeklyVolume } from './weeklyVolumeAudit.js';
import { creditedSetsByTarget, creditedTargetKeys } from './sharedCredit.js';

/** Same value the domain validator applies to an exercise with no authored
 * prescription. Exported (2026-09-24, Push Generation Architectural Fix)
 * so targetFeasibility.ts's and programmerAdequacyCompletion.ts's own
 * "effective ceiling" calculations use this exact same number rather
 * than a second, independently-copied constant. */
export const MAX_SETS_WITHOUT_AUTHORED_CAP = 6;

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

/** "physique_target:side-delt" -> ["physique_target", "side-delt"] — the
 * inverse of sharedCredit.ts's own keyOf, splitting on the first colon
 * only (a targetId is always a plain kebab-case Blueprint id, never
 * itself containing one). */
function parseTargetKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Whether `exercise` has a real Blueprint catalogue entry for its own
 * literal target — the exact same check repairExercise() makes before
 * touching anything. An unknown exercise/target pair is deliberately
 * left untouched by every repair rule in this file (domain validation
 * rejects it); trimToTargetCaps must honor that too, never trimming an
 * exercise repair has no real data to reason about. */
function hasKnownCatalogueEntry(exercise: AIWorkoutExerciseProposal, targets: readonly AIProgrammerTargetContext[]): boolean {
  const target = findTarget(targets, exercise.targetType, exercise.targetId);
  return Boolean(target?.validExercises.find((v) => v.exerciseId === exercise.exerciseId));
}

/** Aggregate Target-Cap Repair Fix (2026-09-24): repairExercise() above
 * clamps each INDIVIDUAL exercise to at most min(authored sets, the
 * target's own directSetsPerExposureCap) — but the model can legitimately
 * assign MULTIPLE different exercises to the same target, each
 * individually within its own per-exercise ceiling, whose SUM still
 * exceeds that target's real, hard Blueprint per-exposure cap. Verified
 * live (Legs, real-provider testing): "gluteus-maximus: total proposed
 * sets (9) exceed cap (6)" / "quads: (9) exceed cap (8)" — both slipped
 * through this file's own per-exercise clamp and were only ever caught
 * downstream, at adequacy validation. This closes that gap at repair
 * time, for all three AI modes that share repairExerciseList
 * (generate_session, reconcile_week, generate_week) — never a
 * mode-specific fix.
 *
 * Uses creditedSetsByTarget/creditedTargetKeys (sharedCredit.ts) — the
 * SAME real crediting adequacy validation itself checks — never a
 * literal-targetId-only sum, so a shared-credit overage (one exercise's
 * sets counting toward two targets at once) is caught exactly as
 * adequacy would catch it, never under-caught by a weaker sum.
 *
 * The per-target directSetsPerExposureCap is a HARD constraint here —
 * unlike repairSets' own per-exercise clamp (which restores an
 * unexplained goal-muscle reduction back UP to that exercise's own
 * ceiling), this pass only ever reduces, and a goal-oriented target's
 * aggregate is never restored back above its own hard cap. In practice
 * repairSets' restoration branch cannot even fire from a call made here:
 * every reduction requested below is a REDUCTION from the exercise's own
 * current, already-repaired sets value, so `given` is always >=
 * `maxSets`, and repairSets' `sets = min(maxSets, ...)` can only end up
 * below `maxSets` when `given` itself already was — which never happens
 * when this function is the one lowering the ceiling. Documented
 * explicitly (never left as an implicit accident of repairSets' own
 * logic) per this task's own "goal-oriented protection only while
 * compatible with the hard aggregate cap" requirement. */
function trimToTargetCaps<T extends AIWorkoutExerciseProposal>(exercises: readonly T[], scope: RepairScope, notes: string[]): T[] {
  let result = [...exercises];

  // Every distinct credited target key present at all, in a stable,
  // first-seen order — computed once, up front, so processing order
  // never depends on how later reductions reshuffle credited totals.
  const targetKeysSeen = new Set<string>();
  for (const ex of result) {
    for (const key of creditedTargetKeys(ex, scope.targets)) targetKeysSeen.add(key);
  }

  for (const targetKey of targetKeysSeen) {
    const [targetType, targetId] = parseTargetKey(targetKey);
    const target = scope.targets.find((t) => t.targetType === targetType && t.targetId === targetId);
    if (!target) continue;
    const cap = directSetsPerExposureCapFor(target);
    if (cap == null) continue; // no hard cap for this target — nothing to enforce

    // Reduction phase: the exercise with the largest CURRENT set count
    // among this target's real credited contributors, tie-broken by
    // exerciseId ascending — recomputed fresh every iteration, so
    // "largest" always reflects the current state, never a stale sort,
    // and a shared-credit exercise reduced here correctly reduces every
    // target it credits, not just this one.
    let total = creditedSetsByTarget(result, scope.targets).get(targetKey) ?? 0;
    while (total > cap) {
      const contributors = result.filter(
        (e) => e.sets > 1 && hasKnownCatalogueEntry(e, scope.targets) && creditedTargetKeys(e, scope.targets).includes(targetKey)
      );
      if (contributors.length === 0) break; // every contributor already at the 1-set floor
      contributors.sort((a, b) => b.sets - a.sets || a.exerciseId.localeCompare(b.exerciseId));
      const victim = contributors[0]!;
      const excess = total - cap;
      const before = victim.sets;
      const after = Math.max(1, before - excess);
      result = result.map((e) => (e === victim ? { ...e, sets: after } : e));
      notes.push(
        `Aggregate target-cap trim: reduced ${victim.exerciseId} (credits ${targetKey}) from ${before} to ${after} sets — this target's combined credited sets exceeded its hard per-exposure cap of ${cap}.`
      );
      total = creditedSetsByTarget(result, scope.targets).get(targetKey) ?? 0;
    }

    // Removal phase: every contributor is already at the 1-set floor and
    // the aggregate is STILL over cap — remove entire exercises, never a
    // goal-oriented one, reusing the exact same removeLastNonGoalMatching
    // convention trimToSessionCaps already uses elsewhere in this file.
    // If only goal-oriented contributors remain, removeLastNonGoalMatching
    // returns null and the loop stops — the residual overage is left for
    // adequacy validation to catch, the same "genuine judgment failure"
    // philosophy trimToSessionCaps' own escalation limit already follows.
    while (total > cap) {
      const removed = removeLastNonGoalMatching(
        result,
        scope,
        (e) => hasKnownCatalogueEntry(e, scope.targets) && creditedTargetKeys(e, scope.targets).includes(targetKey)
      );
      if (!removed) break;
      const removedExercise = result.find((e) => !removed.includes(e))!;
      notes.push(
        `Aggregate target-cap trim: removed ${removedExercise.exerciseId} (credited ${targetKey}) entirely — every contributing exercise was already at its 1-set floor and the aggregate still exceeded the hard cap of ${cap}.`
      );
      result = removed;
      total = creditedSetsByTarget(result, scope.targets).get(targetKey) ?? 0;
    }
  }

  return result;
}

function repairExerciseList<T extends AIWorkoutExerciseProposal>(exercises: readonly T[], scope: RepairScope): { exercises: T[]; notes: string[] } {
  const notes: string[] = [];
  const perExercise = exercises.map((exercise) => repairExercise(exercise, scope, notes));
  const deduped = repairDuplicateExercises(perExercise, scope);
  const targetCapNotes: string[] = [];
  const targetCapped = trimToTargetCaps(deduped.exercises, scope, targetCapNotes);
  const capped = trimToSessionCaps(targetCapped, scope);
  return { exercises: capped.exercises, notes: [...notes, ...deduped.notes, ...targetCapNotes, ...capped.notes] };
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
 * eval harness builds one today. Production-impact review (2026-09-23)
 * found that auditWeeklyVolume's no-brief fallback (the package's full
 * deliverable figure) is NOT a safe stand-in for a real week's intended
 * goal volume — decideVolume's real, conservative decision (maintain
 * on improving trend, a small bounded step otherwise, hold on
 * decline/stagnation) is what should govern that, and it isn't wired into
 * reconciliation at all yet. The completion pass below therefore requires
 * this field to be present (see completeGoalVolume's own guard) — it is a
 * no-op on a real request until reconciliation gains a genuine brief. */
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

/** True iff this session has real room to simply ADD one more exercise for
 * `target`, without exceeding any of sessionRealismCapFor's own limits —
 * the exercise-count cap, and (only when `target` is itself a leg or abs
 * target) that category's own share-of-session cap. Never checks the
 * muscle-count cap: `target` is already present in this session (the
 * caller only reaches here after confirming that), so adding one more of
 * its own exercises never adds a new distinct target. This is the
 * fallback for a lean, honest session that findDisplaceableExercise
 * correctly refuses to touch (2026-09-23 fresh-slate finding: a session
 * well under the exercise cap, with no redundant non-goal exercise to
 * safely give up, previously left a real, cap-legal shortfall unclosed). */
function hasSpareCapacityFor(dayExercises: readonly AIWeekReconciliationExerciseProposal[], purpose: SessionPurpose | null, target: AIProgrammerTargetContext): boolean {
  const targetIdsInSession = [...new Set(dayExercises.map((e) => e.targetId))];
  const caps = sessionRealismCapFor(purpose, targetIdsInSession);
  if (dayExercises.length >= caps.maxExercises) return false;
  if (caps.legExerciseShareMax !== null && LEGS_PHYSIQUE_TARGETS.includes(target.targetId)) {
    if (dayExercises.filter((e) => LEGS_PHYSIQUE_TARGETS.includes(e.targetId)).length >= caps.legExerciseShareMax) return false;
  }
  if (caps.absExerciseShareMax !== null && ABS_PHYSIQUE_TARGETS.includes(target.targetId)) {
    if (dayExercises.filter((e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId)).length >= caps.absExerciseShareMax) return false;
  }
  return true;
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
  // Safety gate (2026-09-23 production-impact review): with no brief,
  // auditWeeklyVolume's only fallback "required" figure is the package's
  // full deliverable — a long-term reference, not a real week's intended
  // volume (decideVolume's actual, conservative decision isn't wired into
  // reconciliation at all). Acting on that fallback in real production
  // output would push a goal target toward a ceiling nothing has actually
  // decided it should reach this week. Never run this pass without a real
  // brief to work toward; production's own reconcile_week context has none
  // today, so this makes the whole pass a no-op there until it does.
  if (!context.programmingBrief) return { days: [...days], notes: [] };

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

        // Primary path (2026-09-20): displace a safe, redundant non-goal
        // exercise. Preserved unchanged and tried first.
        const displaceable = findDisplaceableExercise(exercises, context.targets);
        if (displaceable) {
          const added = buildGoalExercise(target, missing, cap, trainedHere.classification);
          const nextExercises = [...exercises];
          nextExercises[exercises.indexOf(displaceable)] = added;
          current[i] = { ...day, session: { ...day.session, exercises: nextExercises } };
          notes.push(`${day.date}: replaced ${displaceable.exerciseId} (${displaceable.targetId}) with ${added.exerciseId} to work toward ${target.targetId}'s required weekly volume.`);
          improved = true;
          break; // re-audit before attempting another swap
        }

        // Fallback (2026-09-23, fresh-slate finding): no safe exercise to
        // give up, but the session is nowhere near its own real caps — a
        // lean, honest session should not be left short just because
        // nothing else is safe to sacrifice. Add the missing exercise
        // outright, under the exact same eligibility/authored-ceiling/
        // session-cap rules as everywhere else in this file; never
        // invents an exercise (still only ever drawn from `target`'s own
        // validExercises), and never used when displacement already
        // worked or when it would exceed any real cap.
        if (hasSpareCapacityFor(exercises, validPurpose(day.session.sessionPurpose), target)) {
          const added = buildGoalExercise(target, missing, cap, trainedHere.classification);
          current[i] = { ...day, session: { ...day.session, exercises: [...exercises, added] } };
          notes.push(`${day.date}: added ${added.exerciseId} to work toward ${target.targetId}'s required weekly volume (session had spare exercise capacity, no safe exercise to displace).`);
          improved = true;
          break; // re-audit before attempting another change
        }
        // Neither a safe displacement nor spare capacity exists on this
        // day for this target — try the next day, or leave it short.
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

// ---------------------------------------------------------------------
// generate_week (2026-09-23): the same two repair passes as
// repairWeekReconciliation above (per-exercise set-ceiling repair, then
// goal-completion), for a FROM-SCRATCH week instead of a revision of an
// existing one. repairExerciseList is reused directly (already generic
// over any AIWorkoutExerciseProposal). The goal-completion pass's own
// five small helpers are intentionally NOT shared with
// completeGoalVolume above — they are duplicated here, concretely typed
// to AIGenerateWeekExerciseProposal/AIGenerateWeekDay, rather than
// generified under time pressure and risk changing repairWeekReconciliation's
// own tested behavior. A future pass can unify them once both call
// sites are stable; see the architecture review's own note on this
// tradeoff.
// ---------------------------------------------------------------------

function wouldZeroOutCoverageGW(exercise: AIGenerateWeekExerciseProposal, dayExercises: readonly AIGenerateWeekExerciseProposal[]): boolean {
  return dayExercises.filter((e) => e.targetType === exercise.targetType && e.targetId === exercise.targetId).length <= 1;
}

function findDisplaceableExerciseGW(dayExercises: readonly AIGenerateWeekExerciseProposal[], targets: readonly AIProgrammerTargetContext[]): AIGenerateWeekExerciseProposal | null {
  for (let i = dayExercises.length - 1; i >= 0; i--) {
    const candidate = dayExercises[i]!;
    if (isGoalTarget(targets, candidate)) continue;
    if (wouldZeroOutCoverageGW(candidate, dayExercises)) continue;
    return candidate;
  }
  return null;
}

function findMissingAuthoredExerciseGW(target: AIProgrammerTargetContext, dayExercises: readonly AIGenerateWeekExerciseProposal[]): AIProgrammerValidExerciseContext | null {
  const present = new Set(dayExercises.map((e) => e.exerciseId));
  return target.validExercises.find((v) => v.authoredPrescription && !present.has(v.exerciseId)) ?? null;
}

function hasSpareCapacityForGW(dayExercises: readonly AIGenerateWeekExerciseProposal[], purpose: SessionPurpose | null, target: AIProgrammerTargetContext): boolean {
  const targetIdsInSession = [...new Set(dayExercises.map((e) => e.targetId))];
  const caps = sessionRealismCapFor(purpose, targetIdsInSession);
  if (dayExercises.length >= caps.maxExercises) return false;
  if (caps.legExerciseShareMax !== null && LEGS_PHYSIQUE_TARGETS.includes(target.targetId)) {
    if (dayExercises.filter((e) => LEGS_PHYSIQUE_TARGETS.includes(e.targetId)).length >= caps.legExerciseShareMax) return false;
  }
  if (caps.absExerciseShareMax !== null && ABS_PHYSIQUE_TARGETS.includes(target.targetId)) {
    if (dayExercises.filter((e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId)).length >= caps.absExerciseShareMax) return false;
  }
  return true;
}

function buildGoalExerciseGW(target: AIProgrammerTargetContext, catalogueEntry: AIProgrammerValidExerciseContext, cap: number | null, classification: AIGenerateWeekExerciseProposal['classification']): AIGenerateWeekExerciseProposal {
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

/** Goal-completion pass for a from-scratch week — identical rules to
 * completeGoalVolume above (displacement first, add-when-capacity
 * fallback, never introduces a goal into a day the model didn't already
 * train it in, never exceeds any real cap), operating on
 * AIGenerateWeekDay[] instead of AIWeekReconciliationDay[]. There are no
 * locked days for a from-scratch week (nothing exists yet to lock). */
function completeGoalVolumeForGenerateWeek(days: readonly AIGenerateWeekDay[], context: AIGenerateWeekContext): { days: AIGenerateWeekDay[]; notes: string[] } {
  const current: AIGenerateWeekDay[] = days.map((d) => (d.session ? { ...d, session: { ...d.session, exercises: [...d.session.exercises] } } : d));
  const notes: string[] = [];

  for (let iteration = 0; iteration < MAX_GOAL_COMPLETION_ITERATIONS; iteration++) {
    // existingProgram here only supplies the date list — there is no
    // pre-AI-response purpose data for a from-scratch week at all.
    // auditWeeklyVolume's compatibleSessions fix (2026-09-23) already
    // prefers the audited week's own real session.sessionPurpose
    // (`current`, which reflects what the AI actually returned) over
    // this fallback, so sessionPurpose: null here is never actually used
    // once the AI has responded.
    const existingProgramDates = context.routine.week.map((d) => ({ date: d.date, sessionPurpose: null as string | null }));
    const audit = auditWeeklyVolume({ days: current }, { targets: context.targets, existingProgram: existingProgramDates, programmingBrief: undefined });
    if (audit.goalShortfalls.length === 0) break;

    let improved = false;
    for (const row of audit.goalShortfalls) {
      const target = findTarget(context.targets, row.targetType, row.targetId);
      if (!target) continue;
      const cap = directSetsPerExposureCapFor(target);

      for (let i = 0; i < current.length; i++) {
        const day = current[i]!;
        if (!day.session) continue;
        const exercises = day.session.exercises;
        const trainedHere = exercises.find((e) => e.targetType === target.targetType && e.targetId === target.targetId);
        if (!trainedHere) continue;

        const missing = findMissingAuthoredExerciseGW(target, exercises);
        if (!missing) continue;

        const displaceable = findDisplaceableExerciseGW(exercises, context.targets);
        if (displaceable) {
          const added = buildGoalExerciseGW(target, missing, cap, trainedHere.classification);
          const nextExercises = [...exercises];
          nextExercises[exercises.indexOf(displaceable)] = added;
          current[i] = { ...day, session: { ...day.session, exercises: nextExercises } };
          notes.push(`${day.date}: replaced ${displaceable.exerciseId} (${displaceable.targetId}) with ${added.exerciseId} to work toward ${target.targetId}'s required weekly volume.`);
          improved = true;
          break;
        }

        if (hasSpareCapacityForGW(exercises, validPurpose(day.session.sessionPurpose), target)) {
          const added = buildGoalExerciseGW(target, missing, cap, trainedHere.classification);
          current[i] = { ...day, session: { ...day.session, exercises: [...exercises, added] } };
          notes.push(`${day.date}: added ${added.exerciseId} to work toward ${target.targetId}'s required weekly volume (session had spare exercise capacity, no safe exercise to displace).`);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }

  return { days: current, notes };
}

/** Repairs every day of a from-scratch week with the same routine
 * repairWeekReconciliation uses for an existing one — no locked days
 * apply here (there is nothing to lock in a week that never existed
 * before this call). Requires no programmingBrief: auditWeeklyVolume's
 * own deliverable fallback (the package's real per-exposure cap x this
 * week's own compatible-session count, itself derived from
 * context.routine.week, never a stale snapshot) is exactly the intended
 * requirement for a first-time week — there is no separate build-up
 * decision to defer to yet, unlike reconciling an already-running week. */
export function repairGenerateWeek(output: AIGenerateWeekOutput, context: AIGenerateWeekContext): AIGenerateWeekOutput {
  const notes: string[] = [];

  const days = output.days.map((day) => {
    if (!day.session) return day;
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

  // Goal-completion (completeGoalVolumeForGenerateWeek, defined above) is
  // deliberately NOT invoked here yet. Flagged as an open architectural
  // decision rather than decided silently: with no programmingBrief field
  // in AIGenerateWeekContext (decideVolume's real, conservative per-target
  // decision is not wired into any week-level context in this codebase
  // today — see the safety gate on completeGoalVolume/commit 37c8a35 for
  // why that number, not the package's raw deliverable ceiling, is the
  // one that should gate completion), running it here would push every
  // shortfall straight to full physical delivery capacity regardless of
  // whether decideVolume would actually recommend that much this week —
  // safe today only by coincidence for an advanced trainee starting a
  // goal from zero (decideVolume's own cold-start rule happens to agree),
  // not in general. See Phase 1 report.
  return { ...output, days, warnings: [...output.warnings, ...notes] };
}
