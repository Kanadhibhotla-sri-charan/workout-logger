// Weekly volume ledger (2026-10-25, revised 2026-10-27 for Blueprint
// schema 2; docs/WEEKLY_VOLUME_PLANNING_DESIGN.md).
//
// Owner rules: growth decides the numbers, not frequency. Every muscle
// counts per calendar week (decision 2026-10-27: the 14-day cycle for
// non-goal muscles is dropped). The numbers are Blueprint's own
// (volume-targets.yaml): goal muscles at "priority", the rest at
// "efficient", counted as credited sets (completed sets x the exercise's
// target_credit weight). Goal muscles are planned on every suitable day.
// Goal muscles count direct work only (owner decision 2026-10-30, after
// triceps read "met" at 17/16 with ~6 of it from pressing): a set counts
// toward a goal muscle only when the exercise gives that muscle's volume
// group full credit (1), e.g. skull crushers and dips for triceps, not
// bench or overhead press. Non-goal muscles keep Blueprint's partial credit.
// Blueprint's min_hours_between is not applied (owner decision
// 2026-10-27: four training days in a row are normal). Goal muscles may
// go past Blueprint's per_session_max (owner decision 2026-10-27: on a
// Push/Pull week brachialis gets two sessions, and 2 x 6 < 14).
//
// Sub-regions (upper/mid/lower pec, triceps long head) have no number of
// their own: their parent's number applies, and a child with a min_share
// gets an entry for that share of the parent's number.
//
// For today's session each target gets a status:
//   must      goal muscle (D2), or more still needed than the later
//             suitable days this week can hold
//   can_wait  still needed, later days can hold it
//   indirect  non-goal muscle Blueprint leaves to compound work
//             (indirect_only); counted, never scheduled directly
//   met       this week's number reached
//   not_today not compatible with today's session, or paused
//
// computeLedger is pure; buildWeeklyLedger reads the logged sessions and
// the coming schedule. Shadow mode only logs the result.

import type Database from 'better-sqlite3';
import { WEEKDAYS, type Weekday } from '../../contracts/types.js';
import type { SessionPurpose } from '../../engine/config.js';
import { addDays, daysBetween } from '../../engine/dateMath.js';
import { isTargetCompatibleWithPurpose } from '../../engine/sessionPurpose.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { athleticPaused } from '../../athletic/athleticSession.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';
import { InjuryPausesRepo } from '../../repositories/injuryPausesRepo.js';
import { LegTrainingRepo } from '../../repositories/legTrainingRepo.js';
import { getTargetCredit, listVolumeNumbers, outcomeVolumeLevels, volumeChildren, volumeParentOf } from '../../blueprint/volumeTargets.js';
import type { AIProgrammerContext } from '../context/programmerContextTypes.js';
import { weekGymDays } from '../service/weekGeneration.js';

export const LEDGER_SCHEMA_VERSION = 'weekly-ledger.v2' as const;
/** How far back a weekday's most recent real purpose is looked up. */
export const LEDGER_PURPOSE_LOOKBACK_DAYS = 21;

export type LedgerStatus = 'must' | 'can_wait' | 'indirect' | 'met' | 'not_today';

export interface LedgerTargetInput {
  targetId: string;
  isGoal: boolean;
  /** Credited sets this week. */
  reference: number;
  /** Blueprint per_session_max; null = none authored. */
  perSessionCap: number | null;
  /** Non-goal muscle left to compound work (Blueprint indirect_only). */
  indirectOnly: boolean;
  /** Sub-region entry: the parent whose number this is a share of. */
  shareOf: string | null;
  eligibleToday: boolean;
  paused: boolean;
  /** Whether a session of this purpose can train the target (later days). */
  trainedOn: (purpose: SessionPurpose) => boolean;
}

export interface LedgerFutureDay {
  date: string;
  purpose: SessionPurpose;
}

