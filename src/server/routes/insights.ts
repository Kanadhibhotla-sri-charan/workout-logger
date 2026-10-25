// Insights API (2026-10-11): read-only facts from logged data; no AI, no
// writes. GET /api/insights?date=YYYY-MM-DD (default: today).

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { isValidCalendarDate } from '../../engine/dateMath.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { WeeklyProgramRepo } from '../../repositories/weeklyProgramRepo.js';
import { athleticWork, consistency, deloadHistory, goalCheckIns, strengthProgress, volumeHistory, type WeekRequirement } from '../../insights/insightsService.js';
import { addDays } from '../../engine/dateMath.js';
import { liveTargetAllocations } from './programming.js';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { LEDGER_CYCLE_DAYS, volumeOverview } from '../../ai-programmer/planning/weeklyLedger.js';
import { aiWeeklyLedgerAnchor } from '../../ai-programmer/provider/config.js';

export const insightsRouter = Router();

/** GET /api/insights/volume (2026-10-25): each muscle's progress toward
 * its weekly (goal) or 14-day cycle (non-goal) number — the weekly
 * volume ledger, read-only (docs/WEEKLY_VOLUME_PLANNING_DESIGN.md). */
insightsRouter.get('/volume', (req, res) => {
  const database = db(req);
  const today = todayForUser(database);
  const overview = volumeOverview(database, today, aiWeeklyLedgerAnchor());
  const name = (id: string) => BlueprintAdapter.getTarget(id)?.name ?? id;
  res.json({
    today,
    goals: overview.goals,
    muscles: overview.entries
      .filter((e) => !overview.paused.includes(e.targetId))
      .map((e) => ({
        targetId: e.targetId,
        name: name(e.targetId),
        isGoal: e.basis === 'week',
        basis: e.basis,
        number: e.number,
        done: e.done,
        remaining: e.remaining,
        windowStart: e.windowStart,
        windowEnd: e.windowEnd,
        windowDay: e.windowDay,
        windowLength: e.basis === 'week' ? 7 : LEDGER_CYCLE_DAYS,
        overdue: e.status === 'overdue',
        behind: e.behind,
      })),
  });
});

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db as Database.Database;
}

/** Volume history window, in programming weeks (current week included). */
export const INSIGHTS_WEEKS = 6;

// A finished week's requirement never changes; computing it runs the
// planner, so it is cached per database.
const pastWeekCache = new WeakMap<Database.Database, Map<string, WeekRequirement>>();

/** A week's per-target requirement: the saved week program's allocations
 * when one exists, else the planner as of the week's start (the same
 * figures the Program page's goals panel shows). */
export function weekRequirement(database: Database.Database, weekStart: string, currentWeekStart: string): WeekRequirement {
  const cache = pastWeekCache.get(database) ?? pastWeekCache.set(database, new Map()).get(database)!;
  const cached = weekStart < currentWeekStart ? cache.get(weekStart) : undefined;
  if (cached) return cached;
  const saved = new WeeklyProgramRepo(database).getByWeekStart(weekStart)?.target_allocations as
    | Array<{ target_type: string; target_id: string; requiredDirectSets: number; goal_label?: string | null }>
    | null
    | undefined;
  const allocations = Array.isArray(saved) && saved.length > 0 ? saved : liveTargetAllocations(database, weekStart);
  const physique = allocations.filter((a) => a.target_type === 'physique_target');
  const result: WeekRequirement = {
    required: new Map(physique.map((a) => [a.target_id, a.requiredDirectSets])),
    goalLabel: new Map(physique.map((a) => [a.target_id, a.goal_label ?? null])),
  };
  if (weekStart < currentWeekStart) cache.set(weekStart, result);
  return result;
}

insightsRouter.get('/', (req, res) => {
  const database = db(req);
  const asOf = typeof req.query.date === 'string' ? req.query.date : todayForUser(database);
  if (!isValidCalendarDate(asOf)) {
    return res.status(400).json({ error: 'date must be a real calendar date in YYYY-MM-DD format' });
  }
  const currentWeekStart = programmingWeekStart(todayForUser(database));
  res.json({
    asOf,
    strength: strengthProgress(database, asOf),
    volume: volumeHistory(database, asOf, INSIGHTS_WEEKS, (weekStart) => weekRequirement(database, weekStart, currentWeekStart)),
    consistency: consistency(database, asOf, INSIGHTS_WEEKS),
    goalCheckIns: goalCheckIns(database, asOf),
    athletic: athleticWork(database, asOf, INSIGHTS_WEEKS),
    deloads: deloadHistory(database, addDays(currentWeekStart, -7 * (INSIGHTS_WEEKS - 1)), asOf),
  });
});
