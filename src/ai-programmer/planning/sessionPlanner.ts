// Session Planner (2026-09-28, shadow mode): the deterministic pre-AI
// session plan from the approved generation-contract redesign. Given a
// generate_session context, it decides which targets can be trained this
// session, which are genuinely infeasible, which must wait for capacity,
// how many exercise slots the chosen targets need, and which exercises
// actually earn credit for each target. It never picks the workout's
// exercises — candidate lists and slot counts only.
//
// Pure and deterministic: reads only the context (plus the non-goal
// rotation cursor the caller reads, read-only) and returns a new object.
// Built entirely from existing rules — never a second copy of them:
//   - eligibility, goals, floors, caps:   context.programmingBrief
//   - feasibility:                        computeTargetFeasibility (credit-consistent)
//   - credit / side credit:               creditedTargetKeys (sharedCredit.ts)
//   - adequacy threshold and identity:    programmerAdequacyValidator.ts constants
//   - ranking within a tier:              rankTarget / compareRankings (workoutBuilder.ts)
//   - rotation:                           nonGoalRotation (workoutBuilder.ts)
//   - session caps:                       sessionRealismCapFor (config.ts)
//   - identity vs accessory regions:      Blueprint parent_region + SESSION_ACCESSORY_REGIONS (config.ts)
//
// Allocation order (Phase 2 revision): required active goals, then one
// target per not-yet-covered identity region, then the remaining identity
// targets, then accessory regions — compareRankings order inside each
// tier. First-fit: a target is taken whole or deferred whole.
//
// Capacity (Phase 2 revision): targets linked by shared credit form a
// capacity group whose exercise need is computed jointly — one physical
// exercise fills one slot and counts toward every target it legitimately
// credits (the same crediting adequacy validation applies).
//
// Shadow mode: generate_session computes and logs this plan but nothing
// reads it back (AI context, prompt, output, repair, completion and
// validation are unchanged).

import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, SESSION_ACCESSORY_REGIONS, sessionRealismCapFor } from '../../engine/config.js';
import type { SessionPurpose } from '../../engine/sessionPurpose.js';
import { compareRankings, nonGoalRotation, rankTarget, type RankableTarget, type TargetRanking } from '../../engine/workoutBuilder.js';
import { computeTargetFeasibility } from '../context/targetFeasibility.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance, AIProgrammerTargetContext } from '../context/programmerContextTypes.js';
import { MEANINGFUL_COVERAGE_MIN_SETS, MIN_EXPECTED_COVERAGE_TARGETS, UNDER_PRESCRIPTION_TOLERANCE } from '../validation/programmerAdequacyValidator.js';
import { creditedTargetKeys, keyOf } from '../validation/sharedCredit.js';
import { boundDiagnosticIssues } from '../validation/diagnosticsBounds.js';

export const SESSION_PLAN_SCHEMA_VERSION = 'session-plan.v1' as const;

export type PlannedTargetStatus =
  /** An active growth goal eligible for this session: always planned first. */
  | 'required'
  /** A session-identity or accessory target that fit the plan's capacity whole. */
  | 'selected'
  /** A plannable target that could not fit whole; waits for a later session. */
  | 'deferred'
  /** No credited authored combination reaches its adequacy floor. */
  | 'infeasible'
  /** Not compatible with this session's purpose. */
  | 'ineligible'
  /** Recovery engine says avoid (validator already excuses it). */
  | 'recovery_excused'
  /** Eligible but neither a goal nor an expected target of this session identity. */
  | 'outside_identity'
  /** No feasibility data for this target (never planned). */
  | 'unassessed';

/** Allocation tier, in the order capacity is handed out. */
export type PlanningTier = 'goal' | 'identity_primary' | 'identity' | 'accessory';

export interface PlannedCandidate {
  exerciseId: string;
  /** min(authored sets, the target's directSetsPerExposureCap). */
  ceiling: number;
  /** Other target keys this exercise also earns credit for. */
  sideCredits: string[];
}

