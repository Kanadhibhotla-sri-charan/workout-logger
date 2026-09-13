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

export function commitWeekReconciliation(db: Database.Database, reconciliationId: string): CommitWeekReconciliationResult {
  const repo = new AIWeekReconciliationRepo(db);
  const record = loadCurrent(db, reconciliationId);

  if (record.status === 'committed') {
    if (!record.committedSessionId) throw new AIWeekReconciliationCommitFailedError(reconciliationId);
    return { sessionId: record.committedSessionId, reconciliation: record };
  }
  if (record.status === 'expired') throw new AIWeekReconciliationExpiredError(reconciliationId, record.expiresAt);
  if (record.status !== 'approved') throw new AIWeekReconciliationInvalidStateError(reconciliationId, record.status, 'committed');

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
  // AITargetNotEditableError, an AIProgrammerError with its own 409, if
  // the target date itself became locked or moved into the past).
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

  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  const weekStart = programmingWeekStart(output.targetDate);
  const weekEnd = addDays(weekStart, 6);

  let sessionId: string;
  try {
    const tx = db.transaction(() => {
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
    if (err instanceof AIWeekReconciliationInvalidStateError || err instanceof AIWeekReconciliationExpiredError) throw err;
    console.error(`AI week-reconciliation commit failed for reconciliation ${reconciliationId}:`, err);
    repo.recordFailure(reconciliationId, classifyCommitFailure(err));
    throw new AIWeekReconciliationCommitFailedError(reconciliationId);
  }

  const finalRecord = repo.getById(reconciliationId);
  if (!finalRecord) throw new AIWeekReconciliationCommitFailedError(reconciliationId);
  return { sessionId, reconciliation: finalRecord };
}
