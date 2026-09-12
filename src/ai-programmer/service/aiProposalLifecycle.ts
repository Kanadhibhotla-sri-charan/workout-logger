// AI Programmer Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md):
// retrieval, explicit approval, and the ONLY function allowed to commit
// an AI proposal into the real workout/session data model. Never calls
// the LLM/provider — everything here operates on an already-generated,
// already-persisted proposal (spec §10.5: "never call the LLM/provider").

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { AIProposalRepo, type AIProposalRecord } from '../../repositories/aiProposalRepo.js';
import { nowIso } from '../../repositories/ids.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { buildProgrammerContext } from '../context/programmerContextBuilder.js';
import {
  AIProposalCommitFailedError,
  AIProposalConflictError,
  AIProposalExpiredError,
  AIProposalInvalidStateError,
  AIProposalNotFoundError,
  AIProposalStaleError,
  AIProposalValidationFailedError,
} from '../errors.js';
import { validateProposalDomain } from '../validation/programmerDomainValidator.js';
import { validateProposalSchema } from '../validation/programmerOutputValidator.js';

/** Loads a proposal and, if it is still `pending`/`approved` but past
 * its `expires_at`, persists the lazy pending/approved -> expired
 * transition right now (never on a background timer — see
 * AIProposalRepo.markExpired's own doc comment) before returning it, so
 * every caller (retrieval, approve, commit) observes a consistent,
 * truthful status. */
function loadCurrent(db: Database.Database, proposalId: string): AIProposalRecord {
  const repo = new AIProposalRepo(db);
  const record = repo.getById(proposalId);
  if (!record) throw new AIProposalNotFoundError(proposalId);
  if ((record.status === 'pending' || record.status === 'approved') && record.expiresAt < nowIso()) {
    return repo.markExpired(proposalId) ?? record;
  }
  return record;
}

export function getProposal(db: Database.Database, proposalId: string): AIProposalRecord {
  return loadCurrent(db, proposalId);
}

/** Explicit approval only — never commits, never mutates the proposal's
 * own JSON content (spec §7). Approving an already-`approved` proposal
 * is idempotent (returns the existing record unchanged rather than
 * erroring); every other non-`pending` state is a documented conflict. */
export function approveProposal(db: Database.Database, proposalId: string): AIProposalRecord {
  const record = loadCurrent(db, proposalId);
  if (record.status === 'approved') return record;
  if (record.status === 'expired') throw new AIProposalExpiredError(proposalId, record.expiresAt);
  if (record.status !== 'pending') throw new AIProposalInvalidStateError(proposalId, record.status, 'approved');

  const approved = new AIProposalRepo(db).approve(proposalId);
  if (!approved) {
    // Lost a race with another request that changed this proposal's
    // status between loadCurrent() above and this conditional UPDATE —
    // re-read and report whatever state it actually landed in.
    const current = new AIProposalRepo(db).getById(proposalId);
    throw new AIProposalInvalidStateError(proposalId, current?.status ?? record.status, 'approved');
  }
  return approved;
}

export interface CommitAIProposalResult {
  sessionId: string;
  proposal: AIProposalRecord;
}

/** The only function in this codebase allowed to translate an AI
 * proposal into a real, persisted planned workout session (spec §10).
 * Accepts only an already-validated, already-approved proposal by id;
 * revalidates everything about CURRENT state before writing anything
 * (spec §8: "do not rely only on validation performed during
 * generation"); never calls the provider.
 *
 * Concurrency (spec §9's "race protection... not only an in-memory
 * boolean"): the actual proposal -> committed transition is a
 * conditional `UPDATE ... WHERE status IN (...)` (AIProposalRepo.
 * markCommitted), so two racing commit calls can never both succeed even
 * in principle. In THIS application (a single Node process, a
 * synchronous better-sqlite3 connection, and no `await` anywhere between
 * this function's preconditions and its transaction), two "simultaneous"
 * HTTP commit requests are additionally serialized in practice by
 * Node's single-threaded event loop — the whole commit transaction below
 * runs to completion before the second request's handler code executes
 * at all. The conditional UPDATE is what makes that a real guarantee
 * rather than an assumption that happens to hold today. */
