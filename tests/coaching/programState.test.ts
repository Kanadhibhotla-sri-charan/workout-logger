// Coaching Depth Batch 1 spec §10 "Program state" required tests.

import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import {
  calculateWeekIndex,
  computeScheduledDeloadWeek,
  createInitialProgramState,
  getActiveProgramState,
  advanceProgramState,
  resetProgramStateForNewProgram,
  getOrCreateActiveProgramState,
  updateReactiveState,
  ProgramStateAlreadyExistsError,
  ProgramStateNotFoundError,
} from '../../src/coaching/programState/programStateService.js';

let db: Database.Database;
let programId: string;

beforeEach(() => {
  db = openDb(':memory:');
  programId = new UsersRepo(db).getOrCreateDefault().id;
});

describe('createInitialProgramState — new programs begin at week 1, block base, isDeload false', () => {
  it('creates the expected initial state', () => {
    const state = createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    expect(state.blockKind).toBe('base');
    expect(state.isDeload).toBe(false);
    expect(state.weekIndex).toBe(1);
    expect(state.stateVersion).toBe(1);
    expect(state.blockStartDate).toBe('2026-12-14');
    expect(state.blockLengthWeeks).toBe(4);
  });

  it('throws if state already exists for this programId', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    expect(() => createInitialProgramState(db, { programId, blockStartDate: '2026-12-21', blockLengthWeeks: 4 })).toThrow(ProgramStateAlreadyExistsError);
  });
});

describe('getActiveProgramState — IDs remain stable, week index is 1-based', () => {
  it('returns null when no state exists yet', () => {
    expect(getActiveProgramState(db, programId, '2026-12-14', 'monday')).toBeNull();
  });

  it('reading twice with the same referenceDate returns the identical blockId (IDs remain stable during regeneration/re-reads)', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const first = getActiveProgramState(db, programId, '2026-12-16', 'monday');
    const second = getActiveProgramState(db, programId, '2026-12-16', 'monday');
    expect(first?.blockId).toBe(second?.blockId);
    expect(first?.blockId).toBeTruthy();
  });

  it('week index is 1-based, never 0', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 }); // Monday
    const state = getActiveProgramState(db, programId, '2026-12-14', 'monday');
    expect(state?.weekIndex).toBe(1);
  });
});

describe('calculateWeekIndex — app-open time (time of day) must not affect the week', () => {
  it('same calendar date, different notional times of day, gives the same week index (this function only ever receives a calendar date, never a timestamp)', () => {
    // dateMath.ts operates purely on YYYY-MM-DD — there is no time-of-day
    // component to vary, which is itself the enforcement: this function
    // cannot be influenced by wall-clock time even if a caller wanted it to.
    const a = calculateWeekIndex('2026-12-14', '2026-12-16', 'monday');
    const b = calculateWeekIndex('2026-12-14', '2026-12-16', 'monday');
    expect(a).toBe(b);
    expect(a).toBe(1);
  });

  it('Sunday/Monday boundary: a Monday-anchored week does not advance until the following Monday', () => {
    // Block starts Monday 2026-12-14. 2026-12-20 is the Sunday still in
    // week 1; 2026-12-21 is the next Monday, week 2.
    expect(calculateWeekIndex('2026-12-14', '2026-12-20', 'monday')).toBe(1);
    expect(calculateWeekIndex('2026-12-14', '2026-12-21', 'monday')).toBe(2);
  });

  it('month boundary: crossing a month does not itself advance the week incorrectly', () => {
    // 2026-12-28 is a Monday; the following Monday is 2027-01-04.
    expect(calculateWeekIndex('2026-12-28', '2027-01-03', 'monday')).toBe(1);
    expect(calculateWeekIndex('2026-12-28', '2027-01-04', 'monday')).toBe(2);
  });

  it('year boundary: crossing a year does not itself advance the week incorrectly', () => {
    expect(calculateWeekIndex('2026-12-28', '2026-12-31', 'monday')).toBe(1);
    expect(calculateWeekIndex('2026-12-28', '2027-01-04', 'monday')).toBe(2);
  });

  it('a different weekBoundary (e.g. sunday-start) normalizes both dates consistently', () => {
    // Block starts Sunday 2026-12-13 (a real Sunday). Its own Sunday-
    // anchored week runs through Saturday 2026-12-19; the next
    // Sunday-anchored week starts 2026-12-20.
    expect(calculateWeekIndex('2026-12-13', '2026-12-19', 'sunday')).toBe(1);
    expect(calculateWeekIndex('2026-12-13', '2026-12-20', 'sunday')).toBe(2);
  });

  it('never returns less than 1 even if referenceDate precedes blockStartDate', () => {
    expect(calculateWeekIndex('2026-12-14', '2026-12-01', 'monday')).toBe(1);
  });

  it('multiple full weeks elapsed are counted correctly', () => {
    expect(calculateWeekIndex('2026-12-14', '2027-02-02', 'monday')).toBe(8); // 7 weeks later = week 8
  });
});

