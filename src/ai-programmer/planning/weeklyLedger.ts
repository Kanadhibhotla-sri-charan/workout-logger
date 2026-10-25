// Weekly volume ledger (2026-10-25, docs/WEEKLY_VOLUME_PLANNING_DESIGN.md).
//
// Owner rules: growth decides the numbers, not frequency. Goal muscles
// get their Complete-package number every calendar week and are planned
// on every suitable day. Non-goal muscles get their Efficient-package
// number over a cycle of up to LEDGER_CYCLE_DAYS days; each muscle runs
// its own cycle, and the moment its number is reached (direct sets 1.0 +
// secondary 0.33, the engine's own exposure units) the next cycle starts.
// A cycle not finished by day 14 keeps counting (the shortfall is not
// wiped) and is offered first.
//
// For today's session each target gets a status:
//   must      goal muscle (D2), or more still needed than the later
//             suitable days before its window ends can hold
//   can_wait  still needed, later days can hold it
//   overdue   non-goal cycle past day 14, still short (offered first)
//   met       goal muscle with this week's number reached
//   not_today not compatible with today's purpose, or paused
//
// computeLedger is pure; buildWeeklyLedger reads the logged sessions and
// the coming schedule. Shadow mode only logs the result.

import type Database from 'better-sqlite3';
import { WEEKDAYS, type Weekday } from '../../contracts/types.js';
import type { SessionPurpose } from '../../engine/config.js';
import { addDays, daysBetween } from '../../engine/dateMath.js';
import { calculateExerciseExposure } from '../../engine/exposureEngine.js';
import { isTargetCompatibleWithPurpose } from '../../engine/sessionPurpose.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { athleticPaused } from '../../athletic/athleticSession.js';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { getPackageForTarget } from '../../blueprint/developmentPackages.js';
import { getSubTargetExerciseIds } from '../../blueprint/subTargetExerciseScope.js';
import { getPreferredFrequencyReference } from '../../coaching/profiles/muscleProfileService.js';
import type { AIProgrammerContext } from '../context/programmerContextTypes.js';
import { weekGymDays } from '../service/weekGeneration.js';

export const LEDGER_SCHEMA_VERSION = 'weekly-ledger.v1' as const;
export const LEDGER_CYCLE_DAYS = 14;
/** How far back a weekday's most recent real purpose is looked up. */
export const LEDGER_PURPOSE_LOOKBACK_DAYS = 21;

export type LedgerStatus = 'must' | 'can_wait' | 'overdue' | 'met' | 'not_today';

export interface LedgerTargetInput {
  targetId: string;
  isGoal: boolean;
  /** Weekly (goal) or per-cycle (non-goal) set number; null = no package. */
  reference: number | null;
  /** Blueprint per-session maximum; null = none authored. */
  perSessionCap: number | null;
  eligibleToday: boolean;
  paused: boolean;
}

export interface LedgerFutureDay {
  date: string;
  purpose: SessionPurpose;
}

export interface LedgerInput {
  targetDate: string;
  anchor: string;
  targets: readonly LedgerTargetInput[];
  /** Exposure units per date per target id, for dates before targetDate. */
  dailyExposure: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Gym days after targetDate (any horizon; filtered per window). */
  futureDays: readonly LedgerFutureDay[];
}

export interface LedgerEntry {
  targetId: string;
  basis: 'week' | 'cycle';
  number: number;
  windowStart: string;
  windowEnd: string;
  /** 1-based day of the window today falls on. */
  windowDay: number;
  done: number;
  remaining: number;
  laterSessions: number;
  laterCapacity: number;
  status: LedgerStatus;
  /** Sets that must happen today so the window can still be met (must only). */
  mustSetsToday: number;
  /** Share of the window elapsed minus share of the number done (higher = further behind). */
  behind: number;
  reason: string;
}

