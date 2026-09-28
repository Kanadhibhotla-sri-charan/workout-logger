// Push Generation Architectural Fix (2026-09-24), priority 3:
// deterministic exercise/volume completion. Sits between domain
// validation and adequacy validation in generate_session's pipeline
// (see aiProgrammerService.ts's own generateSession) — operating on the
// FINAL effective exercise/set values (post-repair, post-domain-
// validation), the exact point the investigation report identified as
// correct: repair has already clamped every exercise to its real
// ceiling, domain validation has already confirmed every entry is
// structurally legitimate, so this module sees the TRUE credited
// shortfall the adequacy validator is about to check, and adds only
// what real data proves can close it.
//
// CORE PRINCIPLE (explicit user approval, 2026-09-24): the AI chooses
// the workout; this module only GUARANTEES the chosen workout is
// feasible when a valid deterministic completion exists. It never
// redesigns the session, never invents an exercise, never bypasses
// adequacy validation (the completed proposal still flows through the
// real, unmodified validateProposalAdequacy() afterward — this module
// has no pass/fail authority of its own), and never forces a completion
// when none is genuinely feasible (that case is left for adequacy
// validation to reject exactly as it already does, unchanged).
//
// WHAT THIS NEVER DOES:
//   - Never touches a target with ZERO credited work (a complete
//     omission is a legitimate AI choice — rule 10 — never force-added).
//   - Never adds an exercise whose muscle_group has no genuine feasible
//     combination (targetFeasibility.ts's own isFeasible: false is
//     respected, never overridden).
//   - Never invents a shared-credit relationship — uses
//     creditedTargetKeys/creditedSetsByTarget (sharedCredit.ts) as the
//     single source of truth, identical to what adequacy validation
//     itself checks afterward.
//   - Never exceeds a per-exercise authored/cap ceiling, the session
//     exercise-count cap, the session target-count cap, or the abs
//     exercise-share cap (sessionRealismCapFor — the SAME function
//     repair's own trimToSessionCaps and adequacy validation both use).
//   - Never adds an exercise already present anywhere in the proposal
//     (an exerciseId can only carry one targetId — the same rule
//     repairDuplicateExercises already enforces).
//   - Never adds more volume than the minimum needed to clear the real
//     adequacy threshold (never tops up to the full recommended floor).
//   - Only ever adds a NEW exercise that has a real Blueprint-authored
//     prescription — never one requiring an invented rep/RIR range.

