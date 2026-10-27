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

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { volumeChildren, volumeParentOf } from '../../blueprint/volumeTargets.js';
import { aiWeeklyLedgerMode } from '../provider/config.js';
import { computeTargetFeasibility } from '../context/targetFeasibility.js';
import { hashContext } from '../context/programmerContextDiagnostics.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance } from '../context/programmerContextTypes.js';
import { adequacyToleranceFor } from '../validation/programmerAdequacyValidator.js';
import { planSession } from './sessionPlanner.js';
import { buildWeeklyLedger, type LedgerEntry, type WeeklyLedger } from './weeklyLedger.js';

export type WeeklyStatus = 'must' | 'can_wait' | 'done';

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
    const target = targetsByKey.get(`${m.targetType}:${m.targetId}`);
    const adequacyTolerance = m.adequacyTolerance ?? (own && ownStatus === 'must' ? MUST_ADEQUACY_TOLERANCE : undefined);
    const feasibilityAt = (n: number) => (target ? computeTargetFeasibility(target, context.targets, n, cap, adequacyToleranceFor({ adequacyTolerance })) : undefined);
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
    programmingBrief: { ...context.programmingBrief, muscles, session: { ...context.programmingBrief.session, expectedCoverageTargetIds } },
  };
  return { ...rewritten, contextId, contextHash: hashContext(rewritten), generatedAt, diagnostics };
}

/** applyWeeklyLedger, lowering a goal's ask one set at a time while the
 * session plan refuses it (its credited exercises cannot deliver that
 * many alongside today's other targets), never below its original
 * minimum. */
export function applyWeeklyLedgerPlannable(context: AIProgrammerContext, ledger: WeeklyLedger): AIProgrammerContext {
  const reductions = new Map<string, number>();
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
    return applyWeeklyLedgerPlannable(context, buildWeeklyLedger(db, context));
  } catch (err) {
    console.warn('[ai-programmer] weekly ledger not applied', JSON.stringify({ targetDate: context.targetDate, error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
    return context;
  }
}