export interface WeeklyLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  targetDate: string;
  anchor: string;
  entries: LedgerEntry[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function sumExposure(daily: LedgerInput['dailyExposure'], targetId: string, from: string, toExclusive: string): number {
  let total = 0;
  for (const [date, byTarget] of daily) if (date >= from && date < toExclusive) total += byTarget.get(targetId) ?? 0;
  return total;
}

/** The current cycle of a non-goal target: walk the logged days from the
 * anchor; each time the running total reaches the number, the next cycle
 * starts the following day (any excess does not carry over). */
export function currentCycle(daily: LedgerInput['dailyExposure'], targetId: string, number: number, anchor: string, targetDate: string): { start: string; done: number } {
  const dates = [...daily.keys()].filter((d) => d >= anchor && d < targetDate).sort();
  let start = anchor;
  let done = 0;
  for (const date of dates) {
    done += daily.get(date)!.get(targetId) ?? 0;
    if (number > 0 && done >= number) {
      start = addDays(date, 1);
      done = 0;
    }
  }
  return { start, done };
}

export function computeLedger(input: LedgerInput): WeeklyLedger {
  const weekStart = programmingWeekStart(input.targetDate);
  const entries: LedgerEntry[] = [];
  for (const t of input.targets) {
    if (t.reference == null || t.reference <= 0) continue;
    const basis = t.isGoal ? 'week' : 'cycle';
    let windowStart: string;
    let done: number;
    if (t.isGoal) {
      windowStart = weekStart;
      done = sumExposure(input.dailyExposure, t.targetId, weekStart, input.targetDate);
    } else {
      const cycle = currentCycle(input.dailyExposure, t.targetId, t.reference, input.anchor, input.targetDate);
      windowStart = cycle.start > input.targetDate ? input.targetDate : cycle.start;
      done = cycle.done;
    }
    const windowEnd = addDays(windowStart, (t.isGoal ? 7 : LEDGER_CYCLE_DAYS) - 1);
    const windowDay = daysBetween(windowStart, input.targetDate) + 1;
    const remaining = Math.max(0, t.reference - done);
    const later = t.paused
      ? []
      : input.futureDays.filter((d) => d.date > input.targetDate && d.date <= windowEnd && isTargetCompatibleWithPurpose('physique_target', t.targetId, d.purpose));
    const perSession = t.perSessionCap ?? t.reference;
    const laterCapacity = later.length * perSession;
    const windowLength = t.isGoal ? 7 : LEDGER_CYCLE_DAYS;
    const behind = round2(Math.min(windowDay, windowLength) / windowLength - (t.reference > 0 ? (t.reference - remaining) / t.reference : 1));
    const overdue = !t.isGoal && input.targetDate > windowEnd && remaining > 0;

    let status: LedgerStatus;
    let mustSetsToday = 0;
    let reason: string;
    if (t.paused || !t.eligibleToday) {
      status = 'not_today';
      reason = t.paused ? 'paused (injury pause)' : "not compatible with today's session";
    } else if (remaining <= 0) {
      status = 'met';
      reason = `this week's ${t.reference} reached`;
    } else if (overdue) {
      status = 'overdue';
      reason = `cycle day ${windowDay} of ${LEDGER_CYCLE_DAYS}, ${round2(remaining)} still needed`;
    } else if (t.isGoal) {
      status = 'must';
      mustSetsToday = Math.min(perSession, Math.ceil(remaining / (later.length + 1)));
      reason = `goal muscle: ${round2(remaining)} left this week over ${later.length + 1} suitable day(s)`;
    } else if (remaining > laterCapacity) {
      status = 'must';
      mustSetsToday = Math.min(perSession, Math.ceil(remaining - laterCapacity));
      reason = `${round2(remaining)} needed by ${windowEnd}; later days hold only ${laterCapacity}`;
    } else {
      status = 'can_wait';
      reason = `${round2(remaining)} needed by ${windowEnd}; ${later.length} later suitable day(s) hold ${laterCapacity}`;
    }
    entries.push({
      targetId: t.targetId,
      basis,
      number: t.reference,
      windowStart,
      windowEnd,
      windowDay,
      done: round2(done),
      remaining: round2(remaining),
      laterSessions: later.length,
      laterCapacity,
      status,
      mustSetsToday,
      behind,
      reason,
    });
  }
  const order: LedgerStatus[] = ['must', 'overdue', 'can_wait', 'met', 'not_today'];
  entries.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.behind - a.behind || a.targetId.localeCompare(b.targetId));
  return { schemaVersion: LEDGER_SCHEMA_VERSION, targetDate: input.targetDate, anchor: input.anchor, entries };
}

