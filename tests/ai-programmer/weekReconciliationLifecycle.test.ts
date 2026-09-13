// AI-Powered Weekly Reconciliation (spec §13, persistence/commit tests):
// approve/commit lifecycle for a `reconcile_week` proposal — mirrors
// aiProposalLifecycle's own approve/commit test discipline
// (tests/ai-programmer/aiProposalRoutes.test.ts) at the weekly
// granularity. Builds a real context, hand-builds a valid output,
// inserts it directly via AIWeekReconciliationRepo (never going through
// the async provider call) so these tests exercise ONLY the
// approve/commit persistence logic in weekReconciliationLifecycle.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { buildReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextBuilder.js';
import type { AIReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextTypes.js';
import { AI_WEEK_RECONCILIATION_SCHEMA_VERSION, type AIWeekReconciliationDay, type AIWeekReconciliationOutput } from '../../src/ai-programmer/contracts/weekReconciliationTypes.js';
import { AIWeekReconciliationRepo } from '../../src/repositories/aiWeekReconciliationRepo.js';
import {
  approveWeekReconciliation,
  commitWeekReconciliation,
  getWeekReconciliation,
} from '../../src/ai-programmer/service/weekReconciliationLifecycle.js';
import {
  AITargetNotEditableError,
  AIWeekReconciliationCommitFailedError,
  AIWeekReconciliationConflictError,
  AIWeekReconciliationExpiredError,
  AIWeekReconciliationInvalidStateError,
  AIWeekReconciliationStaleError,
} from '../../src/ai-programmer/errors.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13'; // target date, currently rest (not a training day)
const WEDNESDAY = '2026-09-09'; // currently rest
const FRIDAY = '2026-09-11'; // currently a training day (gym)
const WEEK_START = '2026-09-07';

let db: Database.Database;
let profileId: string;

const GYM_EXERCISE = {
  exerciseId: 'flat-barbell-bench-press',
  role: 'primary' as const,
  targetType: 'physique_target' as const,
  targetId: 'mid-pec',
  classification: 'specialization' as const,
  sets: 3,
  repsMin: 6,
  repsMax: 12,
  rirMin: 1,
  rirMax: 3,
  rationale: ['Direct mid-pec exposure.'],
  source: 'blueprint' as const,
};

/** A richer multi-day scenario than the minimal validator-test fixture:
 * targetDate (Sunday, rest -> gym), a brand-new gym day (Wednesday, rest
 * -> gym), and a training day given up (Friday, gym -> rest) — exercises
 * the full "only the target date gets a real session, every other
 * changed day only gets its plan snapshot/override updated" contract. */
function multiDayOutput(ctx: AIReconciliationContext): AIWeekReconciliationOutput {
  const days: AIWeekReconciliationDay[] = ctx.existingProgram.map((existing) => {
    if (existing.locked) {
      return { date: existing.date, weekday: existing.weekday, activity: existing.activity, changeType: 'unchanged', locked: true, session: null };
    }
    if (existing.date === SUNDAY) {
      return {
        date: existing.date,
        weekday: existing.weekday,
        activity: 'gym',
        changeType: 'modified',
        locked: false,
        session: { sessionPurpose: 'chest', availableMinutes: 60, estimatedMinutes: 45, exercises: [GYM_EXERCISE], skipped: [] },
      };
    }
    if (existing.date === WEDNESDAY) {
      return {
        date: existing.date,
        weekday: existing.weekday,
        activity: 'gym',
        changeType: 'new',
        locked: false,
        session: { sessionPurpose: 'arms', availableMinutes: 60, estimatedMinutes: 40, exercises: [GYM_EXERCISE], skipped: [] },
      };
    }
    if (existing.date === FRIDAY) {
      return { date: existing.date, weekday: existing.weekday, activity: 'unselected', changeType: 'removed', locked: false, session: null };
    }
    return { date: existing.date, weekday: existing.weekday, activity: existing.activity, changeType: 'unchanged', locked: false, session: null };
  });
  return {
    schemaVersion: AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
    proposalId: 'app-generated-id',
    mode: 'reconcile_week',
    targetDate: SUNDAY,
    requestedActivity: 'gym',
    days,
    reconciliation: {
      changedDates: [SUNDAY, WEDNESDAY, FRIDAY],
      preservedLockedDates: [...ctx.lockedDates],
      rationale: 'Move Friday\'s session to Sunday and add an arms session Wednesday.',
      warnings: [],
    },
  };
}

function insertReconciliation(ctx: AIReconciliationContext, output: AIWeekReconciliationOutput) {
  return new AIWeekReconciliationRepo(db).create({
    proposal: output,
    weekStart: programmingWeekStart(output.targetDate),
    contextHash: ctx.contextHash,
    blueprintCommit: BlueprintAdapter.getManifest().sourceCommit,
    modelProvider: 'fake',
    modelName: 'fake-model',
    requestId: 'req-1',
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
  profileId = profile.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approveWeekReconciliation', () => {
  it('transitions pending -> approved', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    const approved = approveWeekReconciliation(db, record.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();
  });

  it('is idempotent on an already-approved reconciliation', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const secondCall = approveWeekReconciliation(db, record.id);
    expect(secondCall.status).toBe('approved');
  });

  it('rejects approving an already-committed reconciliation', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    commitWeekReconciliation(db, record.id);
    expect(() => approveWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationInvalidStateError);
  });

  it('rejects approving an expired reconciliation', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    db.prepare('UPDATE ai_week_reconciliation_proposals SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', record.id);
    expect(() => approveWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationExpiredError);
  });
});

