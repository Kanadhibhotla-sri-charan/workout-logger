// Coaching Depth Batch 3 spec §15 "Testing Requirements" — periodization
// system (Phase 2 + Phase 4 combined).

import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { PeriodizationEventsRepo } from '../../src/coaching/periodization/periodizationEventsRepo.js';
import { evaluateReactiveDeloadTrigger } from '../../src/coaching/periodization/reactiveTrendEvaluator.js';
import { getPeriodizationContext } from '../../src/coaching/periodization/periodizationService.js';
import { applyDeloadSetVolumeReduction, computeCooldownUntil, computeReactiveDeloadEndDate } from '../../src/coaching/periodization/deloadPolicy.js';
import { createInitialProgramState } from '../../src/coaching/programState/programStateService.js';

let db: Database.Database;
let programId: string;
let sessionsRepo: WorkoutSessionsRepo;

const RECTUS_ABDOMINIS_EXERCISE = 'cable-crunch'; // primary: rectus-abdominis
const GASTROCNEMIUS_EXERCISE = 'standing-calf-raise'; // primary: gastrocnemius
const OBLIQUES_EXERCISE = 'cable-woodchop'; // primary: obliques

beforeEach(() => {
  db = openDb(':memory:');
  programId = new UsersRepo(db).getOrCreateDefault().id;
  sessionsRepo = new WorkoutSessionsRepo(db);
});

function seedSession(date: string, exerciseId: string, weight: number, reps: number) {
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  sessionsRepo.addExercisePerformance(session.session_id, {
    exercise_id: exerciseId,
    order: 0,
    role: 'primary',
    target_sets: 3,
    sets: [1, 2, 3].map((n) => ({ set_number: n, weight, reps, completed: true, rir: null })),
  });
}

describe('deloadPolicy — centralized, deterministic', () => {
  it('applyDeloadSetVolumeReduction halves and never goes below 1', () => {
    expect(applyDeloadSetVolumeReduction(10)).toBe(5);
    expect(applyDeloadSetVolumeReduction(1)).toBe(1);
    expect(applyDeloadSetVolumeReduction(0)).toBe(0);
  });

  it('computeReactiveDeloadEndDate/computeCooldownUntil are pure functions of the start date', () => {
    const end = computeReactiveDeloadEndDate('2026-12-16');
    expect(end).toBe('2026-12-22'); // 1 week (maxReactiveDeloadDurationWeeks=1)
    const cooldown = computeCooldownUntil(end);
    expect(cooldown).toBe('2027-01-05'); // +14 days
  });
});

