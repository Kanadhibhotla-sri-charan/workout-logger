// AI-Powered Weekly Reconciliation: persistence for AI-generated week-
// reconciliation proposals — a DISTINCT table/repo from
// aiProposalRepo.ts (see schema.sql's own comment on why), mirroring its
// exact pending/approved/committed/rejected/expired lifecycle
// convention and conditional-UPDATE race-safety pattern rather than
// reinventing either.

import type Database from 'better-sqlite3';
import type { AIWeekReconciliationOutput } from '../ai-programmer/contracts/weekReconciliationTypes.js';
import { nowIso } from './ids.js';

export type AIWeekReconciliationStatus = 'pending' | 'approved' | 'committed' | 'rejected' | 'expired';

/** Same 24h window as ai_program_proposals (AIProposalRepo.PROPOSAL_TTL_MS) — no reason for this lifecycle to behave differently. */
export const WEEK_RECONCILIATION_TTL_MS = 24 * 60 * 60 * 1000;

export function computeWeekReconciliationExpiresAt(createdAtIso: string): string {
  return new Date(new Date(createdAtIso).getTime() + WEEK_RECONCILIATION_TTL_MS).toISOString();
}

export interface AIWeekReconciliationRecord {
  id: string;
  status: AIWeekReconciliationStatus;
  targetDate: string;
  weekStart: string;
  requestedActivity: string;
  proposal: AIWeekReconciliationOutput;
  /** AUDIT METADATA ONLY, same caveat as AIProposalRecord.contextHash —
   * never compared against a freshly-computed hash at commit time. */
  contextHash: string;
  blueprintCommit: string;
  modelProvider: string;
  modelName: string;
  requestId: string;
  committedSessionId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  committedAt: string | null;
  rejectedAt: string | null;
  expiresAt: string;
}

export interface CreateAIWeekReconciliationInput {
  proposal: AIWeekReconciliationOutput;
  weekStart: string;
  contextHash: string;
  blueprintCommit: string;
  modelProvider: string;
  modelName: string;
  requestId: string;
}

export class MalformedWeekReconciliationJsonError extends Error {
  constructor(public reconciliationId: string) {
    super(`Stored proposal_json for week-reconciliation proposal "${reconciliationId}" is not valid JSON`);
    this.name = 'MalformedWeekReconciliationJsonError';
  }
}

interface AIWeekReconciliationRow {
  id: string;
  status: AIWeekReconciliationStatus;
  target_date: string;
  week_start: string;
  requested_activity: string;
  proposal_json: string;
  context_hash: string;
  blueprint_commit: string;
  model_provider: string;
  model_name: string;
  request_id: string;
  committed_session_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  committed_at: string | null;
  rejected_at: string | null;
  expires_at: string;
}

function rowToRecord(row: AIWeekReconciliationRow): AIWeekReconciliationRecord {
  let proposal: AIWeekReconciliationOutput;
  try {
    proposal = JSON.parse(row.proposal_json) as AIWeekReconciliationOutput;
  } catch {
    throw new MalformedWeekReconciliationJsonError(row.id);
  }
  return {
    id: row.id,
    status: row.status,
    targetDate: row.target_date,
    weekStart: row.week_start,
    requestedActivity: row.requested_activity,
    proposal,
    contextHash: row.context_hash,
    blueprintCommit: row.blueprint_commit,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    requestId: row.request_id,
    committedSessionId: row.committed_session_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    committedAt: row.committed_at,
    rejectedAt: row.rejected_at,
    expiresAt: row.expires_at,
  };
}

export class AIWeekReconciliationRepo {
  constructor(private db: Database.Database) {}

