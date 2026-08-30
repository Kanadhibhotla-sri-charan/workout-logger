import type Database from 'better-sqlite3';
import type { Measurement } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

export interface RecordMeasurementInput {
  goal_id?: string | null;
  date: string;
  metric_name: string;
  value: number;
  unit: string;
  notes?: string | null;
}

/** Dated body measurements — spec §3. `goal_id` is optional and single:
 * "do not assume every measurement applies to every goal." */
export class MeasurementsRepo {
  constructor(private db: Database.Database) {}

  record(input: RecordMeasurementInput): Measurement {
    const measurement: Measurement = {
      id: newId('measurement'),
      goal_id: input.goal_id ?? null,
      date: input.date,
      metric_name: input.metric_name,
      value: input.value,
      unit: input.unit,
      notes: input.notes ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO measurements (id, goal_id, date, metric_name, value, unit, notes, created_at)
         VALUES (@id, @goal_id, @date, @metric_name, @value, @unit, @notes, @created_at)`
      )
      .run(measurement);
    return measurement;
  }

  listForGoal(goalId: string): Measurement[] {
    return this.db.prepare('SELECT * FROM measurements WHERE goal_id = ? ORDER BY date ASC').all(goalId) as Measurement[];
  }

  list(): Measurement[] {
    return this.db.prepare('SELECT * FROM measurements ORDER BY date ASC').all() as Measurement[];
  }
}