describe('commitWeekReconciliation', () => {
  it('rejects committing a still-pending (never approved) reconciliation', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    expect(() => commitWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationInvalidStateError);
  });

  it('rejects committing an expired reconciliation', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    db.prepare('UPDATE ai_week_reconciliation_proposals SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', record.id);
    expect(() => commitWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationExpiredError);
  });

  it('creates exactly ONE real workout_sessions row, on the target date only', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const result = commitWeekReconciliation(db, record.id);

    const sessionsRepo = new WorkoutSessionsRepo(db);
    expect(sessionsRepo.listSessionsByDate(SUNDAY)).toHaveLength(1);
    expect(sessionsRepo.listSessionsByDate(SUNDAY)[0]!.session_id).toBe(result.sessionId);
    expect(sessionsRepo.listSessionsByDate(SUNDAY)[0]!.status).toBe('planned');
    expect(sessionsRepo.listSessionsByDate(SUNDAY)[0]!.source_type).toBe('ai');
    // Every other changed day gets NO real session — only a plan snapshot.
    expect(sessionsRepo.listSessionsByDate(WEDNESDAY)).toHaveLength(0);
    expect(sessionsRepo.listSessionsByDate(FRIDAY)).toHaveLength(0);
  });

  it('records the exercise performance for the target-day session', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const result = commitWeekReconciliation(db, record.id);
    const exercises = new WorkoutSessionsRepo(db).getExercisePerformances(result.sessionId);
    expect(exercises).toHaveLength(1);
    expect(exercises[0]?.exercise_id).toBe('flat-barbell-bench-press');
  });

  it('writes a program_sessions snapshot for a new changed day (Wednesday) without creating a real session there', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    commitWeekReconciliation(db, record.id);

    const program = new WeeklyProgramRepo(db).getByWeekStart(WEEK_START);
    expect(program).toBeDefined();
    const wednesdaySession = program!.sessions.find((s) => s.day_index === 2); // wednesday = index 2
    expect(wednesdaySession).toBeDefined();
    expect((wednesdaySession!.snapshot as any).sessionPurpose).toBe('arms');
  });

  it('deletes the program_sessions snapshot for a day changed to "removed" (Friday)', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    // Pre-seed a program session for Friday so there's something to remove.
    const weeklyProgramRepo = new WeeklyProgramRepo(db);
    const program = weeklyProgramRepo.getByWeekStart(WEEK_START) ?? weeklyProgramRepo.create(WEEK_START, '2026-09-13');
    weeklyProgramRepo.upsertSession(program.id, 4, 'legs', 'gym', { sessionPurpose: 'legs', availableMinutes: 60, estimatedMinutes: 55, plannedWork: [], skipped: [] });

    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    commitWeekReconciliation(db, record.id);

    const updatedProgram = weeklyProgramRepo.getByWeekStart(WEEK_START);
    const fridaySession = updatedProgram!.sessions.find((s) => s.day_index === 4); // friday = index 4
    expect(fridaySession).toBeUndefined();
  });

  it('writes week_activity_overrides for every day whose activity actually changed', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    commitWeekReconciliation(db, record.id);

    const overrides = new WeekActivityOverridesRepo(db).get(profileId, WEEK_START);
    expect(overrides.get('sunday')).toBe('gym');
    expect(overrides.get('wednesday')).toBe('gym');
    expect(overrides.get('friday')).toBe('unselected');
    // Unchanged days never get an override written.
    expect(overrides.has('monday')).toBe(false);
    expect(overrides.has('tuesday')).toBe(false);
    expect(overrides.has('thursday')).toBe(false);
    expect(overrides.has('saturday')).toBe(false);
  });

  it('rejects (as stale) a commit when a day became newly locked since generation — commit rebuilds a fresh context and never trusts the stale preservedLockedDates list', () => {
    // Lock Tuesday (a currently-unchanged day) AFTER the reconciliation
    // was generated but BEFORE commit — commit rebuilds a fresh context
    // whose lockedDates now includes Tuesday, which the stored output's
    // reconciliation.preservedLockedDates (computed before Tuesday was
    // locked) cannot possibly already list. This is the safe outcome:
    // rather than silently deciding for itself what to do with a day
    // that just became locked, commit refuses and nothing is written.
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    new WorkoutSessionsRepo(db).createSession({ date: '2026-09-08', session_type: 'gym', status: 'completed' }); // tuesday, now locked
    expect(() => commitWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationStaleError);
    const overrides = new WeekActivityOverridesRepo(db).get(profileId, WEEK_START);
    expect(overrides.size).toBe(0);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('leaves unchanged days\' pre-existing program_sessions snapshots untouched', () => {
    const weeklyProgramRepo = new WeeklyProgramRepo(db);
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const program = weeklyProgramRepo.getByWeekStart(WEEK_START) ?? weeklyProgramRepo.create(WEEK_START, '2026-09-13');
    weeklyProgramRepo.upsertSession(program.id, 0, 'push', 'gym', { sessionPurpose: 'push', availableMinutes: 60, estimatedMinutes: 55, plannedWork: [], skipped: [] }); // monday, unchanged

    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    commitWeekReconciliation(db, record.id);

    const updatedProgram = weeklyProgramRepo.getByWeekStart(WEEK_START);
    const mondaySession = updatedProgram!.sessions.find((s) => s.day_index === 0);
    expect(mondaySession).toBeDefined();
    expect((mondaySession!.snapshot as any).sessionPurpose).toBe('push');
  });

  it('is idempotent when called again on an already-committed reconciliation, returning the same sessionId', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const first = commitWeekReconciliation(db, record.id);
    const second = commitWeekReconciliation(db, record.id);
    expect(second.sessionId).toBe(first.sessionId);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('rejects a commit when a Blueprint change has made the stored proposal stale', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    db.prepare('UPDATE ai_week_reconciliation_proposals SET blueprint_commit = ? WHERE id = ?').run('a-different-blueprint-commit', record.id);
    expect(() => commitWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationStaleError);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('rejects a commit blocked by an active conflicting session already on the target date', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'planned' });
    expect(() => commitWeekReconciliation(db, record.id)).toThrow(AIWeekReconciliationConflictError);
    // Only the pre-existing session exists — commit never created its own.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('rolls back the entire transaction on a mid-commit persistence failure — no partial writes, no stack trace leak', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);

    const DISTINCTIVE_INTERNAL_MESSAGE = 'SQLITE_CONSTRAINT: simulated internal failure xyz';
    const spy = vi.spyOn(WorkoutSessionsRepo.prototype, 'addExercisePerformance').mockImplementation(() => {
      throw new Error(DISTINCTIVE_INTERNAL_MESSAGE);
    });

    let thrown: unknown;
    try {
      commitWeekReconciliation(db, record.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AIWeekReconciliationCommitFailedError);
    spy.mockRestore();

    // Nothing partially written: no real session, no overrides, no
    // program_sessions changes, and the record stays 'approved'.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    const overrides = new WeekActivityOverridesRepo(db).get(profileId, WEEK_START);
    expect(overrides.size).toBe(0);
    const program = new WeeklyProgramRepo(db).getByWeekStart(WEEK_START);
    expect(program?.sessions ?? []).toHaveLength(0);

    const finalRecord = getWeekReconciliation(db, record.id);
    expect(finalRecord.status).toBe('approved');
    expect(finalRecord.committedSessionId).toBeNull();
    expect(finalRecord.failureReason).toBe('commit_transaction_failed');
    expect(finalRecord.failureReason).not.toContain(DISTINCTIVE_INTERNAL_MESSAGE);
  });

  // Fix AI Weekly Reconciliation Review, Finding 1: every conflict check
  // and the target-session creation now happen inside the SAME
  // transaction, reloaded fresh — these tests exercise the specific
  // race/idempotency/duplicate-prevention guarantees that restructuring
  // is required to provide.

  it('an existing COMPLETED session on the target date blocks commit (never replaced, never converted to a generic failure)', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const completed = new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'completed' });

    let thrown: unknown;
    try {
      commitWeekReconciliation(db, record.id);
    } catch (err) {
      thrown = err;
    }
    // A completed/in-progress target date is caught by
    // buildReconciliationContext's own lock check (AITargetNotEditableError,
    // a 409) — it must propagate as-is, never reclassified as
    // AIWeekReconciliationCommitFailedError, and never recorded as a
    // generic transaction failure.
    expect(thrown).toBeInstanceOf(AITargetNotEditableError);
    expect(thrown).not.toBeInstanceOf(AIWeekReconciliationCommitFailedError);

    const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe(completed.session_id);
    expect(sessions[0]!.status).toBe('completed'); // never replaced/overwritten

    const finalRecord = getWeekReconciliation(db, record.id);
    expect(finalRecord.status).toBe('approved'); // never advanced, never marked failed
    expect(finalRecord.failureReason).toBeNull();
  });

  it('an existing IN-PROGRESS session on the target date blocks commit and is left completely untouched', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const inProgress = new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'in_progress' });

    expect(() => commitWeekReconciliation(db, record.id)).toThrow(AITargetNotEditableError);

    const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe(inProgress.session_id);
    expect(sessions[0]!.status).toBe('in_progress');
  });

  it('two reconciliations targeting the same date: the first commit succeeds, the second is safely rejected as a conflict — never a duplicate actionable session', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const first = insertReconciliation(context, multiDayOutput(context));
    const second = insertReconciliation(context, { ...multiDayOutput(context), proposalId: 'app-generated-id-2' });
    approveWeekReconciliation(db, first.id);
    approveWeekReconciliation(db, second.id);

    // Simulates the "concurrent commit attempts" scenario this app's
    // single-process synchronous execution model serializes in
    // practice (see aiProposalLifecycle.ts's own documented rationale)
    // — by the time the second commit's fresh, in-transaction conflict
    // check runs, the first commit's session already exists.
    const firstResult = commitWeekReconciliation(db, first.id);
    expect(() => commitWeekReconciliation(db, second.id)).toThrow(AIWeekReconciliationConflictError);

    const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY);
    expect(sessions).toHaveLength(1); // exactly one actionable session — never two
    expect(sessions[0]!.session_id).toBe(firstResult.sessionId);

    const secondRecord = getWeekReconciliation(db, second.id);
    expect(secondRecord.status).toBe('approved'); // rejected, never advanced to committed
    expect(secondRecord.committedSessionId).toBeNull();
  });

  it('the target-day session created by commit is the only new actionable AI session for that date', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const record = insertReconciliation(context, multiDayOutput(context));
    approveWeekReconciliation(db, record.id);
    const before = new WorkoutSessionsRepo(db).listSessions().length;
    commitWeekReconciliation(db, record.id);
    const after = new WorkoutSessionsRepo(db).listSessions();
    expect(after.length).toBe(before + 1);
    const created = after.find((s) => s.date === SUNDAY)!;
    expect(created.source_type).toBe('ai');
    expect(created.status).toBe('planned');
  });
});