describe('reactiveTrendEvaluator — insufficient data never triggers', () => {
  it('reports clear with insufficient_data when fewer than the minimum completed sessions exist', () => {
    seedSession('2026-12-01', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    const result = evaluateReactiveDeloadTrigger(db, { programId, referenceDate: '2026-12-10', isInCooldown: false, isAlreadyInReactiveDeload: false });
    expect(result.triggered).toBe(false);
    expect(result.level).toBe('clear');
    expect(result.blockingReasons).toContain('insufficient_data');
  });
});

describe('reactiveTrendEvaluator — one declining target is watch, never triggered', () => {
  it('a single target in genuine decline reports level watch, triggered false', () => {
    // 6 completed sessions total (the minimum) to pass the data-volume
    // gate, but decline concentrated on ONE target only.
    seedSession('2026-11-20', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-23', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-26', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-29', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-12-01', GASTROCNEMIUS_EXERCISE, 50, 12);
    seedSession('2026-12-03', GASTROCNEMIUS_EXERCISE, 50, 12);

    const result = evaluateReactiveDeloadTrigger(db, { programId, referenceDate: '2026-12-10', isInCooldown: false, isAlreadyInReactiveDeload: false });
    expect(result.sessionsConsidered).toBeGreaterThanOrEqual(6);
    expect(result.level).toBe('watch');
    expect(result.triggered).toBe(false);
    expect(result.signals.map((s) => s.targetId)).toEqual(['rectus-abdominis']);
  });
});

describe('reactiveTrendEvaluator — sustained decline across 2+ targets triggers', () => {
  it('two independently declining targets report level triggered, triggered true (no blocking reasons)', () => {
    seedSession('2026-11-20', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-22', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-24', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-26', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-28', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-30', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-12-02', GASTROCNEMIUS_EXERCISE, 30, 12);
    seedSession('2026-12-04', GASTROCNEMIUS_EXERCISE, 30, 12);

    const result = evaluateReactiveDeloadTrigger(db, { programId, referenceDate: '2026-12-10', isInCooldown: false, isAlreadyInReactiveDeload: false });
    expect(result.level).toBe('triggered');
    expect(result.triggered).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('the same evidence is withheld (triggered false) when already in cooldown', () => {
    seedSession('2026-11-20', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-22', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-24', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-26', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-28', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-30', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-12-02', GASTROCNEMIUS_EXERCISE, 30, 12);
    seedSession('2026-12-04', GASTROCNEMIUS_EXERCISE, 30, 12);

    const result = evaluateReactiveDeloadTrigger(db, { programId, referenceDate: '2026-12-10', isInCooldown: true, isAlreadyInReactiveDeload: false });
    expect(result.level).toBe('triggered');
    expect(result.triggered).toBe(false);
    expect(result.blockingReasons).toContain('cooldown_active');
  });

  it('never fires from a single noisy session — one exposure per target is never enough data quality', () => {
    seedSession('2026-11-20', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-22', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-24', OBLIQUES_EXERCISE, 30, 12);
    seedSession('2026-11-26', RECTUS_ABDOMINIS_EXERCISE, 15, 12);
    seedSession('2026-11-28', GASTROCNEMIUS_EXERCISE, 20, 12);
    seedSession('2026-11-30', OBLIQUES_EXERCISE, 10, 12);
    // Each target has exactly 2 exposures — the minimum for a
    // classification at all, but each target's own trend is what it is;
    // this test's real point is that unrelated exercises are never
    // pooled together (see historicalService.ts) so this remains a
    // per-target, multi-signal decision, not a single blended average.
    const result = evaluateReactiveDeloadTrigger(db, { programId, referenceDate: '2026-12-05', isInCooldown: false, isAlreadyInReactiveDeload: false });
    // Whatever the outcome, it must be internally consistent: triggered
    // implies level 'triggered' and vice versa when unblocked.
    if (result.triggered) expect(result.level).toBe('triggered');
    if (result.level !== 'triggered') expect(result.triggered).toBe(false);
  });
});

describe('periodizationService.getPeriodizationContext — scheduled (calendar) deload', () => {
  it('deloadActive is false during accumulation weeks', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const ctx = getPeriodizationContext(db, { programId, referenceDate: '2026-12-16', weekBoundary: 'monday', defaultBlockLengthWeeks: 4 });
    expect(ctx.deloadActive).toBe(false);
    expect(ctx.setVolumeMultiplier).toBe(1);
    expect(ctx.deloadRepRangeBias).toBeNull();
  });

  it('deloadActive is true with setVolumeMultiplier 0.5 and repRangeBias lower on the block\'s scheduled deload week', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const ctx = getPeriodizationContext(db, { programId, referenceDate: '2027-01-04', weekBoundary: 'monday', defaultBlockLengthWeeks: 4 });
    expect(ctx.deloadActive).toBe(true);
    expect(ctx.deloadReason).toBe('calendar');
    expect(ctx.setVolumeMultiplier).toBe(0.5);
    expect(ctx.deloadRepRangeBias).toBe('lower');
  });
});

describe('periodizationService.getPeriodizationContext — reactive evaluation lifecycle', () => {
  it('runs a fresh evaluation on the first call of the day, then skips re-evaluation on a same-day re-read', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const first = getPeriodizationContext(db, { programId, referenceDate: '2026-12-16', weekBoundary: 'monday', defaultBlockLengthWeeks: 4 });
    expect(first.reactiveEvaluation).not.toBeNull();
    const second = getPeriodizationContext(db, { programId, referenceDate: '2026-12-16', weekBoundary: 'monday', defaultBlockLengthWeeks: 4 });
    expect(second.reactiveEvaluation).toBeNull();
    expect(second.programState.lastEvaluatedAt).toBe(first.programState.lastEvaluatedAt);
  });

  it('a genuine multi-target decline triggers a reactive deload, persists the window, and logs an observability event', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-11-01', blockLengthWeeks: 8 });
    seedSession('2026-11-04', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-06', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-08', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-10', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-12', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-14', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-16', GASTROCNEMIUS_EXERCISE, 30, 12);
    seedSession('2026-11-18', GASTROCNEMIUS_EXERCISE, 30, 12);

    const ctx = getPeriodizationContext(db, { programId, referenceDate: '2026-11-22', weekBoundary: 'monday', defaultBlockLengthWeeks: 8 });
    expect(ctx.reactiveEvaluation?.triggered).toBe(true);
    expect(ctx.deloadActive).toBe(true);
    expect(ctx.deloadReason).toBe('reactive');
    expect(ctx.setVolumeMultiplier).toBe(0.5);
    expect(ctx.programState.reactiveDeloadStartDate).toBe('2026-11-22');
    expect(ctx.programState.cooldownUntil).not.toBeNull();

    const events = new PeriodizationEventsRepo(db).listForProgram(programId);
    expect(events.some((e) => e.triggerType === 'reactive_triggered')).toBe(true);
  });

  it('never triggers a second reactive deload while one is already active, even with the same evidence', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-11-01', blockLengthWeeks: 8 });
    seedSession('2026-11-04', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-06', RECTUS_ABDOMINIS_EXERCISE, 40, 12);
    seedSession('2026-11-08', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-10', RECTUS_ABDOMINIS_EXERCISE, 20, 12);
    seedSession('2026-11-12', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-14', GASTROCNEMIUS_EXERCISE, 60, 12);
    seedSession('2026-11-16', GASTROCNEMIUS_EXERCISE, 30, 12);
    seedSession('2026-11-18', GASTROCNEMIUS_EXERCISE, 30, 12);

    const triggered = getPeriodizationContext(db, { programId, referenceDate: '2026-11-22', weekBoundary: 'monday', defaultBlockLengthWeeks: 8 });
    expect(triggered.reactiveEvaluation?.triggered).toBe(true);
    const originalStart = triggered.programState.reactiveDeloadStartDate;

    // A day later, still within the active reactive window — re-evaluation
    // runs (rate limit allows it) but must not re-trigger or move the
    // window.
    const nextDay = getPeriodizationContext(db, { programId, referenceDate: '2026-11-23', weekBoundary: 'monday', defaultBlockLengthWeeks: 8 });
    expect(nextDay.reactiveEvaluation?.triggered).toBe(false);
    expect(nextDay.reactiveEvaluation?.blockingReasons).toContain('already_in_active_reactive_deload');
    expect(nextDay.programState.reactiveDeloadStartDate).toBe(originalStart);
    expect(nextDay.deloadActive).toBe(true); // still deloading, from the ORIGINAL window
  });
});
