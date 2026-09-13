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

  /** Final Selected Session Resolution and AI/Deterministic Precedence
   * Fixes §5: filters to `status = 'active'` explicitly — every program
   * row THIS repo creates (`create`, below) is written with
   * `status = 'active'` and never transitions away from it, so this is
   * a no-op for the happy path, but it closes the hypothetical gap of
   * ever matching a row the SEPARATE legacy `ProgramsRepo` (the original
   * draft/active/completed/archived Program concept, over the same
   * `programs` table — see this file's own top-of-file doc comment)
   * later marks 'completed'/'archived'/'draft'. `supersedes_program_
   * session_id` (aiProposalLifecycle.ts) is only ever set from a row
   * this method returns, so this guard is exactly the "not archived or
   * obsolete" / "not ambiguous with another program" check spec §5
   * requires.
   *
   * One-program-per-week is otherwise an invariant this repo maintains
   * procedurally, not via a schema constraint: `programs.start_date` has
   * no UNIQUE index, because the SAME shared `programs` table also holds
   * the legacy ProgramsRepo's OWN rows (with a nullable, usually-null,
   * independently-set `start_date`) — a blanket UNIQUE(start_date)
   * would risk a spurious constraint violation if a legacy Program ever
   * set a `start_date` coinciding with a real week-Monday. This is safe
   * in practice because (a) `ensureWeekProgramGenerated`'s check-then-
   * create is only ever reached synchronously within one Node.js
   * request — better-sqlite3 is synchronous, so no `await` point exists
   * between the `getByWeekStart` read and the `create` write for two
   * concurrent requests to interleave through — and (b) `create` is the
   * only code path in this repo that ever inserts a row, always exactly
   * once per week the first time it is requested. See
   * `tests/repositories/weeklyProgramRepo.test.ts`'s "§5: one program
   * per week" test, which exercises this directly. */
  getByWeekStart(weekStart: string): PersistedWeekProgram | undefined {
    const row = this.db
      .prepare("SELECT id, start_date, end_date, active_goals_json, target_allocations_json FROM programs WHERE start_date = ? AND status = 'active'")
      .get(weekStart) as ProgramRow | undefined;
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
   * content is updated.
   *
   * Fix 6 (Activity Scheduling and AI Alignment Fixes) — identity
   * semantics review: this row's `id` represents a STABLE DAY SLOT
   * (program_id, day_index), never a stable prescription-artifact
   * identity. Overwriting content in place (as here, and as
   * scheduleOperations.ts's swapDayActivities does when it exchanges two
   * days' content) is therefore correct, not a shortcut — audited
   * consumers of this id:
   *   - `program_session_exercises.program_session_id` (schema.sql) —
   *     written only by the separate, legacy `ProgramsRepo`
   *     (draft/active/completed Program concept), which creates and
   *     reads its OWN program/program_session rows and never reads rows
   *     this repo writes; swap/reconciliation here never touch that
   *     table.
   *   - `workout_sessions.program_session_id` (schema.sql, ON DELETE SET
   *     NULL) — the column exists, but no code path in this codebase
   *     (POST /api/workouts, aiProposalLifecycle.ts's commit, or any
   *     frontend page) ever sets it when creating a session; it is
   *     always null in current practice. A real session therefore never
   *     references a specific `program_sessions` row today, so
   *     overwriting that row's content in place cannot silently change
   *     what an existing session "points to."
   *   - No UI state and no historical/audit logic anywhere in this
   *     codebase is keyed by a `program_sessions.id` value.
   * Conclusion: nothing currently depends on a `program_sessions.id`
   * continuing to denote the SAME prescription content over time — only
   * on it continuing to denote the same (program, day_index) slot, which
   * `upsertSession` already guarantees. If a future feature starts
   * setting `workout_sessions.program_session_id` (e.g. to link a
   * started workout back to its originating prescription), this
   * conclusion must be re-checked before any code swaps day content in
   * place again — see this task's own final report. */
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