// ---------------------------------------------------------------- reads

/** Exposure units per date per physique target from completed sessions
 * in [from, toExclusive). Unknown (non-Blueprint) exercises are skipped. */
export function readDailyExposure(db: Database.Database, from: string, toExclusive: string): Map<string, Map<string, number>> {
  const rows = db
    .prepare(
      `SELECT s.date AS date, we.id AS weId, we.exercise_id AS exerciseId,
              (SELECT COUNT(*) FROM workout_sets ws WHERE ws.workout_exercise_id = we.id AND ws.completed = 1) AS done
         FROM workout_sessions s JOIN workout_exercises we ON we.workout_session_id = s.session_id
        WHERE s.status = 'completed' AND s.date >= ? AND s.date < ?`
    )
    .all(from, toExclusive) as Array<{ date: string; weId: string; exerciseId: string; done: number }>;
  const daily = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.done <= 0) continue;
    let contributions;
    try {
      contributions = calculateExerciseExposure(r.exerciseId, Array.from({ length: r.done }, () => ({ completed: true }))).contributions;
    } catch {
      continue;
    }
    const day = daily.get(r.date) ?? new Map<string, number>();
    for (const c of contributions) {
      if (c.target_type !== 'physique_target') continue;
      day.set(c.target_id, (day.get(c.target_id) ?? 0) + c.exposure_units);
    }
    daily.set(r.date, day);
  }
  return daily;
}

const isPurpose = (v: unknown): v is SessionPurpose => v === 'push' || v === 'pull' || v === 'legs' || v === 'upper' || v === 'athletic';

/** The purpose the user really trained on each weekday lately: the
 * committed AI proposal's first focus word, most recent first. */
function recentPurposeByWeekday(db: Database.Database, targetDate: string): Map<Weekday, SessionPurpose> {
  const rows = db
    .prepare(
      `SELECT target_date AS date, weekday, json_extract(proposal_json, '$.sessionFocus[0]') AS focus, json_extract(proposal_json, '$.sessionKind') AS kind
         FROM ai_program_proposals WHERE status = 'committed' AND target_date >= ? AND target_date < ? ORDER BY target_date DESC`
    )
    .all(addDays(targetDate, -LEDGER_PURPOSE_LOOKBACK_DAYS), targetDate) as Array<{ date: string; weekday: string; focus: string | null; kind: string | null }>;
  const out = new Map<Weekday, SessionPurpose>();
  for (const r of rows) {
    const purpose = r.kind === 'athletic' ? 'athletic' : r.focus?.toLowerCase();
    if ((WEEKDAYS as readonly string[]).includes(r.weekday) && isPurpose(purpose) && !out.has(r.weekday as Weekday)) out.set(r.weekday as Weekday, purpose);
  }
  return out;
}

/** Gym days after targetDate through targetDate + horizon: the effective
 * schedule (overrides applied) with the purpose the user has lately
 * trained on that weekday, else the rotation's purpose. An Athletic slot
 * while legs are paused, with no recent purpose, is a rest day. */
