// AI-Powered Weekly Reconciliation: retrieval, explicit approval, and
// the ONLY function allowed to commit a week-reconciliation proposal
// into the real workout/session/program data model — same separation
// aiProposalLifecycle.ts already enforces for single-session proposals,
// applied at the weekly granularity. Never calls the LLM/provider —
// operates only on an already-generated, already-persisted proposal.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { AIWeekReconciliationRepo, type AIWeekReconciliationRecord } from '../../repositories/aiWeekReconciliationRepo.js';
import { nowIso } from '../../repositories/ids.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../repositories/weeklyProgramRepo.js';
import { findActiveGymSessionConflict, logSessionConflict } from '../../engine/selectedSessionResolver.js';
import { WEEKDAYS } from '../../contracts/types.js';
import { addDays, isValidCalendarDate } from '../../engine/dateMath.js';
import { programmingWeekStart, weekdayOfDate } from '../../engine/workoutBuilder.js';
import { buildReconciliationContext } from '../context/reconciliationContextBuilder.js';
import type { AIWeekReconciliationDay, AIWeekReconciliationOutput } from '../contracts/weekReconciliationTypes.js';
import {
  AIProgrammerError,
  AIWeekReconciliationCommitFailedError,
  AIWeekReconciliationConflictError,
  AIWeekReconciliationExpiredError,
  AIWeekReconciliationInvalidStateError,
  AIWeekReconciliationNotFoundError,
  AIWeekReconciliationStaleError,
  AIWeekReconciliationValidationFailedError,
} from '../errors.js';
import { validateWeekReconciliationDomain } from '../validation/weekReconciliationDomainValidator.js';
import { validateWeekReconciliationSchema } from '../validation/weekReconciliationOutputValidator.js';

function expireIfNeeded(repo: AIWeekReconciliationRepo, record: AIWeekReconciliationRecord): AIWeekReconciliationRecord {
  if ((record.status === 'pending' || record.status === 'approved') && record.expiresAt < nowIso()) {
    return repo.markExpired(record.id) ?? record;
  }
  return record;
}

function loadCurrent(db: Database.Database, reconciliationId: string): AIWeekReconciliationRecord {
  const repo = new AIWeekReconciliationRepo(db);
  const record = repo.getById(reconciliationId);
  if (!record) throw new AIWeekReconciliationNotFoundError(reconciliationId);
  return expireIfNeeded(repo, record);
}

export function getWeekReconciliation(db: Database.Database, reconciliationId: string): AIWeekReconciliationRecord {
  return loadCurrent(db, reconciliationId);
}

export function getLatestWeekReconciliationForDate(db: Database.Database, targetDate: string): AIWeekReconciliationRecord | undefined {
  const repo = new AIWeekReconciliationRepo(db);
  const record = repo.findLatestForTargetDate(targetDate);
  if (!record) return undefined;
  return expireIfNeeded(repo, record);
}

/** Explicit approval only — never commits, never mutates the proposal's
 * own JSON content. Idempotent on an already-approved proposal, same as
 * approveProposal. */
export function approveWeekReconciliation(db: Database.Database, reconciliationId: string): AIWeekReconciliationRecord {
  const record = loadCurrent(db, reconciliationId);
  if (record.status === 'approved') return record;
  if (record.status === 'expired') throw new AIWeekReconciliationExpiredError(reconciliationId, record.expiresAt);
  if (record.status !== 'pending') throw new AIWeekReconciliationInvalidStateError(reconciliationId, record.status, 'approved');

  const approved = new AIWeekReconciliationRepo(db).approve(reconciliationId);
  if (!approved) {
    const current = new AIWeekReconciliationRepo(db).getById(reconciliationId);
    throw new AIWeekReconciliationInvalidStateError(reconciliationId, current?.status ?? record.status, 'approved');
  }
  return approved;
}

export interface CommitWeekReconciliationResult {
  sessionId: string;
  reconciliation: AIWeekReconciliationRecord;
}

function classifyCommitFailure(_err: unknown): string {
  return 'commit_transaction_failed';
}

