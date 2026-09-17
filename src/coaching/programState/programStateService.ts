// Coaching Depth Batch 1 spec §5.2/§5.3. Extended by Coaching Depth
// Batch 3 (Periodization System) — see programStateTypes.ts's own doc
// comment and schema.sql's comment on coaching_program_state for why
// periodizationState/deloadReason are computed here rather than stored.

import type Database from 'better-sqlite3';
import { DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS } from '../../engine/config.js';
import { addDays, daysBetween } from '../../engine/dateMath.js';
import { weekRangeContaining } from '../../engine/dateMath.js';
import { newId, nowIso } from '../../repositories/ids.js';
import type {
  AdvanceProgramStateInput,
  CreateInitialProgramStateInput,
  DeloadReason,
  PeriodizationState,
  ProgramBlockKind,
  ProgramState,
  ReactiveTriggerStatus,
  ResetProgramStateForNewProgramInput,
  UpdateReactiveStateInput,
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

/** Raw DB row's own `reactive_trigger_status` never stores the derived
 * `'cooldown'` value (see deriveReactiveTriggerStatus) — only what the
 * most recent real evaluation actually concluded. */
type StoredReactiveTriggerStatus = Exclude<ReactiveTriggerStatus, 'cooldown'>;

interface ProgramStateRow {
  program_id: string;
  block_id: string;
  block_number: number;
  block_kind: ProgramBlockKind;
  block_start_date: string;
  block_length_weeks: number;
  is_deload: number;
  reactive_trigger_status: StoredReactiveTriggerStatus;
  reactive_triggered_at: string | null;
  reactive_deload_start_date: string | null;
  reactive_deload_end_date: string | null;
  cooldown_until: string | null;
  last_evaluated_at: string | null;
  specialization_target_id: string | null;
  specialization_goal_id: string | null;
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

/** Batch 3 spec §6.3: the scheduled calendar deload is always the LAST
 * week of the block (e.g. a 4-week block accumulates for 3 weeks then
 * deloads in week 4) — a pure function of `blockLengthWeeks`, computed
 * everywhere this is needed rather than stored as a second value that
 * could drift out of sync with the block's own length. */
export function computeScheduledDeloadWeek(blockLengthWeeks: number): number {
  return blockLengthWeeks;
}

/** Batch 3 spec §9.4: overlays the derived `'cooldown'` value onto the
 * stored raw evaluation outcome. An active reactive-deload window always
 * reports `'triggered'` regardless of the stored value (the window dates
 * are the source of truth for "is a reactive deload live right now,"
 * never a separate stored flag that could disagree with them); once that
 * window has passed, `cooldownUntil` (set once, at trigger time — see
 * reactiveTrendEvaluator.ts) governs whether `'cooldown'` is reported
 * instead of the stale `'triggered'`/whatever the last real evaluation
 * concluded. */
function deriveReactiveTriggerStatus(
  stored: StoredReactiveTriggerStatus,
  reactiveDeloadStartDate: string | null,
  reactiveDeloadEndDate: string | null,
  cooldownUntil: string | null,
  referenceDate: string
): ReactiveTriggerStatus {
  const inActiveReactiveWindow =
    reactiveDeloadStartDate !== null && reactiveDeloadEndDate !== null && referenceDate >= reactiveDeloadStartDate && referenceDate <= reactiveDeloadEndDate;
  if (inActiveReactiveWindow) return 'triggered';
  if (cooldownUntil !== null && referenceDate <= cooldownUntil) return 'cooldown';
  return stored;
}

/** Batch 3 spec §5's state machine + "combined condition" — both
 * computed together since they share the same two boolean inputs
 * (never independently derived, so they can never disagree with each
 * other). */
function derivePeriodizationStateAndReason(
  weekIndex: number,
  scheduledDeloadWeek: number,
  isManualDeloadBlock: boolean,
  reactiveDeloadStartDate: string | null,
  reactiveDeloadEndDate: string | null,
  referenceDate: string
): { periodizationState: PeriodizationState; deloadReason: DeloadReason } {
  const isScheduledDeloadWeek = weekIndex === scheduledDeloadWeek;
  const isReactiveDeloadActive =
    reactiveDeloadStartDate !== null && reactiveDeloadEndDate !== null && referenceDate >= reactiveDeloadStartDate && referenceDate <= reactiveDeloadEndDate;
  const isCalendarDeload = isScheduledDeloadWeek || isManualDeloadBlock;

  if (isReactiveDeloadActive && isCalendarDeload) return { periodizationState: 'REACTIVE_DELOAD', deloadReason: 'combined' };
  if (isReactiveDeloadActive) return { periodizationState: 'REACTIVE_DELOAD', deloadReason: 'reactive' };
  if (isScheduledDeloadWeek && isManualDeloadBlock) return { periodizationState: 'SCHEDULED_DELOAD', deloadReason: 'combined' };
  if (isManualDeloadBlock) return { periodizationState: 'SCHEDULED_DELOAD', deloadReason: 'manual' };
  if (isScheduledDeloadWeek) return { periodizationState: 'SCHEDULED_DELOAD', deloadReason: 'calendar' };
  return { periodizationState: 'ACTIVE', deloadReason: null };
}

function rowToProgramState(row: ProgramStateRow, referenceDate: string, weekBoundary: WeekBoundary): ProgramState {
  const weekIndex = calculateWeekIndex(row.block_start_date, referenceDate, weekBoundary);
  const scheduledDeloadWeek = computeScheduledDeloadWeek(row.block_length_weeks);
  const { periodizationState, deloadReason } = derivePeriodizationStateAndReason(
    weekIndex,
    scheduledDeloadWeek,
    row.is_deload === 1,
    row.reactive_deload_start_date,
    row.reactive_deload_end_date,
    referenceDate
  );
  return {
    programId: row.program_id,
    blockId: row.block_id,
    blockNumber: row.block_number,
    blockKind: row.block_kind,
    blockStartDate: row.block_start_date,
    blockLengthWeeks: row.block_length_weeks,
    weekIndex,
    scheduledDeloadWeek,
    periodizationState,
    deloadReason,
    isDeload: periodizationState !== 'ACTIVE',
    reactiveTriggerStatus: deriveReactiveTriggerStatus(row.reactive_trigger_status, row.reactive_deload_start_date, row.reactive_deload_end_date, row.cooldown_until, referenceDate),
    reactiveTriggeredAt: row.reactive_triggered_at,
    reactiveDeloadStartDate: row.reactive_deload_start_date,
    reactiveDeloadEndDate: row.reactive_deload_end_date,
    cooldownUntil: row.cooldown_until,
    lastEvaluatedAt: row.last_evaluated_at,
    specializationTargetId: row.specialization_target_id,
    specializationGoalId: row.specialization_goal_id,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectRow(db: Database.Database, programId: string): ProgramStateRow | undefined {
  return db.prepare('SELECT * FROM coaching_program_state WHERE program_id = ?').get(programId) as ProgramStateRow | undefined;
}

/** Batch 3 spec §6.4: performs the block transition (finalize current
 * block, start the next one, week resets to 1) — but ONLY when
 * `referenceDate` has genuinely moved past the current block's own last
 * week (`weekIndex > blockLengthWeeks`), i.e. calendar time, never mere
 * app-open count, has elapsed. Preserves `blockLengthWeeks` and, for the
 * normal `base`/`development` case, `blockKind` too (a plain calendar
 * rollover keeps training the same way it was — changing block
 * kind/length is otherwise a deliberate, separate `advanceProgramState`
 * call, never implied by a rollover); a `deload`-kind block is the one
 * exception (see `nextBlockKind` below — a manual whole-block deload
 * must never silently perpetuate). Reactive-deload fields are left
 * untouched (spec §5's own state machine keeps them independent of block
 * identity — an active reactive window or cooldown can span a block
 * boundary and keeps applying regardless of which block is now current).
 * Idempotent and safe to call on every read: a block already caught up
 * to the calendar is a no-op. */
function advanceToNextBlockIfDue(db: Database.Database, programId: string, row: ProgramStateRow, referenceDate: string, weekBoundary: WeekBoundary): ProgramStateRow {
  const weekIndex = calculateWeekIndex(row.block_start_date, referenceDate, weekBoundary);
  if (weekIndex <= row.block_length_weeks) return row;

  const previousBlockEnd = addDays(weekRangeContaining(row.block_start_date, weekBoundary).start, row.block_length_weeks * 7 - 1);
  const nextBlockStart = addDays(previousBlockEnd, 1);
  const now = nowIso();
  const newBlockId = newId('coachblock');
  // A manually-declared whole-block deload (`block_kind = 'deload'`,
  // `is_deload = 1` via an explicit advanceProgramState call) is
  // inherently a one-off, temporary block — it must never silently
  // perpetuate into the next block purely because calendar time passed.
  // A 'development'/'base' block rolling into another of the same kind
  // AND LENGTH is the normal, expected case and IS preserved; a deload
  // block's own (often short) length was itself a deliberate, transient
  // choice and must not become the new normal either, so the rollover
  // falls back to the one shared default length rather than inheriting
  // it (a length-1 deload block would otherwise make every future week
  // trivially "the block's own last week" forever).
  const isRollingOverFromManualDeload = row.block_kind === 'deload';
  const nextBlockKind: ProgramBlockKind = isRollingOverFromManualDeload ? 'base' : row.block_kind;
  const nextBlockLengthWeeks = isRollingOverFromManualDeload ? DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS : row.block_length_weeks;

  db.prepare(
    `UPDATE coaching_program_state
     SET block_id = @block_id, block_number = block_number + 1, block_kind = @block_kind, block_start_date = @block_start_date,
         block_length_weeks = @block_length_weeks, is_deload = 0, state_version = state_version + 1, updated_at = @updated_at
     WHERE program_id = @program_id`
  ).run({ program_id: programId, block_id: newBlockId, block_kind: nextBlockKind, block_start_date: nextBlockStart, block_length_weeks: nextBlockLengthWeeks, updated_at: now });

  const refreshed = selectRow(db, programId);
  if (!refreshed) throw new ProgramStateNotFoundError(programId);
  return refreshed;
}

/** Reads the current program state for `programId`, or `null` if none
 * has been created yet. Automatically performs a calendar-due block
 * transition first (Batch 3) — this remains a plain, idempotent read
 * from the CALLER's perspective (never resets anything a caller didn't
 * already expect from real elapsed calendar time), and is still never
 * called from weekly plan regeneration itself (spec §5.3's own
 * boundary — see programmingWeekStart's callers), only from an explicit
 * context-build/planner-integration read.
 *
 * `referenceDate`/`weekBoundary` are required, explicit parameters
 * (rather than this function reaching for wall-clock "now" itself) so
 * every date-derived field is always computed from a real calendar date
 * the caller already resolved through the app's own timezone-aware
 * "today" logic — matching every other date-sensitive computation in
 * this codebase (see dateMath.ts's own timezone-contract doc comment). */
export function getActiveProgramState(db: Database.Database, programId: string, referenceDate: string, weekBoundary: WeekBoundary): ProgramState | null {
  const row = selectRow(db, programId);
  if (!row) return null;
  const advanced = advanceToNextBlockIfDue(db, programId, row, referenceDate, weekBoundary);
  return rowToProgramState(advanced, referenceDate, weekBoundary);
}

/** Creates the FIRST program state for `programId` — always block kind
 * `base`, `isDeload: false`, at week 1, block number 1 (spec §5.3: "new
 * programs begin at week 1, block kind base, isDeload = false"). Throws
 * `ProgramStateAlreadyExistsError` if one already exists — this is a
 * one-time setup operation, never a silent overwrite (use
 * `resetProgramStateForNewProgram` for a deliberate, explicit restart). */
export function createInitialProgramState(db: Database.Database, input: CreateInitialProgramStateInput): ProgramState {
  const existing = db.prepare('SELECT program_id FROM coaching_program_state WHERE program_id = ?').get(input.programId);
  if (existing) throw new ProgramStateAlreadyExistsError(input.programId);

  const now = nowIso();
  db.prepare(
    `INSERT INTO coaching_program_state (program_id, block_id, block_number, block_kind, block_start_date, block_length_weeks, is_deload, reactive_trigger_status, state_version, created_at, updated_at)
     VALUES (@program_id, @block_id, 1, 'base', @block_start_date, @block_length_weeks, 0, 'not_evaluated', 1, @created_at, @updated_at)`
  ).run({
    program_id: input.programId,
    block_id: newId('coachblock'),
    block_start_date: input.blockStartDate,
    block_length_weeks: input.blockLengthWeeks,
    created_at: now,
    updated_at: now,
  });

  const row = selectRow(db, input.programId);
  if (!row) throw new ProgramStateNotFoundError(input.programId);
  // A freshly created block's own start date IS the reference point by
  // definition, so referenceDate = blockStartDate here is always correct
  // (week 1, never a scheduled deload unless blockLengthWeeks is 1).
  return rowToProgramState(row, input.blockStartDate, 'monday');
}

/** Explicitly starts the program's NEXT block (spec §5.2) — a genuinely
 * new block identity (`blockId` changes and `blockNumber` increments;
 * spec §5.3: "blockId remains stable WITHIN a block", which this
 * respects by only ever changing it here or in the automatic calendar
 * rollover, never on a plain read otherwise). A deliberate, explicit
 * override of block kind/length (e.g. starting a manually-chosen deload
 * block), distinct from `advanceToNextBlockIfDue`'s automatic
 * same-kind/same-length rollover. Throws `ProgramStateNotFoundError` if
 * no state exists yet for `programId`. Reactive-deload fields are left
 * untouched — see `advanceToNextBlockIfDue`'s own doc comment for why. */
export function advanceProgramState(db: Database.Database, programId: string, input: AdvanceProgramStateInput): ProgramState {
  const existing = db.prepare('SELECT program_id FROM coaching_program_state WHERE program_id = ?').get(programId) as { program_id: string } | undefined;
  if (!existing) throw new ProgramStateNotFoundError(programId);

  const now = nowIso();
  db.prepare(
    `UPDATE coaching_program_state
     SET block_id = @block_id, block_number = block_number + 1, block_kind = @block_kind, block_start_date = @block_start_date,
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

  const row = selectRow(db, programId);
  if (!row) throw new ProgramStateNotFoundError(programId);
  return rowToProgramState(row, input.blockStartDate, 'monday');
}

/** Resets `programId` back to a fresh `base` block at week 1, block
 * number 1, `isDeload: false`, and clears every reactive/specialization
 * field — an explicit, deliberate restart (e.g. the user begins a
 * genuinely new program), unlike `createInitialProgramState` (which
 * requires no prior state) or `advanceProgramState` (which transitions
 * within an ongoing program's own block sequence). Creates a row if none
 * exists yet, or overwrites the existing one — this is the one function
 * in this module allowed to unconditionally replace prior state, since
 * "a new program" is by definition not a continuation of whatever came
 * before. */
export function resetProgramStateForNewProgram(db: Database.Database, programId: string, input: ResetProgramStateForNewProgramInput): ProgramState {
  const existing = db.prepare('SELECT state_version FROM coaching_program_state WHERE program_id = ?').get(programId) as { state_version: number } | undefined;
  const now = nowIso();
  db.prepare(
    `INSERT INTO coaching_program_state (program_id, block_id, block_number, block_kind, block_start_date, block_length_weeks, is_deload, reactive_trigger_status, reactive_triggered_at, reactive_deload_start_date, reactive_deload_end_date, cooldown_until, last_evaluated_at, specialization_target_id, specialization_goal_id, state_version, created_at, updated_at)
     VALUES (@program_id, @block_id, 1, 'base', @block_start_date, @block_length_weeks, 0, 'not_evaluated', NULL, NULL, NULL, NULL, NULL, NULL, NULL, @state_version, @created_at, @updated_at)
     ON CONFLICT(program_id) DO UPDATE SET
       block_id = @block_id, block_number = 1, block_kind = 'base', block_start_date = @block_start_date,
       block_length_weeks = @block_length_weeks, is_deload = 0,
       reactive_trigger_status = 'not_evaluated', reactive_triggered_at = NULL, reactive_deload_start_date = NULL,
       reactive_deload_end_date = NULL, cooldown_until = NULL, last_evaluated_at = NULL,
       specialization_target_id = NULL, specialization_goal_id = NULL,
       state_version = @state_version, updated_at = @updated_at`
  ).run({
    program_id: programId,
    block_id: newId('coachblock'),
    block_start_date: input.blockStartDate,
    block_length_weeks: input.blockLengthWeeks,
    state_version: (existing?.state_version ?? 0) + 1,
    created_at: now,
    updated_at: now,
  });

  // Re-select rather than trust the just-computed values directly: on
  // an UPDATE conflict, created_at is deliberately left out of the SET
  // clause above (a reset keeps the row's true original creation time),
  // so the persisted value can differ from `now` above.
  const row = selectRow(db, programId);
  if (!row) throw new ProgramStateNotFoundError(programId);
  return rowToProgramState(row, input.blockStartDate, 'monday');
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

/** Batch 3: applies a partial update to the stored reactive-evidence
 * fields — the ONLY way `reactiveTrendEvaluator.ts`/the periodization
 * orchestrator ever writes evaluation results or specialization
 * selection, so every write to these columns goes through one place.
 * Never touches block identity/kind/length. Throws
 * `ProgramStateNotFoundError` if no state exists yet. */
export function updateReactiveState(db: Database.Database, programId: string, referenceDate: string, weekBoundary: WeekBoundary, input: UpdateReactiveStateInput): ProgramState {
  const existing = selectRow(db, programId);
  if (!existing) throw new ProgramStateNotFoundError(programId);

  const now = nowIso();
  db.prepare(
    `UPDATE coaching_program_state
     SET reactive_trigger_status = @reactive_trigger_status,
         reactive_triggered_at = @reactive_triggered_at,
         reactive_deload_start_date = @reactive_deload_start_date,
         reactive_deload_end_date = @reactive_deload_end_date,
         cooldown_until = @cooldown_until,
         last_evaluated_at = @last_evaluated_at,
         specialization_target_id = @specialization_target_id,
         specialization_goal_id = @specialization_goal_id,
         state_version = state_version + 1,
         updated_at = @updated_at
     WHERE program_id = @program_id`
  ).run({
    program_id: programId,
    reactive_trigger_status: input.reactiveTriggerStatus ?? existing.reactive_trigger_status,
    reactive_triggered_at: input.reactiveTriggeredAt !== undefined ? input.reactiveTriggeredAt : existing.reactive_triggered_at,
    reactive_deload_start_date: input.reactiveDeloadStartDate !== undefined ? input.reactiveDeloadStartDate : existing.reactive_deload_start_date,
    reactive_deload_end_date: input.reactiveDeloadEndDate !== undefined ? input.reactiveDeloadEndDate : existing.reactive_deload_end_date,
    cooldown_until: input.cooldownUntil !== undefined ? input.cooldownUntil : existing.cooldown_until,
    last_evaluated_at: input.lastEvaluatedAt !== undefined ? input.lastEvaluatedAt : existing.last_evaluated_at,
    specialization_target_id: input.specializationTargetId !== undefined ? input.specializationTargetId : existing.specialization_target_id,
    specialization_goal_id: input.specializationGoalId !== undefined ? input.specializationGoalId : existing.specialization_goal_id,
    updated_at: now,
  });

  const row = selectRow(db, programId);
  if (!row) throw new ProgramStateNotFoundError(programId);
  return rowToProgramState(row, referenceDate, weekBoundary);
}

// Re-exported so a caller building a block start date one week later
// than another (e.g. in tests) never needs a second import just for
// addDays.
export { addDays };