export interface ExcludedCandidate {
  exerciseId: string;
  /** Side-credited targets that would get an obligation this plan cannot satisfy. */
  uncoveredSideTargets: string[];
}

export interface TargetPlan {
  key: string;
  targetType: string;
  targetId: string;
  parentRegion: string | null;
  status: PlannedTargetStatus;
  /** Allocation tier; null for targets never ranked (ineligible, excused, etc.). */
  tier: PlanningTier | null;
  /** Position in the allocation order; null when not ranked. Lower = protected first. */
  rank: number | null;
  isGoal: boolean;
  goalPriority: number | null;
  eligible: boolean;
  isExpectedCoverage: boolean;
  /** Feasibility using only this plan's candidates; null when not assessed. */
  feasible: boolean | null;
  adequacyThreshold: number;
  /** The validator's floor as whole sets: ceil(adequacyThreshold). */
  hardMinimumSets: number;
  /** hardMinimumSets, raised to the validator's meaningful-coverage minimum when this target carries the session identity. */
  plannedMinimumSets: number;
  recommendedSessionSets: { min: number; max: number };
  /** min(directSetsPerExposureCap, sum of this plan's candidate ceilings). */
  legalMaximumSets: number;
  candidates: PlannedCandidate[];
  excludedCandidates: ExcludedCandidate[];
  /** Reserved exercise slots that credit this target (a shared slot counts for each target it credits). */
  reservedExerciseSlots: number;
  /** Other planned targets whose reserved slots are shared with this one. */
  sharedSlotsWith: string[];
  availableExtraSlots: number;
  reason: string;
}

/** A set of planned targets linked by shared credit, with the joint minimum exercise count that meets every member's floor. */
export interface CapacityGroup {
  targetIds: string[];
  exerciseSlots: number;
}

export type SessionPlanRefusalCode = 'REQUIRED_GOAL_INFEASIBLE' | 'REQUIRED_GOAL_EXCEEDS_CAPACITY' | 'IDENTITY_MINIMUM_UNSATISFIABLE';

export interface SessionPlanRefusal {
  code: SessionPlanRefusalCode;
  targetIds: string[];
}

export interface SessionPlan {
  schemaVersion: typeof SESSION_PLAN_SCHEMA_VERSION;
  targetDate: string;
  purpose: SessionPurpose | null;
  contextHash: string;
  caps: { maxExercises: number; maxTargets: number; absExerciseShareMax: number | null; legExerciseShareMax: number | null };
  /** exerciseSlots = physical exercises (sum of capacityGroups); targetSlots = planned targets. */
  reserved: { exerciseSlots: number; targetSlots: number; absExerciseSlots: number; legExerciseSlots: number };
  capacityGroups: CapacityGroup[];
  flexExerciseSlots: number;
  identityMinimum: { requiredTargets: number; coveringTargetIds: string[]; satisfied: boolean };
  /** Non-empty means this session cannot be planned without weakening a rule (Phase 5 will refuse before the AI call). */
  refusals: SessionPlanRefusal[];
  targets: TargetPlan[];
  notes: string[];
}

export interface PlanSessionOptions {
  /** The non-goal rotation cursor for this week (NonGoalRotationRepo.cursorFor), read by the caller. Defaults to 0. */
  nonGoalRotationCursor?: number;
}

const isAbs = (targetId: string) => ABS_PHYSIQUE_TARGETS.includes(targetId);
const isLeg = (targetId: string) => LEGS_PHYSIQUE_TARGETS.includes(targetId);
const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

/** Upper bound on options (exercise × label) in one capacity group for the exact joint search (real groups hold ~4-10). */
const MAX_EXACT_GROUP_EXERCISES = 20;

interface Working {
  target: AIProgrammerTargetContext;
  guidance: AIProgrammerMuscleGuidance;
  key: string;
  plan: TargetPlan;
  baseCandidates: PlannedCandidate[];
  /** Eligible, not recovery-excused, assessed, and a goal or expected target — the only targets allocation ranks. */
  plannable: boolean;
}