/** Only the target date gets a real, actionable `workout_sessions` row
 * on commit — the day the user actually asked to train NOW. Every OTHER
 * day this reconciliation touches gets its `program_sessions` snapshot
 * updated (the deterministic weekly PLAN), exactly like
 * weekProgramReconciliation.ts's own reconcileWeekProgram already does
 * for the deterministic planner's output — never a second real session
 * for a day nobody is training today. This mirrors
 * commitAIProposalToPlannedSession's "session creation only for the one
 * date this commit is actually about" discipline at the weekly scale. */
function toSnapshot(day: AIWeekReconciliationDay): unknown {
  return {
    sessionPurpose: day.session?.sessionPurpose ?? null,
    availableMinutes: day.session?.availableMinutes ?? 0,
    estimatedMinutes: day.session?.estimatedMinutes ?? 0,
    plannedWork: (day.session?.exercises ?? []).map((e) => ({
      exercise_id: e.exerciseId,
      target_type: e.targetType,
      target_id: e.targetId,
      role: e.role,
      classification: e.classification,
      sets: e.sets,
      reps_min: e.repsMin,
      reps_max: e.repsMax,
      rir_min: e.rirMin,
      rir_max: e.rirMax,
    })),
    // Deliberately empty — a persisted snapshot's `skipped` entries have
    // their own enrichment shape (renderWeekDays' enrichSkip) this
    // proposal's plain string[] `skipped` reasons don't match; the AI's
    // own explanatory text is preserved instead in this reconciliation
    // record's `reconciliation.warnings`, retrievable via
    // GET /week-reconciliations/:id, rather than risking a malformed
    // snapshot field breaking /week's rendering.
    skipped: [],
    badmintonContext: null,
    resourceAllocation: [],
  };
}

/** Every error this commit can deliberately throw — every
 * `AIWeekReconciliation*` lifecycle/validation/conflict error AND
 * `AITargetNotEditableError`/`AIContextIncompleteError` (thrown by
 * `buildReconciliationContext`, now called from inside the same
 * transaction) — is an `AIProgrammerError` subclass, already carrying
 * its own safe `publicMessage` and correct `statusCode`. Any such error
 * represents an EXPECTED, business-logic rejection of this specific
 * commit attempt, as opposed to a truly unexpected internal failure
 * (a thrown plain `Error`, a raw SQLite constraint violation, etc.).
 * Thrown from inside the transaction below, an `AIProgrammerError` must
 * propagate to the caller completely unchanged: never reclassified as
 * `AIWeekReconciliationCommitFailedError`, and never recorded via
 * `recordFailure` (that field is reserved for the "commit transaction
 * failed for an unclassified internal reason" case). */
function isExpectedCommitRejection(err: unknown): boolean {
  return err instanceof AIProgrammerError;
}

/** Fix AI Weekly Reconciliation Review, Finding 1: every fact this
 * commit relies on — the reconciliation's own lifecycle state, its
 * persisted output, Blueprint/domain validity, and (most importantly)
 * whether an active/duplicate Gym session already exists for the target
 * date — is reloaded and re-checked FRESH, INSIDE this single
 * `db.transaction()`, with the target-session INSERT itself as the very
 * next statement after the conflict check passes. There is no gap
 * between "we decided this is safe" and "we wrote it" for any of these
 * facts to change in — this repository's own existing transaction
 * abstraction (`Database.transaction()`, the same one every other
 * commit path in this codebase already uses) is the only mechanism
 * used; no second one is invented. A thrown error of any kind rolls the
 * whole transaction back automatically (better-sqlite3's own guarantee)
 * before propagating, so a rejected commit can never leave a partial
 * write behind. */
