// Programming Redesign (Step 12) Phase 7/8: deterministic, low-level
// tests of reconcileWeekProgram/reconcileAfterActualTraining's new
// trigger-context and deviation-reason mechanics — hand-built
// FreshDayInput fixtures, bypassing the full realistic engine's
// emergent multi-target ranking, so each branch of
// classifyDeviationReason is proven directly and unambiguously.
// Complements tests/routes/actualTrainingAdaptation.test.ts's real
// end-to-end HTTP coverage.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { reconcileWeekProgram, reconcileAfterActualTraining, type FreshDayInput, type WeekAggregates } from '../../src/engine/weekProgramReconciliation.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

const AGG: WeekAggregates = { activeGoals: [], targetAllocations: [] };
const WEEK_START = '2026-08-31'; // a real Monday

function plainDay(dayIndex: number, date: string, sets: number, opts: { skipped?: unknown[]; recoveryAdjustment?: string } = {}): FreshDayInput {
  return {
    dayIndex,
    date,
    hasGymComponent: true,
    sessionPurpose: 'gym',
    snapshot: {
      sessionPurpose: 'gym',
      plannedWork:
        sets > 0
          ? [
              {
                exercise_id: 'back-squat',
                target_id: 'quads',
                target_type: 'physique_target',
                sets,
                reps_min: 8,
                reps_max: 12,
                decision: opts.recoveryAdjustment ? { recovery: { priority_adjustment: opts.recoveryAdjustment } } : { recovery: { priority_adjustment: 'none' } },
              },
            ]
          : [],
      skipped: opts.skipped ?? [],
    } as unknown as FreshDayInput['snapshot'],
  };
}

describe('reconcileWeekProgram — trigger-aware deviation_reason (spec section 9)', () => {
  it('never attaches deviation_reason on first-ever generation (genesis, not a deviation)', () => {
    const days = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 3)];
    const program = reconcileWeekProgram(db, WEEK_START, days, AGG);
    for (const s of program.sessions) {
      expect((s.snapshot as any).deviation_reason).toBeUndefined();
    }
  });

  it('the exact day an actual-training trigger targets is tagged actual_user_modification', () => {
    const days = [plainDay(0, '2026-08-31', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG); // genesis
    const changed = [plainDay(0, '2026-08-31', 9)]; // genuinely different prescription
    const program = reconcileWeekProgram(db, WEEK_START, changed, AGG, { kind: 'actual_training', dayIndex: 0 });
    expect((program.sessions[0]!.snapshot as any).deviation_reason).toBe('actual_user_modification');
  });

  it('a DIFFERENT day changed as a real consequence of an actual-training trigger is also actual_user_modification when no more specific signal applies', () => {
    const days = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG); // genesis
    const changed = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 2)]; // day 1 genuinely changed, day 0 didn't
    const program = reconcileWeekProgram(db, WEEK_START, changed, AGG, { kind: 'actual_training', dayIndex: 0 });
    const day1 = program.sessions.find((s) => s.day_index === 1)!;
    expect((day1.snapshot as any).deviation_reason).toBe('actual_user_modification');
    const day0 = program.sessions.find((s) => s.day_index === 0)!;
    expect((day0.snapshot as any).deviation_reason).toBeUndefined(); // unchanged — never rewritten
  });

  it('a day changed as a consequence of an activity-override trigger (not the override day itself) is tagged goal_priority_tradeoff by default', () => {
    const days = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG);
    const changed = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 9)];
    const program = reconcileWeekProgram(db, WEEK_START, changed, AGG, { kind: 'activity_override', dayIndex: 0 });
    const day1 = program.sessions.find((s) => s.day_index === 1)!;
    expect((day1.snapshot as any).deviation_reason).toBe('goal_priority_tradeoff');
  });

  it('a day whose fresh computation shows a recovery adjustment is tagged recovery, regardless of trigger kind', () => {
    const days = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG);
    const changed = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 2, { recoveryAdjustment: 'reduce' })];
    const program = reconcileWeekProgram(db, WEEK_START, changed, AGG, { kind: 'actual_training', dayIndex: 0 });
    const day1 = program.sessions.find((s) => s.day_index === 1)!;
    expect((day1.snapshot as any).deviation_reason).toBe('recovery');
  });

  it('a day whose fresh computation skipped a target as "adequately exposed" is tagged sufficient_secondary_exposure', () => {
    const days = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG);
    const changed = [
      plainDay(0, '2026-08-31', 5),
      plainDay(1, '2026-09-01', 0, { skipped: [{ target_id: 'triceps', reason: 'Already adequately exposed via compound work (14.0 exposure_units) — spec §7/§8.' }] }),
    ];
    const program = reconcileWeekProgram(db, WEEK_START, changed, AGG, { kind: 'actual_training', dayIndex: 0 });
    const day1 = program.sessions.find((s) => s.day_index === 1)!;
    expect((day1.snapshot as any).deviation_reason).toBe('sufficient_secondary_exposure');
  });

  it('every attached deviation_reason is always one of the exact 9 defined values (spec section 9, never decorative text)', () => {
    const VALID = [
      'time_constraint',
      'recovery',
      'sufficient_secondary_exposure',
      'goal_priority_tradeoff',
      'equipment_constraint',
      'exercise_redundancy',
      'actual_user_modification',
      'session_capacity',
      'adherence_pattern',
    ];
    const days = [plainDay(0, '2026-08-31', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG);
    const changed = [plainDay(0, '2026-08-31', 9)];
    const program = reconcileWeekProgram(db, WEEK_START, changed, AGG, { kind: 'actual_training', dayIndex: 0 });
    const reason = (program.sessions[0]!.snapshot as any).deviation_reason;
    expect(VALID).toContain(reason);
  });
});

