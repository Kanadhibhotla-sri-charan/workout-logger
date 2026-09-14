// Repair: AI generation was previously validated only for STRUCTURAL/
// DOMAIN correctness (programmerDomainValidator.ts — real exercise/
// target IDs, exact authored-prescription match, safety ceilings). None
// of that checks whether the resulting session is a programmatically
// ADEQUATE workout: whether it respects the requested session identity
// (Push/Pull/Legs/Upper), covers the muscles that identity requires,
// gives priority (Complete-level, goal-oriented) targets their required
// coverage, and keeps per-muscle/total volume within the deterministic
// programmingBrief's own guidance (context.programmingBrief — built by
// programmerContextBuilder.ts's buildProgrammingBrief, itself calling
// the EXISTING developmentReferenceEngine.ts/volumeEngine.ts, never a
// second volume system).
//
// This is deliberately bounds/range-based, never an exact-match check:
// Efficient/Complete are volume/reference guidance, not fixed exercise
// lists (see programmingBrief.muscles[].recommendedSessionSets, a
// {min,max} range) — an exercise absent from either Blueprint package
// remains fully eligible, and nothing here inspects WHICH exercise was
// chosen, only how much total volume landed on which target.

import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance } from '../context/programmerContextTypes.js';

export interface AdequacyValidationResult {
  ok: boolean;
  errors: string[];
}

/** A target must clear at least this many sets to count as "given
 * meaningful direct coverage" for session-identity/priority-coverage
 * purposes — a single warm-up-weight set does not. [DEFAULT], not a
 * Blueprint value; documented here rather than left as a magic number. */
const MEANINGFUL_COVERAGE_MIN_SETS = 2;

/** When a session's identity names more than this many non-universal
 * expected-coverage targets (e.g. Push names chest/front-delt/side-delt/
 * triceps/triceps-long-head = 5), require at least this many of them to
 * receive meaningful coverage — never all of them (rule: goal
 * prioritization and flexible exercise selection remain intact; a
 * session recognizably built around its identity does not require
 * hitting every single muscle it could touch). [DEFAULT]. */
const MIN_EXPECTED_COVERAGE_TARGETS = 2;

/** A single target consuming more than this fraction of the whole
 * session's total sets — while at least this many distinct targets are
 * present — is "nearly the entire session on one small area" (the
 * user's own framing). [DEFAULT]. */
const MAX_SINGLE_TARGET_SHARE = 0.6;
const MIN_DISTINCT_TARGETS_FOR_SHARE_CHECK = 3;

/** Total session volume this far above the deterministic
 * approxSessionSetBudget guidance is "clearly excessive," not merely
 * generous — the budget itself is already guidance, not a hard cap, so
 * this multiplier gives real headroom before rejecting. [DEFAULT]. */
const MAX_TOTAL_SETS_BUDGET_MULTIPLIER = 2;

/** A covered target's total sets falling below this fraction of its own
 * recommendedSessionSets.min is "clearly inadequate volume," not a
 * reasonable judgment-call deviation — recommendedSessionSets.min is
 * already a floor (see programmingBrief's own doc comment), so this is
 * a floor UNDER the floor, not exact-match enforcement. Applied only to
 * targets that are either goal-oriented (Complete-level) or part of the
 * session's own expected coverage — never to every incidental
 * maintenance target, preserving the AI's freedom to skip a target
 * entirely (rule 10: "omission never implies invalidity") rather than
 * being forced to half-cover everything. [DEFAULT]. */
const UNDER_PRESCRIPTION_TOLERANCE = 0.5;

function setsByTarget(exercises: readonly AIWorkoutExerciseProposal[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const ex of exercises) {
    const key = `${ex.targetType}:${ex.targetId}`;
    totals.set(key, (totals.get(key) ?? 0) + ex.sets);
  }
  return totals;
}

function guidanceKey(g: Pick<AIProgrammerMuscleGuidance, 'targetType' | 'targetId'>): string {
  return `${g.targetType}:${g.targetId}`;
}

/**
 * Checks a structurally/domain-valid proposal for programming adequacy
 * against `context.programmingBrief`. Never inspects exercise identity
 * — only aggregate sets per target and per session. Returns every
 * violation found (never stops at the first) so a caller/reviewer sees
 * the complete picture at once, matching programmerDomainValidator's
 * own convention.
 */
