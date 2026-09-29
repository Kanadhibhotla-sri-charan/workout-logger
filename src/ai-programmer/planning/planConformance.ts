// Plan conformance (Phase 3, 2026-09-29): the deterministic normalization
// that makes an AI proposal respect the SessionPlan's structural
// decisions before the existing repair / domain / completion / adequacy
// pipeline runs. It only ever REMOVES whole targets, non-crediting
// entries, or entries beyond a shared group's planned allocation — it never invents an exercise, never adds volume, never
// removes a required active goal, and never touches a validator. A
// proposal that is still inadequate afterwards is rejected exactly as
// before by the unchanged downstream validators.
//
// Rules, in order:
//   1. Remove every entry of a target the plan does not train this
//      session (infeasible, ineligible, recovery-excused, outside the
//      session identity, unassessed, or deferred — the plan's allocation
//      is authoritative, so a deferred target is never swapped in).
//      Whole target, never partial.
//   2. Remove an entry whose exercise does not earn credit for its
//      labelled target, or whose side credit would give work to a target
//      the plan does not train (that target would otherwise be present
//      in the session without its own plan).
//   3. If what remains cannot fit the planned capacity (the session caps,
//      counting each capacity group at its reserved size so completion
//      can still fill it):
//      a. remove whole OPTIONAL targets, lowest plan priority first — but
//         only removals that actually lower the excess and keep every
//         required goal, identity-minimum covering target and represented
//         identity region (a target still credited by what remains is
//         never "removed");
//      b. when no such removal is left, trim a capacity group that uses
//         more entries than its planned allocation back to it, only while
//         every member keeps its plannedMinimumSets and the requirements in
//         (a) hold. If neither applies, nothing more is changed and the
//         unchanged validators decide.
// A target the plan does not know at all is left untouched, so domain
// validation still rejects an unknown or invented target.

import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext } from '../context/programmerContextTypes.js';
import { creditedTargetKeys, keyOf } from '../validation/sharedCredit.js';
import { boundDiagnosticIssues } from '../validation/diagnosticsBounds.js';
import { groupExerciseAllocation, type CapacityGroup, type SessionPlan, type TargetPlan } from './sessionPlanner.js';

export interface ConformanceResult {
  proposal: AIWorkoutSessionProposal;
  notes: string[];
  removedTargetIds: string[];
  removedEntries: number;
}

const isPlanned = (t: TargetPlan | undefined) => t !== undefined && (t.status === 'required' || t.status === 'selected') && t.reservedExerciseSlots > 0;

