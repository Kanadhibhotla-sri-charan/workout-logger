// AI Programmer Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md
// §15 "Repository tests"): AIProposalRepo in isolation, no HTTP layer,
// no provider — same in-memory-SQLite pattern as every other repo test
// in this codebase (see tests/repositories/goalPhaseRepo.test.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { AIProposalRepo, MalformedProposalJsonError, computeExpiresAt, effectiveStatus } from '../../src/repositories/aiProposalRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION, type AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';

/** `ai_program_proposals.committed_session_id` has a real FK to
 * `workout_sessions(session_id)` (schema.sql) — so any test that
 * commits a proposal must point it at a session that genuinely exists,
 * exactly the way commitAIProposalToPlannedSession() itself would. */
function createRealSession(database: Database.Database): string {
  return new WorkoutSessionsRepo(database).createSession({ date: '2026-09-13', session_type: 'gym', status: 'planned' }).session_id;
}

let db: Database.Database;

function makeProposal(overrides: Partial<AIWorkoutSessionProposal> = {}): AIWorkoutSessionProposal {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'proposal-1',
    mode: 'generate_session',
    targetDate: '2026-09-13',
    weekday: 'sunday',
    sessionFocus: ['chest'],
    exercises: [
      {
        exerciseId: 'flat-barbell-bench-press',
        role: 'primary',
        targetType: 'physique_target',
        targetId: 'mid-pec',
        sets: 3,
        repsMin: 6,
        repsMax: 12,
        rirMin: 1,
        rirMax: 3,
        rationale: ['Direct mid-pec exposure.'],
        source: 'blueprint',
      },
    ],
    programmingRationale: ['Chest focus this session.'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('AIProposalRepo — create/retrieve', () => {
  it('creates a proposal in pending status, with the row id equal to proposal.proposalId', () => {
    const repo = new AIProposalRepo(db);
    const record = repo.create({
      proposal: makeProposal(),
      contextHash: 'ctx-hash-1',
      blueprintCommit: 'bp-commit-1',
      modelProvider: 'velona',
      modelName: 'velona-model',
      requestId: 'req-1',
    });
    expect(record.id).toBe('proposal-1');
    expect(record.status).toBe('pending');
    expect(record.targetDate).toBe('2026-09-13');
    expect(record.weekday).toBe('sunday');
    expect(record.committedSessionId).toBeNull();
    expect(record.approvedAt).toBeNull();
    expect(record.committedAt).toBeNull();
  });

  it('preserves the exact validated proposal JSON, round-tripped', () => {
    const repo = new AIProposalRepo(db);
    const proposal = makeProposal({ programmingRationale: ['a', 'b', 'c'] });
    repo.create({ proposal, contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    const fetched = repo.getById('proposal-1');
    expect(fetched?.proposal).toEqual(proposal);
  });

  it('retrieves a known proposal by id', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    expect(repo.getById('proposal-1')).toBeDefined();
  });

  it('returns undefined for an unknown proposal id', () => {
    const repo = new AIProposalRepo(db);
    expect(repo.getById('does-not-exist')).toBeUndefined();
  });

  it('sets expires_at to exactly created_at + 24h', () => {
    const repo = new AIProposalRepo(db);
    const record = repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    expect(record.expiresAt).toBe(computeExpiresAt(record.createdAt));
    expect(new Date(record.expiresAt).getTime() - new Date(record.createdAt).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('throws MalformedProposalJsonError if proposal_json is corrupted in storage', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    db.prepare('UPDATE ai_program_proposals SET proposal_json = ? WHERE id = ?').run('{not valid json', 'proposal-1');
    expect(() => repo.getById('proposal-1')).toThrow(MalformedProposalJsonError);
  });
});

describe('AIProposalRepo — status transitions', () => {
  it('approve(): pending -> approved, records approved_at, leaves proposal_json untouched', () => {
    const repo = new AIProposalRepo(db);
    const proposal = makeProposal();
    repo.create({ proposal, contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    const approved = repo.approve('proposal-1');
    expect(approved?.status).toBe('approved');
    expect(approved?.approvedAt).not.toBeNull();
    expect(approved?.proposal).toEqual(proposal);
  });

  it('approve(): returns undefined (rejects) for a proposal that is not pending', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    expect(repo.approve('proposal-1')).toBeUndefined(); // already approved
  });

  it('markCommitted(): approved -> committed, records committed_at + committed_session_id', () => {
    const repo = new AIProposalRepo(db);
    const sessionId = createRealSession(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    const committed = repo.markCommitted('proposal-1', sessionId);
    expect(committed?.status).toBe('committed');
    expect(committed?.committedSessionId).toBe(sessionId);
    expect(committed?.committedAt).not.toBeNull();
  });

  it('markCommitted(): rejects a pending (never-approved) proposal', () => {
    const repo = new AIProposalRepo(db);
    const sessionId = createRealSession(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    expect(repo.markCommitted('proposal-1', sessionId)).toBeUndefined();
  });

  it('markCommitted(): a second call after a successful commit does not change anything (conditional UPDATE matches zero rows)', () => {
    const repo = new AIProposalRepo(db);
    const sessionId1 = createRealSession(db);
    const sessionId2 = createRealSession(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    const first = repo.markCommitted('proposal-1', sessionId1);
    const second = repo.markCommitted('proposal-1', sessionId2);
    expect(first?.committedSessionId).toBe(sessionId1);
    expect(second).toBeUndefined(); // the second attempt is rejected by the DB, not silently applied
    expect(repo.getById('proposal-1')?.committedSessionId).toBe(sessionId1); // still the first session, never overwritten
  });

  it('markCommitted(): rejects an approved proposal whose expires_at has already passed, even before markExpired() has run (cleanup pass §2 atomic expiry guard)', () => {
    const repo = new AIProposalRepo(db);
    const sessionId = createRealSession(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    // Simulate the row having crossed its expiry boundary without the
    // lazy pending/approved -> expired transition having run yet — the
    // stored `status` still reads 'approved'.
    db.prepare('UPDATE ai_program_proposals SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', 'proposal-1');
    expect(repo.getById('proposal-1')?.status).toBe('approved'); // status alone doesn't yet reflect expiry

    expect(repo.markCommitted('proposal-1', sessionId)).toBeUndefined(); // the atomic WHERE clause rejects it anyway
    expect(repo.getById('proposal-1')?.status).toBe('approved'); // untouched — no partial/incorrect commit
    expect(repo.getById('proposal-1')?.committedSessionId).toBeNull();
  });

  it('markCommitted(): still succeeds for an approved proposal that has not yet expired', () => {
    const repo = new AIProposalRepo(db);
    const sessionId = createRealSession(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    db.prepare('UPDATE ai_program_proposals SET expires_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', 'proposal-1');
    expect(repo.markCommitted('proposal-1', sessionId)?.status).toBe('committed');
  });

  it('markExpired(): pending -> expired, and approved -> expired', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal({ proposalId: 'p-pending' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    expect(repo.markExpired('p-pending')?.status).toBe('expired');

    repo.create({ proposal: makeProposal({ proposalId: 'p-approved' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('p-approved');
    expect(repo.markExpired('p-approved')?.status).toBe('expired');
  });

  it('markExpired(): does not touch an already-committed proposal', () => {
    const repo = new AIProposalRepo(db);
    const sessionId = createRealSession(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    repo.markCommitted('proposal-1', sessionId);
    expect(repo.markExpired('proposal-1')).toBeUndefined();
    expect(repo.getById('proposal-1')?.status).toBe('committed');
  });

  it('recordFailure(): sets failure_reason without changing status', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.approve('proposal-1');
    const updated = repo.recordFailure('proposal-1', 'simulated persistence error');
    expect(updated?.failureReason).toBe('simulated persistence error');
    expect(updated?.status).toBe('approved');
  });
});

// Discovery/Rehydration
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PROPOSAL_DISCOVERY_REHYDRATION.md
// §3): repository-level tests for the ordering/date-scoping contract
// findLatestForTargetDate makes — the service-layer/route-level tests
// (tests/ai-programmer/aiProposalRoutes.test.ts) cover the same
// behavior end-to-end through HTTP; these isolate the SQL query itself.
describe('AIProposalRepo — findLatestForTargetDate', () => {
  it('returns undefined when no proposal exists for the date', () => {
    const repo = new AIProposalRepo(db);
    expect(repo.findLatestForTargetDate('2026-09-13')).toBeUndefined();
  });

  it('returns the single proposal for a date when only one exists', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    expect(repo.findLatestForTargetDate('2026-09-13')?.id).toBe('proposal-1');
  });

  it('orders by created_at DESC — the most recently created proposal wins, not insertion order', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal({ proposalId: 'proposal-older' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.create({ proposal: makeProposal({ proposalId: 'proposal-newer' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    // Force explicit, unambiguous created_at values rather than relying
    // on real insertion timing being fast enough to differ.
    db.prepare("UPDATE ai_program_proposals SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = 'proposal-older'").run();
    db.prepare("UPDATE ai_program_proposals SET created_at = '2026-06-01T00:00:00.000Z' WHERE id = 'proposal-newer'").run();

    expect(repo.findLatestForTargetDate('2026-09-13')?.id).toBe('proposal-newer');
  });

  it('breaks a created_at tie deterministically by id', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal({ proposalId: 'proposal-aaa' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.create({ proposal: makeProposal({ proposalId: 'proposal-zzz' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    const sameInstant = '2026-01-01T00:00:00.000Z';
    db.prepare("UPDATE ai_program_proposals SET created_at = ? WHERE id = 'proposal-aaa'").run(sameInstant);
    db.prepare("UPDATE ai_program_proposals SET created_at = ? WHERE id = 'proposal-zzz'").run(sameInstant);

    // Deterministic (id DESC), not "whichever the DB happens to return
    // first" — run it twice to rule out incidental row-order stability.
    expect(repo.findLatestForTargetDate('2026-09-13')?.id).toBe('proposal-zzz');
    expect(repo.findLatestForTargetDate('2026-09-13')?.id).toBe('proposal-zzz');
  });

  it('never returns a proposal for a different target date', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal({ proposalId: 'proposal-sun', targetDate: '2026-09-13', weekday: 'sunday' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    repo.create({ proposal: makeProposal({ proposalId: 'proposal-mon', targetDate: '2026-09-14', weekday: 'monday' }), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });

    expect(repo.findLatestForTargetDate('2026-09-13')?.id).toBe('proposal-sun');
    expect(repo.findLatestForTargetDate('2026-09-14')?.id).toBe('proposal-mon');
  });

  it('returns a proposal regardless of its status — expired/rejected/committed are still "the latest attempt for this date"', () => {
    const repo = new AIProposalRepo(db);
    repo.create({ proposal: makeProposal(), contextHash: 'h', blueprintCommit: 'b', modelProvider: 'velona', modelName: 'm', requestId: 'r' });
    db.prepare("UPDATE ai_program_proposals SET status = 'rejected' WHERE id = 'proposal-1'").run();
    expect(repo.findLatestForTargetDate('2026-09-13')?.status).toBe('rejected');
  });
});

describe('effectiveStatus()', () => {
  it('reports "expired" for a pending/approved record past its expiresAt, without mutating anything', () => {
    const past = { status: 'pending' as const, expiresAt: '2020-01-01T00:00:00.000Z' };
    expect(effectiveStatus(past, '2026-01-01T00:00:00.000Z')).toBe('expired');
  });

  it('reports the stored status for a committed/rejected/expired record regardless of expiresAt', () => {
    expect(effectiveStatus({ status: 'committed', expiresAt: '2020-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z')).toBe('committed');
  });

  it('reports the stored status for a not-yet-expired pending/approved record', () => {
    expect(effectiveStatus({ status: 'approved', expiresAt: '2030-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z')).toBe('approved');
  });
});