interface CapacityResult {
  exerciseSlots: number;
  absSlots: number;
  legSlots: number;
  /** Planned targets plus every target the reserved exercises also credit — what the validator's target cap counts. */
  creditedTargetCount: number;
  groups: CapacityGroup[];
  perTarget: Map<string, { slots: number; reachSets: number; sharedWith: string[] }>;
}

export function planSession(context: AIProgrammerContext, options: PlanSessionOptions = {}): SessionPlan {
  const brief = context.programmingBrief;
  const purpose = brief.session.purpose;
  const expected = new Set(brief.session.expectedCoverageTargetIds);
  const guidanceByKey = new Map(brief.muscles.map((g) => [keyOf(g.targetType, g.targetId), g]));
  const notes: string[] = [];
  const refusals: SessionPlanRefusal[] = [];

  /** A target the adequacy validator holds to a floor as soon as it gets any credit. */
  const floorChecked = (g: AIProgrammerMuscleGuidance) =>
    g.eligibleForThisSession && (g.isGoalOriented || expected.has(g.targetId)) && g.recoveryAdjustment !== 'avoid';

  // ---- 1. per-target working entries, initial status ----
  const working: Working[] = [];
  for (const target of context.targets) {
    const key = keyOf(target.targetType, target.targetId);
    const guidance = guidanceByKey.get(key);
    if (!guidance) continue;
    const goal = target.goalId ? context.activeGoals.find((g) => g.goalId === target.goalId) ?? null : null;
    const threshold = guidance.feasibility?.adequacyThreshold ?? guidance.recommendedSessionSets.min * UNDER_PRESCRIPTION_TOLERANCE;
    const cap = guidance.directSetsPerExposureCap;
    const baseCandidates: PlannedCandidate[] = [];
    for (const v of target.validExercises) {
      if (!v.authoredPrescription) continue;
      const credited = creditedTargetKeys({ exerciseId: v.exerciseId, targetType: target.targetType, targetId: target.targetId }, context.targets);
      if (!credited.includes(key)) continue;
      const ceiling = cap != null ? Math.min(v.authoredPrescription.sets, cap) : v.authoredPrescription.sets;
      if (ceiling <= 0) continue;
      // Sorted: a set, and its order must not depend on context.targets order.
      baseCandidates.push({ exerciseId: v.exerciseId, ceiling, sideCredits: credited.filter((k) => k !== key).sort() });
    }

    let status: PlannedTargetStatus | null = null;
    let reason = '';
    if (!guidance.eligibleForThisSession) [status, reason] = ['ineligible', `not compatible with the "${purpose}" session`];
    else if (guidance.recoveryAdjustment === 'avoid') [status, reason] = ['recovery_excused', 'recovery engine says avoid today'];
    else if (!guidance.feasibility) [status, reason] = ['unassessed', 'no feasibility data'];
    else if (!guidance.isGoalOriented && !expected.has(target.targetId)) [status, reason] = ['outside_identity', 'not a goal or an expected target of this session identity'];

    const hardMinimumSets = Math.ceil(threshold);
    working.push({
      target,
      guidance,
      key,
      baseCandidates,
      plannable: status === null,
      plan: {
        key,
        targetType: target.targetType,
        targetId: target.targetId,
        parentRegion: target.parentRegion,
        status: status ?? 'deferred', // provisional; decided by allocation below
        tier: null,
        rank: null,
        isGoal: guidance.isGoalOriented,
        goalPriority: goal?.priority ?? null,
        eligible: guidance.eligibleForThisSession,
        isExpectedCoverage: expected.has(target.targetId),
        feasible: null,
        adequacyThreshold: threshold,
        hardMinimumSets,
        plannedMinimumSets: hardMinimumSets,
        recommendedSessionSets: { ...guidance.recommendedSessionSets },
        legalMaximumSets: 0,
        candidates: [],
        excludedCandidates: [],
        reservedExerciseSlots: 0,
        sharedSlotsWith: [],
        availableExtraSlots: 0,
        reason,
      },
    });
  }
  const workingByKey = new Map(working.map((w) => [w.key, w]));
  const plannable = working.filter((w) => w.plannable);

  // ---- 2. existing ranking (compareRankings), used inside every tier ----
  const startingPointMin = BlueprintAdapter.getGlobalPrinciples().weekly_volume.starting_point_sets[0];
  const { tieBreakByTargetId } = nonGoalRotation(
    context.targets.map((t) => ({ target_type: t.targetType, target_id: t.targetId, is_specialization: t.isSpecialization })),
    options.nonGoalRotationCursor
  );
  const rankingOf = new Map<Working, TargetRanking<RankableTarget>>(
    plannable.map((w) => [
      w,
      rankTarget(
        {
          target_type: w.target.targetType,
          target_id: w.target.targetId,
          is_specialization: w.target.isSpecialization,
          goal_priority: w.plan.goalPriority ?? Number.MAX_SAFE_INTEGER,
          weekly_exposure_units: w.target.weeklyExposureUnits,
          days_since_target_last_trained: w.target.daysSinceLastTrainedAsOfTargetDate,
        },
        startingPointMin,
        w.target.recovery,
        w.guidance.weeklyDevelopmentReference != null ? { weekly_direct_set_reference: w.guidance.weeklyDevelopmentReference } : null,
        tieBreakByTargetId.get(w.target.targetId) ?? 0
      ),
    ])
  );
  const byRank = (a: Working, b: Working) => compareRankings(rankingOf.get(a)!, rankingOf.get(b)!);
  const isAccessory = (w: Working) => w.target.parentRegion === null || SESSION_ACCESSORY_REGIONS.includes(w.target.parentRegion);

  // ---- 3. side-credit rule: which candidates are safe given the planned set ----
  function splitCandidates(w: Working, planned: ReadonlySet<string>): { kept: PlannedCandidate[]; excluded: ExcludedCandidate[] } {
    const kept: PlannedCandidate[] = [];
    const excluded: ExcludedCandidate[] = [];
    for (const c of w.baseCandidates) {
      const uncovered = c.sideCredits.filter((sideKey) => {
        const g = guidanceByKey.get(sideKey);
        if (!g) return false;
        // Any credit to a floor-checked target starts its floor check.
        if (floorChecked(g)) return !planned.has(sideKey);
        // An ineligible target is rejected above the meaningful-coverage amount.
        if (!g.eligibleForThisSession && purpose !== null) return c.ceiling > MEANINGFUL_COVERAGE_MIN_SETS;
        return false;
      });
      if (uncovered.length === 0) kept.push(c);
      else excluded.push({ exerciseId: c.exerciseId, uncoveredSideTargets: uncovered });
    }
    return { kept, excluded };
  }
  const feasibilityWith = (w: Working, candidates: readonly PlannedCandidate[]) => {
    const ids = new Set(candidates.map((c) => c.exerciseId));
    const restricted: AIProgrammerTargetContext = { ...w.target, validExercises: w.target.validExercises.filter((v) => ids.has(v.exerciseId)) };
    return computeTargetFeasibility(restricted, context.targets, w.guidance.recommendedSessionSets.min, w.guidance.directSetsPerExposureCap, UNDER_PRESCRIPTION_TOLERANCE);
  };

  // ---- 4. joint capacity for a planned set (shared credit fills one slot for every target it credits) ----
  function capacityFor(planned: ReadonlySet<string>): CapacityResult {
    const plannedKeys = [...planned].sort();
    // One option per (exercise, labelled target): credit depends on the label
    // (creditedTargetKeys credits a package's scoped sub-targets regardless of
    // label, but an unscoped exercise credits only the target it is labelled
    // for). An exercise can only appear once in a session, so a chosen set of
    // options must use distinct exercise ids.
    interface Option { exerciseId: string; label: string; sets: number; credits: Set<string>; allCredits: Set<string> }
    const options: Option[] = [];
    for (const key of plannedKeys) {
      for (const c of splitCandidates(workingByKey.get(key)!, planned).kept) {
        options.push({
          exerciseId: c.exerciseId,
          label: key,
          sets: c.ceiling,
          credits: new Set([key, ...c.sideCredits.filter((s) => planned.has(s))]),
          allCredits: new Set([key, ...c.sideCredits]),
        });
      }
    }
    options.sort((a, b) => a.exerciseId.localeCompare(b.exerciseId) || a.label.localeCompare(b.label));
    const contribution = (o: Option, key: string) => {
      if (!o.credits.has(key)) return 0;
      const cap = workingByKey.get(key)!.guidance.directSetsPerExposureCap;
      return cap != null ? Math.min(o.sets, cap) : o.sets;
    };

    // Union-find: planned targets linked only by an option that genuinely credits both (Blueprint side credit).
    const parent = new Map(plannedKeys.map((k) => [k, k]));
    const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!));
    for (const o of options) {
      for (const m of o.credits) {
        const a = find(o.label);
        const b = find(m);
        if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
      }
    }
    const componentOf = new Map<string, string[]>();
    for (const k of plannedKeys) componentOf.set(find(k), [...(componentOf.get(find(k)) ?? []), k]);

    const perTarget = new Map<string, { slots: number; reachSets: number; sharedWith: string[] }>();
    const groups: CapacityGroup[] = [];
    const creditedTargets = new Set<string>(plannedKeys);
    let exerciseSlots = 0;
    let absSlots = 0;
    let legSlots = 0;
    for (const members of [...componentOf.values()].sort((a, b) => a[0]!.localeCompare(b[0]!))) {
      const memberSet = new Set(members);
      const pool = options.filter((o) => memberSet.has(o.label));
      const threshold = (k: string) => workingByKey.get(k)!.plan.adequacyThreshold;
      const satisfies = (chosen: readonly Option[]) =>
        members.every((m) => chosen.reduce((s, o) => s + contribution(o, m), 0) >= threshold(m));
      // Smallest set of options with distinct exercises (lexicographically first)
      // meeting every member's floor. Found by depth-first search with increasing size.
      let witness: Option[] | null = null;
      if (pool.length <= MAX_EXACT_GROUP_EXERCISES) {
        const pick = (start: number, size: number, chosen: Option[]): Option[] | null => {
          if (chosen.length === size) return satisfies(chosen) ? [...chosen] : null;
          for (let i = start; i < pool.length; i++) {
            if (chosen.some((o) => o.exerciseId === pool[i]!.exerciseId)) continue;
            chosen.push(pool[i]!);
            const found = pick(i + 1, size, chosen);
            chosen.pop();
            if (found) return found;
          }
          return null;
        };
        for (let size = 1; size <= pool.length && !witness; size++) witness = pick(0, size, []);
      }
      // Fallback (never expected with real data): each member reserves its own
      // minimum without sharing — conservative, and always feasible.
      if (!witness) {
        witness = [];
        for (const m of members) {
          const own = pool.filter((o) => o.label === m && !witness!.some((x) => x.exerciseId === o.exerciseId)).sort((a, b) => b.sets - a.sets);
          let reached = witness.reduce((s, o) => s + contribution(o, m), 0);
          for (const o of own) {
            if (reached >= threshold(m)) break;
            witness.push(o);
            reached += contribution(o, m);
          }
        }
      }
      groups.push({ targetIds: members.map(idOf), exerciseSlots: witness.length });
      exerciseSlots += witness.length;
      if (members.some((m) => isAbs(idOf(m)))) absSlots += witness.length;
      if (members.some((m) => isLeg(idOf(m)))) legSlots += witness.length;
      for (const o of witness) for (const c of o.allCredits) creditedTargets.add(c);
      for (const m of members) {
        const crediting = witness.filter((o) => o.credits.has(m));
        const sharedWith = [...new Set(crediting.flatMap((o) => [...o.credits]).filter((k) => k !== m))].map(idOf).sort();
        perTarget.set(m, { slots: crediting.length, reachSets: crediting.reduce((s, o) => s + contribution(o, m), 0), sharedWith });
      }
    }
    return { exerciseSlots, absSlots, legSlots, creditedTargetCount: creditedTargets.size, groups, perTarget };
  }

  // ---- 5. tiered first-fit allocation ----
  const planned = new Set<string>();
  const representedRegions = new Set<string>();
  const attempted = new Set<Working>();
  let order = 0;

  function attempt(w: Working, tier: PlanningTier): boolean {
    attempted.add(w);
    w.plan.tier = tier;
    w.plan.rank = order++;
    const withT = new Set([...planned, w.key]);
    const { kept } = splitCandidates(w, withT);
    const feasibility = feasibilityWith(w, kept);
    if (!feasibility.isFeasible) {
      const genuinelyInfeasible = !feasibilityWith(w, w.baseCandidates).isFeasible;
      w.plan.feasible = false;
      if (genuinelyInfeasible || w.guidance.isGoalOriented) {
        w.plan.status = 'infeasible';
        w.plan.reason = genuinelyInfeasible
          ? 'no credited authored combination reaches the adequacy floor'
          : 'reachable only through exercises whose side credit this plan cannot cover';
        if (w.guidance.isGoalOriented) refusals.push({ code: 'REQUIRED_GOAL_INFEASIBLE', targetIds: [w.target.targetId] });
      } else {
        w.plan.status = 'deferred';
        w.plan.reason = 'its adequate combinations also credit targets this plan does not cover';
      }
      return false;
    }
    w.plan.feasible = true;
    const before = capacityFor(planned);
    const after = capacityFor(withT);
    const caps = sessionRealismCapFor(purpose, [...withT].map(idOf));
    const blockedBy = [
      after.exerciseSlots > caps.maxExercises ? `${caps.maxExercises}-exercise cap` : null,
      after.creditedTargetCount > caps.maxTargets ? `${caps.maxTargets}-target cap` : null,
      caps.absExerciseShareMax !== null && after.absSlots > caps.absExerciseShareMax ? `${caps.absExerciseShareMax}-abs-exercise cap` : null,
      caps.legExerciseShareMax !== null && after.legSlots > caps.legExerciseShareMax ? `${caps.legExerciseShareMax}-leg-exercise cap` : null,
    ].filter((b): b is string => b !== null);
    const fits = blockedBy.length === 0;
    if (!fits) {
      if (w.guidance.isGoalOriented) {
        w.plan.status = 'required';
        w.plan.reason = 'active growth goal does not fit the session caps';
        refusals.push({ code: 'REQUIRED_GOAL_EXCEEDS_CAPACITY', targetIds: [w.target.targetId] });
      } else {
        w.plan.status = 'deferred';
        w.plan.reason = `needs ${after.exerciseSlots - before.exerciseSlots} more exercise slot(s); taking it whole would exceed the ${blockedBy.join(' and ')} after higher-priority targets`;
      }
      return false;
    }
    planned.add(w.key);
    if (w.target.parentRegion) representedRegions.add(w.target.parentRegion);
    w.plan.status = w.guidance.isGoalOriented ? 'required' : 'selected';
    w.plan.reason =
      tier === 'goal' ? 'active growth goal'
        : tier === 'identity_primary' ? `first target of the "${w.target.parentRegion}" identity region`
          : tier === 'identity' ? 'session-identity target that fits whole'
            : 'accessory target that fits the capacity left';
    return true;
  }

  const goals = plannable.filter((w) => w.guidance.isGoalOriented).sort(byRank);
  for (const w of goals) attempt(w, 'goal');

  // Genuinely infeasible targets never enter capacity allocation.
  const allocatable = plannable
    .filter((w) => !w.guidance.isGoalOriented)
    .sort(byRank) // rank numbers must never depend on context.targets order
    .filter((w) => {
      if (feasibilityWith(w, w.baseCandidates).isFeasible) return true;
      attempt(w, isAccessory(w) ? 'accessory' : 'identity');
      return false;
    });
  const identityTargets = allocatable.filter((w) => !isAccessory(w)).sort(byRank);
  for (const w of identityTargets) {
    if (w.target.parentRegion && !representedRegions.has(w.target.parentRegion)) attempt(w, 'identity_primary');
  }
  for (const w of identityTargets) if (!attempted.has(w)) attempt(w, 'identity');
  for (const w of allocatable.filter(isAccessory).sort(byRank)) attempt(w, 'accessory');

  // ---- 6. final capacity, candidate lists and per-target reservations ----
  const final = capacityFor(planned);
  for (const w of working) {
    if (planned.has(w.key)) {
      const { kept, excluded } = splitCandidates(w, planned);
      const reservation = final.perTarget.get(w.key)!;
      w.plan.candidates = kept;
      w.plan.excludedCandidates = excluded;
      w.plan.reservedExerciseSlots = reservation.slots;
      w.plan.sharedSlotsWith = reservation.sharedWith;
    } else if (w.plan.status !== 'ineligible') {
      w.plan.candidates = w.baseCandidates; // informational only
    }
    const sumCeilings = w.plan.candidates.reduce((s, c) => s + c.ceiling, 0);
    const cap = w.guidance.directSetsPerExposureCap;
    w.plan.legalMaximumSets = cap != null ? Math.min(cap, sumCeilings) : sumCeilings;
    if (w.plan.feasible === null && w.plan.status !== 'ineligible' && w.guidance.feasibility) w.plan.feasible = w.guidance.feasibility.isFeasible;
  }

  // ---- 7. session identity minimum (the validator's own rule) ----
  const caps = sessionRealismCapFor(purpose, [...planned].map(idOf));
  const requiredTargets = purpose !== null && expected.size > 0 ? Math.min(MIN_EXPECTED_COVERAGE_TARGETS, expected.size) : 0;
  const allocationOrder = working.filter((w) => w.plan.rank !== null).sort((a, b) => a.plan.rank! - b.plan.rank!);
  const covering = allocationOrder
    .filter((w) => planned.has(w.key) && expected.has(w.target.targetId) && final.perTarget.get(w.key)!.reachSets >= MEANINGFUL_COVERAGE_MIN_SETS)
    .slice(0, requiredTargets);
  for (const w of covering) w.plan.plannedMinimumSets = Math.max(w.plan.hardMinimumSets, MEANINGFUL_COVERAGE_MIN_SETS);
  const identitySatisfied = covering.length >= requiredTargets;
  if (!identitySatisfied) refusals.push({ code: 'IDENTITY_MINIMUM_UNSATISFIABLE', targetIds: covering.map((w) => w.target.targetId) });

  // ---- 8. flex capacity and per-target extra slots ----
  const flexExerciseSlots = Math.max(0, caps.maxExercises - final.exerciseSlots);
  const absLeft = caps.absExerciseShareMax === null ? Number.POSITIVE_INFINITY : caps.absExerciseShareMax - final.absSlots;
  const legLeft = caps.legExerciseShareMax === null ? Number.POSITIVE_INFINITY : caps.legExerciseShareMax - final.legSlots;
  for (const w of working) {
    if (!planned.has(w.key)) continue;
    let extra = Math.min(w.plan.candidates.length - w.plan.reservedExerciseSlots, flexExerciseSlots);
    if (isAbs(w.target.targetId)) extra = Math.min(extra, absLeft);
    if (isLeg(w.target.targetId)) extra = Math.min(extra, legLeft);
    w.plan.availableExtraSlots = Math.max(0, extra);
  }

  // ---- 9. informational notes ----
  for (const w of allocationOrder) {
    if (w.plan.status === 'infeasible') {
      const all = w.baseCandidates.reduce((s, c) => s + c.ceiling, 0);
      const best = w.guidance.directSetsPerExposureCap != null ? Math.min(w.guidance.directSetsPerExposureCap, all) : all;
      notes.push(`${w.target.targetId}: infeasible — credited authored exercises reach at most ${best} of the ${w.plan.adequacyThreshold}-set adequacy floor`);
    } else if (w.plan.status === 'deferred') {
      notes.push(`${w.target.targetId}: deferred — ${w.plan.reason}`);
    }
  }
  for (const g of final.groups.filter((g) => g.targetIds.length > 1)) {
    notes.push(`shared capacity: ${g.targetIds.join(' + ')} need ${g.exerciseSlots} exercise slot(s) together`);
  }
  for (const r of refusals) notes.push(`refusal ${r.code}: ${r.targetIds.join(', ') || '(none)'}`);

  const statusOrder: PlannedTargetStatus[] = ['required', 'selected', 'deferred', 'infeasible', 'recovery_excused', 'outside_identity', 'unassessed', 'ineligible'];
  const targets = working
    .map((w) => w.plan)
    .sort((a, b) =>
      a.rank !== null && b.rank !== null
        ? a.rank - b.rank
        : a.rank !== null
          ? -1
          : b.rank !== null
            ? 1
            : statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || a.key.localeCompare(b.key)
    );

  return {
    schemaVersion: SESSION_PLAN_SCHEMA_VERSION,
    targetDate: context.targetDate,
    purpose,
    contextHash: context.contextHash,
    caps: { maxExercises: caps.maxExercises, maxTargets: caps.maxTargets, absExerciseShareMax: caps.absExerciseShareMax, legExerciseShareMax: caps.legExerciseShareMax },
    reserved: { exerciseSlots: final.exerciseSlots, targetSlots: planned.size, absExerciseSlots: final.absSlots, legExerciseSlots: final.legSlots },
    capacityGroups: final.groups,
    flexExerciseSlots,
    identityMinimum: { requiredTargets, coveringTargetIds: covering.map((w) => w.target.targetId), satisfied: identitySatisfied },
    refusals,
    targets,
    notes,
  };
}