describe('reconcileAfterActualTraining — the remaining-week adaptation entry point (spec section 8)', () => {
  it('is a pure no-op when the week has never been persisted at all', () => {
    const result = reconcileAfterActualTraining(db, WEEK_START, '2026-08-31', () => ({ days: [plainDay(0, '2026-08-31', 9)], aggregates: AGG }));
    expect(result).toBeNull();
    expect(new WeeklyProgramRepo(db).getByWeekStart(WEEK_START)).toBeUndefined();
  });

  it('adapts the persisted week once it already exists, and never touches a locked (completed) day\'s own persisted prescription', () => {
    const days = [plainDay(0, '2026-08-31', 5), plainDay(1, '2026-09-01', 5)];
    reconcileWeekProgram(db, WEEK_START, days, AGG);

    // Day 0 (Monday) is now real, logged, completed history.
    new WorkoutSessionsRepo(db).createSession({ date: '2026-08-31', session_type: 'gym', status: 'completed', duration_minutes: 45 });

    const repoBefore = new WeeklyProgramRepo(db).getByWeekStart(WEEK_START)!;
    const day0Before = repoBefore.sessions.find((s) => s.day_index === 0)!;

    const changed = [plainDay(0, '2026-08-31', 20), plainDay(1, '2026-09-01', 2)]; // fresh recompute wants Monday different too
    const result = reconcileAfterActualTraining(db, WEEK_START, '2026-08-31', () => ({ days: changed, aggregates: AGG }));

    expect(result).not.toBeNull();
    const day0After = result!.sessions.find((s) => s.day_index === 0)!;
    const day1After = result!.sessions.find((s) => s.day_index === 1)!;
    // Locked day 0 is byte-for-byte unchanged despite the fresh
    // computation wanting something different for it.
    expect(day0After.id).toBe(day0Before.id);
    expect(day0After.snapshot).toEqual(day0Before.snapshot);
    // Unlocked day 1 genuinely adapted and carries a real reason.
    expect((day1After.snapshot as any).deviation_reason).toBe('actual_user_modification');
  });
});
