// AI Programmer Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md
// §4/§9): persistence for AI-generated workout proposals. Status
// transitions are enforced entirely here in application code — not a DB
// constraint/trigger — matching this codebase's existing style for
// other state machines (see GoalPhaseRepo's `transition()` helper).
//
// `id` is always the same UUID as the in-memory
// `AIWorkoutSessionProposal.proposalId` the service already generated
// (never a second, different identifier) — this is what guarantees
// "the response proposalId equals the persisted proposal id" (spec §5)
// trivially, by construction, rather than by convention.

import type Database from 'better-sqlite3';
import type { AIWorkoutSessionProposal } from '../ai-programmer/contracts/programmerTypes.js';
import { nowIso } from './ids.js';

export type AIProposalStatus = 'pending' | 'approved' | 'committed' | 'rejected' | 'expired';

/** Spec §12's recommended default: a proposal is commit-able for 24
 * hours after generation. Deterministic and timezone-safe because both
 * `createdAt` and `expiresAt` are plain UTC ISO instants (`nowIso()`),
 * never a calendar date or a wall-clock/local-timezone computation. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export function computeExpiresAt(createdAtIso: string): string {
  return new Date(new Date(createdAtIso).getTime() + PROPOSAL_TTL_MS).toISOString();
}

export interface AIProposalRecord {
  id: string;
  status: AIProposalStatus;
  targetDate: string;
  weekday: string;
  proposal: AIWorkoutSessionProposal;
  /** AUDIT METADATA ONLY — the generation-time
   * `AIProgrammerContext.contextHash`, kept so a specific historical
   * proposal's exact source context can be identified for debugging.
   * NOT compared against a freshly-computed hash at commit time: it
   * necessarily includes point-in-time-volatile facts (current date,
   * live exposure/recovery snapshots), so an exact-match check would
   * fail almost any proposal older than a few minutes regardless of
   * whether anything commit-relevant actually changed. The real
   * staleness guard is `blueprintCommit` equality plus a full domain
   * revalidation against a freshly rebuilt context — see
   * `commitAIProposalToPlannedSession()` in
   * `src/ai-programmer/service/aiProposalLifecycle.ts`. */
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

export interface CreateAIProposalInput {
  proposal: AIWorkoutSessionProposal;
  contextHash: string;
  blueprintCommit: string;
  modelProvider: string;
  modelName: string;
  requestId: string;
}

/** A stored `proposal_json` value that is not valid JSON, or does not
 * parse back into an object — never trusted at commit time without this
 * check (spec §4: "do not trust stored JSON without revalidation"). */
export class MalformedProposalJsonError extends Error {
  constructor(public proposalId: string) {
    super(`Stored proposal_json for proposal "${proposalId}" is not valid JSON`);
    this.name = 'MalformedProposalJsonError';
  }
}

