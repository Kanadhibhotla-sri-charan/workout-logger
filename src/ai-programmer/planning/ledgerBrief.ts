// Weekly ledger drives the session (step 2, 2026-10-27; owner: "if the old
// way is clearly falling short, why not change now"). With
// AI_WEEKLY_LEDGER_MODE=on the weekly ledger rewrites the generation
// context's programming brief, so the planner, the validators, adequacy
// completion and the AI all read one rule:
//   must      expected today; minimum = the ledger's sets for today
//             (goal muscles may exceed Blueprint's per-session maximum);
//             the validator floor is MUST_ADEQUACY_TOLERANCE of it, not half
//   can_wait  expected today, planned after every must (only while the
//             session holds under 22 sets per 60 minutes), at an even
//             share of what is left this week
//   done      (met, or left to compound work) not expected today; a met
//             goal stops being a required goal for this session
// A volume group (chest) is one muscle: its ask goes to ONE region today,
// the one furthest behind (its own must first, else the largest
// volume_share); the other regions are done for today unless their own
// minimum share is due. Another sub-region (triceps long head) follows its
// parent's status. Targets the ledger does not know keep the previous
// behaviour.
// A goal muscle whose ask its exercises cannot hold at their usual sets
// (isolations get 2) may take up to GOAL_EXERCISE_MAX_SETS on each
// exercise that works it directly (2026-11-09: brachialis has three such
// exercises, 2 x 3 = 6 < the 7 a Pull day needs, so it ran 5-8 of 14 a
// week). Only then: a goal its exercises already hold keeps 2 per exercise.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { volumeChildren, volumeParentOf } from '../../blueprint/volumeTargets.js';
import { aiWeeklyLedgerMode } from '../provider/config.js';
import { computeTargetFeasibility } from '../context/targetFeasibility.js';
import { hashContext } from '../context/programmerContextDiagnostics.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance } from '../context/programmerContextTypes.js';
import { adequacyToleranceFor } from '../validation/programmerAdequacyValidator.js';
import { planSession } from './sessionPlanner.js';
import { planSessionTime } from './sessionTime.js';
import { planFlexibilityBlock } from '../../athletic/flexibility.js';
import { buildWeeklyLedger, type LedgerEntry, type WeeklyLedger } from './weeklyLedger.js';

export type WeeklyStatus = 'must' | 'can_wait' | 'done';

/** Most sets one direct exercise of a goal muscle may take when the usual
 * sets cannot hold the goal's ask. */
export const GOAL_EXERCISE_MAX_SETS = 3;

/** A must target may fall at most 20% short of today's sets. */
export const MUST_ADEQUACY_TOLERANCE = 0.8;

const VOLATILE_KEYS = ['contextId', 'contextHash', 'generatedAt', 'diagnostics'] as const;

function statusOf(entry: LedgerEntry | undefined): WeeklyStatus | null {
  if (!entry || entry.status === 'not_today') return null;
  return entry.status === 'must' ? 'must' : entry.status === 'can_wait' ? 'can_wait' : 'done';
}

const rankOf = (s: WeeklyStatus | null) => (s === 'must' ? 0 : s === 'can_wait' ? 1 : s === 'done' ? 2 : 3);
const best = (...s: (WeeklyStatus | null)[]) => [...s].sort((a, b) => rankOf(a) - rankOf(b))[0] ?? null;

/** Today's sets for an entry: the must amount, or an even share of what is left. */
function askOf(entry: LedgerEntry | undefined): number | null {
  const status = statusOf(entry);
  if (!entry || status === 'done' || status === null) return null;
  return status === 'must' ? Math.ceil(entry.mustSetsToday) : Math.ceil(entry.remaining / (entry.laterSessions + 1));
}

/** The context with its brief rewritten from the weekly ledger (and its
 * contextHash recomputed over the new content). */
