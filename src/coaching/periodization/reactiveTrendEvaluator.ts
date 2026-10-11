// Coaching Depth Batch 3 spec §8-§9: the reactive-deload evidence
// engine. A transparent RULE evaluation (spec §9.3: "not an opaque
// score") built entirely from Batch 1's own already-derived
// `TargetHistoricalSummary`/`calculateBasicTrend` (never a second,
// competing history/trend computation) plus the real completed-session
// count from `WorkoutSessionsRepo` — no new persisted history.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { REACTIVE_TRIGGER } from '../../engine/config.js';
import { rollingRangeEnding } from '../../engine/dateMath.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { getTargetHistory } from '../history/historicalService.js';
import type { BasicTrendDirection, TrendDataQuality } from '../history/historicalTypes.js';
import { calculateBasicTrend, classifyDataQuality } from '../history/trendCalculations.js';
import { addDays } from '../../engine/dateMath.js';
import { PeriodizationEventsRepo } from './periodizationEventsRepo.js';

export type ReactiveEvaluationLevel = 'clear' | 'watch' | 'triggered';

export interface ReactiveDeclineSignal {
  targetId: string;
  trend: BasicTrendDirection;
  dataQuality: TrendDataQuality;
  completedExposureCount: number;
  /** Per-exercise evidence (2026-10-11): each exercise's own estimated-1RM
   * trend, oldest and newest value, over the non-deload exposures. */
  exercises?: ExerciseTrendEvidence[];
}

export interface ExerciseTrendEvidence {
  exerciseId: string;
  /** Equipment the series was done with; null when not specified. */
  equipment: string | null;
  trend: BasicTrendDirection;
  points: number;
  first: number;
  last: number;
}

/** Dates in [start, end] that fell in a deload (scheduled or reactive),
 * from the periodization event log: each event's new state holds from its
 * evaluation date until the next event. */
export function deloadDatesInRange(db: Database.Database, programId: string, start: string, end: string): Set<string> {
  const events = new PeriodizationEventsRepo(db).listForProgram(programId).map((e) => ({
    date: (e.evidence as { evaluationTimestamp?: string } | null)?.evaluationTimestamp ?? e.occurredAt.slice(0, 10),
    deload: e.newState !== 'ACTIVE',
  }));
  const dates = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    if (!events[i]!.deload) continue;
    const until = i + 1 < events.length ? addDays(events[i + 1]!.date, -1) : end;
    for (let d = events[i]!.date < start ? start : events[i]!.date; d <= until && d <= end; d = addDays(d, 1)) dates.add(d);
  }
  return dates;
}

/** An exercise needs at least this many non-deload sessions before its
 * own trend can count as decline: two points are one good day against
 * one bad day, not a sustained trend. */
export const MIN_EXERCISE_POINTS_FOR_DECLINE = 3;

/** A target's decline signal from its exercises compared each with
 * itself (2026-10-11 fix): averaging load across different exercises read
 * an exercise swap (e.g. seated cable row -> chest-supported DB row) or a
 * deload week as a decline. Exposures on deload dates are ignored; the
 * target is "down" when more than half of its exercises with a trend are
 * down (only exercises with MIN_EXERCISE_POINTS_FOR_DECLINE sessions count). */