interface AIProposalRow {
  id: string;
  status: AIProposalStatus;
  target_date: string;
  weekday: string;
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

function rowToRecord(row: AIProposalRow): AIProposalRecord {
  let proposal: AIWorkoutSessionProposal;
  try {
    proposal = JSON.parse(row.proposal_json) as AIWorkoutSessionProposal;
  } catch {
    throw new MalformedProposalJsonError(row.id);
  }
  return {
    id: row.id,
    status: row.status,
    targetDate: row.target_date,
    weekday: row.weekday,
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

/** A proposal's effective status is `expired` once past `expiresAt`,
 * even before anything writes that to the row (spec §12: "retrieval
 * should expose expiry status"). Only `pending`/`approved` can lapse
 * into `expired` this way — a `committed`/`rejected`/already-`expired`
 * row's status is always its stored, terminal value. Pure function, no
 * DB write — callers that need the transition PERSISTED (approve/commit)
 * use `AIProposalRepo.expireIfNeeded()` instead. */
export function effectiveStatus(record: Pick<AIProposalRecord, 'status' | 'expiresAt'>, nowIsoTimestamp: string): AIProposalStatus {
  if ((record.status === 'pending' || record.status === 'approved') && record.expiresAt < nowIsoTimestamp) {
    return 'expired';
  }
  return record.status;
}

export class AIProposalRepo {
  constructor(private db: Database.Database) {}

  create(input: CreateAIProposalInput): AIProposalRecord {
    const now = nowIso();
    const row: AIProposalRow = {
      id: input.proposal.proposalId,
      status: 'pending',
      target_date: input.proposal.targetDate,
      weekday: input.proposal.weekday,
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
      expires_at: computeExpiresAt(now),
    };
    this.db
      .prepare(
        `INSERT INTO ai_program_proposals
           (id, status, target_date, weekday, proposal_json, context_hash, blueprint_commit,
            model_provider, model_name, request_id, committed_session_id, failure_reason,
            created_at, updated_at, approved_at, committed_at, rejected_at, expires_at)
         VALUES
           (@id, @status, @target_date, @weekday, @proposal_json, @context_hash, @blueprint_commit,
            @model_provider, @model_name, @request_id, @committed_session_id, @failure_reason,
            @created_at, @updated_at, @approved_at, @committed_at, @rejected_at, @expires_at)`
      )
      .run(row);
    return rowToRecord(row);
  }

  getById(id: string): AIProposalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM ai_program_proposals WHERE id = ?').get(id) as AIProposalRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Every planned/completed/etc. workout session created FROM a
   * committed proposal is found via `committed_session_id` on the
   * proposal row, not the other way around — no reverse index needed at
   * this scale (single-user application). */

  /** A genuinely conditional update — `WHERE status IN (...)` is part of
   * the SQL itself, not a separate "read status, then write" pair of
   * calls — so two racing transition attempts on the same row can never
   * both succeed: whichever UPDATE the SQLite engine applies first
   * changes the row's status out of `from`, and the second UPDATE's own
   * `WHERE status IN (...)` clause then matches zero rows and reports
   * `changes: 0` (spec §9: "use the database transaction, unique
   * constraints, [or] conditional updates... do not implement race
   * protection only with an in-memory boolean" — this is the conditional-
   * update option, not an in-memory flag). */
  private transition(id: string, from: readonly AIProposalStatus[], to: AIProposalStatus, extraSql: string, extraParams: Record<string, unknown> = {}): AIProposalRecord | undefined {
    const fromParams: Record<string, unknown> = {};
    const whereIn = from.map((status, i) => {
      fromParams[`from${i}`] = status;
      return `@from${i}`;
    });
    const result = this.db
      .prepare(
        `UPDATE ai_program_proposals SET status = @status, updated_at = @updated_at${extraSql} WHERE id = @id AND status IN (${whereIn.join(', ')})`
      )
      .run({ id, status: to, updated_at: nowIso(), ...extraParams, ...fromParams });
    if (result.changes === 0) return undefined;
    return this.getById(id);
  }

  /** pending -> approved. Never touches `proposal_json` (spec §7:
   * "approval must not mutate the proposal's workout content"). Returns
   * `undefined` if the proposal isn't currently `pending` (including
   * when it's already `approved` — callers that want idempotent-approve
   * behavior check for that case themselves before calling this, since
   * only the service layer knows whether "already approved" should be a
   * success or a conflict for a given caller). */
  approve(id: string): AIProposalRecord | undefined {
    return this.transition(id, ['pending'], 'approved', ', approved_at = @approved_at', { approved_at: nowIso() });
  }

  /** approved -> committed. `sessionId` is the `workout_sessions.session_id`
   * created for this proposal — recorded so a repeated commit request is
   * idempotent (spec §9). */
  markCommitted(id: string, sessionId: string): AIProposalRecord | undefined {
    return this.transition(id, ['approved'], 'committed', ', committed_at = @committed_at, committed_session_id = @committed_session_id', {
      committed_at: nowIso(),
      committed_session_id: sessionId,
    });
  }

  /** (pending|approved) -> expired. Called lazily by the approve/commit
   * service paths the moment an expired proposal is actually acted on —
   * never by a background sweep — so a proposal's stored status only
   * ever changes as the direct result of an explicit request touching
   * it (spec §12: "expiry must not delete audit history automatically"). */
  markExpired(id: string): AIProposalRecord | undefined {
    return this.transition(id, ['pending', 'approved'], 'expired', '');
  }

  /** Records why a commit attempt failed without changing `status` —
   * the proposal stays `approved` (still eligible for a future commit
   * retry once the underlying condition is fixed, e.g. a transient DB
   * error) or the caller has already independently transitioned it (e.g.
   * to `expired`) before calling this. Purely a diagnostic annotation. */
  recordFailure(id: string, reason: string): AIProposalRecord | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    this.db
      .prepare('UPDATE ai_program_proposals SET failure_reason = @failure_reason, updated_at = @updated_at WHERE id = @id')
      .run({ id, failure_reason: reason, updated_at: nowIso() });
    return this.getById(id);
  }
}