export function applyWeeklyLedger(context: AIProgrammerContext, ledger: WeeklyLedger, reductions: ReadonlyMap<string, number> = new Map()): AIProgrammerContext {
  const byId = new Map(ledger.entries.map((e) => [e.targetId, e]));
  const targetsByKey = new Map(context.targets.map((t) => [`${t.targetType}:${t.targetId}`, t]));
  /** Targets whose direct exercises were allowed GOAL_EXERCISE_MAX_SETS. */
  const raised = new Map<string, AIProgrammerContext['targets'][number]>();
  const statusById = new Map<string, WeeklyStatus>();
  const eligible = new Set(context.programmingBrief.muscles.filter((m) => m.eligibleForThisSession).map((m) => m.targetId));
  const groupIds = new Set(BlueprintAdapter.listVolumeGroups().map((g) => g.id));
  /** Per volume group: the region that carries the group's ask today. */
  const carrierOf = new Map<string, string>();
  for (const groupId of groupIds) {
    const children = volumeChildren(groupId).filter((c) => eligible.has(c.id));
    const pick = [...children].sort(
      (a, b) => rankOf(statusOf(byId.get(a.id))) - rankOf(statusOf(byId.get(b.id))) || (b.volumeShare ?? 0) - (a.volumeShare ?? 0) || a.id.localeCompare(b.id)
    )[0];
    if (pick) carrierOf.set(groupId, pick.id);
  }

  const muscles = context.programmingBrief.muscles.map((m): AIProgrammerMuscleGuidance => {
    if (m.targetType !== 'physique_target' || !m.eligibleForThisSession) return m;
    const own = byId.get(m.targetId);
    const parentId = volumeParentOf(m.targetId);
    const parent = parentId !== m.targetId ? byId.get(parentId) : undefined;
    const ownStatus = statusOf(own);
    let status: WeeklyStatus | null;
    let ask: number | null;
    if (groupIds.has(parentId)) {
      const carrier = carrierOf.get(parentId) === m.targetId;
      status = carrier ? best(ownStatus, statusOf(parent)) : ownStatus === 'must' ? 'must' : parent || own ? 'done' : null;
      ask = carrier ? Math.max(askOf(own) ?? 0, askOf(parent) ?? 0) || null : ownStatus === 'must' ? askOf(own) : null;
    } else {
      status = best(ownStatus, statusOf(parent));
      ask = askOf(own);
    }
    if (status === null) return m;
    statusById.set(m.targetId, status);

    let min = m.recommendedSessionSets.min;
    if (ask !== null) min = ask;
    const reduction = reductions.get(m.targetId) ?? 0;
    if (reduction > 0) min = Math.max(Math.min(m.recommendedSessionSets.min, min), min - reduction);
    const isGoal = m.isGoalOriented && status !== 'done';
    let cap = m.directSetsPerExposureCap;
    if (cap != null && min > cap) {
      if (isGoal) cap = min;
      else min = cap;
    }
    let target = targetsByKey.get(`${m.targetType}:${m.targetId}`);
    const adequacyTolerance = m.adequacyTolerance ?? (own && ownStatus === 'must' ? MUST_ADEQUACY_TOLERANCE : undefined);
    const feasibilityAt = (n: number) => (target ? computeTargetFeasibility(target, context.targets, n, cap, adequacyToleranceFor({ adequacyTolerance })) : undefined);
    if (isGoal && target && feasibilityAt(min)?.isFeasible === false) {
      const more = {
        ...target,
        validExercises: target.validExercises.map((v) =>
          v.role === 'primary' && v.authoredPrescription && v.authoredPrescription.sets < GOAL_EXERCISE_MAX_SETS ? { ...v, authoredPrescription: { ...v.authoredPrescription, sets: GOAL_EXERCISE_MAX_SETS } } : v
        ),
      };
      if (more.validExercises.some((v, i) => v !== target!.validExercises[i])) {
        target = more;
        raised.set(`${m.targetType}:${m.targetId}`, more);
      }
    }
    // More than this session's credited exercises can deliver (e.g. a goal's
    // whole remaining week on its last day): ask for the most they can,
    // never a number the planner must refuse. The rest shows as behind.
    let feasibility = feasibilityAt(min);
    while (feasibility && !feasibility.isFeasible && min > 1) feasibility = feasibilityAt(--min);
    const max = Math.max(m.recommendedSessionSets.max, min);
    return {
      ...m,
      ...(adequacyTolerance !== undefined ? { adequacyTolerance } : {}),
      isGoalOriented: isGoal,
      directSetsPerExposureCap: cap,
      recommendedSessionSets: { min, max },
      weeklyStatus: status,
      ...(feasibility ? { feasibility } : {}),
    };
  });

  const expectedCoverageTargetIds = context.programmingBrief.session.expectedCoverageTargetIds.filter((id) => statusById.get(id) !== 'done');
  const { contextId, generatedAt, diagnostics } = context;
  const content = Object.fromEntries(Object.entries(context).filter(([k]) => !(VOLATILE_KEYS as readonly string[]).includes(k))) as Omit<AIProgrammerContext, (typeof VOLATILE_KEYS)[number]>;
  const rewritten = {
    ...content,
    targets: context.targets.map((t) => raised.get(`${t.targetType}:${t.targetId}`) ?? t),
    programmingBrief: { ...context.programmingBrief, muscles, session: { ...context.programmingBrief.session, expectedCoverageTargetIds } },
  };
  return { ...rewritten, contextId, contextHash: hashContext(rewritten), generatedAt, diagnostics };
}

