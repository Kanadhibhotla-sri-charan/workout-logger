import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { newId, nowIso } from './ids.js';

/** Final Current-Week Reconciliation Fix §5/§6: persisted storage for
 * "this calendar week's actual generated plan" — reusing the existing
 * `programs`/`program_sessions` tables (see their schema.sql doc
 * comments) rather than a new table, per spec §5/§21. Deliberately a
 * separate, purpose-built repo from `ProgramsRepo` (which still owns
 * the original draft/active/completed/archived Program concept and is
 * untouched) — the input/output shapes here are different enough
 * (a `snapshot_json` blob per session, week-level aggregate JSON) that
 * overloading ProgramsRepo's existing API would have been more
 * confusing than two repos over the same tables for two distinct
 * purposes.
 *
 * A `PersistedWeekProgram` row is found by `programs.start_date` = the
 * week's Monday-anchored start date (`programmingWeekStart`). Only real
 * gym/both days ever get a `program_sessions` row — a badminton-only or
 * unselected/rest day has nothing to persist (no exercise prescription
 * exists for it). */

export interface PersistedWeekSession {
  id: string;
  day_index: number; // 0=Monday..6=Sunday
  name: string;
  planned_session_type: string;
  /** The exact enriched per-day object /api/programming/week already
   * returns for a gym day (sessionPurpose, availableMinutes,
   * estimatedMinutes, plannedWork, skipped, badmintonContext,
   * resourceAllocation) — stored verbatim so a plain read never needs
   * the planner, and so an untouched day's reasoning/decision text is
   * never silently rewritten by an unrelated reconciliation. */
  snapshot: unknown;
}

export interface PersistedWeekProgram {
  id: string;
  start_date: string;
  end_date: string;
  active_goals: unknown | null;
  target_allocations: unknown | null;
  sessions: PersistedWeekSession[]; // one per day that currently has a gym/both component
}

interface ProgramRow {
  id: string;
  start_date: string;
  end_date: string;
  active_goals_json: string | null;
  target_allocations_json: string | null;
}

interface ProgramSessionRow {
  id: string;
  day_index: number;
  name: string;
  planned_session_type: string;
  snapshot_json: string | null;
}

function rowToProgram(row: ProgramRow, sessionRows: ProgramSessionRow[]): PersistedWeekProgram {
  return {
    id: row.id,
    start_date: row.start_date,
    end_date: row.end_date,
    active_goals: row.active_goals_json ? JSON.parse(row.active_goals_json) : null,
    target_allocations: row.target_allocations_json ? JSON.parse(row.target_allocations_json) : null,
    sessions: sessionRows
      .filter((s) => s.snapshot_json !== null)
      .map((s) => ({
        id: s.id,
        day_index: s.day_index,
        name: s.name,
        planned_session_type: s.planned_session_type,
        snapshot: JSON.parse(s.snapshot_json!),
      })),
  };
}

export class WeeklyProgramRepo {
  constructor(private db: Database.Database) {}

  getByWeekStart(weekStart: string): PersistedWeekProgram | undefined {
    const row = this.db.prepare('SELECT id, start_date, end_date, active_goals_json, target_allocations_json FROM programs WHERE start_date = ?').get(weekStart) as
      | ProgramRow
      | undefined;
    if (!row) return undefined;
    const sessionRows = this.db
      .prepare('SELECT id, day_index, name, planned_session_type, snapshot_json FROM program_sessions WHERE program_id = ? ORDER BY day_index ASC')
      .all(row.id) as ProgramSessionRow[];
    return rowToProgram(row, sessionRows);
  }

  /** Creates the (initially session-less) program row for a week — call
   * once, the first time a week is ever read/written, then populate its
   * sessions via `upsertSession`. */
  create(weekStart: string, weekEnd: string): PersistedWeekProgram {
    const id = newId('program');
    this.db
      .prepare(
        `INSERT INTO programs (id, name, status, start_date, end_date, notes, blueprint_commit, created_at)
         VALUES (@id, @name, 'active', @start_date, @end_date, NULL, @blueprint_commit, @created_at)`
      )
      .run({
        id,
        name: `Week of ${weekStart}`,
        start_date: weekStart,
        end_date: weekEnd,
        blueprint_commit: BlueprintAdapter.getManifest().sourceCommit,
        created_at: nowIso(),
      });
    return { id, start_date: weekStart, end_date: weekEnd, active_goals: null, target_allocations: null, sessions: [] };
  }

  updateAggregates(programId: string, activeGoals: unknown, targetAllocations: unknown): void {
    this.db
      .prepare('UPDATE programs SET active_goals_json = @active_goals_json, target_allocations_json = @target_allocations_json WHERE id = @id')
      .run({ id: programId, active_goals_json: JSON.stringify(activeGoals), target_allocations_json: JSON.stringify(targetAllocations) });
  }

  getSession(programId: string, dayIndex: number): PersistedWeekSession | undefined {
    const row = this.db
      .prepare('SELECT id, day_index, name, planned_session_type, snapshot_json FROM program_sessions WHERE program_id = ? AND day_index = ?')
      .get(programId, dayIndex) as ProgramSessionRow | undefined;
    if (!row || row.snapshot_json === null) return undefined;
    return { id: row.id, day_index: row.day_index, name: row.name, planned_session_type: row.planned_session_type, snapshot: JSON.parse(row.snapshot_json) };
  }

  /** Creates or replaces the ONE session for (programId, dayIndex) —
   * touches no other day. If a row already exists for this day, its id
   * is preserved (session identity stable — spec §6/§20) and only its
   * content is updated. */
  upsertSession(programId: string, dayIndex: number, name: string, plannedSessionType: string, snapshot: unknown): PersistedWeekSession {
    const existing = this.db
      .prepare('SELECT id FROM program_sessions WHERE program_id = ? AND day_index = ?')
      .get(programId, dayIndex) as { id: string } | undefined;

    const snapshotJson = JSON.stringify(snapshot);
    if (existing) {
      this.db
        .prepare('UPDATE program_sessions SET name = @name, planned_session_type = @planned_session_type, snapshot_json = @snapshot_json WHERE id = @id')
        .run({ id: existing.id, name, planned_session_type: plannedSessionType, snapshot_json: snapshotJson });
      return { id: existing.id, day_index: dayIndex, name, planned_session_type: plannedSessionType, snapshot };
    }

    const id = newId('psession');
    this.db
      .prepare(
        `INSERT INTO program_sessions (id, program_id, day_index, name, planned_session_type, notes, created_at, snapshot_json)
         VALUES (@id, @program_id, @day_index, @name, @planned_session_type, NULL, @created_at, @snapshot_json)`
      )
      .run({ id, program_id: programId, day_index: dayIndex, name, planned_session_type: plannedSessionType, created_at: nowIso(), snapshot_json: snapshotJson });
    return { id, day_index: dayIndex, name, planned_session_type: plannedSessionType, snapshot };
  }

  /** Removes the persisted session for (programId, dayIndex), if any —
   * e.g. a day that changed from Gym to Badminton/Rest. Never called for
   * a "locked" day (see weekProgramReconciliation.ts) — the caller is
   * responsible for that check. */
  deleteSession(programId: string, dayIndex: number): void {
    this.db.prepare('DELETE FROM program_sessions WHERE program_id = ? AND day_index = ?').run(programId, dayIndex);
  }
}
