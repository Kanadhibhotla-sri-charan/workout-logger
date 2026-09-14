// Aggregate-Integrity Fix: `reconcileWeekProgram` used to persist
// `programs.target_allocations_json` verbatim from whatever
// `buildWeeklyProgrammingPlan` computed in its own blind, in-memory
// `sessions[]` — built with zero awareness of which days the SAME
// call's own locked-day-preservation loop actually kept untouched.
// Once any day in a week is locked (a real completed/in-progress
// workout exists for it), that in-memory plan can describe entirely
// different work for it than what genuinely ends up in
// `program_sessions` — production observed a week where every gym day
// became locked and `deliveredDirectSets: 0` was persisted for the
// large majority of targets despite their real sessions clearly
// containing that work. The cross-week carryover fix then reads that
// corrupted `unmetDirectSets` as real backlog.
//
// This file proves `target_allocations_json` now reflects the week's
// REAL final persisted sessions — never the discarded hypothetical
// run — for both a fully-locked and a partially-locked week.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { reconcileWeekProgram, type FreshDayInput, type WeekAggregates } from '../../src/engine/weekProgramReconciliation.js';
import { WeeklyProgramRepo, type PersistedWeekSession } from '../../src/repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import type { WeeklyPlanTargetAllocation } from '../../src/engine/workoutBuilder.js';

let db: Database.Database;
const WEEK_START = '2026-08-31'; // a real Monday

beforeEach(() => {
  db = openDb(':memory:');
});

function dayWithTarget(dayIndex: number, date: string, targetId: string, sets: number): FreshDayInput {
  return {
    dayIndex,
    date,
    hasGymComponent: true,
    sessionPurpose: 'gym',
    snapshot: {
      sessionPurpose: 'gym',
      plannedWork: [
        {
          exercise_id: 'back-squat',
          target_id: targetId,
          target_type: 'physique_target',
          sets,
          reps_min: 8,
          reps_max: 12,
          primary_exposure: sets,
          secondary_exposure: 0,
        },
      ],
      skipped: [],
    } as unknown as FreshDayInput['snapshot'],
  };
}

function aggFor(targetId: string, requiredDirectSets: number, deliveredDirectSets: number): WeekAggregates {
  const allocation: WeeklyPlanTargetAllocation = {
    target_type: 'physique_target',
    target_id: targetId,
    layer: 'normal_development',
    requiredDirectSets,
    deliveredDirectSets,
    unmetDirectSets: Math.max(0, requiredDirectSets - deliveredDirectSets),
    plannedPrimaryExposure: deliveredDirectSets,
    plannedSecondaryExposure: 0,
    allocatedSessionDates: [],
  };
  return { activeGoals: [], targetAllocations: [allocation] };
}

function allocationFor(sessions: readonly PersistedWeekSession[] | undefined, allocations: unknown, targetId: string) {
  return (allocations as WeeklyPlanTargetAllocation[]).find((a) => a.target_id === targetId);
}

function markCompleted(date: string) {
  new WorkoutSessionsRepo(db).createSession({ date, session_type: 'gym', status: 'completed' });
}