/** applyWeeklyLedger, lowering a goal's ask one set at a time while the
 * session plan refuses it (its credited exercises cannot deliver that
 * many alongside today's other targets), never below its original
 * minimum. */
export function applyWeeklyLedgerPlannable(context: AIProgrammerContext, ledger: WeeklyLedger, initialReductions: ReadonlyMap<string, number> = new Map()): AIProgrammerContext {
  const reductions = new Map<string, number>(initialReductions);
  const minOf = (ctx: AIProgrammerContext, id: string) => ctx.programmingBrief.muscles.find((m) => m.targetId === id)?.recommendedSessionSets.min ?? 0;
  let applied = applyWeeklyLedger(context, ledger, reductions);
  for (;;) {
    const refused = planSession(applied).refusals.filter((r) => r.code === 'REQUIRED_GOAL_INFEASIBLE' || r.code === 'REQUIRED_GOAL_EXCEEDS_CAPACITY').flatMap((r) => r.targetIds);
    const next = new Map(reductions);
    for (const id of refused) next.set(id, (next.get(id) ?? 0) + 1);
    const lowered = applyWeeklyLedger(context, ledger, next);
    if (!refused.some((id) => minOf(lowered, id) < minOf(applied, id))) return applied;
    for (const [id, n] of next) reductions.set(id, n);
    applied = lowered;
  }
}

/** The generation context, rewritten from the weekly ledger when
 * AI_WEEKLY_LEDGER_MODE=on; unchanged otherwise. A ledger failure is
 * logged and generation falls back to the unchanged context. */
