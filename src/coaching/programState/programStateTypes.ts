// Coaching Depth Batch 1 spec §5: explicit persisted state for the
// program's position in time — preparing for future periodization
// without implementing any of it yet (spec §12: no ramping/periodization
// cycles, no automatic/reactive deloads in this batch).

import type { Weekday } from '../../contracts/types.js';

export type ProgramBlockKind = 'base' | 'development' | 'deload';

export interface ProgramState {
  /** This app has no stable multi-week "Program" identity today — every
   * calendar week's persisted plan gets its OWN fresh `programs` row
   * (see WeeklyProgramRepo's own doc comment: "found by
   * programs.start_date"), so a per-week program id cannot anchor state
   * meant to stay stable ACROSS weeks/regenerations. This module
   * therefore keys `programId` to the single-user's own stable id
   * (`UsersRepo.getOrCreateDefault().id`) — the exact identity-scoping
   * convention this session's own `NonGoalRotationRepo` already
   * established for identical reasons ("one row per user... this is a
   * single-user app today, but this repo is scoped per-user exactly
   * like every other piece of training state, never a bare global"). */
  programId: string;
  blockId: string;
  blockKind: ProgramBlockKind;
  blockStartDate: string;
  blockLengthWeeks: number;
  /** 1-based; computed from `blockStartDate` and a real reference date
   * (see `calculateWeekIndex`) — never stored as its own persisted
   * counter, so it can never drift from the block's real start date and
   * can never be advanced by mere app-open time (spec §5.3). */
  weekIndex: number;
  /** Stored only — no code in this batch ever sets this automatically
   * (spec §5.3/§12: "no automatic deload trigger is implemented"). */
  isDeload: boolean;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInitialProgramStateInput {
  programId: string;
  blockStartDate: string;
  blockLengthWeeks: number;
}

/** Explicitly starts the program's NEXT block — a new, real block
 * identity (never a mutation of the current block's own meaning), used
 * only when a caller deliberately decides "this block is over, the next
 * one starts now." Never called automatically by weekly plan
 * regeneration (spec §5.3: "regeneration must not reset the block or
 * week"). */
export interface AdvanceProgramStateInput {
  blockKind: ProgramBlockKind;
  blockStartDate: string;
  blockLengthWeeks: number;
  isDeload?: boolean;
}

export interface ResetProgramStateForNewProgramInput {
  blockStartDate: string;
  blockLengthWeeks: number;
}

/** Which weekday a training week is considered to start on, for
 * `calculateWeekIndex`'s own week-boundary normalization — reuses
 * `TrainingProfile.week_start_day`'s existing concept/type, never a
 * second "week start" convention. */
export type WeekBoundary = Weekday;