export function conformProposalToPlan(proposal: AIWorkoutSessionProposal, plan: SessionPlan, context: AIProgrammerContext): ConformanceResult {
  const planByKey = new Map(plan.targets.map((t) => [t.key, t]));
  const notes: string[] = [];
  const removedTargetIds = new Set<string>();
  let exercises: AIWorkoutExerciseProposal[] = [...proposal.exercises];
  const initialCount = exercises.length;
  const keyOfEntry = (e: AIWorkoutExerciseProposal) => keyOf(e.targetType, e.targetId);

  // ---- rule 1: targets the plan does not train this session ----
  for (const [key, t] of planByKey) {
    if (isPlanned(t)) continue;
    const entries = exercises.filter((e) => keyOfEntry(e) === key);
    if (entries.length === 0) continue;
    exercises = exercises.filter((e) => keyOfEntry(e) !== key);
    removedTargetIds.add(t.targetId);
    notes.push(`Plan conformance: removed ${t.targetId} (${entries.map((e) => e.exerciseId).join(', ')}) — the session plan marks it ${t.status.replace('_', '-')} for this session.`);
  }

  // ---- rule 2: entries whose credit the plan cannot accept ----
  exercises = exercises.filter((e) => {
    const key = keyOfEntry(e);
    if (!planByKey.has(key)) return true; // unknown target: left for domain validation to reject
    const credited = creditedTargetKeys(e, context.targets);
    if (!credited.includes(key)) {
      notes.push(`Plan conformance: removed ${e.exerciseId} from ${e.targetId} — it does not earn credit for ${e.targetId} (Blueprint credits it to ${credited.map((k) => k.split(':')[1]).join(', ')}).`);
      return false;
    }
    const uncovered = credited.filter((k) => k !== key && planByKey.has(k) && !isPlanned(planByKey.get(k)));
    if (uncovered.length > 0) {
      notes.push(`Plan conformance: removed ${e.exerciseId} from ${e.targetId} — it also credits ${uncovered.map((k) => k.split(':')[1]).join(', ')}, which the session plan does not train today.`);
      return false;
    }
    return true;
  });

  // ---- rule 3: planned capacity ----
  // Capacity need counts each present capacity group at max(its labelled
  // entries, its reserved slots): a group keeps its reservation while any
  // member is present, so completion can still fill it.
  const targetById = new Map(plan.targets.map((t) => [t.targetId, t]));
  const planned = plan.targets.filter(isPlanned);
  const membersOf = (g: CapacityGroup) => g.targetIds.map((id) => targetById.get(id)!);
  const creditsOf = (e: AIWorkoutExerciseProposal) => creditedTargetKeys(e, context.targets);
  const presentKeys = (exs: readonly AIWorkoutExerciseProposal[]) => new Set(exs.map(keyOfEntry));
  const capacityNeed = (exs: readonly AIWorkoutExerciseProposal[]) => {
    const present = presentKeys(exs);
    let total = 0;
    let abs = 0;
    let legs = 0;
    const counted = new Set<string>();
    for (const g of plan.capacityGroups) {
      const members = membersOf(g);
      if (!members.some((m) => present.has(m.key))) continue;
      const labelled = exs.filter((e) => members.some((m) => m.key === keyOfEntry(e))).length;
      const need = Math.max(labelled, g.exerciseSlots);
      total += need;
      if (g.targetIds.some((id) => ABS_PHYSIQUE_TARGETS.includes(id))) abs += need;
      if (g.targetIds.some((id) => LEGS_PHYSIQUE_TARGETS.includes(id))) legs += need;
      for (const m of members) counted.add(m.key);
    }
    total += exs.filter((e) => !counted.has(keyOfEntry(e))).length; // entries outside any group (unknown targets)
    const creditedTargets = new Set<string>();
    for (const e of exs) for (const k of creditsOf(e)) creditedTargets.add(k);
    const caps = sessionRealismCapFor(plan.purpose, [...present].map((k) => k.slice(k.indexOf(':') + 1)));
    // How far over the session caps this is; 0 = fits.
    const excess =
      Math.max(0, total - caps.maxExercises) +
      Math.max(0, creditedTargets.size - caps.maxTargets) +
      (caps.absExerciseShareMax === null ? 0 : Math.max(0, abs - caps.absExerciseShareMax)) +
      (caps.legExerciseShareMax === null ? 0 : Math.max(0, legs - caps.legExerciseShareMax));
    return { total, excess, maxExercises: caps.maxExercises };
  };

  // The session requirements every capacity action must preserve, all read from the plan:
  // required goals, the identity-minimum covering targets, and every identity region the plan
  // represents (the parent region of a planned target outside the accessory tier).
  const coveringIds = new Set(plan.identityMinimum.coveringTargetIds);
  const regionTargets = planned.filter((t) => t.tier !== 'accessory' && t.parentRegion !== null);
  const representedRegions = [...new Set(regionTargets.map((t) => t.parentRegion!))];
  /** Regions the plan represents that still have a planned (non-accessory) target present. */
  const regionsHeld = (exs: readonly AIWorkoutExerciseProposal[]) => {
    const present = presentKeys(exs);
    return new Set(representedRegions.filter((r) => regionTargets.some((t) => t.parentRegion === r && present.has(t.key))));
  };
  const keepsRegions = (before: ReadonlySet<string>, after: readonly AIWorkoutExerciseProposal[]) => {
    const held = regionsHeld(after);
    return [...before].every((r) => held.has(r));
  };

  /** Sets an entry credits to a target: the AI's sets, never above the plan's ceiling for that exercise. */
  const creditTo = (e: AIWorkoutExerciseProposal, t: TargetPlan) => {
    if (!creditsOf(e).includes(t.key)) return 0;
    const ceiling = planByKey.get(keyOfEntry(e))?.candidates.find((c) => c.exerciseId === e.exerciseId)?.ceiling;
    return ceiling !== undefined ? Math.min(e.sets, ceiling) : e.sets;
  };
  const creditSum = (exs: readonly AIWorkoutExerciseProposal[], t: TargetPlan) => exs.reduce((s, e) => s + creditTo(e, t), 0);

  for (;;) {
    const now = capacityNeed(exercises);
    if (now.excess === 0) break;
    const heldBefore = regionsHeld(exercises);

    // 3a. Whole-target removal of a SELECTED target, lowest plan priority first, among removals
    // that are both useful (the excess actually falls — a member of a group whose reservation
    // another member keeps frees nothing) and legal (not an identity-minimum covering target,
    // not still credited by what remains, and no represented region left without a planned target).
    const removable = plan.targets
      .filter((t) => t.status === 'selected' && t.rank !== null && !coveringIds.has(t.targetId) && presentKeys(exercises).has(t.key))
      .map((t) => ({ t, after: exercises.filter((e) => keyOfEntry(e) !== t.key) }))
      .filter(({ t, after }) => capacityNeed(after).excess < now.excess && !after.some((e) => creditsOf(e).includes(t.key)) && keepsRegions(heldBefore, after))
      .sort((a, b) => b.t.rank! - a.t.rank!);
    const drop = removable[0];
    if (drop) {
      const dropped = exercises.filter((e) => keyOfEntry(e) === drop.t.key);
      exercises = drop.after;
      removedTargetIds.add(drop.t.targetId);
      notes.push(
        `Plan conformance: removed optional target ${drop.t.targetId} (${dropped.map((e) => e.exerciseId).join(', ')}) — the proposal exceeded the session's planned capacity (${now.total} exercise slots needed including reserved completion slots, cap ${now.maxExercises}); lowest plan priority among removals that free capacity and keep every goal, identity target and represented region.`
      );
      continue;
    }

    // 3b. No legal whole-target removal is left: trim a capacity group that uses more entries
    // than its planned allocation back to that allocation. If none can be trimmed legally,
    // conformance stops here and the unchanged validators decide.
    if (!trimOverAllocatedGroup(now.excess, heldBefore)) break;
  }

  /** Trims ONE over-allocated capacity group back to its planned allocation (reserved + its flex
   * share), entry by entry, only while every member keeps its plannedMinimumSets, every required
   * goal and identity-minimum covering target keeps its minimum, and every represented region
   * keeps a planned target. Entry choice is deterministic: the fewest credited member sets lost,
   * then the later-listed entry. Only applied when it reaches the allocation and lowers the excess. */
  function trimOverAllocatedGroup(excessBefore: number, heldBefore: ReadonlySet<string>): boolean {
    const protectedTargets = planned.filter((t) => t.status === 'required' || coveringIds.has(t.targetId));
    const over = plan.capacityGroups
      .map((g, order) => {
        const members = membersOf(g);
        const { reserved, extra } = groupExerciseAllocation(plan, g);
        return { g, order, members, allocation: reserved + extra, entries: exercises.filter((e) => members.some((m) => m.key === keyOfEntry(e))) };
      })
      .filter((x) => x.entries.length > x.allocation)
      .sort((a, b) => b.entries.length - b.allocation - (a.entries.length - a.allocation) || a.order - b.order);

    for (const x of over) {
      let working = exercises;
      let entries = x.entries;
      const trimmed: AIWorkoutExerciseProposal[] = [];
      while (entries.length > x.allocation) {
        const choice = entries
          .map((e) => ({ e, after: working.filter((w) => w !== e), lost: x.members.reduce((s, m) => s + creditTo(e, m), 0), position: working.indexOf(e) }))
          .filter(({ after }) =>
            x.members.every((m) => creditSum(after, m) >= m.plannedMinimumSets) &&
            protectedTargets.every((t) => creditSum(after, t) >= Math.min(t.plannedMinimumSets, creditSum(working, t))) &&
            keepsRegions(heldBefore, after)
          )
          .sort((a, b) => a.lost - b.lost || b.position - a.position)[0];
        if (!choice) break;
        working = choice.after;
        entries = entries.filter((e) => e !== choice.e);
        trimmed.push(choice.e);
      }
      if (entries.length > x.allocation || capacityNeed(working).excess >= excessBefore) continue; // cannot reach the allocation legally
      exercises = working;
      const minimums = x.members.map((m) => `${m.targetId} ${creditSum(exercises, m)}/${m.plannedMinimumSets}`).join(', ');
      notes.push(
        `Plan conformance: trimmed ${trimmed.map((e) => `${e.exerciseId} from ${e.targetId}`).join(', ')} — the ${x.g.targetIds.join(' + ')} group used ${x.entries.length} exercises against its planned allocation of ${x.allocation}; every member keeps at least its planned minimum sets (${minimums}).`
      );
      return true;
    }
    return false;
  }

  const bounded = boundDiagnosticIssues(notes);
  if (exercises.length === initialCount && bounded.length === 0) {
    return { proposal, notes: [], removedTargetIds: [], removedEntries: 0 };
  }
  return {
    proposal: { ...proposal, exercises, warnings: [...proposal.warnings, ...bounded] },
    notes: bounded,
    removedTargetIds: [...removedTargetIds].sort(),
    removedEntries: initialCount - exercises.length,
  };
}