export function targetDeclineEvidence(
  db: Database.Database,
  targetId: string,
  start: string,
  end: string,
  excludedDates: ReadonlySet<string>
): { trend: BasicTrendDirection; dataQuality: TrendDataQuality; completedExposureCount: number; exercises: ExerciseTrendEvidence[] } {
  const exposures = getTargetHistory(db, targetId, start, end).filter(
    (e): e is typeof e & { load: number } => e.completionStatus === 'completed' && e.load !== undefined && !excludedDates.has(e.date)
  );
  // One series per exercise AND equipment: dumbbell and barbell numbers for
  // the same exercise are not comparable.
  const byExercise = new Map<string, Array<{ date: string; load: number }>>();
  const keyOf = (e: { exerciseId: string; equipment?: string | null }) => `${e.exerciseId}|${e.equipment ?? ''}`;
  for (const e of exposures) (byExercise.get(keyOf(e)) ?? byExercise.set(keyOf(e), []).get(keyOf(e))!).push({ date: e.date, load: e.load });
  const exercises: ExerciseTrendEvidence[] = [...byExercise].map(([key, points]) => {
    const [exerciseId, equipment] = key.split('|') as [string, string];
    const first = points[0]!.load;
    const last = points[points.length - 1]!.load;
    const trend = calculateBasicTrend(points);
    return {
      exerciseId,
      equipment: equipment || null,
      // A decline must also end lower than it started: one light session in
      // the middle can tip the early/late averages without any real drop.
      trend: trend === 'down' && last >= first ? 'stable' : trend,
      points: points.length,
      first: Math.round(first * 10) / 10,
      last: Math.round(last * 10) / 10,
    };
  });
  const withTrend = exercises.filter((x) => x.trend !== 'unknown' && x.points >= MIN_EXERCISE_POINTS_FOR_DECLINE);
  const down = withTrend.filter((x) => x.trend === 'down').length;
  const counted = withTrend.reduce((n, x) => n + x.points, 0);
  return {
    trend: withTrend.length === 0 ? 'unknown' : down * 2 > withTrend.length ? 'down' : 'stable',
    dataQuality: classifyDataQuality(counted),
    completedExposureCount: counted,
    exercises,
  };
}

export interface ReactiveEvaluationResult {
  triggered: boolean;
  level: ReactiveEvaluationLevel;
  /** Every target that independently showed a genuine decline signal —
   * spec §8.3: "a single signal should generally be insufficient on its
   * own." */
  signals: ReactiveDeclineSignal[];
  /** Real completed workout sessions found in the lookback window —
   * spec §9.2.1's "minimum amount of usable recent data" gate. */
  sessionsConsidered: number;
  lookbackStart: string;
  lookbackEnd: string;
  /** Spec §9.2.6: reasons a trigger is withheld even when the raw
   * evidence alone would otherwise support one (insufficient data, an
   * active cooldown, an already-active deload). Non-empty exactly when
   * `triggered` is false despite `level === 'triggered'`-strength
   * evidence, OR when evidence itself is insufficient. */
  blockingReasons: string[];
  recommendedAction: string;
  evaluationTimestamp: string;
}

export interface EvaluateReactiveDeloadTriggerInput {
  programId: string;
  referenceDate: string;
  /** Spec §9.2.5: no active cooldown or recently completed deload — the
   * caller (periodizationService.ts) already knows this from the same
   * `ProgramState` row, so it's passed in rather than re-derived here. */
  isInCooldown: boolean;
  /** Spec §9.2.5 / §10: never trigger a SECOND reactive deload while one
   * is already active. */
  isAlreadyInReactiveDeload: boolean;
}

/** Batch 3 spec §8-§9: evaluates every real Blueprint physique target's
 * own `TargetHistoricalSummary` (Batch 1's existing, unmodified
 * historicalService.ts) over a fixed lookback window and decides
 * `clear`/`watch`/`triggered` — never from one target, never from one
 * session. Deterministic and side-effect-free: this function reads only,
 * it never writes any persisted state (the caller — periodizationService.ts
 * — decides what to do with the result and performs any write). */
