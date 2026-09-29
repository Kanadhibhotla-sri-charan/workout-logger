// Session Planner (shadow mode): invariants and representative snapshots
// over REAL programmer contexts — real Blueprint data, real context
// builder, real goals — across Pull, Push, Upper and Legs.

import { beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { computeTargetFeasibility } from '../../src/ai-programmer/context/targetFeasibility.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance } from '../../src/ai-programmer/context/programmerContextTypes.js';
import { planSession, summarizeSessionPlanForLog, type CapacityGroup, type SessionPlan, type TargetPlan } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { creditedTargetKeys, keyOf } from '../../src/ai-programmer/validation/sharedCredit.js';
import { MEANINGFUL_COVERAGE_MIN_SETS, UNDER_PRESCRIPTION_TOLERANCE } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, SESSION_ACCESSORY_REGIONS } from '../../src/engine/config.js';

const PURPOSES = ['pull', 'push', 'upper', 'legs'] as const;
type Purpose = (typeof PURPOSES)[number];

/** A Tuesday ~2 months ahead: a real clock-relative date (never rots into the past) with a fixed weekday. */
function futureTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 61);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dbWithGoal(blueprintRef: string): Database.Database {
  const db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'],
    other_activity_schedule: [],
  });
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: blueprintRef, priority: 1 });
  return db;
}

// arm-side-thickness (brachialis) and triceps-back-depth (triceps) are the
// user's real production goals; the goal-category guard forbids creating
// both together, so each gets its own database.
const SCENARIOS = ['arm-side-thickness', 'triceps-back-depth'] as const;
const contexts: { scenario: string; purpose: Purpose; context: AIProgrammerContext; plan: SessionPlan }[] = [];

beforeAll(() => {
  const targetDate = futureTuesday();
  for (const scenario of SCENARIOS) {
    const db = dbWithGoal(scenario);
    for (const purpose of PURPOSES) {
      const context = buildProgrammerContext(db, { targetDate, requestedSessionPurpose: purpose });
      contexts.push({ scenario, purpose, context, plan: planSession(context, { nonGoalRotationCursor: 0 }) });
    }
  }
});

const get = (scenario: string, purpose: Purpose) => contexts.find((c) => c.scenario === scenario && c.purpose === purpose)!;
const target = (plan: SessionPlan, targetId: string) => plan.targets.find((t) => t.targetId === targetId)!;
const planned = (plan: SessionPlan) => plan.targets.filter((t) => (t.status === 'required' || t.status === 'selected') && t.reservedExerciseSlots > 0);
const guidanceOf = (context: AIProgrammerContext, t: Pick<TargetPlan, 'targetId'>) => context.programmingBrief.muscles.find((m) => m.targetId === t.targetId)!;
const floorChecked = (context: AIProgrammerContext, g: AIProgrammerMuscleGuidance) =>
  g.eligibleForThisSession && (g.isGoalOriented || context.programmingBrief.session.expectedCoverageTargetIds.includes(g.targetId)) && g.recoveryAdjustment !== 'avoid';
const TIER_ORDER = ['goal', 'identity_primary', 'identity', 'accessory'];
const isAccessoryRegion = (t: TargetPlan) => t.parentRegion === null || SESSION_ACCESSORY_REGIONS.includes(t.parentRegion);

/** Independent check (real crediting function, not planner code): can `size` distinct exercises, each labelled to a
 * group member, meet every member's floor? Credit follows creditedTargetKeys exactly as adequacy validation does. */
function groupCanMeet(context: AIProgrammerContext, plan: SessionPlan, group: CapacityGroup, size: number, floorOf: (t: TargetPlan) => number): boolean {
  const members = group.targetIds.map((id) => target(plan, id));
  const memberKeys = new Set(members.map((m) => m.key));
  const options = members.flatMap((m) =>
    m.candidates.map((c) => ({
      exerciseId: c.exerciseId,
      sets: c.ceiling,
      credits: creditedTargetKeys({ exerciseId: c.exerciseId, targetType: m.targetType, targetId: m.targetId }, context.targets).filter((k) => memberKeys.has(k)),
    }))
  );
  const contribution = (o: (typeof options)[number], m: TargetPlan) => {
    if (!o.credits.includes(m.key)) return 0;
    const cap = guidanceOf(context, m).directSetsPerExposureCap;
    return cap != null ? Math.min(o.sets, cap) : o.sets;
  };
  const search = (start: number, chosen: typeof options): boolean => {
    if (chosen.length === size) return members.every((m) => chosen.reduce((s, o) => s + contribution(o, m), 0) >= floorOf(m));
    for (let i = start; i < options.length; i++) {
      if (chosen.some((o) => o.exerciseId === options[i]!.exerciseId)) continue;
      if (search(i + 1, [...chosen, options[i]!])) return true;
    }
    return false;
  };
  return search(0, []);
}

