// AI-Powered Weekly Reconciliation (spec §13, context tests): verifies
// buildReconciliationContext assembles a complete, self-contained
// `reconcile_week` context — 7 days, effective current activity, the
// explicit requested target activity, the existing persisted weekly
// program, real training/exposure/recovery data (via the shared
// buildTargetContexts/assembleWeeklyPlanInput pipeline), locked-day
// identification, a valid exercise catalogue, and bounded diagnostics.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextBuilder.js';
import { AIContextIncompleteError, AITargetNotEditableError } from '../../src/ai-programmer/errors.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
// A Sunday; training days below are Mon/Tue/Thu/Fri, so Sunday is
// currently "rest" — the exact Rest -> Gym scenario this feature targets.
const SUNDAY = '2026-09-13';
const WEEK_START = '2026-09-07';
const WEEK_END = '2026-09-13';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
});

describe('buildReconciliationContext', () => {
  it('throws AIContextIncompleteError when no TrainingProfile exists', () => {
    const freshDb = openDb(':memory:');
    expect(() => buildReconciliationContext(freshDb, { targetDate: SUNDAY, requestedActivity: 'gym' })).toThrow(AIContextIncompleteError);
  });

  it('rejects an invalid targetDate', () => {
    expect(() => buildReconciliationContext(db, { targetDate: 'not-a-date', requestedActivity: 'gym' })).toThrow(AIContextIncompleteError);
  });

  it('rejects a targetDate that already has a completed session (locked)', () => {
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'completed' });
    expect(() => buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' })).toThrow(AITargetNotEditableError);
  });

  it('rejects a targetDate that already has an in-progress session (locked)', () => {
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'in_progress' });
    expect(() => buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' })).toThrow(AITargetNotEditableError);
  });

  it('rejects a targetDate in the past relative to current date', () => {
    expect(() => buildReconciliationContext(db, { targetDate: '2020-01-05', requestedActivity: 'gym' })).toThrow(AITargetNotEditableError);
  });

  it('includes exactly 7 days in existingProgram, Monday..Sunday, spanning the target week', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(context.existingProgram).toHaveLength(7);
    expect(context.existingProgram.map((d) => d.date)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
    expect(context.existingProgram.map((d) => d.weekday)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(context.reportingBoundary.weekStart).toBe(WEEK_START);
    expect(context.reportingBoundary.weekEnd).toBe(WEEK_END);
  });

  it('reports the current effective activity and the explicit requested target activity for the target date', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    // Sunday is not a training day per the profile — effective activity is rest/unselected.
    expect(context.routine.proposedChange.currentActivity).toBe('unselected');
    expect(context.routine.proposedChange.requestedActivity).toBe('gym');
    expect(context.routine.proposedChange.date).toBe(SUNDAY);
    expect(context.request.targetDate).toBe(SUNDAY);
    expect(context.request.requestedActivity).toBe('gym');
    const sundayInWeek = context.existingProgram.find((d) => d.date === SUNDAY);
    expect(sundayInWeek?.activity).toBe('unselected');
  });

  it('threads reason/swapUnavailableReason through as plain data fields', () => {
    const context = buildReconciliationContext(db, {
      targetDate: SUNDAY,
      requestedActivity: 'gym',
      reason: 'Friend invited me to the gym',
      swapUnavailableReason: 'Monday is already a rest day I need',
    });
    expect(context.request.reason).toBe('Friend invited me to the gym');
    expect(context.request.swapUnavailableReason).toBe('Monday is already a rest day I need');
  });

  it('defaults reason/swapUnavailableReason to null when not supplied', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(context.request.reason).toBeNull();
    expect(context.request.swapUnavailableReason).toBeNull();
  });

  it('includes the existing persisted weekly program when one exists', () => {
    const weeklyProgramRepo = new WeeklyProgramRepo(db);
    const program = weeklyProgramRepo.create(WEEK_START, WEEK_END);
    weeklyProgramRepo.upsertSession(program.id, 0, 'push', 'gym', {
      sessionPurpose: 'push',
      availableMinutes: 60,
      estimatedMinutes: 55,
      plannedWork: [{ exercise_id: 'flat-barbell-bench-press', target_type: 'physique_target', target_id: 'mid-pec', classification: 'specialization', sets: 3, reps_min: 6, reps_max: 12, rir_min: 1, rir_max: 3 }],
      skipped: [],
    });
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const monday = context.existingProgram.find((d) => d.date === WEEK_START);
    expect(monday?.programSessionExists).toBe(true);
    expect(monday?.sessionPurpose).toBe('push');
    expect(monday?.plannedWork).toHaveLength(1);
    expect(monday?.plannedWork[0]?.exerciseId).toBe('flat-barbell-bench-press');
    expect(monday?.plannedWork[0]?.targetId).toBe('mid-pec');
  });

  it('marks a day with no persisted program session as programSessionExists: false with an empty plannedWork', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const monday = context.existingProgram.find((d) => d.date === WEEK_START);
    expect(monday?.programSessionExists).toBe(false);
    expect(monday?.plannedWork).toEqual([]);
  });

  it('identifies locked dates (completed/in-progress real sessions) via the shared isDayLocked rule', () => {
    new WorkoutSessionsRepo(db).createSession({ date: '2026-09-08', session_type: 'gym', status: 'completed' });
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(context.lockedDates).toContain('2026-09-08');
    const tuesday = context.existingProgram.find((d) => d.date === '2026-09-08');
    expect(tuesday?.locked).toBe(true);
    expect(tuesday?.lockReason).toMatch(/completed or in_progress/);
    const monday = context.existingProgram.find((d) => d.date === WEEK_START);
    expect(monday?.locked).toBe(false);
    expect(monday?.lockReason).toBeNull();
  });

  it('exposes the real actionable session for a date via the shared resolveSelectedSession resolver', () => {
    const session = new WorkoutSessionsRepo(db).createSession({ date: '2026-09-08', session_type: 'gym', status: 'planned', source_type: 'manual' });
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const tuesday = context.existingProgram.find((d) => d.date === '2026-09-08');
    expect(tuesday?.realSession?.sessionId).toBe(session.session_id);
    expect(tuesday?.realSession?.status).toBe('planned');
  });

  it('includes a non-empty target/valid-exercise catalogue (real training exposure/recovery data), self-contained (no filtering flags)', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(context.targets.length).toBeGreaterThan(0);
    const withExercises = context.targets.find((t) => t.validExercises.length > 0);
    expect(withExercises).toBeDefined();
    expect(context.executionContext.programmingFilteringAllowed).toBe(false);
  });

  it('includes activeGoals (empty array when the user has none)', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(Array.isArray(context.activeGoals)).toBe(true);
  });

  it('produces a stable, non-empty contextHash and contextId, with bounded diagnostics', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(typeof context.contextHash).toBe('string');
    expect(context.contextHash.length).toBeGreaterThan(0);
    expect(typeof context.contextId).toBe('string');
    expect(context.contextId.length).toBeGreaterThan(0);
    expect(context.diagnostics.approxContextSizeChars).toBeGreaterThan(0);
    expect(Array.isArray(context.diagnostics.warnings)).toBe(true);
    expect(Array.isArray(context.diagnostics.missingData)).toBe(true);
  });

  it('produces the same contextHash for two builds against identical, unchanged state', () => {
    const a = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const b = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(a.contextHash).toBe(b.contextHash);
  });

  it('warns diagnostically when no persisted week program exists yet', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(context.diagnostics.warnings.some((w) => /no persisted week program exists/.test(w))).toBe(true);
  });

  it('sets mode and schemaVersion correctly', () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(context.mode).toBe('reconcile_week');
    expect(context.schemaVersion).toBe('ai-reconciliation-context.v1');
  });
});
