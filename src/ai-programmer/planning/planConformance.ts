// Plan conformance (Phase 3, 2026-09-29): the deterministic normalization
// that makes an AI proposal respect the SessionPlan's structural
// decisions before the existing repair / domain / completion / adequacy
// pipeline runs. It only ever REMOVES whole targets or non-crediting
// entries — it never invents an exercise, never adds volume, never
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
//      can still fill it), remove whole OPTIONAL targets, lowest plan
//      priority first. Required goals are never removed.
// A target the plan does not know at all is left untouched, so domain
// validation still rejects an unknown or invented target.

import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext } from '../context/programmerContextTypes.js';
import { creditedTargetKeys, keyOf } from '../validation/sharedCredit.js';
import { boundDiagnosticIssues } from '../validation/diagnosticsBounds.js';
import type { SessionPlan, TargetPlan } from './sessionPlanner.js';

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

  // ---- rule 3: planned capacity, dropping whole optional targets lowest-priority first ----
  const presentKeys = () => new Set(exercises.map(keyOfEntry));
  const capacityNeed = () => {
    const present = presentKeys();
    let total = 0;
    let abs = 0;
    let legs = 0;
    const counted = new Set<string>();
    for (const g of plan.capacityGroups) {
      const members = g.targetIds.map((id) => [...planByKey.values()].find((t) => t.targetId === id)!);
      if (!members.some((m) => present.has(m.key))) continue;
      const labelled = exercises.filter((e) => members.some((m) => m.key === keyOfEntry(e))).length;
      const need = Math.max(labelled, g.exerciseSlots);
      total += need;
      if (g.targetIds.some((id) => ABS_PHYSIQUE_TARGETS.includes(id))) abs += need;
      if (g.targetIds.some((id) => LEGS_PHYSIQUE_TARGETS.includes(id))) legs += need;
      for (const m of members) counted.add(m.key);
    }
    total += exercises.filter((e) => !counted.has(keyOfEntry(e))).length; // entries outside any group (unknown targets)
    const creditedTargets = new Set<string>();
    for (const e of exercises) for (const k of creditedTargetKeys(e, context.targets)) creditedTargets.add(k);
    return { total, abs, legs, targets: creditedTargets.size };
  };
  for (;;) {
    const need = capacityNeed();
    const caps = sessionRealismCapFor(plan.purpose, [...presentKeys()].map((k) => k.slice(k.indexOf(':') + 1)));
    const fits =
      need.total <= caps.maxExercises &&
      need.targets <= caps.maxTargets &&
      (caps.absExerciseShareMax === null || need.abs <= caps.absExerciseShareMax) &&
      (caps.legExerciseShareMax === null || need.legs <= caps.legExerciseShareMax);
    if (fits) break;
    const present = presentKeys();
    const optional = plan.targets
      .filter((t) => t.status === 'selected' && present.has(t.key) && t.rank !== null)
      .sort((a, b) => b.rank! - a.rank!);
    const drop = optional[0];
    if (!drop) break; // only required goals left: nothing conformance may remove — validators decide
    const dropped = exercises.filter((e) => keyOfEntry(e) === drop.key);
    exercises = exercises.filter((e) => keyOfEntry(e) !== drop.key);
    removedTargetIds.add(drop.targetId);
    notes.push(
      `Plan conformance: removed optional target ${drop.targetId} (${dropped.map((e) => e.exerciseId).join(', ')}) — the proposal exceeded the session's planned capacity (${need.total} exercise slots needed including reserved completion slots, cap ${caps.maxExercises}); lowest plan priority removed first.`
    );
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