export function validateProposalAdequacy(proposal: AIWorkoutSessionProposal, context: AIProgrammerContext): AdequacyValidationResult {
  const errors: string[] = [];
  const brief = context.programmingBrief;
  const totals = setsByTarget(proposal.exercises);
  const totalSessionSets = proposal.exercises.reduce((sum, ex) => sum + ex.sets, 0);

  // --- Per-muscle set bounds (hard: directSetsPerExposureCap is a real
  // Blueprint-authored per-exposure ceiling, the same one
  // developmentReferenceEngine.ts already computes and workoutBuilder.ts
  // already treats as a real cap). ---
  for (const guidance of brief.muscles) {
    const totalForTarget = totals.get(guidanceKey(guidance)) ?? 0;
    if (guidance.directSetsPerExposureCap != null && totalForTarget > guidance.directSetsPerExposureCap) {
      errors.push(
        `${guidance.targetType}:${guidance.targetId}: total proposed sets (${totalForTarget}) exceed this target's Blueprint per-exposure cap (${guidance.directSetsPerExposureCap}, ${guidance.developmentLevel} level)`
      );
    }
    // A target the deterministic layer marked ineligible for this
    // session's identity (e.g. an arm goal on a Push day) receiving
    // more than a small supplementary amount is exactly the "off-
    // purpose displacement" the design set out to catch.
    if (!guidance.eligibleForThisSession && totalForTarget > MEANINGFUL_COVERAGE_MIN_SETS && brief.session.purpose !== null) {
      errors.push(
        `${guidance.targetType}:${guidance.targetId}: ${totalForTarget} sets given, but this target is not compatible with the requested "${brief.session.purpose}" session identity (only small supplementary work is tolerated here)`
      );
    }
  }

  // --- Priority (goal-oriented, eligible, not recovery-excused)
  // coverage: an active-goal target compatible with this session must
  // not be silently omitted. ---
  for (const guidance of brief.muscles) {
    if (!guidance.isGoalOriented || !guidance.eligibleForThisSession) continue;
    if (guidance.recoveryAdjustment === 'avoid') continue; // excused — recovery caution already reflected
    const totalForTarget = totals.get(guidanceKey(guidance)) ?? 0;
    if (totalForTarget === 0) {
      errors.push(`${guidance.targetType}:${guidance.targetId}: an active-goal target eligible for this session received no direct work at all (recommended ${guidance.recommendedSessionSets.min}-${guidance.recommendedSessionSets.max} sets)`);
    }
  }

  // --- Under-prescription: a covered priority/expected-coverage target
  // given real but clearly insufficient volume relative to its own
  // deterministic floor (never checked for a target the AI chose to
  // omit entirely — that stays a legitimate choice, rule 10). This is
  // what catches the exact real-world gap the repair targets: an
  // eligible goal-oriented target, or a session-identity-expected
  // target, receiving e.g. 2-3 sets when the deterministic guidance's
  // own floor was ~7-8. ---
  const expectedCoverageSet = new Set(brief.session.expectedCoverageTargetIds);
  for (const guidance of brief.muscles) {
    if (!guidance.eligibleForThisSession) continue;
    const isPriorityOrExpected = guidance.isGoalOriented || expectedCoverageSet.has(guidance.targetId);
    if (!isPriorityOrExpected) continue;
    if (guidance.recoveryAdjustment === 'avoid') continue;
    const totalForTarget = totals.get(guidanceKey(guidance)) ?? 0;
    if (totalForTarget === 0) continue; // complete omission is checked separately (goal targets) or is a legitimate choice (non-goal)
    const floor = guidance.recommendedSessionSets.min * UNDER_PRESCRIPTION_TOLERANCE;
    if (totalForTarget < floor) {
      errors.push(
        `${guidance.targetType}:${guidance.targetId}: ${totalForTarget} sets is clearly inadequate volume — below ${Math.round(UNDER_PRESCRIPTION_TOLERANCE * 100)}% of this target's own deterministic guidance floor (recommended ${guidance.recommendedSessionSets.min}-${guidance.recommendedSessionSets.max} sets, ${guidance.developmentLevel} level)`
      );
    }
  }

  // --- Session-identity coverage: the session must remain recognizable
  // as its requested purpose. ---
  if (brief.session.purpose !== null && brief.session.expectedCoverageTargetIds.length > 0) {
    const coveredExpected = brief.session.expectedCoverageTargetIds.filter((targetId) => {
      const covered = proposal.exercises.some((ex) => ex.targetId === targetId && ex.sets >= 1);
      const totalForTarget = [...totals.entries()].find(([key]) => key.endsWith(`:${targetId}`))?.[1] ?? 0;
      return covered && totalForTarget >= MEANINGFUL_COVERAGE_MIN_SETS;
    });
    const required = Math.min(MIN_EXPECTED_COVERAGE_TARGETS, brief.session.expectedCoverageTargetIds.length);
    if (coveredExpected.length < required) {
      errors.push(
        `session identity "${brief.session.purpose}" expects meaningful coverage of at least ${required} of [${brief.session.expectedCoverageTargetIds.join(', ')}]; only ${coveredExpected.length} received >= ${MEANINGFUL_COVERAGE_MIN_SETS} sets ([${coveredExpected.join(', ')}])`
      );
    }
  }

  // --- No single target dominating the whole session. ---
  const distinctTargetsPresent = totals.size;
  if (distinctTargetsPresent >= MIN_DISTINCT_TARGETS_FOR_SHARE_CHECK && totalSessionSets > 0) {
    for (const [key, setsForTarget] of totals) {
      if (setsForTarget / totalSessionSets > MAX_SINGLE_TARGET_SHARE) {
        errors.push(`${key}: ${setsForTarget} of ${totalSessionSets} total session sets (${Math.round((setsForTarget / totalSessionSets) * 100)}%) — nearly the entire session on one target`);
      }
    }
  }

  // --- Total session volume vs. the deterministic time-budget guidance. ---
  if (brief.approxSessionSetBudget > 0 && totalSessionSets > brief.approxSessionSetBudget * MAX_TOTAL_SETS_BUDGET_MULTIPLIER) {
    errors.push(
      `total proposed sets (${totalSessionSets}) far exceed the deterministic session set-budget guidance (~${brief.approxSessionSetBudget}, from the real time budget) — clearly excessive volume for this session`
    );
  }

  return { ok: errors.length === 0, errors };
}
