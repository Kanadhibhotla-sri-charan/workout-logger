// Coaching Depth Batch 1 spec §5.2/§5.3.

import type Database from 'better-sqlite3';
import { addDays, daysBetween } from '../../engine/dateMath.js';
import { weekRangeContaining } from '../../engine/dateMath.js';
import { newId, nowIso } from '../../repositories/ids.js';
import type {
  AdvanceProgramStateInput,
  CreateInitialProgramStateInput,
  ProgramBlockKind,
  ProgramState,
  ResetProgramStateForNewProgramInput,
  WeekBoundary,
} from './programStateTypes.js';

export class ProgramStateAlreadyExistsError extends Error {
  constructor(programId: string) {
    super(`Program state already exists for programId "${programId}" — use getActiveProgramState/advanceProgramState/resetProgramStateForNewProgram instead.`);
    this.name = 'ProgramStateAlreadyExistsError';
  }
}

export class ProgramStateNotFoundError extends Error {
  constructor(programId: string) {
    super(`No program state exists for programId "${programId}" — call createInitialProgramState first.`);
    this.name = 'ProgramStateNotFoundError';
  }
}

interface ProgramStateRow {
  program_id: string;
  block_id: string;
  block_kind: ProgramBlockKind;
  block_start_date: string;
  block_length_weeks: number;
  is_deload: number;
  state_version: number;
  created_at: string;
  updated_at: string;
}

/** 1-based week index of `referenceDate` within a block that started on
 * `blockStartDate`, counting whole calendar weeks (normalized to
 * `weekBoundary`'s own week-start convention — reusing
 * `weekRangeContaining`, never a second week-boundary calculation).
 * Deterministic pure calendar-day arithmetic (see dateMath.ts's own
 * "sidesteps DST entirely" doc comment) — never affected by wall-clock
 * time-of-day, timezone offset, or which moment within a day this is
 * called (spec §5.3: "app-open time must not determine the week").
 * Never returns less than 1, even if `referenceDate` somehow precedes
 * `blockStartDate`. */
export function calculateWeekIndex(blockStartDate: string, referenceDate: string, weekBoundary: WeekBoundary): number {
  const blockWeekStart = weekRangeContaining(blockStartDate, weekBoundary).start;
  const referenceWeekStart = weekRangeContaining(referenceDate, weekBoundary).start;
  const wholeWeeksElapsed = Math.floor(daysBetween(blockWeekStart, referenceWeekStart) / 7);
  return Math.max(1, wholeWeeksElapsed + 1);
}