/** A bounded, single-line-JSON-friendly summary of a plan for the shadow-mode server log. */
export function summarizeSessionPlanForLog(plan: SessionPlan): Record<string, unknown> {
  const MAX_IDS = 8;
  const ranked = plan.targets.filter((t) => t.status !== 'ineligible');
  return {
    event: 'session_plan_shadow',
    schemaVersion: plan.schemaVersion,
    targetDate: plan.targetDate,
    purpose: plan.purpose,
    contextHash: plan.contextHash,
    caps: plan.caps,
    reserved: plan.reserved,
    capacityGroups: plan.capacityGroups.slice(0, 20),
    flexExerciseSlots: plan.flexExerciseSlots,
    identityMinimum: plan.identityMinimum,
    refusals: plan.refusals,
    targets: ranked.map((t) => ({
      id: t.targetId,
      status: t.status,
      tier: t.tier,
      rank: t.rank,
      reserved: t.reservedExerciseSlots,
      sharedWith: t.sharedSlotsWith.slice(0, MAX_IDS),
      extra: t.availableExtraSlots,
      min: t.plannedMinimumSets,
      rec: [t.recommendedSessionSets.min, t.recommendedSessionSets.max],
      max: t.legalMaximumSets,
      candidates: t.candidates.slice(0, MAX_IDS).map((c) => `${c.exerciseId}:${c.ceiling}`),
      excluded: t.excludedCandidates.slice(0, MAX_IDS).map((c) => c.exerciseId),
    })),
    ineligibleTargetIds: plan.targets.filter((t) => t.status === 'ineligible').map((t) => t.targetId),
    notes: boundDiagnosticIssues(plan.notes),
  };
}
