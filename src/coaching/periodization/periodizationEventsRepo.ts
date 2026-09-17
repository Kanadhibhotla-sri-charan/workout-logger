// Coaching Depth Batch 3 spec §16: append-only observability log for
// every periodization transition or reactive evaluation, mirroring
// GoalEventsRepo's own append-only event-log convention (never updated
// or deleted, only appended to) rather than inventing a second logging
// shape.

import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../repositories/ids.js';
import type { PeriodizationState } from '../programState/programStateTypes.js';

export type PeriodizationTriggerType = 'calendar' | 'reactive_triggered' | 'reactive_suppressed' | 'manual' | 'block_transition';

export interface PeriodizationEvent {
  id: string;
  programId: string;
  occurredAt: string;
  previousState: PeriodizationState;
  newState: PeriodizationState;
  triggerType: PeriodizationTriggerType;
  blockId: string;
  blockNumber: number;
  weekIndex: number;
  evidence: unknown | null;
  appliedPolicy: unknown | null;
  reason: string;
}

export interface RecordPeriodizationEventInput {
  programId: string;
  previousState: PeriodizationState;
  newState: PeriodizationState;
  triggerType: PeriodizationTriggerType;
  blockId: string;
  blockNumber: number;
  weekIndex: number;
  evidence?: unknown | null;
  appliedPolicy?: unknown | null;
  reason: string;
}

interface PeriodizationEventRow {
  id: string;
  program_id: string;
  occurred_at: string;
  previous_state: PeriodizationState;
  new_state: PeriodizationState;
  trigger_type: PeriodizationTriggerType;
  block_id: string;
  block_number: number;
  week_index: number;
  evidence_json: string | null;
  applied_policy_json: string | null;
  reason: string;
}

function rowToEvent(row: PeriodizationEventRow): PeriodizationEvent {
  return {
    id: row.id,
    programId: row.program_id,
    occurredAt: row.occurred_at,
    previousState: row.previous_state,
    newState: row.new_state,
    triggerType: row.trigger_type,
    blockId: row.block_id,
    blockNumber: row.block_number,
    weekIndex: row.week_index,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    appliedPolicy: row.applied_policy_json ? JSON.parse(row.applied_policy_json) : null,
    reason: row.reason,
  };
}

/** Batch 3 spec §16: one row per periodization transition or reactive
 * evaluation — INCLUDING a non-trigger (so "why did it not trigger" is
 * always answerable, per §16's own required debug questions). Never
 * updated or deleted. */
export class PeriodizationEventsRepo {
  constructor(private db: Database.Database) {}

  record(input: RecordPeriodizationEventInput): PeriodizationEvent {
    const event: PeriodizationEvent = {
      id: newId('coachpevent'),
      programId: input.programId,
      occurredAt: nowIso(),
      previousState: input.previousState,
      newState: input.newState,
      triggerType: input.triggerType,
      blockId: input.blockId,
      blockNumber: input.blockNumber,
      weekIndex: input.weekIndex,
      evidence: input.evidence ?? null,
      appliedPolicy: input.appliedPolicy ?? null,
      reason: input.reason,
    };
    this.db
      .prepare(
        `INSERT INTO coaching_periodization_events
           (id, program_id, occurred_at, previous_state, new_state, trigger_type, block_id, block_number, week_index, evidence_json, applied_policy_json, reason)
         VALUES (@id, @program_id, @occurred_at, @previous_state, @new_state, @trigger_type, @block_id, @block_number, @week_index, @evidence_json, @applied_policy_json, @reason)`
      )
      .run({
        id: event.id,
        program_id: event.programId,
        occurred_at: event.occurredAt,
        previous_state: event.previousState,
        new_state: event.newState,
        trigger_type: event.triggerType,
        block_id: event.blockId,
        block_number: event.blockNumber,
        week_index: event.weekIndex,
        evidence_json: event.evidence !== null ? JSON.stringify(event.evidence) : null,
        applied_policy_json: event.appliedPolicy !== null ? JSON.stringify(event.appliedPolicy) : null,
        reason: event.reason,
      });
    return event;
  }

  listForProgram(programId: string): PeriodizationEvent[] {
    const rows = this.db.prepare('SELECT * FROM coaching_periodization_events WHERE program_id = ? ORDER BY occurred_at ASC').all(programId) as PeriodizationEventRow[];
    return rows.map(rowToEvent);
  }
}