export function commitWeekReconciliation(db: Database.Database, reconciliationId: string): CommitWeekReconciliationResult {
  const repo = new AIWeekReconciliationRepo(db);

  let sessionId: string;
  try {
    const tx = db.transaction((): string => {
      // 1 & 2: reload the record fresh and confirm it is still
      // approvable/approved — never trust a snapshot taken before this
      // transaction opened. Lazy expiry (expireIfNeeded) is applied here
      // too, exactly as every other read of a reconciliation record
      // applies it, so an accompanying status transition is persisted in
      // the same breath as everything else this call decides.
      const loaded = repo.getById(reconciliationId);
      if (!loaded) throw new AIWeekReconciliationNotFoundError(reconciliationId);
      const record = expireIfNeeded(repo, loaded);

      // Idempotency: a second commit for an already-committed
      // reconciliation returns its existing result — no new session, no
      // re-run of any check below, nothing further written.
      if (record.status === 'committed') {
        if (!record.committedSessionId) throw new AIWeekReconciliationCommitFailedError(reconciliationId);
        return record.committedSessionId;
      }
      if (record.status === 'expired') throw new AIWeekReconciliationExpiredError(reconciliationId, record.expiresAt);
      if (record.status !== 'approved') throw new AIWeekReconciliationInvalidStateError(reconciliationId, record.status, 'committed');

      // 3: reload the persisted output fresh from the just-reloaded record.
      const structural = validateWeekReconciliationSchema(record.proposal);
      if (!structural.ok || !structural.value) {
        throw new AIWeekReconciliationValidationFailedError(reconciliationId, structural.errors);
      }
      const output: AIWeekReconciliationOutput = structural.value;

      const currentBlueprintCommit = BlueprintAdapter.getManifest().sourceCommit;
      if (currentBlueprintCommit !== record.blueprintCommit) {
        throw new AIWeekReconciliationStaleError(reconciliationId, [
          `Blueprint changed since this proposal was generated (was "${record.blueprintCommit}", now "${currentBlueprintCommit}")`,
        ]);
      }

      // Rebuild the FULL context fresh against current DB state — reuses
      // buildReconciliationContext's own lock/editability checks (throws
      // AITargetNotEditableError, an AIProgrammerError with its own 409,
      // if the target date itself became locked or moved into the past)
      // and is what answers step 6, "is the target program day still
      // eligible for replacement."
      const context = buildReconciliationContext(db, {
        targetDate: output.targetDate,
        requestedActivity: output.requestedActivity,
        reason: undefined,
        swapUnavailableReason: undefined,
      });

      const domain = validateWeekReconciliationDomain(output, context, db);
      if (!domain.ok || !domain.value) {
        throw new AIWeekReconciliationStaleError(reconciliationId, domain.errors);
      }

      // 4, 5 & 7: re-read every session for the target date and re-run
      // the SAME authoritative active-Gym-session conflict rule the
      // generic write path and the single-session AI commit already
      // share (`findActiveGymSessionConflict`) — this is the actual
      // race-safety boundary, and there is now nothing between this
      // check passing and the INSERT immediately below it.
      const sessionsRepo = new WorkoutSessionsRepo(db);
      const plannedConflict = findActiveGymSessionConflict(sessionsRepo.listSessionsByDate(output.targetDate));
      if (plannedConflict) {
        logSessionConflict({
          operation: 'AI week-reconciliation commit',
          date: output.targetDate,
          sessionType: 'gym',
          code: 'AI_WEEK_RECONCILIATION_CONFLICT',
          conflictingSessionIds: [plannedConflict.session_id],
        });
        throw new AIWeekReconciliationConflictError(reconciliationId, output.targetDate, plannedConflict.session_id, plannedConflict.status);
      }

      // Only past this point does anything actually get written.
      const user = new UsersRepo(db).getOrCreateDefault();
      const profile = new TrainingProfileRepo(db).get(user.id);
      const weekStart = programmingWeekStart(output.targetDate);
      const weekEnd = addDays(weekStart, 6);

      const weeklyProgramRepo = new WeeklyProgramRepo(db);
      const program = weeklyProgramRepo.getByWeekStart(weekStart) ?? weeklyProgramRepo.create(weekStart, weekEnd);

      let targetDayProgramSessionId: string | null = null;
      for (const day of output.days) {
        if (!isValidCalendarDate(day.date)) continue;
        const dayIndex = WEEKDAYS.indexOf(day.weekday);
        const existing = context.existingProgram.find((d) => d.date === day.date);

        // Locked days are never touched — domain validation already
        // enforced their content is unchanged, but this is the actual
        // enforcement point: no write happens for them regardless.
        if (existing?.locked) continue;

        // The day's activity representation (week_activity_overrides) —
        // written whenever it actually differs from what's currently
        // effective, for ANY day this reconciliation touches, not only
        // the target date.
        if (profile && existing && day.activity !== existing.activity) {
          const overrideActivity = day.activity === 'rest' ? 'unselected' : day.activity;
          new WeekActivityOverridesRepo(db).setOverride(profile.id, weekStart, day.weekday, overrideActivity);
        }

        // The deterministic plan snapshot (program_sessions) — written/
        // removed only for days the model actually changed; an
        // 'unchanged' day's existing snapshot (if any) is left exactly
        // as it was, preserving its own persisted explanation text
        // (same discipline as weekProgramReconciliation.ts's own
        // core-prescription-equality skip).
        if (day.changeType === 'removed') {
          weeklyProgramRepo.deleteSession(program.id, dayIndex);
        } else if (day.changeType === 'modified' || day.changeType === 'new') {
          const upserted = weeklyProgramRepo.upsertSession(program.id, dayIndex, day.session?.sessionPurpose ?? 'gym', 'gym', toSnapshot(day));
          if (day.date === output.targetDate) targetDayProgramSessionId = upserted.id;
        } else if (day.date === output.targetDate) {
          targetDayProgramSessionId = weeklyProgramRepo.getSession(program.id, dayIndex)?.id ?? null;
        }
      }

      // The ONE real, actionable session — for targetDate only (see
      // toSnapshot's own doc comment on why other days never get one).
      // This INSERT is the very next write after the conflict check
      // above passed — the whole point of this restructuring.
      const targetDay = output.days.find((d) => d.date === output.targetDate)!;
      const session = sessionsRepo.createSession({
        date: output.targetDate,
        session_type: 'gym',
        status: 'planned',
        source_type: 'ai',
        supersedes_program_session_id: targetDayProgramSessionId,
        notes: `AI week-reconciliation session (reconciliation ${record.id})`,
      });
      (targetDay.session?.exercises ?? []).forEach((exercise, index) => {
        sessionsRepo.addExercisePerformance(session.session_id, {
          exercise_id: exercise.exerciseId,
          order: index,
          role: exercise.role,
          target_sets: exercise.sets,
          target_reps_min: exercise.repsMin,
          target_reps_max: exercise.repsMax,
          target_rir_min: exercise.rirMin,
          target_rir_max: exercise.rirMax,
          target_rest_seconds: exercise.restSeconds ?? null,
          sets: Array.from({ length: exercise.sets }, (_, setIndex) => ({
            set_number: setIndex + 1,
            weight: null,
            reps: null,
            completed: false,
            rir: null,
            rpe: null,
            rest_seconds: null,
            technique: null,
            tempo: null,
            notes: null,
          })),
        });
      });

      const committed = repo.markCommitted(reconciliationId, session.session_id);
      if (!committed) {
        const current = repo.getById(reconciliationId);
        if (current && current.status !== 'expired' && current.expiresAt < nowIso()) {
          throw new AIWeekReconciliationExpiredError(reconciliationId, current.expiresAt);
        }
        throw new AIWeekReconciliationInvalidStateError(reconciliationId, current?.status ?? record.status, 'committed');
      }
      return session.session_id;
    });
    sessionId = tx();
  } catch (err) {
    if (isExpectedCommitRejection(err)) throw err;
    console.error(`AI week-reconciliation commit failed for reconciliation ${reconciliationId}:`, err);
    repo.recordFailure(reconciliationId, classifyCommitFailure(err));
    throw new AIWeekReconciliationCommitFailedError(reconciliationId);
  }

  const finalRecord = repo.getById(reconciliationId);
  if (!finalRecord) throw new AIWeekReconciliationCommitFailedError(reconciliationId);
  return { sessionId, reconciliation: finalRecord };
}
