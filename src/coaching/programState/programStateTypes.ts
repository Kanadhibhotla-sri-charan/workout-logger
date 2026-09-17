// Coaching Depth Batch 1 spec §5: explicit persisted state for the
// program's position in time — preparing for future periodization
// without implementing any of it yet (spec §12: no ramping/periodization
// cycles, no automatic/reactive deloads in this batch).
//
// Coaching Depth Batch 3 (Periodization System) activates that
// foundation: calendar-based scheduled deloads and evidence-driven
// reactive deloads, both against this SAME row (see schema.sql's own
// comment on coaching_program_state for the one-mechanism rationale).

import type { Weekday } from '../../contracts/types.js';

export type ProgramBlockKind = 'base' | 'development' | 'deload';

/** Batch 3 spec §5's state machine — computed, never stored (see
 * schema.sql's own comment): a pure function of the block's calendar
 * dates plus the stored reactive-evidence fields below, exactly the same
 * "derive, don't duplicate" discipline `weekIndex` already uses. */
export type PeriodizationState = 'ACTIVE' | 'SCHEDULED_DELOAD' | 'REACTIVE_DELOAD';

/** Batch 3 spec §5's "combined condition" — also computed, never stored. */
export type DeloadReason = 'calendar' | 'reactive' | 'manual' | 'combined' | null;

/** Batch 3 spec §9.4. Stored (evidence-based, not calendar-derivable):
 * `not_evaluated` (never run), `clear` (evaluated, no concern),
 * `watch` (early warning, no deload), `triggered` (an active reactive
 * deload is running), `cooldown` (recently deloaded, suppressing
 * re-evaluation). */
export type ReactiveTriggerStatus = 'not_evaluated' | 'clear' | 'watch' | 'triggered' | 'cooldown';

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
  /** Batch 3: sequential count of blocks this program has ever had,
   * starting at 1 — used only for display/observability (e.g. "Block
   * 3, Week 2"), never for any decision logic. */
  blockNumber: number;
  blockKind: ProgramBlockKind;
  blockStartDate: string;
  blockLengthWeeks: number;
  /** 1-based; computed from `blockStartDate` and a real reference date
   * (see `calculateWeekIndex`) — never stored as its own persisted
   * counter, so it can never drift from the block's real start date and
   * can never be advanced by mere app-open time (spec §5.3). */
  weekIndex: number;
  /** Batch 3 spec §6.3: the LAST week of every block is its scheduled
   * calendar deload — a pure function of `blockLengthWeeks`, computed
   * here for caller convenience, never independently stored. */
  scheduledDeloadWeek: number;
  /** Batch 3: computed periodization state — see PeriodizationState's
   * own doc comment for why this is derived, not stored. */
  periodizationState: PeriodizationState;
  /** Batch 3: computed — see DeloadReason's own doc comment. */
  deloadReason: DeloadReason;
  /** Derived from `periodizationState` (true for SCHEDULED_DELOAD and
   * REACTIVE_DELOAD) — kept as a plain boolean for callers that only
   * care "is this a deload week at all," and mirrored into the stored
   * `is_deload` column for cheap SQL-level inspection, but never itself
   * the source of truth (spec §2.1: no competing sources of truth). */
  isDeload: boolean;
  /** Batch 3 spec §9.4 — stored, evidence-based (see
   * ReactiveTriggerStatus's own doc comment). */
  reactiveTriggerStatus: ReactiveTriggerStatus;
  reactiveTriggeredAt: string | null;
  reactiveDeloadStartDate: string | null;
  reactiveDeloadEndDate: string | null;
  /** Batch 3 spec §10 — no reactive re-evaluation may TRIGGER a new
   * deload while `referenceDate <= cooldownUntil`, even if evidence
   * would otherwise support one. */
  cooldownUntil: string | null;
  lastEvaluatedAt: string | null;
  /** Batch 3 spec §11 — explicit-only; null unless a human deliberately
   * set it (never inferred from trend data by anything in this
   * codebase). */
  specializationTargetId: string | null;
  specializationGoalId: string | null;
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
 * week") — Batch 3's own automatic calendar transition
 * (`advanceToNextBlockIfDue`) is a SEPARATE, narrower function that only
 * ever runs this exact transition when the calendar genuinely warrants
 * it (see periodizationService.ts), never a blanket permission for
 * regeneration to call this directly. */
export interface AdvanceProgramStateInput {
  blockKind: ProgramBlockKind;
  blockStartDate: string;
  blockLengthWeeks: number;
  isDeload?: boolean;
}

/** Batch 3: the subset of stored reactive-evidence fields a periodization
 * write can change — every field optional so a caller only ever touches
 * what it's actually updating (e.g. a plain "mark evaluated, still
 * clear" write never has to also restate the specialization fields). */
export interface UpdateReactiveStateInput {
  reactiveTriggerStatus?: ReactiveTriggerStatus;
  reactiveTriggeredAt?: string | null;
  reactiveDeloadStartDate?: string | null;
  reactiveDeloadEndDate?: string | null;
  cooldownUntil?: string | null;
  lastEvaluatedAt?: string | null;
  specializationTargetId?: string | null;
  specializationGoalId?: string | null;
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