describe('advanceProgramState — explicit block transition, week resets to 1 for the new block', () => {
  it('changes blockId, blockKind, blockStartDate and resets week to 1', () => {
    const initial = createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const advanced = advanceProgramState(db, programId, { blockKind: 'deload', blockStartDate: '2027-01-11', blockLengthWeeks: 1, isDeload: true });
    expect(advanced.blockId).not.toBe(initial.blockId);
    expect(advanced.blockKind).toBe('deload');
    expect(advanced.isDeload).toBe(true);
    expect(advanced.weekIndex).toBe(1);
    expect(advanced.stateVersion).toBe(initial.stateVersion + 1);
  });

  it('throws if no state exists yet', () => {
    expect(() => advanceProgramState(db, programId, { blockKind: 'base', blockStartDate: '2026-12-14', blockLengthWeeks: 4 })).toThrow(ProgramStateNotFoundError);
  });
});

describe('resetProgramStateForNewProgram — always base/week 1/isDeload false', () => {
  it('creates a fresh state when none exists', () => {
    const state = resetProgramStateForNewProgram(db, programId, { blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    expect(state.blockKind).toBe('base');
    expect(state.isDeload).toBe(false);
    expect(state.weekIndex).toBe(1);
  });

  it('overwrites an existing (even deload) state back to a fresh base block', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    advanceProgramState(db, programId, { blockKind: 'deload', blockStartDate: '2027-01-11', blockLengthWeeks: 1, isDeload: true });
    const reset = resetProgramStateForNewProgram(db, programId, { blockStartDate: '2027-02-01', blockLengthWeeks: 4 });
    expect(reset.blockKind).toBe('base');
    expect(reset.isDeload).toBe(false);
    expect(reset.weekIndex).toBe(1);
    expect(reset.stateVersion).toBe(3); // 1 (create) -> 2 (advance) -> 3 (reset)
  });
});

describe('Batch 3: scheduled calendar deload activates automatically; reactive deload never does', () => {
  it('isDeload stays false through the accumulation weeks of a block', () => {
    const state = createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    expect(state.isDeload).toBe(false);
    // Week 3 (2026-12-28) is still an accumulation week — not the block's
    // last (scheduled deload) week.
    const week3 = getActiveProgramState(db, programId, '2026-12-28', 'monday');
    expect(week3?.weekIndex).toBe(3);
    expect(week3?.isDeload).toBe(false);
    expect(week3?.periodizationState).toBe('ACTIVE');
    expect(week3?.deloadReason).toBeNull();
  });

  it('isDeload becomes true automatically on the block\'s own last (scheduled deload) week — a plain calendar-driven read, never a reactive trigger', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    // 2027-01-04 is week 4 of a 4-week block starting 2026-12-14 — its
    // scheduled deload week.
    const later = getActiveProgramState(db, programId, '2027-01-04', 'monday');
    expect(later?.weekIndex).toBe(4);
    expect(later?.isDeload).toBe(true);
    expect(later?.periodizationState).toBe('SCHEDULED_DELOAD');
    expect(later?.deloadReason).toBe('calendar');
  });

  it('a plain read never sets reactive trigger status away from not_evaluated — reactive evaluation is a separate, explicit action', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const later = getActiveProgramState(db, programId, '2027-01-04', 'monday');
    expect(later?.reactiveTriggerStatus).toBe('not_evaluated');
    expect(later?.reactiveDeloadStartDate).toBeNull();
  });
});

describe('getOrCreateActiveProgramState — lazy initialization for old/never-initialized programs', () => {
  it('old programs (no coaching state row yet) receive safe defaults on first read', () => {
    expect(getActiveProgramState(db, programId, '2026-12-14', 'monday')).toBeNull();
    const state = getOrCreateActiveProgramState(db, programId, '2026-12-14', 'monday', 4);
    expect(state.blockKind).toBe('base');
    expect(state.weekIndex).toBe(1);
  });

  it('a second call reads the same, already-created state rather than creating another', () => {
    const first = getOrCreateActiveProgramState(db, programId, '2026-12-14', 'monday', 4);
    const second = getOrCreateActiveProgramState(db, programId, '2026-12-21', 'monday', 4);
    expect(second.blockId).toBe(first.blockId);
    expect(second.weekIndex).toBe(2);
  });
});

describe('Batch 3: computeScheduledDeloadWeek — always the block\'s own last week', () => {
  it('equals blockLengthWeeks for any block length', () => {
    expect(computeScheduledDeloadWeek(4)).toBe(4);
    expect(computeScheduledDeloadWeek(1)).toBe(1);
    expect(computeScheduledDeloadWeek(6)).toBe(6);
  });
});