describe('session planner invariants (every real scenario × purpose)', () => {
  it('1 & 4. no planned target is infeasible; no infeasible target is planned', () => {
    for (const { plan } of contexts) {
      for (const t of planned(plan)) expect(t.feasible, `${plan.purpose}:${t.targetId}`).toBe(true);
      for (const t of plan.targets.filter((t) => t.status === 'infeasible')) expect(t.reservedExerciseSlots).toBe(0);
    }
  });

  it('2. every capacity group meets every member\'s planned minimum with exactly its reserved slots — and no fewer slots suffice', () => {
    for (const { context, plan } of contexts) {
      for (const group of plan.capacityGroups) {
        const label = `${plan.purpose}: ${group.targetIds.join('+')}`;
        expect(groupCanMeet(context, plan, group, group.exerciseSlots, (t) => t.plannedMinimumSets), label).toBe(true);
        if (group.exerciseSlots > 1) expect(groupCanMeet(context, plan, group, group.exerciseSlots - 1, (t) => t.adequacyThreshold), `${label} minimal`).toBe(false);
      }
      for (const t of planned(plan)) expect(t.plannedMinimumSets).toBeGreaterThanOrEqual(t.hardMinimumSets);
    }
  });

  it('every planned target is in exactly one capacity group, and multi-target groups exist only through genuine side credit', () => {
    for (const { plan } of contexts) {
      const plannedIds = planned(plan).map((t) => t.targetId).sort();
      expect(plan.capacityGroups.flatMap((g) => g.targetIds).sort()).toEqual(plannedIds);
      for (const g of plan.capacityGroups.filter((g) => g.targetIds.length > 1)) {
        const members = g.targetIds.map((id) => target(plan, id));
        for (const m of members) {
          const linked = m.candidates.some((c) => c.sideCredits.some((k) => members.some((o) => o.key === k)));
          const linkedFrom = members.some((o) => o !== m && o.candidates.some((c) => c.sideCredits.includes(m.key)));
          expect(linked || linkedFrom, `${plan.purpose}: ${m.targetId} in ${g.targetIds.join('+')}`).toBe(true);
        }
      }
    }
  });

  it('3. required active goals are planned whenever eligible and feasible — never silently deferred', () => {
    for (const { context, plan } of contexts) {
      for (const g of context.programmingBrief.muscles.filter((m) => m.isGoalOriented && m.eligibleForThisSession && m.recoveryAdjustment !== 'avoid')) {
        const t = target(plan, g.targetId);
        expect(t.status, `${plan.purpose}:${g.targetId}`).not.toBe('deferred');
        const namedInRefusal = plan.refusals.some((r) => r.targetIds.includes(g.targetId));
        expect(t.status === 'required' && t.reservedExerciseSlots > 0 ? true : namedInRefusal, `${plan.purpose}:${g.targetId}`).toBe(true);
      }
    }
  });

  it('5. recovery-excused, ineligible and outside-identity targets never receive reserved capacity', () => {
    for (const { plan } of contexts) {
      for (const t of plan.targets.filter((t) => ['recovery_excused', 'ineligible', 'outside_identity', 'unassessed'].includes(t.status))) {
        expect(t.reservedExerciseSlots).toBe(0);
        expect(t.availableExtraSlots).toBe(0);
      }
    }
  });

  it('6, 7 & 8. physical exercise slots, targets, abs and leg exercises stay within the session caps', () => {
    for (const { plan } of contexts) {
      const groupSlots = (pred: (g: CapacityGroup) => boolean) => plan.capacityGroups.filter(pred).reduce((s, g) => s + g.exerciseSlots, 0);
      expect(plan.reserved.exerciseSlots).toBe(groupSlots(() => true));
      expect(plan.reserved.exerciseSlots).toBeLessThanOrEqual(plan.caps.maxExercises);
      expect(plan.reserved.targetSlots).toBe(planned(plan).length);
      expect(planned(plan).length).toBeLessThanOrEqual(plan.caps.maxTargets);
      expect(plan.flexExerciseSlots).toBe(plan.caps.maxExercises - plan.reserved.exerciseSlots);
      if (plan.caps.absExerciseShareMax !== null) expect(groupSlots((g) => g.targetIds.some((id) => ABS_PHYSIQUE_TARGETS.includes(id)))).toBeLessThanOrEqual(plan.caps.absExerciseShareMax);
      if (plan.caps.legExerciseShareMax !== null) expect(groupSlots((g) => g.targetIds.some((id) => LEGS_PHYSIQUE_TARGETS.includes(id)))).toBeLessThanOrEqual(plan.caps.legExerciseShareMax);
      for (const t of planned(plan)) expect(t.availableExtraSlots).toBeLessThanOrEqual(plan.flexExerciseSlots);
    }
  });

  it('9. every candidate is authored and actually earns credit for its target', () => {
    let checked = 0;
    for (const { context, plan } of contexts) {
      for (const t of plan.targets) {
        const ctxTarget = context.targets.find((x) => x.targetId === t.targetId)!;
        const cap = guidanceOf(context, t).directSetsPerExposureCap;
        for (const c of t.candidates) {
          const authored = ctxTarget.validExercises.find((v) => v.exerciseId === c.exerciseId)?.authoredPrescription;
          expect(authored, `${t.targetId}:${c.exerciseId}`).toBeTruthy();
          expect(c.ceiling).toBeLessThanOrEqual(authored!.sets);
          if (cap != null) expect(c.ceiling).toBeLessThanOrEqual(cap);
          expect(creditedTargetKeys({ exerciseId: c.exerciseId, targetType: t.targetType, targetId: t.targetId }, context.targets)).toContain(t.key);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('10. side credit never creates an obligation the plan cannot satisfy', () => {
    for (const { context, plan } of contexts) {
      const plannedKeys = new Set(planned(plan).map((t) => t.key));
      for (const t of planned(plan)) {
        for (const c of t.candidates) {
          for (const sideKey of c.sideCredits) {
            const g = context.programmingBrief.muscles.find((m) => keyOf(m.targetType, m.targetId) === sideKey);
            if (!g) continue;
            if (floorChecked(context, g)) expect(plannedKeys.has(sideKey), `${plan.purpose}: ${c.exerciseId} for ${t.targetId} side-credits ${sideKey}`).toBe(true);
            else if (!g.eligibleForThisSession) expect(c.ceiling).toBeLessThanOrEqual(MEANINGFUL_COVERAGE_MIN_SETS);
          }
        }
      }
    }
  });

  it('11. deterministic and pure: same plan twice, same plan with targets reordered, input never mutated', () => {
    for (const { context, plan } of contexts) {
      const before = JSON.stringify(context);
      expect(planSession(context, { nonGoalRotationCursor: 0 })).toEqual(plan);
      const reordered = { ...context, targets: [...context.targets].reverse(), programmingBrief: { ...context.programmingBrief, muscles: [...context.programmingBrief.muscles].reverse() } };
      expect(planSession(reordered, { nonGoalRotationCursor: 0 })).toEqual(plan);
      expect(JSON.stringify(context)).toBe(before);
    }
  });

  it('12. the session identity minimum is guaranteed by planned expected targets', () => {
    for (const { context, plan } of contexts) {
      expect(plan.identityMinimum.satisfied, String(plan.purpose)).toBe(true);
      expect(plan.identityMinimum.coveringTargetIds.length).toBeGreaterThanOrEqual(plan.identityMinimum.requiredTargets);
      for (const id of plan.identityMinimum.coveringTargetIds) {
        const t = target(plan, id);
        expect(context.programmingBrief.session.expectedCoverageTargetIds).toContain(id);
        expect(t.reservedExerciseSlots).toBeGreaterThan(0);
        expect(t.plannedMinimumSets).toBeGreaterThanOrEqual(MEANINGFUL_COVERAGE_MIN_SETS);
      }
    }
  });

  it('13. deferred targets stay whole: no reserved or extra capacity at all', () => {
    for (const { plan } of contexts) {
      for (const t of plan.targets.filter((t) => t.status === 'deferred')) {
        expect(t.reservedExerciseSlots).toBe(0);
        expect(t.availableExtraSlots).toBe(0);
      }
    }
  });

  it('14. an unshared reservation only offers candidates that can reach the planned minimum within its reserved slots', () => {
    let narrowed = 0;
    for (const { plan } of contexts) {
      for (const t of planned(plan).filter((t) => t.sharedSlotsWith.length === 0)) {
        const label = `${plan.purpose}:${t.targetId}`;
        for (const c of t.candidates) {
          const others = t.candidates.filter((o) => o !== c).map((o) => o.ceiling).sort((a, b) => b - a).slice(0, t.reservedExerciseSlots - 1);
          expect(c.ceiling + others.reduce((s, x) => s + x, 0), `${label} ${c.exerciseId}`).toBeGreaterThanOrEqual(t.plannedMinimumSets);
        }
        for (const e of t.excludedCandidates.filter((e) => e.reason === 'below_minimum')) {
          expect(t.candidates.map((c) => c.exerciseId), label).not.toContain(e.exerciseId);
          narrowed++;
        }
      }
    }
    expect(narrowed).toBeGreaterThan(0);
  });

  it('14. Legs: hamstrings with one slot and a 3-set minimum never offers a 2-set leg curl', () => {
    for (const scenario of SCENARIOS) {
      const hamstrings = target(get(scenario, 'legs').plan, 'hamstrings');
      if (hamstrings.reservedExerciseSlots !== 1 || hamstrings.plannedMinimumSets < 3) continue;
      expect(hamstrings.candidates.every((c) => c.ceiling >= 3)).toBe(true);
      expect(hamstrings.candidates.map((c) => c.exerciseId)).toContain('romanian-deadlift');
    }
  });
});

describe('session planner — contested candidate ownership', () => {
  /** Exercise ids listed for more than one planned target, where some listing target does not get credit from another's label. */
  const labelOnlyShared = (plan: SessionPlan) => {
    const listers = new Map<string, TargetPlan[]>();
    for (const t of planned(plan)) for (const c of t.candidates) listers.set(c.exerciseId, [...(listers.get(c.exerciseId) ?? []), t]);
    return [...listers.entries()].filter(([id, ts]) =>
      ts.length > 1 && ts.some((a) => ts.some((b) => a !== b && !a.candidates.find((c) => c.exerciseId === id)!.sideCredits.includes(b.key)))
    );
  };

  it('no planned target is offered an exercise that another planned target also lists by label only', () => {
    for (const { plan } of contexts) expect(labelOnlyShared(plan).map(([id]) => `${plan.purpose}:${id}`)).toEqual([]);
  });

  it('Pull: lat-width and back-thickness each own their contested rows — no exercise listed for both', () => {
    for (const scenario of SCENARIOS) {
      const plan = get(scenario, 'pull').plan;
      const back = target(plan, 'back-thickness');
      const lat = target(plan, 'lat-width');
      expect(back.candidates.map((c) => c.exerciseId).sort()).toEqual(['chest-supported-row', 'seated-cable-row']);
      expect(lat.candidates.map((c) => c.exerciseId).sort()).toEqual(['lat-pulldown-wide-pronated', 'straight-arm-pulldown']);
      expect(back.excludedCandidates).toContainEqual({ exerciseId: 'lat-pulldown-wide-pronated', reason: 'owned_elsewhere', uncoveredSideTargets: [], ownerTargetId: 'lat-width' });
      expect(lat.excludedCandidates.filter((e) => e.reason === 'owned_elsewhere').map((e) => [e.exerciseId, e.ownerTargetId]).sort()).toEqual([
        ['chest-supported-row', 'back-thickness'],
        ['seated-cable-row', 'back-thickness'],
      ]);
      // Both keep the capacity to reach adequacy with their own reserved slots.
      for (const t of [back, lat]) {
        expect(t.status).toBe('selected');
        const reach = t.candidates.map((c) => c.ceiling).sort((a, b) => b - a).slice(0, t.reservedExerciseSlots).reduce((s, x) => s + x, 0);
        expect(reach, t.targetId).toBeGreaterThanOrEqual(t.plannedMinimumSets);
        expect(t.legalMaximumSets).toBeGreaterThanOrEqual(t.adequacyThreshold);
      }
      const ownership = plan.notes.filter((n) => n.startsWith('ownership:'));
      for (const [id, owner] of [['chest-supported-row', 'back-thickness'], ['lat-pulldown-wide-pronated', 'lat-width'], ['seated-cable-row', 'back-thickness']]) {
        expect(ownership.some((n) => n.startsWith(`ownership: ${id} is used for ${owner} `)), id).toBe(true);
      }
    }
  });

  it('ownership is deterministic: repeated planning and reordered targets give the same assignment', () => {
    for (const { context, plan } of contexts) {
      const lists = (p: SessionPlan) => JSON.stringify(p.targets.map((t) => [t.targetId, t.candidates.map((c) => c.exerciseId), t.excludedCandidates]));
      const reordered: AIProgrammerContext = { ...context, targets: [...context.targets].reverse() };
      expect(lists(planSession(context, { nonGoalRotationCursor: 0 }))).toBe(lists(plan));
      expect(lists(planSession(reordered, { nonGoalRotationCursor: 0 }))).toBe(lists(plan));
    }
  });

  it('genuine shared credit stays available to every target it credits (overhead extensions, cable-fly)', () => {
    const push = get('triceps-back-depth', 'push').plan;
    for (const id of ['cable-overhead-extension-leaning-forward', 'overhead-triceps-extension']) {
      for (const t of ['triceps', 'triceps-long-head']) expect(target(push, t).candidates.map((c) => c.exerciseId), `${t}/${id}`).toContain(id);
    }
    const pecs = ['lower-pec', 'mid-pec', 'upper-pec'].map((id) => target(push, id)).filter((t) => planned(push).includes(t));
    expect(pecs.length).toBeGreaterThan(1);
    for (const t of pecs) expect(t.candidates.map((c) => c.exerciseId), t.targetId).toContain('cable-fly');
    for (const { plan } of contexts) for (const t of plan.targets) for (const e of t.excludedCandidates.filter((e) => e.reason === 'owned_elsewhere')) {
      // an owned-elsewhere exclusion is only ever a label-only listing
      const owner = target(plan, e.ownerTargetId!);
      expect(owner.candidates.find((c) => c.exerciseId === e.exerciseId)!.sideCredits.includes(t.key) && t.candidates.find((c) => c.exerciseId === e.exerciseId) !== undefined).toBe(false);
    }
  });

  it('ownership never makes a target infeasible or deferred: the same targets are planned, each still reaching its minimum', () => {
    for (const { plan } of contexts) {
      for (const t of plan.targets.filter((t) => t.excludedCandidates.some((e) => e.reason === 'owned_elsewhere'))) {
        expect(isPlannedTarget(t), `${plan.purpose}:${t.targetId}`).toBe(true);
        expect(t.feasible).toBe(true);
        if (t.sharedSlotsWith.length === 0) {
          const reach = t.candidates.map((c) => c.ceiling).sort((a, b) => b - a).slice(0, t.reservedExerciseSlots).reduce((s, x) => s + x, 0);
          expect(reach, `${plan.purpose}:${t.targetId}`).toBeGreaterThanOrEqual(t.plannedMinimumSets);
        }
      }
    }
  });
});

const isPlannedTarget = (t: TargetPlan) => (t.status === 'required' || t.status === 'selected') && t.reservedExerciseSlots > 0;

describe('session identity priority', () => {
  it('capacity is handed out goal → identity (one per region first) → identity → accessory, never out of tier order', () => {
    for (const { plan } of contexts) {
      const allocated = plan.targets.filter((t) => t.rank !== null && t.status !== 'infeasible').sort((a, b) => a.rank! - b.rank!);
      const tiers = allocated.map((t) => TIER_ORDER.indexOf(t.tier!));
      expect(tiers, String(plan.purpose)).toEqual([...tiers].sort((a, b) => a - b));
      for (const t of allocated) expect(t.tier === 'accessory', `${plan.purpose}:${t.targetId}`).toBe(!t.isGoal && isAccessoryRegion(t));
    }
  });

  it('an accessory target is never planned while a feasible identity target is deferred ahead of it', () => {
    for (const { plan } of contexts) {
      const deferredIdentity = plan.targets.filter((t) => t.status === 'deferred' && (t.tier === 'identity' || t.tier === 'identity_primary'));
      const plannedAccessories = planned(plan).filter((t) => t.tier === 'accessory');
      for (const a of plannedAccessories) for (const d of deferredIdentity) expect(a.rank!, `${plan.purpose}: ${a.targetId} vs ${d.targetId}`).toBeGreaterThan(d.rank!);
    }
  });

  it('every identity region with a feasible target is represented before any region gets a second target', () => {
    for (const { plan } of contexts) {
      const regions = new Set(plan.targets.filter((t) => t.rank !== null && t.feasible && !isAccessoryRegion(t)).map((t) => t.parentRegion));
      for (const region of regions) {
        expect(planned(plan).some((t) => t.parentRegion === region), `${plan.purpose}: region ${region}`).toBe(true);
      }
    }
  });

  it('Legs: quads is planned with its two required exercise slots, not deferred behind cheaper targets', () => {
    for (const scenario of SCENARIOS) {
      const quads = target(get(scenario, 'legs').plan, 'quads');
      expect(quads.status).toBe('selected');
      expect(quads.reservedExerciseSlots).toBe(2);
      expect(quads.tier).toBe('identity_primary');
    }
  });

  it('Upper: back, chest and shoulders are each planned; forearms get no capacity while identity targets are deferred', () => {
    for (const scenario of SCENARIOS) {
      const plan = get(scenario, 'upper').plan;
      for (const region of ['back', 'chest', 'shoulders']) expect(planned(plan).some((t) => t.parentRegion === region), `${scenario}: ${region}`).toBe(true);
      const identityDeferred = plan.targets.some((t) => t.status === 'deferred' && !isAccessoryRegion(t));
      if (identityDeferred) {
        for (const id of ['forearm-flexors', 'forearm-extensors']) expect(target(plan, id).status, `${scenario}: ${id}`).not.toBe('selected');
      }
    }
  });
});

describe('session planner — shared-credit capacity', () => {
  it('Push: triceps and triceps-long-head form one capacity group whose exercise need is computed jointly', () => {
    const plan = get('triceps-back-depth', 'push').plan;
    const group = plan.capacityGroups.find((g) => g.targetIds.includes('triceps'))!;
    expect(group.targetIds).toEqual(['triceps', 'triceps-long-head']);
    expect(target(plan, 'triceps-long-head').sharedSlotsWith).toContain('triceps');
  });

  it('one shared exercise fills one slot for every target it credits (floors lowered so a single overhead extension covers both)', () => {
    const base = get('triceps-back-depth', 'push').context;
    const lowered = (id: string) => {
      const t = base.targets.find((x) => x.targetId === id)!;
      const g = guidanceOf(base, { targetId: id });
      return { ...g, recommendedSessionSets: { min: 4, max: 4 }, feasibility: computeTargetFeasibility(t, base.targets, 4, g.directSetsPerExposureCap, UNDER_PRESCRIPTION_TOLERANCE) };
    };
    const context: AIProgrammerContext = {
      ...base,
      programmingBrief: {
        ...base.programmingBrief,
        muscles: base.programmingBrief.muscles.map((m) => (m.targetId === 'triceps' || m.targetId === 'triceps-long-head' ? lowered(m.targetId) : m)),
      },
    };
    const plan = planSession(context, { nonGoalRotationCursor: 0 });
    const group = plan.capacityGroups.find((g) => g.targetIds.includes('triceps'))!;
    // Separately each needs 1 exercise (2 slots); one overhead extension credits both.
    expect(group.exerciseSlots).toBe(1);
    expect(target(plan, 'triceps').reservedExerciseSlots).toBe(1);
    expect(target(plan, 'triceps-long-head').reservedExerciseSlots).toBe(1);
    expect(target(plan, 'triceps').sharedSlotsWith).toEqual(['triceps-long-head']);
    expect(groupCanMeet(context, plan, group, 1, (t) => t.plannedMinimumSets)).toBe(true);
  });

  it('exercises listed for two targets but credited by label only never share a slot (back, calves, abs stay separate)', () => {
    for (const { plan } of contexts) {
      for (const pair of [['lat-width', 'back-thickness'], ['gastrocnemius', 'soleus'], ['obliques', 'rectus-abdominis']]) {
        expect(plan.capacityGroups.some((g) => pair.every((id) => g.targetIds.includes(id))), `${plan.purpose}: ${pair.join('+')}`).toBe(false);
      }
    }
  });
});

describe('session planner — specific real cases', () => {
  it('Pull: upper-traps is infeasible (its only authored exercise caps at 2 sets vs a 4-set floor)', () => {
    for (const scenario of SCENARIOS) {
      const t = target(get(scenario, 'pull').plan, 'upper-traps');
      expect(t.status).toBe('infeasible');
      expect(t.legalMaximumSets).toBeLessThan(t.adequacyThreshold);
    }
    expect(get('arm-side-thickness', 'pull').plan.notes.some((n) => n.startsWith('upper-traps: infeasible'))).toBe(true);
  });

  it('Pull: the validated reference shape — brachialis, both large back targets with two slots each, rear-delt', () => {
    const plan = get('arm-side-thickness', 'pull').plan;
    expect(target(plan, 'brachialis-arm-thickness').status).toBe('required');
    for (const id of ['lat-width', 'back-thickness', 'rear-delt']) {
      expect(target(plan, id).status, id).toBe('selected');
      expect(target(plan, id).reservedExerciseSlots, id).toBe(2);
    }
  });

  it('Push and Upper: front-delt infeasibility is represented, never selected', () => {
    for (const scenario of SCENARIOS) {
      for (const purpose of ['push', 'upper'] as const) {
        const t = target(get(scenario, purpose).plan, 'front-delt');
        expect(t.status).toBe('infeasible');
        expect(t.feasible).toBe(false);
        expect(t.reservedExerciseSlots).toBe(0);
      }
    }
  });

  it('Legs: calf targets list only exercises that credit them (no seated raise for gastrocnemius, no standing raise for soleus)', () => {
    for (const scenario of SCENARIOS) {
      const plan = get(scenario, 'legs').plan;
      expect(target(plan, 'gastrocnemius').candidates.map((c) => c.exerciseId)).not.toContain('seated-calf-raise');
      expect(target(plan, 'soleus').candidates.map((c) => c.exerciseId)).not.toContain('standing-calf-raise');
      expect(target(plan, 'gastrocnemius').candidates.length).toBeGreaterThan(0);
      expect(target(plan, 'soleus').candidates.length).toBeGreaterThan(0);
    }
  });

  it('Brachialis: never offered barbell-ez-bar-curl; hammer-curl only when its biceps side credit is covered', () => {
    for (const purpose of ['pull', 'upper'] as const) {
      const plan = get('arm-side-thickness', purpose).plan;
      const brachialis = target(plan, 'brachialis-arm-thickness');
      expect(brachialis.status).toBe('required');
      expect(brachialis.candidates.map((c) => c.exerciseId)).not.toContain('barbell-ez-bar-curl');
      const bicepsPlanned = planned(plan).some((t) => t.targetId === 'biceps');
      const hasHammer = brachialis.candidates.some((c) => c.exerciseId === 'hammer-curl');
      expect(hasHammer).toBe(bicepsPlanned);
      if (!bicepsPlanned) expect(brachialis.excludedCandidates.map((c) => c.exerciseId)).toContain('hammer-curl');
    }
  });

  it('Required goals are planned first, never deferred', () => {
    expect(target(get('triceps-back-depth', 'push').plan, 'triceps')).toMatchObject({ status: 'required', tier: 'goal', rank: 0 });
    expect(target(get('arm-side-thickness', 'pull').plan, 'brachialis-arm-thickness')).toMatchObject({ status: 'required', tier: 'goal', rank: 0 });
  });
});

describe('session planner — refusal and exclusion paths (real contexts, one field changed)', () => {
  const withGuidance = (context: AIProgrammerContext, targetId: string, patch: Partial<AIProgrammerMuscleGuidance>, specialization?: boolean): AIProgrammerContext => ({
    ...context,
    targets: specialization === undefined ? context.targets : context.targets.map((t) => (t.targetId === targetId ? { ...t, isSpecialization: specialization } : t)),
    programmingBrief: {
      ...context.programmingBrief,
      muscles: context.programmingBrief.muscles.map((m) => (m.targetId === targetId ? { ...m, ...patch } : m)),
    },
  });

  it('an infeasible active goal is refused (REQUIRED_GOAL_INFEASIBLE), never weakened or partially planned', () => {
    const context = withGuidance(get('arm-side-thickness', 'pull').context, 'upper-traps', { isGoalOriented: true }, true);
    const plan = planSession(context, { nonGoalRotationCursor: 0 });
    expect(target(plan, 'upper-traps').status).toBe('infeasible');
    expect(target(plan, 'upper-traps').reservedExerciseSlots).toBe(0);
    expect(plan.refusals).toContainEqual({ code: 'REQUIRED_GOAL_INFEASIBLE', targetIds: ['upper-traps'] });
  });

  it('goals that cannot all fit are refused (REQUIRED_GOAL_EXCEEDS_CAPACITY), never deferred', () => {
    let context = get('arm-side-thickness', 'upper').context;
    for (const m of context.programmingBrief.muscles.filter((m) => m.eligibleForThisSession && m.feasibility?.isFeasible)) {
      context = withGuidance(context, m.targetId, { isGoalOriented: true }, true);
    }
    const plan = planSession(context, { nonGoalRotationCursor: 0 });
    const refused = plan.refusals.filter((r) => r.code === 'REQUIRED_GOAL_EXCEEDS_CAPACITY').flatMap((r) => r.targetIds);
    expect(refused.length).toBeGreaterThan(0);
    for (const id of refused) expect(target(plan, id).status).toBe('required');
    expect(plan.targets.filter((t) => t.isGoal && t.status === 'deferred')).toEqual([]);
    expect(plan.reserved.exerciseSlots).toBeLessThanOrEqual(plan.caps.maxExercises);
  });

  it('a recovery-excused target is never planned', () => {
    const context = withGuidance(get('arm-side-thickness', 'pull').context, 'back-thickness', { recoveryAdjustment: 'avoid' });
    const t = target(planSession(context, { nonGoalRotationCursor: 0 }), 'back-thickness');
    expect(t.status).toBe('recovery_excused');
    expect(t.reservedExerciseSlots).toBe(0);
  });
});

describe('session planner — representative snapshots', () => {
  const projection = (plan: SessionPlan) => ({
    purpose: plan.purpose,
    caps: plan.caps,
    reserved: plan.reserved,
    capacityGroups: plan.capacityGroups,
    flexExerciseSlots: plan.flexExerciseSlots,
    identityMinimum: plan.identityMinimum,
    refusals: plan.refusals,
    targets: plan.targets
      .filter((t) => t.status !== 'ineligible')
      .map((t) => ({
        id: t.targetId,
        status: t.status,
        tier: t.tier,
        rank: t.rank,
        reserved: t.reservedExerciseSlots,
        sharedWith: t.sharedSlotsWith,
        extra: t.availableExtraSlots,
        min: t.plannedMinimumSets,
        max: t.legalMaximumSets,
        candidates: t.candidates.map((c) => `${c.exerciseId}:${c.ceiling}`),
        excluded: t.excludedCandidates.map((c) => c.exerciseId),
      })),
  });

  for (const scenario of SCENARIOS) {
    for (const purpose of PURPOSES) {
      it(`${scenario} / ${purpose}`, () => {
        expect(projection(get(scenario, purpose).plan)).toMatchSnapshot();
      });
    }
  }
});

describe('shadow log summary', () => {
  it('is bounded and carries only plan data', () => {
    for (const { plan } of contexts) {
      const summary = summarizeSessionPlanForLog(plan);
      const json = JSON.stringify(summary);
      expect(json.length).toBeLessThan(20_000);
      expect(summary.event).toBe('session_plan_shadow');
      for (const t of summary.targets as { candidates: string[]; excluded: string[] }[]) {
        expect(t.candidates.length).toBeLessThanOrEqual(8);
        expect(t.excluded.length).toBeLessThanOrEqual(8);
      }
    }
  });
});