export function evaluateReactiveDeloadTrigger(db: Database.Database, input: EvaluateReactiveDeloadTriggerInput): ReactiveEvaluationResult {
  const { start: lookbackStart, end: lookbackEnd } = rollingRangeEnding(input.referenceDate, REACTIVE_TRIGGER.lookbackDays);
  const evaluationTimestamp = input.referenceDate;

  const sessionsConsidered = new WorkoutSessionsRepo(db)
    .listSessionsInRange(lookbackStart, lookbackEnd)
    .filter((s) => s.status === 'completed').length;

  const blockingReasons: string[] = [];
  if (input.isAlreadyInReactiveDeload) blockingReasons.push('already_in_active_reactive_deload');
  if (input.isInCooldown) blockingReasons.push('cooldown_active');

  if (sessionsConsidered < REACTIVE_TRIGGER.minimumSessionsForEvaluation) {
    return {
      triggered: false,
      level: 'clear',
      signals: [],
      sessionsConsidered,
      lookbackStart,
      lookbackEnd,
      blockingReasons: [...blockingReasons, 'insufficient_data'],
      recommendedAction: `Continue current programming — only ${sessionsConsidered} completed session(s) in the last ${REACTIVE_TRIGGER.lookbackDays} days, below the ${REACTIVE_TRIGGER.minimumSessionsForEvaluation} required to evaluate a reactive deload.`,
      evaluationTimestamp,
    };
  }

  const deloadDates = deloadDatesInRange(db, input.programId, lookbackStart, lookbackEnd);
  const declining: Array<{ signal: ReactiveDeclineSignal; exerciseIds: string[] }> = [];
  for (const target of BlueprintAdapter.getTargets()) {
    const evidence = targetDeclineEvidence(db, target.id, lookbackStart, lookbackEnd, deloadDates);
    if (evidence.dataQuality === 'insufficient') continue;
    if (evidence.trend !== 'down') continue;
    declining.push({
      signal: { targetId: target.id, trend: evidence.trend, dataQuality: evidence.dataQuality, completedExposureCount: evidence.completedExposureCount, exercises: evidence.exercises },
      exerciseIds: evidence.exercises.filter((x) => x.trend === 'down' && x.points >= MIN_EXERCISE_POINTS_FOR_DECLINE).map((x) => `${x.exerciseId}|${x.equipment ?? ''}`),
    });
  }
  // Independent evidence only: each declining exercise supports one target
  // (overhead extension credits triceps and its long head, but is one
  // piece of evidence). Targets with the fewest declining exercises claim
  // theirs first, so the count is the largest independent set.
  const claimed = new Set<string>();
  const signals: ReactiveDeclineSignal[] = [];
  for (const d of [...declining].sort((x, y) => x.exerciseIds.length - y.exerciseIds.length)) {
    const own = d.exerciseIds.find((id) => !claimed.has(id));
    if (!own) continue;
    claimed.add(own);
    signals.push(d.signal);
  }

  if (signals.length === 0) {
    return {
      triggered: false,
      level: 'clear',
      signals,
      sessionsConsidered,
      lookbackStart,
      lookbackEnd,
      blockingReasons,
      recommendedAction: 'Continue current programming — no sustained decline detected across any evaluated target.',
      evaluationTimestamp,
    };
  }

  if (signals.length < REACTIVE_TRIGGER.minimumDecliningTargets) {
    return {
      triggered: false,
      level: 'watch',
      signals,
      sessionsConsidered,
      lookbackStart,
      lookbackEnd,
      blockingReasons,
      recommendedAction: `Monitor — a decline signal was found on ${signals.length} target(s) (${signals.map((s) => s.targetId).join(', ')}), below the ${REACTIVE_TRIGGER.minimumDecliningTargets} required to initiate a reactive deload. No change to programming yet.`,
      evaluationTimestamp,
    };
  }

  const triggered = blockingReasons.length === 0;
  return {
    triggered,
    level: 'triggered',
    signals,
    sessionsConsidered,
    lookbackStart,
    lookbackEnd,
    blockingReasons,
    recommendedAction: triggered
      ? `Initiate a reactive deload — sustained decline across ${signals.length} targets (${signals.map((s) => s.targetId).join(', ')}) over the last ${REACTIVE_TRIGGER.lookbackDays} days.`
      : `Evidence supports a reactive deload (decline across ${signals.length} targets), but it is withheld: ${blockingReasons.join(', ')}.`,
    evaluationTimestamp,
  };
}