export function readFutureDays(db: Database.Database, targetDate: string, horizonDays: number): LedgerFutureDay[] {
  const recent = recentPurposeByWeekday(db, targetDate);
  const paused = athleticPaused(db);
  const end = addDays(targetDate, horizonDays);
  const out: LedgerFutureDay[] = [];
  for (let week = programmingWeekStart(targetDate); week <= end; week = addDays(week, 7)) {
    for (const day of weekGymDays(db, week)) {
      if (day.date <= targetDate || day.date > end) continue;
      const learned = recent.get(day.weekday);
      const purpose = learned ?? day.purpose;
      if (!purpose || (purpose === 'athletic' && paused)) continue;
      out.push({ date: day.date, purpose });
    }
  }
  return out;
}

/** The ledger's own per-muscle number: the package exercises that train
 * this muscle (the sub-target scope where one exists, else the exercise's
 * own Blueprint physique_targets) x the package frequency. The engine's
 * getDevelopmentReference credits every member of the shoulders, back,
 * forearms and core packages with the whole package (found 2026-10-25);
 * the live planner is built on those numbers, so the ledger computes its
 * own until the planner moves onto it. null = the package gives this
 * muscle no exercise (front-delt: left to pressing work). */
export function ledgerReference(targetId: string, isGoal: boolean): { weekly: number; perSession: number } | null {
  const pkg = getPackageForTarget(targetId, isGoal ? 'complete' : 'efficient');
  if (!pkg) return null;
  const scoped = getSubTargetExerciseIds(pkg.id, targetId);
  const trains = (exerciseId: string) => (scoped ? scoped.includes(exerciseId) : (BlueprintAdapter.getExercise(exerciseId)?.physique_targets ?? []).includes(targetId));
  const perSession = pkg.exercises.filter((e) => trains(e.exercise_id)).reduce((sum, e) => sum + e.sets, 0);
  if (perSession <= 0) return null;
  return { weekly: perSession * (getPreferredFrequencyReference(targetId) ?? pkg.frequency.sessions_per_week), perSession };
}

/** The ledger for a built generation context (reads only). */
export function buildWeeklyLedger(db: Database.Database, context: AIProgrammerContext, anchor: string): WeeklyLedger {
  const targetDate = context.targetDate;
  const from = anchor < programmingWeekStart(targetDate) ? anchor : programmingWeekStart(targetDate);
  const targets: LedgerTargetInput[] = context.programmingBrief.muscles
    .filter((m) => m.targetType === 'physique_target')
    .map((m) => ({
      targetId: m.targetId,
      isGoal: m.isGoalOriented,
      reference: ledgerReference(m.targetId, m.isGoalOriented)?.weekly ?? null,
      perSessionCap: ledgerReference(m.targetId, m.isGoalOriented)?.perSession ?? null,
      eligibleToday: m.eligibleForThisSession,
      paused: m.pausedForInjury === true || m.trainedAthletically === true,
    }));
  return computeLedger({
    targetDate,
    anchor,
    targets,
    dailyExposure: readDailyExposure(db, from, targetDate),
    futureDays: readFutureDays(db, targetDate, LEDGER_CYCLE_DAYS),
  });
}

/** One-line log summary (bounded). */
export function summarizeLedgerForLog(ledger: WeeklyLedger, purpose: SessionPurpose | null): Record<string, unknown> {
  return {
    event: 'weekly_ledger_shadow',
    schemaVersion: ledger.schemaVersion,
    targetDate: ledger.targetDate,
    purpose,
    anchor: ledger.anchor,
    entries: ledger.entries.map((e) => ({
      id: e.targetId,
      status: e.status,
      basis: e.basis,
      number: e.number,
      done: e.done,
      remaining: e.remaining,
      window: `${e.windowStart}..${e.windowEnd}#${e.windowDay}`,
      later: `${e.laterSessions}x=${e.laterCapacity}`,
      ...(e.mustSetsToday > 0 ? { mustToday: e.mustSetsToday } : {}),
      behind: e.behind,
    })),
  };
}