describe('Batch 3: automatic calendar block transition', () => {
  it('a plain read past the block\'s last week automatically starts the next block, week resets to 1', () => {
    const initial = createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    // Week 5 begins 2027-01-11 (4 full weeks after 2026-12-14).
    const rolled = getActiveProgramState(db, programId, '2027-01-11', 'monday');
    expect(rolled?.blockId).not.toBe(initial.blockId);
    expect(rolled?.blockNumber).toBe(2);
    expect(rolled?.weekIndex).toBe(1);
    expect(rolled?.blockStartDate).toBe('2027-01-11');
    expect(rolled?.periodizationState).toBe('ACTIVE');
    expect(rolled?.blockLengthWeeks).toBe(4);
    expect(rolled?.blockKind).toBe('base');
  });

  it('is idempotent — reading the same post-transition date twice never double-advances', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    const first = getActiveProgramState(db, programId, '2027-01-11', 'monday');
    const second = getActiveProgramState(db, programId, '2027-01-18', 'monday');
    expect(second?.blockId).toBe(first?.blockId);
    expect(second?.blockNumber).toBe(2);
    expect(second?.weekIndex).toBe(2);
  });

  it('a manually-declared whole-block deload (block_kind=deload) does not perpetuate into the automatically-rolled-over next block', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    advanceProgramState(db, programId, { blockKind: 'deload', blockStartDate: '2027-01-11', blockLengthWeeks: 1, isDeload: true });
    // One week later, the manual deload block has ended.
    const rolled = getActiveProgramState(db, programId, '2027-01-18', 'monday');
    expect(rolled?.blockKind).toBe('base');
    expect(rolled?.isDeload).toBe(false);
    expect(rolled?.periodizationState).toBe('ACTIVE');
  });
});

describe('Batch 3: reactive deload state via updateReactiveState', () => {
  it('an active reactive window reports periodizationState REACTIVE_DELOAD and deloadReason reactive, isDeload true', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    updateReactiveState(db, programId, '2026-12-16', 'monday', {
      reactiveTriggerStatus: 'triggered',
      reactiveTriggeredAt: '2026-12-16',
      reactiveDeloadStartDate: '2026-12-16',
      reactiveDeloadEndDate: '2026-12-22',
      cooldownUntil: '2027-01-05',
    });
    const state = getActiveProgramState(db, programId, '2026-12-18', 'monday');
    expect(state?.periodizationState).toBe('REACTIVE_DELOAD');
    expect(state?.deloadReason).toBe('reactive');
    expect(state?.isDeload).toBe(true);
    expect(state?.reactiveTriggerStatus).toBe('triggered');
  });

  it('a reactive window overlapping the block\'s own scheduled deload week reports deloadReason combined', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    // Week 4 (scheduled deload) runs 2027-01-04..2027-01-10.
    updateReactiveState(db, programId, '2027-01-02', 'monday', {
      reactiveTriggerStatus: 'triggered',
      reactiveTriggeredAt: '2027-01-02',
      reactiveDeloadStartDate: '2027-01-02',
      reactiveDeloadEndDate: '2027-01-08',
      cooldownUntil: '2027-01-22',
    });
    const state = getActiveProgramState(db, programId, '2027-01-06', 'monday');
    expect(state?.periodizationState).toBe('REACTIVE_DELOAD');
    expect(state?.deloadReason).toBe('combined');
  });

  it('after the reactive window ends but before cooldownUntil, status reports cooldown and isDeload is false', () => {
    createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    updateReactiveState(db, programId, '2026-12-16', 'monday', {
      reactiveTriggerStatus: 'triggered',
      reactiveTriggeredAt: '2026-12-16',
      reactiveDeloadStartDate: '2026-12-16',
      reactiveDeloadEndDate: '2026-12-22',
      cooldownUntil: '2027-01-05',
    });
    const state = getActiveProgramState(db, programId, '2026-12-25', 'monday');
    expect(state?.reactiveTriggerStatus).toBe('cooldown');
    expect(state?.periodizationState).toBe('ACTIVE');
    expect(state?.isDeload).toBe(false);
  });

  it('updateReactiveState throws ProgramStateNotFoundError when no state exists yet', () => {
    expect(() => updateReactiveState(db, programId, '2026-12-16', 'monday', { reactiveTriggerStatus: 'clear' })).toThrow(ProgramStateNotFoundError);
  });

  it('specialization fields are null by default and are set only via an explicit updateReactiveState call', () => {
    const initial = createInitialProgramState(db, { programId, blockStartDate: '2026-12-14', blockLengthWeeks: 4 });
    expect(initial.specializationTargetId).toBeNull();
    const updated = updateReactiveState(db, programId, '2026-12-16', 'monday', { specializationTargetId: 'biceps' });
    expect(updated.specializationTargetId).toBe('biceps');
    expect(updated.specializationGoalId).toBeNull();
  });
});