import { ABS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import type { SessionPurpose } from '../../engine/sessionPurpose.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance, AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from '../context/programmerContextTypes.js';
import { creditedSetsByTarget, creditedTargetKeys, keyOf } from './sharedCredit.js';
import { MAX_SETS_WITHOUT_AUTHORED_CAP } from './programmerProposalRepair.js';

export interface CompletionResult {
  proposal: AIWorkoutSessionProposal;
  notes: string[];
}

function findTarget(targets: readonly AIProgrammerTargetContext[], targetType: string, targetId: string): AIProgrammerTargetContext | undefined {
  return targets.find((t) => t.targetType === targetType && t.targetId === targetId);
}

function guidanceKey(g: Pick<AIProgrammerMuscleGuidance, 'targetType' | 'targetId'>): string {
  return `${g.targetType}:${g.targetId}`;
}

/** A candidate's real, repair-respecting effective ceiling — the exact
 * same rule targetFeasibility.ts's own effectiveCeiling uses (same
 * MAX_SETS_WITHOUT_AUTHORED_CAP constant, imported from
 * programmerProposalRepair.ts — never a second, independently-derived
 * copy of that number). */
function effectiveCeiling(candidate: AIProgrammerValidExerciseContext, directSetsPerExposureCap: number | null): number {
  const authoredMax = candidate.authoredPrescription?.sets ?? MAX_SETS_WITHOUT_AUTHORED_CAP;
  return directSetsPerExposureCap != null ? Math.min(authoredMax, directSetsPerExposureCap) : authoredMax;
}

/** Deterministic, documented tie-break for which candidate to try next
 * when more than one could close the gap: larger effective ceiling
 * first (closes the gap in fewer exercises — the same minimum-change
 * intent as targetFeasibility.ts's own greedy combination), then
 * alphabetical by exerciseId for full determinism (never dependent on
 * object insertion order or randomness). */
function sortCandidates(candidates: readonly { exerciseId: string; ceiling: number }[]): { exerciseId: string; ceiling: number }[] {
  return [...candidates].sort((a, b) => b.ceiling - a.ceiling || a.exerciseId.localeCompare(b.exerciseId));
}

/** Cross-Target Candidate Contention Fix (2026-09-28): the ONE place
 * that computes a target's remaining usable authored candidates for a
 * brand-new exercise — real Blueprint-authored candidates, not already
 * present anywhere in the CURRENT proposal, with real positive headroom
 * under their own effective ceiling. Used both to RANK targets by
 * scarcity (completeProposalAdequacy's own scheduler, below) and, inside
 * completeOneTarget's Step 2, to actually SELECT a candidate — sharing
 * this one function guarantees the two can never disagree about which
 * candidates are still available.
 *
 * Feasibility/Credit Consistency Fix (2026-09-28): a candidate must also
 * earn credit for this target under the shared-credit rule adequacy
 * checks — the same requirement targetFeasibility.ts applies — so
 * completion never adds sets that count toward a different target. */
function remainingUsableCandidates(
  exercises: readonly AIWorkoutExerciseProposal[],
  target: AIProgrammerTargetContext,
  directSetsPerExposureCap: number | null,
  allTargets: readonly AIProgrammerTargetContext[]
): { exerciseId: string; ceiling: number; catalogueEntry: AIProgrammerValidExerciseContext }[] {
  const presentIds = new Set(exercises.map((e) => e.exerciseId));
  const targetKey = keyOf(target.targetType, target.targetId);
  return target.validExercises
    .filter(
      (v) =>
        v.authoredPrescription !== null &&
        !presentIds.has(v.exerciseId) &&
        creditedTargetKeys({ exerciseId: v.exerciseId, targetType: target.targetType, targetId: target.targetId }, allTargets).includes(targetKey)
    )
    .map((v) => ({ exerciseId: v.exerciseId, ceiling: effectiveCeiling(v, directSetsPerExposureCap), catalogueEntry: v }))
    .filter((c) => c.ceiling > 0);
}

/** Cross-Target Candidate Contention Fix (2026-09-28): real remaining
 * headroom under `target`'s OWN already-present exercise(s) — exactly
 * the same ceiling-minus-current-sets arithmetic completeOneTarget's own
 * Step 1 bump performs, extracted so the scheduler can tell, before ever
 * calling completeOneTarget, whether this target can be fully closed by
 * bumping alone (in which case it never competes for a shared candidate
 * with any other target, and its processing order is irrelevant to
 * every other target's outcome). */
function ownBumpHeadroom(exercises: readonly AIWorkoutExerciseProposal[], target: AIProgrammerTargetContext, directSetsPerExposureCap: number | null): number {
  const ownExisting = exercises.filter((e) => e.targetType === target.targetType && e.targetId === target.targetId);
  let total = 0;
  for (const e of ownExisting) {
    const catalogueEntry = target.validExercises.find((v) => v.exerciseId === e.exerciseId);
    const ceiling = catalogueEntry ? effectiveCeiling(catalogueEntry, directSetsPerExposureCap) : e.sets;
    total += Math.max(0, ceiling - e.sets);
  }
  return total;
}

/** Cross-Target Candidate Contention Fix (2026-09-28): a target's real
 * contention rank for the scheduler below — lower goes first.
 * `Infinity` for a target bump-alone can fully close (see
 * ownBumpHeadroom's own doc comment: it never touches a shared
 * candidate, so its position is always safe last); otherwise the real
 * count of remaining usable authored candidates — a target with FEWER
 * real options is more likely to be starved by a more flexible target
 * consuming its only option first, so it goes first (most-constrained-
 * first — the same principle that resolves the reproduced Pull
 * lat-width/back-thickness contention: back-thickness had exactly one
 * remaining candidate (chest-supported-row) while lat-width had two
 * (chest-supported-row, straight-arm-pulldown); processing back-thickness
 * first lets lat-width fall back to its own second option instead of
 * leaving back-thickness with nothing). */
function contentionRank(
  exercises: readonly AIWorkoutExerciseProposal[],
  target: AIProgrammerTargetContext,
  directSetsPerExposureCap: number | null,
  missing: number,
  allTargets: readonly AIProgrammerTargetContext[]
): number {
  if (ownBumpHeadroom(exercises, target, directSetsPerExposureCap) >= missing) return Number.POSITIVE_INFINITY;
  return remainingUsableCandidates(exercises, target, directSetsPerExposureCap, allTargets).length;
}

/** Whether adding one more exercise, for `targetId`, to `exercises` would
 * stay within every real session-wide cap sessionRealismCapFor defines —
 * the SAME function repair's own trimToSessionCaps and adequacy
 * validation both already enforce, never a second, independently-copied
 * set of numbers. Checked BEFORE every single addition (never assumed
 * safe from a stale count), since multiple targets may each be adding
 * exercises within the same completion pass. */
function canAddOneMoreExerciseFor(exercises: readonly AIWorkoutExerciseProposal[], targetId: string, purpose: SessionPurpose | null): boolean {
  const targetIdsAfter = new Set(exercises.map((e) => e.targetId));
  targetIdsAfter.add(targetId);
  const caps = sessionRealismCapFor(purpose, [...targetIdsAfter]);
  if (exercises.length + 1 > caps.maxExercises) return false;
  if (targetIdsAfter.size > caps.maxTargets) return false;
  if (caps.absExerciseShareMax !== null && ABS_PHYSIQUE_TARGETS.includes(targetId)) {
    const absCountAfter = exercises.filter((e) => ABS_PHYSIQUE_TARGETS.includes(e.targetId)).length + 1;
    if (absCountAfter > caps.absExerciseShareMax) return false;
  }
  return true;
}

/** Completes ONE deficient target's shortfall, in place on a working
 * copy of `exercises` — minimum-change: bumps an already-present
 * exercise for this exact target up to ITS OWN ceiling first (no new
 * exercise, no session-cap impact), and only adds a brand-new exercise
 * (from this target's own real, authored candidates, never already
 * present anywhere in the proposal) when bumping alone cannot close the
 * remaining gap. Stops and reports, rather than forcing anything, the
 * moment no further real, cap-respecting option exists — the resulting
 * shortfall is left for adequacy validation to reject exactly as it
 * already would, unchanged. */
function completeOneTarget(
  exercises: AIWorkoutExerciseProposal[],
  target: AIProgrammerTargetContext,
  guidance: AIProgrammerMuscleGuidance,
  currentTotal: number,
  purpose: SessionPurpose | null,
  notes: string[],
  allTargets: readonly AIProgrammerTargetContext[]
): void {
  const threshold = guidance.feasibility!.adequacyThreshold;
  let missing = Math.ceil(threshold - currentTotal);
  if (missing <= 0) return;

  const cap = guidance.directSetsPerExposureCap;

  // Step 1: bump this target's OWN already-present exercise(s) up to
  // their own ceiling first — the smallest possible change, and one
  // with zero impact on any session-wide exercise/target/abs cap.
  // Deterministic order: largest real headroom first, tie-broken
  // alphabetically by exerciseId (sortCandidates' own rule).
  const ownExisting = exercises.filter((e) => e.targetType === target.targetType && e.targetId === target.targetId);
  const withHeadroom = ownExisting.map((e) => {
    const catalogueEntry = target.validExercises.find((v) => v.exerciseId === e.exerciseId);
    const ceiling = catalogueEntry ? effectiveCeiling(catalogueEntry, cap) : e.sets;
    return { exerciseId: e.exerciseId, ceiling: Math.max(0, ceiling - e.sets) };
  });
  const bumpOrder = sortCandidates(withHeadroom).map((c) => ownExisting.find((e) => e.exerciseId === c.exerciseId)!);
  for (const existing of bumpOrder) {
    if (missing <= 0) break;
    const catalogueEntry = target.validExercises.find((v) => v.exerciseId === existing.exerciseId);
    const ceiling = catalogueEntry ? effectiveCeiling(catalogueEntry, cap) : existing.sets;
    const headroom = ceiling - existing.sets;
    if (headroom <= 0) continue;
    const add = Math.min(headroom, missing);
    const before = existing.sets;
    existing.sets += add;
    missing -= add;
    notes.push(
      `Deterministic completion: increased ${existing.exerciseId} for ${target.targetId} from ${before} to ${existing.sets} sets — the AI's own selection was below the real adequacy threshold (${threshold}), and this already-present exercise had real headroom under its own ceiling (${ceiling}).`
    );
  }
  if (missing <= 0) return;

  // Step 2: add a brand-new exercise — only a real, authored candidate
  // (never one requiring an invented rep/RIR range), not already present
  // anywhere in the proposal, and only while every real session-wide cap
  // still allows one more exercise for this target. Uses the SAME
  // remainingUsableCandidates helper the scheduler's own contentionRank
  // ranks targets with (Cross-Target Candidate Contention Fix,
  // 2026-09-28) — selection can never see a candidate ranking didn't
  // already know about, or vice versa.
  const newCandidates = remainingUsableCandidates(exercises, target, cap, allTargets);
  for (const candidate of sortCandidates(newCandidates)) {
    if (missing <= 0) break;
    if (!canAddOneMoreExerciseFor(exercises, target.targetId, purpose)) {
      notes.push(
        `Deterministic completion: could not fully close ${target.targetId}'s shortfall — adding another exercise would exceed a real session-wide cap (exercise count, target count, or abs exercise-share). Reporting the constraint rather than violating it; the resulting shortfall is left for adequacy validation.`
      );
      break;
    }
    const found = newCandidates.find((c) => c.exerciseId === candidate.exerciseId)!;
    const catalogueEntry = found.catalogueEntry;
    const authored = catalogueEntry.authoredPrescription!;
    const addSets = Math.min(candidate.ceiling, missing);
    exercises.push({
      exerciseId: catalogueEntry.exerciseId,
      role: catalogueEntry.role,
      targetType: target.targetType,
      targetId: target.targetId,
      sets: addSets,
      repsMin: authored.repsMin,
      repsMax: authored.repsMax,
      rirMin: authored.rirMin,
      rirMax: authored.rirMax,
      rationale: [
        `Added by deterministic completion: ${target.targetId} was below the real adequacy threshold (${threshold}) after the AI's own selection; this authored, already-eligible exercise was unused and closes the gap without exceeding any real cap.`,
      ],
      source: 'blueprint',
    });
    missing -= addSets;
    notes.push(`Deterministic completion: added ${catalogueEntry.exerciseId} for ${target.targetId} at ${addSets} sets to close the remaining shortfall.`);
  }
}

/** The completion pass for one `generate_session` proposal — see this
 * file's own header comment for the full contract. Called with the
 * proposal AFTER repair and domain validation, BEFORE adequacy
 * validation; the adequacy validator itself still runs, unmodified, on
 * this function's output — this module never decides pass/fail on its
 * own. */
export function completeProposalAdequacy(proposal: AIWorkoutSessionProposal, context: AIProgrammerContext): CompletionResult {
  const notes: string[] = [];
  const exercises: AIWorkoutExerciseProposal[] = proposal.exercises.map((e) => ({ ...e }));
  const purpose = context.programmingBrief.session.purpose;
  const expectedCoverageSet = new Set(context.programmingBrief.session.expectedCoverageTargetIds);

  // Static eligibility filter — never changes as `exercises` mutates
  // below (unlike currentTotal, which must be recomputed fresh every
  // time a completion action changes the credited totals).
  const eligibleGuidances = context.programmingBrief.muscles.filter((guidance) => {
    if (!guidance.feasibility) return false; // only real construction-path guidance has this — never invented here
    if (!guidance.eligibleForThisSession) return false;
    if (guidance.recoveryAdjustment === 'avoid') return false;
    const isPriorityOrExpected = guidance.isGoalOriented || expectedCoverageSet.has(guidance.targetId);
    if (!isPriorityOrExpected) return false;
    if (!guidance.feasibility.isFeasible) return false; // no real completion exists — never force one
    return true;
  });

  // Cross-Target Candidate Contention Fix (2026-09-28): deterministic
  // most-constrained-target-first scheduling, recomputed after every
  // completion action — replaces the old fixed declaration-order single
  // pass, which let one target's own greedy pick permanently starve a
  // still-pending target of its only remaining authored candidate even
  // when a joint legal allocation existed for both (a real, reproduced
  // Pull bug: lat-width and back-thickness both needed the shared
  // candidate `chest-supported-row`; declaration order let lat-width
  // claim it first, leaving back-thickness with nothing, even though
  // lat-width's own second-best candidate alone would have covered its
  // own gap). completeOneTarget's own per-target logic is UNCHANGED —
  // only WHICH target goes next each iteration changes, and each target
  // is still processed at most once (a target that makes no progress —
  // no candidates left, or a real session-wide cap reached — is never
  // revisited; candidate availability only shrinks over time, so this
  // loop always terminates in at most `pending.size` iterations). See
  // contentionRank's own doc comment for the ranking rule and tie-break.
  const pending = new Set(eligibleGuidances.map((g) => guidanceKey(g)));
  while (pending.size > 0) {
    const totals = creditedSetsByTarget(exercises, context.targets);
    let best: { guidance: AIProgrammerMuscleGuidance; target: AIProgrammerTargetContext; currentTotal: number; rank: number } | null = null;

    for (const guidance of eligibleGuidances) {
      const key = guidanceKey(guidance);
      if (!pending.has(key)) continue;

      const currentTotal = totals.get(key) ?? 0;
      // Rule: only a target the AI already represented (nonzero credited
      // work) is ever completed. A complete omission remains the AI's
      // own legitimate choice (rule 10) — never force-added here.
      if (currentTotal === 0 || currentTotal >= guidance.feasibility!.adequacyThreshold) {
        pending.delete(key); // already adequate, or the AI omitted it entirely — nothing to do, never revisit
        continue;
      }

      const target = findTarget(context.targets, guidance.targetType, guidance.targetId);
      if (!target) {
        pending.delete(key);
        continue;
      }

      const missing = Math.ceil(guidance.feasibility!.adequacyThreshold - currentTotal);
      const rank = contentionRank(exercises, target, guidance.directSetsPerExposureCap, missing, context.targets);
      // Deterministic tie-break: alphabetical by targetId (never object
      // insertion order or randomness).
      if (!best || rank < best.rank || (rank === best.rank && guidance.targetId < best.guidance.targetId)) {
        best = { guidance, target, currentTotal, rank };
      }
    }

    if (!best) break; // nothing left needs attention this pass

    completeOneTarget(exercises, best.target, best.guidance, best.currentTotal, purpose, notes, context.targets);
    pending.delete(guidanceKey(best.guidance)); // processed exactly once, regardless of outcome
  }

  if (notes.length === 0) {
    return { proposal, notes: [] };
  }
  return { proposal: { ...proposal, exercises, warnings: [...proposal.warnings, ...notes] }, notes };
}
