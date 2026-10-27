// Weekly ledger drives the session (step 2, 2026-10-27; owner: "if the old
// way is clearly falling short, why not change now"). With
// AI_WEEKLY_LEDGER_MODE=on the weekly ledger rewrites the generation
// context's programming brief, so the planner, the validators, adequacy
// completion and the AI all read one rule:
//   must      expected today; minimum = the ledger's sets for today
//             (goal muscles may exceed Blueprint's per-session maximum);
//             the validator floor is MUST_ADEQUACY_TOLERANCE of it, not half
//   can_wait  expected today, planned after every must, at an even share
//             of what is left this week
//   done      (met, or left to compound work) not expected today; a met
//             goal stops being a required goal for this session
// A sub-region with no entry of its own (lower pec) follows its parent's
// status and keeps its existing minimum. Targets the ledger does not know
// keep the previous behaviour.

import type Database from 'better-sqlite3';
import { volumeParentOf } from '../../blueprint/volumeTargets.js';
import { aiWeeklyLedgerMode } from '../provider/config.js';
import { computeTargetFeasibility } from '../context/targetFeasibility.js';
import { hashContext } from '../context/programmerContextDiagnostics.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance } from '../context/programmerContextTypes.js';
import { adequacyToleranceFor } from '../validation/programmerAdequacyValidator.js';
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

/** The context with its brief rewritten from the weekly ledger (and its
 * contextHash recomputed over the new content). */
export function applyWeeklyLedger(context: AIProgrammerContext, ledger: WeeklyLedger): AIProgrammerContext {
  const byId = new Map(ledger.entries.map((e) => [e.targetId, e]));
  const targetsByKey = new Map(context.targets.map((t) => [`${t.targetType}:${t.targetId}`, t]));
  const statusById = new Map<string, WeeklyStatus>();

  const muscles = context.programmingBrief.muscles.map((m): AIProgrammerMuscleGuidance => {
    if (m.targetType !== 'physique_target' || !m.eligibleForThisSession) return m;
    const own = byId.get(m.targetId);
    const parentId = volumeParentOf(m.targetId);
    const parent = parentId !== m.targetId ? byId.get(parentId) : undefined;
    const ownStatus = statusOf(own);
    const status = [ownStatus, statusOf(parent)].sort((a, b) => rankOf(a) - rankOf(b))[0] ?? null;
    if (status === null) return m;
    statusById.set(m.targetId, status);

    let min = m.recommendedSessionSets.min;
    if (own && ownStatus === 'must') min = Math.ceil(own.mustSetsToday);
    else if (own && ownStatus === 'can_wait') min = Math.ceil(own.remaining / (own.laterSessions + 1));
    const isGoal = m.isGoalOriented && status !== 'done';
    let cap = m.directSetsPerExposureCap;
    if (cap != null && min > cap) {
      if (isGoal) cap = min;
      else min = cap;
    }
    const max = Math.max(m.recommendedSessionSets.max, min);
    const target = targetsByKey.get(`${m.targetType}:${m.targetId}`);
    const adequacyTolerance = m.adequacyTolerance ?? (own && ownStatus === 'must' ? MUST_ADEQUACY_TOLERANCE : undefined);
    return {
      ...m,
      ...(adequacyTolerance !== undefined ? { adequacyTolerance } : {}),
      isGoalOriented: isGoal,
      directSetsPerExposureCap: cap,
      recommendedSessionSets: { min, max },
      weeklyStatus: status,
      ...(target ? { feasibility: computeTargetFeasibility(target, context.targets, min, cap, adequacyToleranceFor({ adequacyTolerance })) } : {}),
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

/** The generation context, rewritten from the weekly ledger when
 * AI_WEEKLY_LEDGER_MODE=on; unchanged otherwise. A ledger failure is
 * logged and generation falls back to the unchanged context. */
export function withWeeklyLedger(db: Database.Database, context: AIProgrammerContext): AIProgrammerContext {
  if (aiWeeklyLedgerMode() !== 'on') return context;
  try {
    return applyWeeklyLedger(context, buildWeeklyLedger(db, context));
  } catch (err) {
    console.warn('[ai-programmer] weekly ledger not applied', JSON.stringify({ targetDate: context.targetDate, error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
    return context;
  }
}