export function withWeeklyLedger(db: Database.Database, context: AIProgrammerContext): AIProgrammerContext {
  if (aiWeeklyLedgerMode() !== 'on') return context;
  try {
    const ledger = buildWeeklyLedger(db, context);
    const timed = withSessionTime(db, context, applyWeeklyLedger(context, ledger));
    return applyWeeklyLedgerPlannable(timed.context, ledger, timed.reductions);
  } catch (err) {
    console.warn('[ai-programmer] weekly ledger not applied', JSON.stringify({ targetDate: context.targetDate, error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
    return context;
  }
}

/** Today's due sets from a ledger-rewritten brief: goal muscles and the
 * other "must" muscles. A sub-region whose parent is itself in the brief
 * (triceps long head) is counted through its parent. */
export function dueSets(context: AIProgrammerContext): { goalSets: number; otherMust: Array<{ targetId: string; sets: number }> } {
  const muscles = context.programmingBrief.muscles.filter((m) => m.eligibleForThisSession && m.targetType === 'physique_target');
  const ids = new Set(muscles.map((m) => m.targetId));
  let goalSets = 0;
  const otherMust: Array<{ targetId: string; sets: number }> = [];
  for (const m of muscles) {
    const parent = volumeParentOf(m.targetId);
    if (parent !== m.targetId && ids.has(parent)) continue;
    if (m.weeklyStatus !== 'must') continue;
    if (m.isGoalOriented) goalSets += m.recommendedSessionSets.min;
    else otherMust.push({ targetId: m.targetId, sets: m.recommendedSessionSets.min });
  }
  return { goalSets, otherMust };
}

/** The session time budget (planning/sessionTime.ts) for a ledger-rewritten
 * context: decides the add-on, the flexibility block's length and the sets
 * "can wait" muscles may take, and returns the context with the budget (and
 * a shortened flexibility block) in its brief, plus the set reductions for
 * non-goal "must" muscles when even the maximum length is passed. */
export function withSessionTime(db: Database.Database, original: AIProgrammerContext, applied: AIProgrammerContext): { context: AIProgrammerContext; reductions: Map<string, number> } {
  const purpose = original.programmingBrief.session.purpose;
  const { goalSets, otherMust } = dueSets(applied);
  const flex = original.programmingBrief.flexibilityBlock;
  const time = planSessionTime({
    aimMinutes: original.profile.defaultSessionDurationMinutes,
    maxMinutes: original.profile.maximumSessionDurationMinutes,
    goalSets,
    otherMustSets: otherMust.reduce((sum, m) => sum + m.sets, 0),
    flexibilityMinutes: flex?.minutes ?? 0,
    addOnMinutes: original.programmingBrief.athleticAddOn?.minutes ?? 0,
    addOnChosen: original.programmingBrief.athleticAddOn?.chosen === true,
    fixedMinutes: original.programmingBrief.shoulderCare?.minutes ?? 0,
  });
  let flexibilityBlock = flex;
  if (flex && time.flexibilityMinutes < flex.minutes) {
    const shorter = planFlexibilityBlock(db, original.targetDate, purpose, time.flexibilityMinutes * 60);
    flexibilityBlock = shorter ? { minutes: shorter.minutes, reason: shorter.reason, drills: [...shorter.warmup, ...shorter.cooldown].map((e) => e.exerciseId) } : undefined;
  }
  // Past the maximum: one set at a time off the largest non-goal must.
  const reductions = new Map<string, number>();
  const left = otherMust.map((m) => ({ ...m }));
  for (let n = 0; n < time.otherMustSetsToCut; n++) {
    const largest = left.filter((m) => m.sets > 1).sort((a, b) => b.sets - a.sets || a.targetId.localeCompare(b.targetId))[0];
    if (!largest) break;
    largest.sets -= 1;
    reductions.set(largest.targetId, (reductions.get(largest.targetId) ?? 0) + 1);
  }
  const { contextId, generatedAt, diagnostics } = original;
  const content = Object.fromEntries(Object.entries(original).filter(([k]) => !(VOLATILE_KEYS as readonly string[]).includes(k))) as Omit<AIProgrammerContext, (typeof VOLATILE_KEYS)[number]>;
  const { flexibilityBlock: _old, ...brief } = original.programmingBrief;
  const rewritten = { ...content, programmingBrief: { ...brief, ...(flexibilityBlock ? { flexibilityBlock } : {}), sessionTime: time } };
  return { context: { ...rewritten, contextId, contextHash: hashContext(rewritten), generatedAt, diagnostics }, reductions };
}