describe('Aggregate-Integrity Fix — target_allocations_json reflects real final sessions', () => {
  it('a FULLY LOCKED week: persisted target_allocations matches the real preserved session, not the discarded fresh hypothetical', () => {
    // Genesis: quads gets 5 real sets on Monday, matches its own fresh aggregate at this point.
    const genesisDays = [dayWithTarget(0, '2026-08-31', 'quads', 5)];
    reconcileWeekProgram(db, WEEK_START, genesisDays, aggFor('quads', 10, 5));

    // Monday is now locked by a real completed workout — its persisted
    // plannedWork (quads: 5) must never be touched again.
    markCompleted('2026-08-31');

    // A LATER reconciliation run's own blind, hypothetical recompute now
    // thinks quads gets ZERO work this week (e.g. because real logged
    // history shifted its own candidate selection) — this is exactly
    // the buggy input that used to get persisted verbatim.
    const hypotheticalDays = [dayWithTarget(0, '2026-08-31', 'quads', 0)];
    const program = reconcileWeekProgram(db, WEEK_START, hypotheticalDays, aggFor('quads', 10, 0), {
      kind: 'actual_training',
      dayIndex: 0,
    });

    // The real, persisted session is untouched (Monday stayed locked/preserved).
    const monday = program.sessions.find((s) => s.day_index === 0)!;
    expect((monday.snapshot as any).plannedWork[0].sets).toBe(5);

    // The aggregate must reflect that real 5, never the hypothetical 0.
    const quads = allocationFor(program.sessions, program.target_allocations, 'quads')!;
    expect(quads.deliveredDirectSets).toBe(5);
    expect(quads.unmetDirectSets).toBe(5); // 10 required - 5 real delivered, never 10
    expect(quads.allocatedSessionDates).toEqual(['2026-08-31']);
  });

  it('a PARTIALLY LOCKED week: the aggregate sums the real locked day AND the real freshly-written day together', () => {
    // Genesis: two real gym days, both contributing to "quads".
    const genesisDays = [dayWithTarget(0, '2026-08-31', 'quads', 5), dayWithTarget(3, '2026-09-03', 'quads', 3)];
    reconcileWeekProgram(db, WEEK_START, genesisDays, aggFor('quads', 8, 8));

    // Only Monday becomes locked (a real completed workout) — Thursday remains open.
    markCompleted('2026-08-31');

    // A later run changes Thursday's own real prescription (a genuine,
    // unlocked change) while its own blind hypothetical for Monday
    // (locked, so irrelevant) claims something different again.
    const changedDays = [dayWithTarget(0, '2026-08-31', 'quads', 0), dayWithTarget(3, '2026-09-03', 'quads', 4)];
    const program = reconcileWeekProgram(db, WEEK_START, changedDays, aggFor('quads', 9, 4), {
      kind: 'actual_training',
      dayIndex: 3,
    });

    const monday = program.sessions.find((s) => s.day_index === 0)!;
    const thursday = program.sessions.find((s) => s.day_index === 3)!;
    expect((monday.snapshot as any).plannedWork[0].sets).toBe(5); // locked, preserved
    expect((thursday.snapshot as any).plannedWork[0].sets).toBe(4); // unlocked, genuinely rewritten

    const quads = allocationFor(program.sessions, program.target_allocations, 'quads')!;
    // Real total across BOTH real sessions — 5 (locked Monday) + 4 (rewritten Thursday) = 9.
    expect(quads.deliveredDirectSets).toBe(9);
    expect(quads.unmetDirectSets).toBe(0); // 9 required, 9 real delivered
    expect([...quads.allocatedSessionDates].sort()).toEqual(['2026-08-31', '2026-09-03']);
  });

  it('an UNLOCKED, UNCHANGED week: the aggregate still matches the real (unchanged) persisted session, not a divergent fresh recompute', () => {
    const genesisDays = [dayWithTarget(0, '2026-08-31', 'quads', 5)];
    reconcileWeekProgram(db, WEEK_START, genesisDays, aggFor('quads', 10, 5));

    // No lock. A later run recomputes the SAME content (corePrescriptionEqual
    // keeps the old row untouched) but passes a DIFFERENT (stale/wrong) aggregate.
    const sameContentDays = [dayWithTarget(0, '2026-08-31', 'quads', 5)];
    const program = reconcileWeekProgram(db, WEEK_START, sameContentDays, aggFor('quads', 10, 999));

    const quads = allocationFor(program.sessions, program.target_allocations, 'quads')!;
    expect(quads.deliveredDirectSets).toBe(5); // real content, never the bogus 999
  });

  it('a target with NO real delivered work anywhere still gets a real zero entry (never silently dropped)', () => {
    const genesisDays = [dayWithTarget(0, '2026-08-31', 'quads', 5)];
    const program = reconcileWeekProgram(db, WEEK_START, genesisDays, {
      activeGoals: [],
      targetAllocations: [
        { target_type: 'physique_target', target_id: 'quads', layer: 'normal_development', requiredDirectSets: 5, deliveredDirectSets: 5, unmetDirectSets: 0, plannedPrimaryExposure: 5, plannedSecondaryExposure: 0, allocatedSessionDates: [] },
        { target_type: 'physique_target', target_id: 'hamstrings', layer: 'normal_development', requiredDirectSets: 6, deliveredDirectSets: 0, unmetDirectSets: 6, plannedPrimaryExposure: 0, plannedSecondaryExposure: 0, allocatedSessionDates: [] },
      ] satisfies WeeklyPlanTargetAllocation[],
    });
    const hamstrings = allocationFor(program.sessions, program.target_allocations, 'hamstrings')!;
    expect(hamstrings).toBeDefined();
    expect(hamstrings.deliveredDirectSets).toBe(0);
    expect(hamstrings.unmetDirectSets).toBe(6);
  });
});