export interface LedgerInput {
  targetDate: string;
  targets: readonly LedgerTargetInput[];
  /** Credited sets per date per target id. */
  dailyCredit: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Gym days after targetDate (only this week's are used). */
  futureDays: readonly LedgerFutureDay[];
  /** Count work logged ON targetDate as done (the overview, read after
   * training); planning counts only earlier days. */
  countTargetDate?: boolean;
}

export interface LedgerEntry {
  targetId: string;
  isGoal: boolean;
  shareOf: string | null;
  number: number;
  weekStart: string;
  weekEnd: string;
  /** 1-based day of the week today falls on. */
  weekDay: number;
  done: number;
  remaining: number;
  laterSessions: number;
  laterCapacity: number;
  status: LedgerStatus;
  /** Sets that must happen today so the week can still be met (must only). */
  mustSetsToday: number;
  /** Share of the week elapsed minus share of the number done (higher = further behind). */
  behind: number;
  reason: string;
}

export interface WeeklyLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  targetDate: string;
  entries: LedgerEntry[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeLedger(input: LedgerInput): WeeklyLedger {
  const weekStart = programmingWeekStart(input.targetDate);
  const weekEnd = addDays(weekStart, 6);
  const weekDay = daysBetween(weekStart, input.targetDate) + 1;
  const countUntil = input.countTargetDate ? addDays(input.targetDate, 1) : input.targetDate;
  const entries: LedgerEntry[] = [];
  for (const t of input.targets) {
    if (t.reference <= 0) continue;
    let done = 0;
    for (const [date, byTarget] of input.dailyCredit) if (date >= weekStart && date < countUntil) done += byTarget.get(t.targetId) ?? 0;
    const remaining = Math.max(0, t.reference - done);
    const later = t.paused ? [] : input.futureDays.filter((d) => d.date > input.targetDate && d.date <= weekEnd && t.trainedOn(d.purpose));
    const perSession = t.perSessionCap ?? t.reference;
    const laterCapacity = later.length * perSession;
    const behind = round2(weekDay / 7 - (t.reference - remaining) / t.reference);

    let status: LedgerStatus;
    let mustSetsToday = 0;
    let reason: string;
    if (t.paused || !t.eligibleToday) {
      status = 'not_today';
      reason = t.paused ? 'paused (injury pause)' : "not compatible with today's session";
    } else if (remaining <= 0) {
      status = 'met';
      reason = `this week's ${t.reference} reached`;
    } else if (t.indirectOnly && !t.isGoal) {
      status = 'indirect';
      reason = `${round2(remaining)} left; Blueprint leaves it to compound work`;
    } else if (t.isGoal) {
      status = 'must';
      mustSetsToday = Math.ceil(remaining / (later.length + 1));
      reason = `goal muscle: ${round2(remaining)} left this week over ${later.length + 1} suitable day(s)`;
    } else if (remaining > laterCapacity) {
      status = 'must';
      mustSetsToday = Math.min(perSession, Math.ceil(remaining - laterCapacity));
      reason = `${round2(remaining)} needed by ${weekEnd}; later days hold only ${laterCapacity}`;
    } else {
      status = 'can_wait';
      reason = `${round2(remaining)} needed by ${weekEnd}; ${later.length} later suitable day(s) hold ${laterCapacity}`;
    }
    entries.push({
      targetId: t.targetId,
      isGoal: t.isGoal,
      shareOf: t.shareOf,
      number: t.reference,
      weekStart,
      weekEnd,
      weekDay,
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
  const order: LedgerStatus[] = ['must', 'can_wait', 'indirect', 'met', 'not_today'];
  entries.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.behind - a.behind || a.targetId.localeCompare(b.targetId));
  return { schemaVersion: LEDGER_SCHEMA_VERSION, targetDate: input.targetDate, entries };
}

// ---------------------------------------------------------- targets

const TRAINING_PURPOSES: readonly SessionPurpose[] = ['push', 'pull', 'legs', 'upper'];

/** The physique targets that stand for a volume id: a group's children
 * (chest -> pecs), anti-extension core -> rectus (both core accessories),
 * else the id itself. */
function representatives(id: string): string[] {
  if (id === 'core-anti-extension') return ['rectus-abdominis'];
  const children = volumeChildren(id).map((c) => c.id);
  return children.length > 0 ? children : [id];
}

const trainsOn = (ids: readonly string[]) => (purpose: SessionPurpose) => ids.some((id) => isTargetCompatibleWithPurpose('physique_target', id, purpose));

/** Ledger targets from Blueprint's volume numbers: every entry a training
 * session can train, at "priority" when an active aesthetic goal gives it
 * that level, else "efficient"; plus a share entry per sub-region with a
 * min_share. `eligible` says whether a physique target fits today. */
export function ledgerTargets(goalOutcomeIds: readonly string[], pausedIds: ReadonlySet<string>, eligible: (targetId: string) => boolean): LedgerTargetInput[] {
  const levels = outcomeVolumeLevels(goalOutcomeIds);
  const out: LedgerTargetInput[] = [];
  for (const v of listVolumeNumbers()) {
    const reps = representatives(v.id);
    const trainedOn = trainsOn(reps);
    if (!TRAINING_PURPOSES.some(trainedOn)) continue;
    const isGoal = levels.get(v.id) === 'priority';
    const reference = isGoal ? v.weekly.priority : v.weekly.efficient;
    const shared = { isGoal, perSessionCap: v.perSessionMax, indirectOnly: v.indirectOnly };
    out.push({ ...shared, targetId: v.id, reference, shareOf: null, eligibleToday: reps.some(eligible), paused: reps.every((id) => pausedIds.has(id)), trainedOn });
    for (const child of volumeChildren(v.id)) {
      if (child.minShare == null) continue;
      out.push({
        ...shared,
        targetId: child.id,
        reference: round2(reference * child.minShare),
        shareOf: v.id,
        eligibleToday: eligible(child.id),
        paused: pausedIds.has(child.id),
        trainedOn: trainsOn([child.id]),
      });
    }
  }
  return out;
}

function activeGoalOutcomeIds(db: Database.Database): string[] {
  return new GoalsRepo(db).list({ active: true, goal_type: 'aesthetic' }).map((g) => g.blueprint_ref);
}

function pausedTargetIds(db: Database.Database): Set<string> {
  return new Set([...new InjuryPausesRepo(db).pausedTargetIds(), ...new LegTrainingRepo(db).athleticLegTargetIds()]);
}

// ---------------------------------------------------------------- reads

/** Whether an exercise trains a target directly: full credit (1) for the
 * target's volume group (a sub-region looks at its parent). */
export function isDirectCredit(credit: Readonly<Record<string, number>>, targetId: string): boolean {
  return (credit[volumeParentOf(targetId)] ?? credit[targetId] ?? 0) >= 1;
}

/** Credited sets per date per volume id from completed sessions in
 * [from, toExclusive): each completed set x the exercise's Blueprint
 * target_credit. Exercises without credit (unknown, mobility) add nothing.
 * Ids in `directOnly` (goal muscles) count only direct exercises. */
export function readDailyCredit(db: Database.Database, from: string, toExclusive: string, directOnly: ReadonlySet<string> = new Set()): Map<string, Map<string, number>> {
  const rows = db
    .prepare(
      `SELECT s.date AS date, we.exercise_id AS exerciseId,
              (SELECT COUNT(*) FROM workout_sets ws WHERE ws.workout_exercise_id = we.id AND ws.completed = 1) AS done
         FROM workout_sessions s JOIN workout_exercises we ON we.workout_session_id = s.session_id
        WHERE s.status = 'completed' AND s.date >= ? AND s.date < ?`
    )
    .all(from, toExclusive) as Array<{ date: string; exerciseId: string; done: number }>;
  const daily = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const credit = getTargetCredit(r.exerciseId);
    if (r.done <= 0 || !credit) continue;
    const day = daily.get(r.date) ?? new Map<string, number>();
    for (const [targetId, weight] of Object.entries(credit)) {
      if (directOnly.has(targetId) && !isDirectCredit(credit, targetId)) continue;
      day.set(targetId, (day.get(targetId) ?? 0) + r.done * weight);
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

/** Gym days after targetDate through the end of its programming week:
 * the effective schedule (overrides applied) with the purpose the user
 * has lately trained on that weekday, else the rotation's purpose. An
 * Athletic slot while legs are paused, with no recent purpose, is a rest
 * day. */
export function readFutureDays(db: Database.Database, targetDate: string): LedgerFutureDay[] {
  const recent = recentPurposeByWeekday(db, targetDate);
  const paused = athleticPaused(db);
  const out: LedgerFutureDay[] = [];
  for (const day of weekGymDays(db, programmingWeekStart(targetDate))) {
    if (day.date <= targetDate) continue;
    const purpose = recent.get(day.weekday) ?? day.purpose;
    if (!purpose || (purpose === 'athletic' && paused)) continue;
    out.push({ date: day.date, purpose });
  }
  return out;
}

const goalIds = (targets: readonly LedgerTargetInput[]) => new Set(targets.filter((t) => t.isGoal).map((t) => t.targetId));

/** The ledger for a built generation context (reads only). */
export function buildWeeklyLedger(db: Database.Database, context: AIProgrammerContext): WeeklyLedger {
  const targetDate = context.targetDate;
  const eligibleIds = new Set(context.programmingBrief.muscles.filter((m) => m.targetType === 'physique_target' && m.eligibleForThisSession).map((m) => m.targetId));
  const targets = ledgerTargets(activeGoalOutcomeIds(db), pausedTargetIds(db), (id) => eligibleIds.has(id));
  return computeLedger({
    targetDate,
    targets,
    dailyCredit: readDailyCredit(db, programmingWeekStart(targetDate), targetDate, goalIds(targets)),
    futureDays: readFutureDays(db, targetDate),
  });
}

/** Volume overview for the UI (reads only): every muscle's progress
 * toward this week's number, counting everything logged through `today`.
 * Status is not day-specific here (every target counts as eligible). */
export function volumeOverview(db: Database.Database, today: string): WeeklyLedger & { paused: string[] } {
  const targets = ledgerTargets(activeGoalOutcomeIds(db), pausedTargetIds(db), () => true);
  const ledger = computeLedger({
    targetDate: today,
    targets,
    dailyCredit: readDailyCredit(db, programmingWeekStart(today), addDays(today, 1), goalIds(targets)),
    futureDays: readFutureDays(db, today),
    countTargetDate: true,
  });
  return { ...ledger, paused: targets.filter((t) => t.paused).map((t) => t.targetId) };
}

/** One-line log summary (bounded). */
export function summarizeLedgerForLog(ledger: WeeklyLedger, purpose: SessionPurpose | null): Record<string, unknown> {
  return {
    event: 'weekly_ledger_shadow',
    schemaVersion: ledger.schemaVersion,
    targetDate: ledger.targetDate,
    purpose,
    entries: ledger.entries.map((e) => ({
      id: e.targetId,
      status: e.status,
      ...(e.isGoal ? { goal: true } : {}),
      number: e.number,
      done: e.done,
      remaining: e.remaining,
      later: `${e.laterSessions}x=${e.laterCapacity}`,
      ...(e.mustSetsToday > 0 ? { mustToday: e.mustSetsToday } : {}),
      behind: e.behind,
    })),
  };
}