  create(input: CreateAIWeekReconciliationInput): AIWeekReconciliationRecord {
    const now = nowIso();
    const row: AIWeekReconciliationRow = {
      id: input.proposal.proposalId,
      status: 'pending',
      target_date: input.proposal.targetDate,
      week_start: input.weekStart,
      requested_activity: input.proposal.requestedActivity,
      proposal_json: JSON.stringify(input.proposal),
      context_hash: input.contextHash,
      blueprint_commit: input.blueprintCommit,
      model_provider: input.modelProvider,
      model_name: input.modelName,
      request_id: input.requestId,
      committed_session_id: null,
      failure_reason: null,
      created_at: now,
      updated_at: now,
      approved_at: null,
      committed_at: null,
      rejected_at: null,
      expires_at: computeWeekReconciliationExpiresAt(now),
    };
    this.db
      .prepare(
        `INSERT INTO ai_week_reconciliation_proposals
           (id, status, target_date, week_start, requested_activity, proposal_json, context_hash, blueprint_commit,
            model_provider, model_name, request_id, committed_session_id, failure_reason,
            created_at, updated_at, approved_at, committed_at, rejected_at, expires_at)
         VALUES
           (@id, @status, @target_date, @week_start, @requested_activity, @proposal_json, @context_hash, @blueprint_commit,
            @model_provider, @model_name, @request_id, @committed_session_id, @failure_reason,
            @created_at, @updated_at, @approved_at, @committed_at, @rejected_at, @expires_at)`
      )
      .run(row);
    return rowToRecord(row);
  }

  getById(id: string): AIWeekReconciliationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM ai_week_reconciliation_proposals WHERE id = ?').get(id) as AIWeekReconciliationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** The single most recently CREATED reconciliation proposal for a
   * given target date, regardless of status — same ordering contract as
   * AIProposalRepo.findLatestForTargetDate. */
  findLatestForTargetDate(targetDate: string): AIWeekReconciliationRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM ai_week_reconciliation_proposals WHERE target_date = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(targetDate) as AIWeekReconciliationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Same conditional-`UPDATE ... WHERE status IN (...)` race-safety
   * pattern as AIProposalRepo.transition — see its own doc comment. */
  private transition(
    id: string,
    from: readonly AIWeekReconciliationStatus[],
    to: AIWeekReconciliationStatus,
    extraSql: string,
    extraParams: Record<string, unknown> = {},
    extraWhereSql = '',
    extraWhereParams: Record<string, unknown> = {}
  ): AIWeekReconciliationRecord | undefined {
    const fromParams: Record<string, unknown> = {};
    const whereIn = from.map((status, i) => {
      fromParams[`from${i}`] = status;
      return `@from${i}`;
    });
    const result = this.db
      .prepare(
        `UPDATE ai_week_reconciliation_proposals SET status = @status, updated_at = @updated_at${extraSql} WHERE id = @id AND status IN (${whereIn.join(', ')})${extraWhereSql}`
      )
      .run({ id, status: to, updated_at: nowIso(), ...extraParams, ...fromParams, ...extraWhereParams });
    if (result.changes === 0) return undefined;
    return this.getById(id);
  }

  approve(id: string): AIWeekReconciliationRecord | undefined {
    return this.transition(id, ['pending'], 'approved', ', approved_at = @approved_at', { approved_at: nowIso() });
  }

  markCommitted(id: string, sessionId: string): AIWeekReconciliationRecord | undefined {
    return this.transition(
      id,
      ['approved'],
      'committed',
      ', committed_at = @committed_at, committed_session_id = @committed_session_id',
      { committed_at: nowIso(), committed_session_id: sessionId },
      ' AND expires_at >= @now',
      { now: nowIso() }
    );
  }

  markExpired(id: string): AIWeekReconciliationRecord | undefined {
    return this.transition(id, ['pending', 'approved'], 'expired', '');
  }

  recordFailure(id: string, reason: string): AIWeekReconciliationRecord | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    this.db
      .prepare('UPDATE ai_week_reconciliation_proposals SET failure_reason = @failure_reason, updated_at = @updated_at WHERE id = @id')
      .run({ id, failure_reason: reason, updated_at: nowIso() });
    return this.getById(id);
  }
}