export function commitAIProposalToPlannedSession(db: Database.Database, proposalId: string): CommitAIProposalResult {
  const repo = new AIProposalRepo(db);
  const record = loadCurrent(db, proposalId);

  // Idempotency (spec §9): repeated commit of an already-committed
  // proposal returns the SAME committed_session_id — never a duplicate
  // session, never an error.
  if (record.status === 'committed') {
    if (!record.committedSessionId) throw new AIProposalCommitFailedError(proposalId);
    return { sessionId: record.committedSessionId, proposal: record };
  }
  if (record.status === 'expired') throw new AIProposalExpiredError(proposalId, record.expiresAt);
  if (record.status !== 'approved') throw new AIProposalInvalidStateError(proposalId, record.status, 'committed');

  // "Proposal JSON parses successfully" / "passes structural validation"
  // (spec §8) — re-checked here rather than assumed from generation
  // time. AIProposalRepo.getById already throws MalformedProposalJsonError
  // (a plain Error, not an AIProgrammerError) if proposal_json itself
  // isn't valid JSON; that surfaces via loadCurrent() above and is left
  // to propagate to the route's generic 500 handler, since a row this
  // codebase itself wrote should never actually be malformed JSON.
  const structural = validateProposalSchema(record.proposal);
  if (!structural.ok || !structural.value) {
    throw new AIProposalValidationFailedError(proposalId, structural.errors);
  }
  const proposal = structural.value;

  // Blueprint/context staleness (spec §13): compare the Blueprint
  // commit captured at generation time against the current one before
  // doing anything else.
  const currentBlueprintCommit = BlueprintAdapter.getManifest().sourceCommit;
  if (currentBlueprintCommit !== record.blueprintCommit) {
    throw new AIProposalStaleError(proposalId, [
      `Blueprint changed since this proposal was generated (was "${record.blueprintCommit}", now "${currentBlueprintCommit}")`,
    ]);
  }

  // Rebuild the FULL context fresh against current DB state — this
  // reuses buildProgrammerContext's own existing checks for "target date
  // still valid" and "no completed/in-progress session already there"
  // (it throws AITargetNotEditableError, itself an AIProgrammerError
  // with its own 409 status, if either fails) rather than duplicating
  // that logic here.
  const context = buildProgrammerContext(db, { targetDate: proposal.targetDate });

  // Full domain revalidation against the FRESH context — this is what
  // catches a changed authored prescription, an exercise that is no
  // longer valid for its target, or a target date/weekday mismatch,
  // exactly the same way generation-time validation did, just re-run
  // against now-current state instead of generation-time state.
  const domain = validateProposalDomain(proposal, context, db);
  if (!domain.ok || !domain.value) {
    throw new AIProposalStaleError(proposalId, domain.errors);
  }

  // Planned-session conflict (spec §11's recommended default: reject).
  // Completed/in-progress conflicts are already covered by
  // buildProgrammerContext's own lock check above; a merely-`planned`
  // session is not, since that path only treats completed/in_progress
  // as locking — so it is checked explicitly here.
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const plannedConflict = sessionsRepo.listSessionsByDate(proposal.targetDate).find((s) => s.status === 'planned');
  if (plannedConflict) {
    throw new AIProposalConflictError(proposalId, proposal.targetDate, plannedConflict.session_id, plannedConflict.status);
  }

  let sessionId: string;
  try {
    const tx = db.transaction(() => {
      const session = sessionsRepo.createSession({
        date: proposal.targetDate,
        session_type: 'gym',
        status: 'planned',
        notes: `AI-proposed session (proposal ${proposal.proposalId})`,
      });
      proposal.exercises.forEach((exercise, index) => {
        sessionsRepo.addExercisePerformance(session.session_id, {
          exercise_id: exercise.exerciseId,
          order: index,
          role: exercise.role,
          sets: Array.from({ length: exercise.sets }, (_, setIndex) => ({
            set_number: setIndex + 1,
            weight: null,
            reps: null,
            completed: false,
            rir: null,
            rpe: null,
            rest_seconds: exercise.restSeconds ?? null,
            technique: null,
            tempo: null,
            notes: null,
          })),
        });
      });
      const committed = repo.markCommitted(proposalId, session.session_id);
      if (!committed) {
        // Lost a race with another commit attempt for this same
        // proposal between loadCurrent() above and this conditional
        // UPDATE — throwing here rolls back the whole transaction
        // (db.transaction wraps this in BEGIN/COMMIT/ROLLBACK), so the
        // just-created session is never left orphaned.
        throw new AIProposalInvalidStateError(proposalId, record.status, 'committed');
      }
      return session.session_id;
    });
    sessionId = tx();
  } catch (err) {
    if (err instanceof AIProposalInvalidStateError) throw err;
    // Atomicity (spec §9): the transaction above rolled back entirely on
    // any thrown error — no partial session/exercise/set rows, and the
    // proposal was never marked committed. Record why, for audit, but
    // never leak the raw error message/stack trace to the client.
    repo.recordFailure(proposalId, err instanceof Error ? err.message : 'unknown commit error');
    throw new AIProposalCommitFailedError(proposalId);
  }

  const finalRecord = repo.getById(proposalId);
  if (!finalRecord) throw new AIProposalCommitFailedError(proposalId);
  return { sessionId, proposal: finalRecord };
}
