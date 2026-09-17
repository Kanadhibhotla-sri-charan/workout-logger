// Coaching Depth Batch 3 spec §12: the ONE orchestrator that combines
// calendar-driven block/deload state (programStateService.ts, extended
// by this batch), the reactive trend evaluator, and the centralized
// deload policy into a single `PeriodizationContext` for the planner —
// never a second place that re-derives any of this.

import type Database from 'better-sqlite3';
import { REACTIVE_TRIGGER } from '../../engine/config.js';
import { DELOAD_POLICY } from '../../engine/config.js';
import { daysBetween } from '../../engine/dateMath.js';
import { DELOAD_REP_RANGE_BIAS, computeCooldownUntil, computeReactiveDeloadEndDate } from './deloadPolicy.js';
import { PeriodizationEventsRepo } from './periodizationEventsRepo.js';
import { evaluateReactiveDeloadTrigger, type ReactiveEvaluationResult } from './reactiveTrendEvaluator.js';
import { getActiveProgramState, getOrCreateActiveProgramState, updateReactiveState } from '../programState/programStateService.js';
import type { DeloadReason, ProgramState, WeekBoundary } from '../programState/programStateTypes.js';
import type { RepRangeBias } from '../profiles/muscleProfileTypes.js';

export interface PeriodizationContext {
  programState: ProgramState;
  /** True for any deload (scheduled, reactive, manual, or combined) —
   * mirrors `programState.isDeload`, surfaced here for planner callers
   * that only need this module's own context object. */
  deloadActive: boolean;
  deloadReason: DeloadReason;
  /** Spec §7: the exact fraction a deload week's recommended weekly sets
   * should be scaled by — `1` (no change) when `deloadActive` is false.
   * The ONE number `volumeEngine.ts`'s own call site multiplies by;
   * never a second, independently-chosen reduction. */
  setVolumeMultiplier: number;
  /** Spec §7: which end of Blueprint's own authored rep range a deload
   * leans toward — `null` when `deloadActive` is false (no override of
   * whatever bias the target's own curated profile already specifies). */
  deloadRepRangeBias: RepRangeBias | null;
  /** Populated only on a call that actually ran a fresh reactive
   * evaluation this time (rate-limited — see
   * REACTIVE_TRIGGER.minimumDaysBetweenEvaluations); `null` when this
   * call's evaluation was skipped because one already ran today. */
  reactiveEvaluation: ReactiveEvaluationResult | null;
}

export interface GetPeriodizationContextInput {
  programId: string;
  referenceDate: string;
  weekBoundary: WeekBoundary;
  defaultBlockLengthWeeks: number;
}

/** Batch 3 spec §12: builds the single periodization context object
 * every planner call site (deterministic `workoutBuilder.ts`/
 * `volumeEngine.ts` AND the AI foundation context) reads. Runs a fresh
 * reactive-trend evaluation at most once per real calendar day (spec
 * §10's own rate limit — `REACTIVE_TRIGGER.minimumDaysBetweenEvaluations`)
 * and persists the outcome via `updateReactiveState` — the ONLY write
 * path for reactive-evidence fields, so every write goes through one
 * place. A plain re-read on the same day never re-evaluates or
 * double-triggers. */
export function getPeriodizationContext(db: Database.Database, input: GetPeriodizationContextInput): PeriodizationContext {
  let programState = getOrCreateActiveProgramState(db, input.programId, input.referenceDate, input.weekBoundary, input.defaultBlockLengthWeeks);

  const daysSinceLastEvaluation = programState.lastEvaluatedAt === null ? Infinity : daysBetween(programState.lastEvaluatedAt, input.referenceDate);
  const shouldEvaluate = daysSinceLastEvaluation >= REACTIVE_TRIGGER.minimumDaysBetweenEvaluations;

  let reactiveEvaluation: ReactiveEvaluationResult | null = null;
  if (shouldEvaluate) {
    reactiveEvaluation = evaluateReactiveDeloadTrigger(db, {
      programId: input.programId,
      referenceDate: input.referenceDate,
      isInCooldown: programState.reactiveTriggerStatus === 'cooldown',
      isAlreadyInReactiveDeload: programState.reactiveTriggerStatus === 'triggered',
    });

    const eventsRepo = new PeriodizationEventsRepo(db);
    if (reactiveEvaluation.triggered) {
      const startDate = input.referenceDate;
      const endDate = computeReactiveDeloadEndDate(startDate);
      const cooldownUntil = computeCooldownUntil(endDate);
      programState = updateReactiveState(db, input.programId, input.referenceDate, input.weekBoundary, {
        reactiveTriggerStatus: 'triggered',
        reactiveTriggeredAt: input.referenceDate,
        reactiveDeloadStartDate: startDate,
        reactiveDeloadEndDate: endDate,
        cooldownUntil,
        lastEvaluatedAt: input.referenceDate,
      });
      eventsRepo.record({
        programId: input.programId,
        previousState: 'ACTIVE',
        newState: 'REACTIVE_DELOAD',
        triggerType: 'reactive_triggered',
        blockId: programState.blockId,
        blockNumber: programState.blockNumber,
        weekIndex: programState.weekIndex,
        evidence: reactiveEvaluation,
        appliedPolicy: DELOAD_POLICY,
        reason: reactiveEvaluation.recommendedAction,
      });
    } else {
      // Spec §9.4: only ever store the raw evaluation OUTCOME here
      // (clear/watch) — 'triggered'/'cooldown' are derived, never
      // written directly (see programStateService.ts's own
      // deriveReactiveTriggerStatus).
      const storedStatus = reactiveEvaluation.level === 'watch' ? 'watch' : 'clear';
      programState = updateReactiveState(db, input.programId, input.referenceDate, input.weekBoundary, {
        reactiveTriggerStatus: storedStatus,
        lastEvaluatedAt: input.referenceDate,
      });
      eventsRepo.record({
        programId: input.programId,
        previousState: programState.periodizationState,
        newState: programState.periodizationState,
        triggerType: 'reactive_suppressed',
        blockId: programState.blockId,
        blockNumber: programState.blockNumber,
        weekIndex: programState.weekIndex,
        evidence: reactiveEvaluation,
        appliedPolicy: null,
        reason: reactiveEvaluation.recommendedAction,
      });
    }
  }

  const deloadActive = programState.isDeload;
  return {
    programState,
    deloadActive,
    deloadReason: programState.deloadReason,
    setVolumeMultiplier: deloadActive ? DELOAD_POLICY.setVolumeMultiplier : 1,
    deloadRepRangeBias: deloadActive ? DELOAD_REP_RANGE_BIAS : null,
    reactiveEvaluation,
  };
}

// Re-exported for convenience so callers that only need a plain read
// (never a fresh evaluation — e.g. a lightweight status endpoint) don't
// need a second import.
export { getActiveProgramState };
