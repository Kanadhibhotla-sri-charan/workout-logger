import type Database from 'better-sqlite3';
import type { GoalEvent, GoalEventType } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

interface GoalEventRow {
  id: string;
  goal_id: string;
  event_type: GoalEventType;
  occurred_at: string;
  detail: string | null;
  notes: string | null;
}

function rowToEvent(row: GoalEventRow): GoalEvent {
  return { ...row, detail: row.detail ? JSON.parse(row.detail) : null };
}

export interface RecordGoalEventInput {
  goal_id: string;
  event_type: GoalEventType;
  detail?: Record<string, unknown> | null;
  notes?: string | null;
}

/** Append-only log of everything that happened to a Goal — spec §18.
 * Never updated or deleted, only appended to; see the goal_events schema
 * comment for why this is one generic table rather than several. */
export class GoalEventsRepo {
  constructor(private db: Database.Database) {}

  record(input: RecordGoalEventInput): GoalEvent {
    const event: GoalEvent = {
      id: newId('gevent'),
      goal_id: input.goal_id,
      event_type: input.event_type,
      occurred_at: nowIso(),
      detail: input.detail ?? null,
      notes: input.notes ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO goal_events (id, goal_id, event_type, occurred_at, detail, notes)
         VALUES (@id, @goal_id, @event_type, @occurred_at, @detail, @notes)`
      )
      .run({ ...event, detail: event.detail ? JSON.stringify(event.detail) : null });
    return event;
  }

  listForGoal(goalId: string): GoalEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM goal_events WHERE goal_id = ? ORDER BY occurred_at ASC')
      .all(goalId) as GoalEventRow[];
    return rows.map(rowToEvent);
  }
}