function rowToProgramState(row: ProgramStateRow, referenceDate: string, weekBoundary: WeekBoundary): ProgramState {
  return {
    programId: row.program_id,
    blockId: row.block_id,
    blockKind: row.block_kind,
    blockStartDate: row.block_start_date,
    blockLengthWeeks: row.block_length_weeks,
    weekIndex: calculateWeekIndex(row.block_start_date, referenceDate, weekBoundary),
    isDeload: row.is_deload === 1,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Reads the current program state for `programId`, or `null` if none
 * has been created yet — a pure read, never creates anything (spec
 * §5.3: "regeneration must not reset the block or week" — a plain read
 * from any call site, including weekly regeneration, can never be the
 * thing that establishes or changes state).
 *
 * `referenceDate`/`weekBoundary` are required, explicit parameters
 * (rather than this function reaching for wall-clock "now" itself) so
 * `weekIndex` is always computed from a real calendar date the caller
 * already resolved through the app's own timezone-aware "today" logic
 * — matching every other date-sensitive computation in this codebase
 * (see dateMath.ts's own timezone-contract doc comment) and directly
 * enforcing spec §5.3's "app-open time must not determine the week." */
export function getActiveProgramState(db: Database.Database, programId: string, referenceDate: string, weekBoundary: WeekBoundary): ProgramState | null {
  const row = db.prepare('SELECT * FROM coaching_program_state WHERE program_id = ?').get(programId) as ProgramStateRow | undefined;
  return row ? rowToProgramState(row, referenceDate, weekBoundary) : null;
}

/** Creates the FIRST program state for `programId` — always block kind
 * `base`, `isDeload: false`, at week 1 (spec §5.3: "new programs begin
 * at week 1, block kind base, isDeload = false"). Throws
 * `ProgramStateAlreadyExistsError` if one already exists — this is a
 * one-time setup operation, never a silent overwrite (use
 * `resetProgramStateForNewProgram` for a deliberate, explicit restart). */
export function createInitialProgramState(db: Database.Database, input: CreateInitialProgramStateInput): ProgramState {
  const existing = db.prepare('SELECT program_id FROM coaching_program_state WHERE program_id = ?').get(input.programId);
  if (existing) throw new ProgramStateAlreadyExistsError(input.programId);

  const now = nowIso();
  const row: ProgramStateRow = {
    program_id: input.programId,
    block_id: newId('coachblock'),
    block_kind: 'base',
    block_start_date: input.blockStartDate,
    block_length_weeks: input.blockLengthWeeks,
    is_deload: 0,
    state_version: 1,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO coaching_program_state (program_id, block_id, block_kind, block_start_date, block_length_weeks, is_deload, state_version, created_at, updated_at)
     VALUES (@program_id, @block_id, @block_kind, @block_start_date, @block_length_weeks, @is_deload, @state_version, @created_at, @updated_at)`
  ).run(row);

  // A freshly created block's own start date IS the reference point by
  // definition, so its week index is always exactly 1 — no need to
  // round-trip through calculateWeekIndex with an arbitrary weekBoundary.
  return {
    programId: row.program_id,
    blockId: row.block_id,
    blockKind: row.block_kind,
    blockStartDate: row.block_start_date,
    blockLengthWeeks: row.block_length_weeks,
    weekIndex: 1,
    isDeload: false,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Explicitly starts the program's NEXT block (spec §5.2) — a genuinely
 * new block identity (`blockId` changes; spec §5.3: "blockId remains
 * stable WITHIN a block", which this respects by only ever changing it
 * here, never on a plain read or regeneration). Never called
 * automatically anywhere in this codebase — Batch 1 implements no
 * automatic block/deload transition (spec §12). Throws
 * `ProgramStateNotFoundError` if no state exists yet for `programId`. */
export function advanceProgramState(db: Database.Database, programId: string, input: AdvanceProgramStateInput): ProgramState {
  const existing = db.prepare('SELECT program_id FROM coaching_program_state WHERE program_id = ?').get(programId) as { program_id: string } | undefined;
  if (!existing) throw new ProgramStateNotFoundError(programId);

  const now = nowIso();
  db.prepare(
    `UPDATE coaching_program_state
     SET block_id = @block_id, block_kind = @block_kind, block_start_date = @block_start_date,
         block_length_weeks = @block_length_weeks, is_deload = @is_deload,
         state_version = state_version + 1, updated_at = @updated_at
     WHERE program_id = @program_id`
  ).run({
    program_id: programId,
    block_id: newId('coachblock'),
    block_kind: input.blockKind,
    block_start_date: input.blockStartDate,
    block_length_weeks: input.blockLengthWeeks,
    is_deload: input.isDeload ? 1 : 0,
    updated_at: now,
  });

  const row = db.prepare('SELECT * FROM coaching_program_state WHERE program_id = ?').get(programId) as ProgramStateRow;
  // A block that was just started has its own start date as the
  // reference point by definition — always week 1, same reasoning as
  // createInitialProgramState.
  return {
    programId: row.program_id,
    blockId: row.block_id,
    blockKind: row.block_kind,
    blockStartDate: row.block_start_date,
    blockLengthWeeks: row.block_length_weeks,
    weekIndex: 1,
    isDeload: row.is_deload === 1,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resets `programId` back to a fresh `base` block at week 1,
 * `isDeload: false` — an explicit, deliberate restart (e.g. the user
 * begins a genuinely new program), unlike `createInitialProgramState`
 * (which requires no prior state) or `advanceProgramState` (which
 * transitions within an ongoing program's own block sequence). Creates
 * a row if none exists yet, or overwrites the existing one — this is
 * the one function in this module allowed to unconditionally replace
 * prior state, since "a new program" is by definition not a
 * continuation of whatever came before. */
export function resetProgramStateForNewProgram(db: Database.Database, programId: string, input: ResetProgramStateForNewProgramInput): ProgramState {
  const existing = db.prepare('SELECT state_version FROM coaching_program_state WHERE program_id = ?').get(programId) as { state_version: number } | undefined;
  const now = nowIso();
  db.prepare(
    `INSERT INTO coaching_program_state (program_id, block_id, block_kind, block_start_date, block_length_weeks, is_deload, state_version, created_at, updated_at)
     VALUES (@program_id, @block_id, @block_kind, @block_start_date, @block_length_weeks, @is_deload, @state_version, @created_at, @updated_at)
     ON CONFLICT(program_id) DO UPDATE SET
       block_id = @block_id, block_kind = @block_kind, block_start_date = @block_start_date,
       block_length_weeks = @block_length_weeks, is_deload = @is_deload,
       state_version = @state_version, updated_at = @updated_at`
  ).run({
    program_id: programId,
    block_id: newId('coachblock'),
    block_kind: 'base',
    block_start_date: input.blockStartDate,
    block_length_weeks: input.blockLengthWeeks,
    is_deload: 0,
    state_version: (existing?.state_version ?? 0) + 1,
    created_at: now,
    updated_at: now,
  });

  // Re-select rather than trust the just-computed values directly: on
  // an UPDATE conflict, created_at is deliberately left out of the SET
  // clause above (a reset keeps the row's true original creation time),
  // so the persisted value can differ from `now` above.
  const row = db.prepare('SELECT * FROM coaching_program_state WHERE program_id = ?').get(programId) as ProgramStateRow;
  return {
    programId: row.program_id,
    blockId: row.block_id,
    blockKind: row.block_kind,
    blockStartDate: row.block_start_date,
    blockLengthWeeks: row.block_length_weeks,
    weekIndex: 1,
    isDeload: false,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convenience used by read paths (e.g. the coaching foundation
 * context) that want "the current state, lazily initialized the first
 * time it is ever read" without every caller re-implementing the
 * get-then-create dance. Never called from weekly plan regeneration
 * itself — only from an explicit context-build request (spec §5.3's
 * "regeneration must not reset the block or week" concerns
 * regeneration specifically, not a caller reading state on demand). */
export function getOrCreateActiveProgramState(
  db: Database.Database,
  programId: string,
  referenceDate: string,
  weekBoundary: WeekBoundary,
  defaultBlockLengthWeeks: number
): ProgramState {
  const existing = getActiveProgramState(db, programId, referenceDate, weekBoundary);
  if (existing) return existing;
  return createInitialProgramState(db, { programId, blockStartDate: referenceDate, blockLengthWeeks: defaultBlockLengthWeeks });
}

// Re-exported so a caller building a block start date one week later
// than another (e.g. in tests) never needs a second import just for
// addDays.
export { addDays };
