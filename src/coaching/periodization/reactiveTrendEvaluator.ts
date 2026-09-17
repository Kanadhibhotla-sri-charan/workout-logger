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
import { getTargetSummary } from '../history/historicalService.js';
import type { BasicTrendDirection, TrendDataQuality } from '../history/historicalTypes.js';

export type ReactiveEvaluationLevel = 'clear' | 'watch' | 'triggered';

export interface ReactiveDeclineSignal {
  targetId: string;
  trend: BasicTrendDirection;
  dataQuality: TrendDataQuality;
  completedExposureCount: number;
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

  const signals: ReactiveDeclineSignal[] = [];
  for (const target of BlueprintAdapter.getTargets()) {
    const summary = getTargetSummary(db, target.id, lookbackStart, lookbackEnd);
    if (summary.dataQuality === 'insufficient') continue;
    if (summary.trend !== 'down') continue;
    signals.push({ targetId: target.id, trend: summary.trend, dataQuality: summary.dataQuality, completedExposureCount: summary.completedExposureCount });
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
