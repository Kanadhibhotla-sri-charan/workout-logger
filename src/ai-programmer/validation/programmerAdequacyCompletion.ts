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
import { creditedSetsByTarget } from './sharedCredit.js';
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
  notes: string[]
): void {
  const threshold = guidance.feasibility!.adequacyThreshold;
  let missing = Math.ceil(threshold - currentTotal);
  if (missing <= 0) return;

  const presentIds = new Set(exercises.map((e) => e.exerciseId));
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
  // still allows one more exercise for this target.
  const newCandidates = target.validExercises
    .filter((v) => v.authoredPrescription !== null && !presentIds.has(v.exerciseId))
    .map((v) => ({ exerciseId: v.exerciseId, ceiling: effectiveCeiling(v, cap), catalogueEntry: v }));
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
    presentIds.add(catalogueEntry.exerciseId);
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

  // Same deterministic order every time: the order targets/muscles were
  // built in (never re-sorted by "who needs the most"), so two runs over
  // identical input always process targets in the same order.
  for (const guidance of context.programmingBrief.muscles) {
    if (!guidance.feasibility) continue; // only real construction-path guidance has this — never invented here
    if (!guidance.eligibleForThisSession) continue;
    if (guidance.recoveryAdjustment === 'avoid') continue;
    const isPriorityOrExpected = guidance.isGoalOriented || expectedCoverageSet.has(guidance.targetId);
    if (!isPriorityOrExpected) continue;
    if (!guidance.feasibility.isFeasible) continue; // no real completion exists — never force one

    const totals = creditedSetsByTarget(exercises, context.targets);
    const currentTotal = totals.get(guidanceKey(guidance)) ?? 0;
    // Rule: only a target the AI already represented (nonzero credited
    // work) is ever completed. A complete omission remains the AI's own
    // legitimate choice (rule 10) — never force-added here.
    if (currentTotal === 0) continue;
    if (currentTotal >= guidance.feasibility.adequacyThreshold) continue; // already adequate — no-op

    const target = findTarget(context.targets, guidance.targetType, guidance.targetId);
    if (!target) continue;
    completeOneTarget(exercises, target, guidance, currentTotal, purpose, notes);
  }

  if (notes.length === 0) {
    return { proposal, notes: [] };
  }
  return { proposal: { ...proposal, exercises, warnings: [...proposal.warnings, ...notes] }, notes };
}
