// Explicit week generation (2026-10-01): durable run, guard and
// quality-gate state for POST /api/ai-programmer/generate-week. Every
// method is synchronous (better-sqlite3), so acquiring the per-week guard
// is a single transaction with no await inside it — two concurrent
// requests can never both pass the check and both launch provider calls.

import type Database from 'better-sqlite3';
import { newId, nowIso } from './ids.js';

export type WeekRunStatus = 'running' | 'completed' | 'partially_completed' | 'failed' | 'abandoned';
export type WeekRunFailureClass = 'provider_auth' | 'provider_transient' | 'abandoned';

export type WeekRunDayOutcome =
  | 'planned'
  | 'proposal_pending'
  | 'refused'
  | 'failed_quality'
  | 'gated'
  | 'failed_provider'
  | 'skipped'
  | 'not_attempted';

export interface WeekRunDay {
  date: string;
  purpose: string | null;
  outcome: WeekRunDayOutcome;
  proposalId?: string;
  code?: string;
  contextHash?: string;
}

export interface WeekRunRecord {
  id: string;
  weekStart: string;
  status: WeekRunStatus;
  failureClass: WeekRunFailureClass | null;
  days: WeekRunDay[];
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  nextAllowedAt: string | null;
}

interface WeekRunRow {
  id: string;
  week_start: string;
  status: WeekRunStatus;
  failure_class: WeekRunFailureClass | null;
  days_json: string;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  next_allowed_at: string | null;
}

const toRecord = (r: WeekRunRow): WeekRunRecord => ({
  id: r.id,
  weekStart: r.week_start,
  status: r.status,
  failureClass: r.failure_class,
  days: JSON.parse(r.days_json) as WeekRunDay[],
  startedAt: r.started_at,
  heartbeatAt: r.heartbeat_at,
  finishedAt: r.finished_at,
  nextAllowedAt: r.next_allowed_at,
});

export type AcquireResult =
  | { kind: 'acquired'; run: WeekRunRecord }
  | { kind: 'in_progress'; run: WeekRunRecord }
  | { kind: 'backoff'; run: WeekRunRecord; retryAfter: string };

export class WeekGenerationRunRepo {
  constructor(private db: Database.Database) {}

  /** The running run for a week, if any (stale or not). */
  running(weekStart: string): WeekRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM ai_week_generation_runs WHERE week_start = ? AND status = 'running'").get(weekStart) as WeekRunRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  latestFinished(weekStart: string): WeekRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM ai_week_generation_runs WHERE week_start = ? AND status <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(weekStart) as WeekRunRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Most-recent-first finished runs, for counting consecutive provider failures. */
  recentFinished(weekStart: string, limit: number): WeekRunRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM ai_week_generation_runs WHERE week_start = ? AND status <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT ?")
        .all(weekStart, limit) as WeekRunRow[]
    ).map(toRecord);
  }

  /** The guard. In ONE synchronous transaction: a running run whose
   * heartbeat is older than `staleBeforeIso` is marked abandoned; a still
   * fresh running run is returned as in_progress; an active provider
   * backoff is returned as backoff; otherwise a new running run is
   * inserted (the partial unique index makes a second concurrent insert
   * impossible even if this were ever called outside a transaction). */
  acquire(weekStart: string, days: WeekRunDay[], nowIsoTimestamp: string, staleBeforeIso: string): AcquireResult {
    return this.db.transaction((): AcquireResult => {
      const current = this.running(weekStart);
      if (current) {
        if (current.heartbeatAt >= staleBeforeIso) return { kind: 'in_progress', run: current };
        this.db
          .prepare("UPDATE ai_week_generation_runs SET status = 'abandoned', failure_class = 'abandoned', finished_at = ? WHERE id = ?")
          .run(nowIsoTimestamp, current.id);
      }
      const last = this.latestFinished(weekStart);
      if (last?.nextAllowedAt && last.nextAllowedAt > nowIsoTimestamp) return { kind: 'backoff', run: last, retryAfter: last.nextAllowedAt };
      const row: WeekRunRow = {
        id: newId('weekrun'),
        week_start: weekStart,
        status: 'running',
        failure_class: null,
        days_json: JSON.stringify(days),
        started_at: nowIsoTimestamp,
        heartbeat_at: nowIsoTimestamp,
        finished_at: null,
        next_allowed_at: null,
      };
      this.db
        .prepare(
          `INSERT INTO ai_week_generation_runs (id, week_start, status, failure_class, days_json, started_at, heartbeat_at, finished_at, next_allowed_at)
           VALUES (@id, @week_start, @status, @failure_class, @days_json, @started_at, @heartbeat_at, @finished_at, @next_allowed_at)`
        )
        .run(row);
      return { kind: 'acquired', run: toRecord(row) };
    })();
  }

  /** Heartbeat + latest per-day outcomes, while the run is still running. */
  update(runId: string, days: WeekRunDay[]): void {
    this.db
      .prepare("UPDATE ai_week_generation_runs SET days_json = ?, heartbeat_at = ? WHERE id = ? AND status = 'running'")
      .run(JSON.stringify(days), nowIso(), runId);
  }

  finish(runId: string, status: Exclude<WeekRunStatus, 'running'>, days: WeekRunDay[], failureClass: WeekRunFailureClass | null, nextAllowedAt: string | null): void {
    const now = nowIso();
    this.db
      .prepare(
        "UPDATE ai_week_generation_runs SET status = ?, days_json = ?, failure_class = ?, next_allowed_at = ?, heartbeat_at = ?, finished_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(status, JSON.stringify(days), failureClass, nextAllowedAt, now, now, runId);
  }

  getById(runId: string): WeekRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM ai_week_generation_runs WHERE id = ?').get(runId) as WeekRunRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  // ---- same-context quality gate for week-run days ----

  dayFailure(targetDate: string, contextHash: string): { code: string; issues: string[]; failedAt: string } | undefined {
    const row = this.db
      .prepare('SELECT code, issues_json, failed_at FROM ai_week_generation_day_failures WHERE target_date = ? AND context_hash = ?')
      .get(targetDate, contextHash) as { code: string; issues_json: string; failed_at: string } | undefined;
    return row ? { code: row.code, issues: JSON.parse(row.issues_json) as string[], failedAt: row.failed_at } : undefined;
  }

  recordDayFailure(targetDate: string, contextHash: string, code: string, issues: string[], runId: string): void {
    this.db
      .prepare(
        `INSERT INTO ai_week_generation_day_failures (target_date, context_hash, code, issues_json, run_id, failed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_date, context_hash) DO UPDATE SET code = excluded.code, issues_json = excluded.issues_json, run_id = excluded.run_id, failed_at = excluded.failed_at`
      )
      .run(targetDate, contextHash, code, JSON.stringify(issues), runId, nowIso());
  }

  clearDayFailure(targetDate: string, contextHash: string): void {
    this.db.prepare('DELETE FROM ai_week_generation_day_failures WHERE target_date = ? AND context_hash = ?').run(targetDate, contextHash);
  }
}
