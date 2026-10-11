import type Database from 'better-sqlite3';
import { nowIso } from './ids.js';

export const DAY_NOTE_MAX_LENGTH = 2000;

export interface DayNote {
  date: string;
  note: string;
}

/** "Other" day notes: the user's own free-text account of a day's
 * non-logged activity (rehab, a sport, an injury). One per date. */
export class DayNotesRepo {
  constructor(private db: Database.Database) {}

  get(date: string): DayNote | null {
    return (this.db.prepare('SELECT date, note FROM day_notes WHERE date = ?').get(date) as DayNote | undefined) ?? null;
  }

  /** Notes dated `from`..`to` inclusive, oldest first. */
  listBetween(from: string, to: string): DayNote[] {
    return this.db.prepare('SELECT date, note FROM day_notes WHERE date >= ? AND date <= ? ORDER BY date').all(from, to) as DayNote[];
  }

  set(date: string, note: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO day_notes (date, note, created_at, updated_at) VALUES (@date, @note, @now, @now)
         ON CONFLICT (date) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
      )
      .run({ date, note, now });
  }

  delete(date: string): void {
    this.db.prepare('DELETE FROM day_notes WHERE date = ?').run(date);
  }
}
