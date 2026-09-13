// AI Activity Alignment / Non-Regenerative Schedule Fixes
// (docs/CLAUDE_TASK_AI_ACTIVITY_ALIGNMENT_AND_NON_REGENERATIVE_SCHEDULE_FIXES.md
// Part 1/2/5): a dedicated schedule-operation service, separate from
// program regeneration (weekProgramReconciliation.ts, which always
// calls the deterministic planner) and from AI proposal commit
// (aiProposalLifecycle.ts). A schedule swap NEVER calls the planner and
// NEVER calls the LLM/provider — it only rearranges already-persisted
// state: this week's own activity overrides, a persisted deterministic
// prescription snapshot (if any), and a still-`planned` AI-committed
// session's date (if any). This is what makes "move Thursday's workout
// to Wednesday" a schedule operation rather than a regeneration request
// (task's own "Final Expected Outcome" §1).

import type Database from 'better-sqlite3';
import { WEEKDAYS, type Weekday } from '../contracts/types.js';
import { addDays } from './dateMath.js';
import { isDayLocked } from './weekProgramReconciliation.js';
import { WeeklyProgramRepo } from '../repositories/weeklyProgramRepo.js';
import { WeekActivityOverridesRepo } from '../repositories/weekActivityOverridesRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { TrainingProfileRepo } from '../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../repositories/usersRepo.js';
import { applyWeekOverrides, deriveDailyActivity } from '../lib/dailyActivity.js';

/** `swap` (A<->B, exchanges both days' content — `swapDayActivities`)
 * and `move` (A->B, source becomes Rest and destination's own PRIOR
 * content is discarded rather than swapped back — `moveActivity`) are
 * two distinct primitives (Final AI-Deterministic Precedence and
 * Scheduling Fixes §4, Option B — true move semantics; a prior release
 * exposed `/week/move` as a thin, misleadingly-named alias for swap,
 * which has been replaced by this real implementation). Neither ever
 * calls the planner or the LLM. `replace` is the existing single-day
 * `PUT /week/days/:day/activity` endpoint (unchanged lifecycle, now with
 * lock/planned-session guards and an explicit `prescriptionPolicy` —
 * see programming.ts). `regenerate` is that same endpoint's explicit
 * planner-call path. */
export type ScheduleChangeMode = 'swap' | 'move' | 'replace' | 'regenerate';

export type ScheduleOperationErrorCode = 'SAME_DAY' | 'DAY_LOCKED' | 'NO_TRAINING_PROFILE' | 'DESTINATION_OCCUPIED';

export class ScheduleOperationError extends Error {
  constructor(
    public readonly code: ScheduleOperationErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ScheduleOperationError';
  }
}

export interface SwapResult {
  weekStart: string;
  dayA: Weekday;
  dayB: Weekday;
  /** session_ids of any real `workout_sessions` rows with
   * `status === 'planned'` whose date moved as part of this swap — see
   * Fix 5's own rule (below, on swapDayActivities) for exactly which
   * sessions this is. For API transparency/testability, never used as a
   * decision input by any caller. */
  movedPlannedSessionIds: string[];
}

/** Swaps two days' weekly activity AND, wherever the data model allows
 * it, the actual program assignment underneath — never regenerating a
 * prescription, never calling the LLM (spec Part 2's exact requirement
 * list). Idempotent by construction: applying the same swap twice
 * restores the original state, because a swap is its own inverse.
 *
 * Locking (Part 4): if EITHER day already has a completed or
 * in-progress real session, the WHOLE swap is rejected before writing
 * anything — a completed day's historical record must never move to a
 * different date, and an in-progress session must never be silently
 * relocated out from under the user (spec: "reject the conflicting
 * schedule change with a clear explanation").
 *
 * Three things move together, atomically (one `db.transaction`):
 *   1. This week's own `WeekActivityOverridesRepo` entries for both days
 *      (never the recurring TrainingProfile).
 *   2. Any persisted deterministic `program_sessions` snapshot for
 *      either day (WeeklyProgramRepo) — the exact prescription content
 *      moves with its day, preserving the receiving day_index's own row
 *      identity (see WeeklyProgramRepo.upsertSession's own doc comment
 *      on what "identity" means in this schema — Part 5's own note that
 *      the exact implementation should follow the current schema).
 *   3. Any real `workout_sessions` row with `status === 'planned'` on
 *      either date — only its `date` column changes; its own exercises/
 *      sets are completely untouched.
 *
 * Fix 5 (Activity Scheduling and AI Alignment Fixes) — which planned
 * sessions move: Option A, "all planned sessions are schedule-bound."
 * The query above is deliberately `status === 'planned'`, not "any
 * session an AI proposal happened to create" — a `workout_sessions` row
 * becomes `planned` only by being explicitly scheduled for a specific
 * date and not yet started (today, only AI-committed sessions reach
 * that status in practice — a deterministic gym day has no real session
 * row at all until the user starts one, at which point it is created
 * directly as `in_progress`, per aiProposalLifecycle.ts's and
 * workouts.ts's own doc comments — but this function does not, and must
 * not, assume "planned implies AI-created"). Any FUTURE code path that
 * creates a `planned` session by some other means (e.g. a manual
 * schedule-ahead feature) is schedule-bound by this same rule and WILL
 * move with its day — this is a deliberate, tested consequence of using
 * `status` as the sole criterion (see tests/engine/scheduleOperations.
 * test.ts's own "a manually-created planned session is schedule-bound
 * too" case), not an oversight. A session origin/ownership column
 * (Option B) is not needed unless a future planned-session source
 * should be EXCLUDED from moving with its day.
 */
export function swapDayActivities(db: Database.Database, weekStart: string, dayA: Weekday, dayB: Weekday): SwapResult {
  if (dayA === dayB) {
    throw new ScheduleOperationError('SAME_DAY', 'dayA and dayB must be different weekdays.');
  }

  const indexA = WEEKDAYS.indexOf(dayA);
  const indexB = WEEKDAYS.indexOf(dayB);
  const dateA = addDays(weekStart, indexA);
  const dateB = addDays(weekStart, indexB);

  for (const date of [dateA, dateB]) {
    if (isDayLocked(db, date)) {
      throw new ScheduleOperationError('DAY_LOCKED', `${date} already has a completed or in-progress workout and cannot be part of a schedule swap.`, { date });
    }
  }

  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) {
    throw new ScheduleOperationError('NO_TRAINING_PROFILE', 'No training profile exists for this user yet — create one first (PUT /api/training-profile).');
  }

  const overridesRepo = new WeekActivityOverridesRepo(db);
  const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overridesRepo.get(profile.id, weekStart));
  const activityA = deriveDailyActivity(dayA, effective.trainingDays, effective.otherActivitySchedule);
  const activityB = deriveDailyActivity(dayB, effective.trainingDays, effective.otherActivitySchedule);

  const movedPlannedSessionIds: string[] = [];
  const programRepo = new WeeklyProgramRepo(db);
  const sessionsRepo = new WorkoutSessionsRepo(db);

  const tx = db.transaction(() => {
    overridesRepo.setOverride(profile.id, weekStart, dayA, activityB);
    overridesRepo.setOverride(profile.id, weekStart, dayB, activityA);

    const program = programRepo.getByWeekStart(weekStart);
    if (program) {
      const sessionA = programRepo.getSession(program.id, indexA);
      const sessionB = programRepo.getSession(program.id, indexB);
      if (sessionA) programRepo.upsertSession(program.id, indexB, sessionA.name, sessionA.planned_session_type, sessionA.snapshot);
      else programRepo.deleteSession(program.id, indexB);
      if (sessionB) programRepo.upsertSession(program.id, indexA, sessionB.name, sessionB.planned_session_type, sessionB.snapshot);
      else programRepo.deleteSession(program.id, indexA);
    }

    // Both sides' planned sessions are snapshotted BEFORE either is
    // moved — reading dateB's list only after already moving dateA's
    // session onto dateB would find that just-moved session and move it
    // straight back, silently undoing the swap for that side.
    const plannedOnA = sessionsRepo.listSessionsByDate(dateA).filter((x) => x.status === 'planned');
    const plannedOnB = sessionsRepo.listSessionsByDate(dateB).filter((x) => x.status === 'planned');
    for (const s of plannedOnA) {
      sessionsRepo.moveDate(s.session_id, dateB);
      movedPlannedSessionIds.push(s.session_id);
    }
    for (const s of plannedOnB) {
      sessionsRepo.moveDate(s.session_id, dateA);
      movedPlannedSessionIds.push(s.session_id);
    }
  });
  tx();

  return { weekStart, dayA, dayB, movedPlannedSessionIds };
}

export interface MoveResult {
  weekStart: string;
  fromDay: Weekday;
  toDay: Weekday;
  /** session_ids of any real `workout_sessions` rows with
   * `status === 'planned'` that moved from `fromDay` to `toDay` — see
   * swapDayActivities' own Fix 5 doc comment for the exact "which
   * planned sessions move" rule; identical here. */
  movedPlannedSessionIds: string[];
}

/** True, asymmetric move (Final AI-Deterministic Precedence and
 * Scheduling Fixes §4, Option B) — `fromDay`'s activity/prescription is
 * relocated onto `toDay`; `fromDay` itself becomes Rest
 * ('unselected'); `toDay`'s own PRIOR activity/prescription is
 * DISCARDED (not swapped back onto `fromDay` — that is what makes this
 * a move rather than a swap; see scheduleOperations.ts's own
 * ScheduleChangeMode doc comment for the worked Badminton/Gym example
 * where the two diverge). Never calls the planner, never the LLM.
 *
 * Ownership/safety (§5):
 *   - Rejects (`DAY_LOCKED`) if EITHER day already has a completed or
 *     in-progress real session — a locked day's real history/current
 *     workout must never be silently relocated or overwritten (rules
 *     3/4/5).
 *   - Rejects (`DESTINATION_OCCUPIED`) if `toDay` already has a real
 *     `planned` session — discarding a real, still-active planned
 *     workout (e.g. an AI-committed session) to make room would be
 *     exactly the "orphaned/silently discarded" failure mode this whole
 *     task line rejects elsewhere (Activity Scheduling and AI Alignment
 *     Fixes' own Fix 3). The caller must resolve that conflict first —
 *     this function never invents a way around it.
 *   - `fromDay`'s own real `planned` session (if any) moves with it,
 *     exactly like swap's own planned-session rule (Fix 5, Option A —
 *     status alone decides, not origin).
 *   - `toDay`'s own persisted deterministic `program_sessions` row (if
 *     any, and if there was nothing to move in from `fromDay`) is
 *     deleted — this is the explicit "destination's prior content is
 *     discarded" behavior, safe because the DESTINATION_OCCUPIED guard
 *     above already ruled out a real session existing there.
 *
 * Idempotency (Invariant 6 / spec §11.D "repeated move is idempotent"):
 * once `fromDay` has nothing left to move (already Rest, no persisted
 * deterministic snapshot, no real planned session — exactly the state
 * this function itself leaves it in), calling this again with the same
 * arguments is a NO-OP — it returns immediately without touching
 * anything. Without this guard, a second identical call would compute
 * `fromDay`'s now-Rest activity and silently overwrite whatever the
 * first call had already placed onto `toDay`, which would make the
 * operation destructive on repetition instead of idempotent.
 */
export function moveActivity(db: Database.Database, weekStart: string, fromDay: Weekday, toDay: Weekday): MoveResult {
  if (fromDay === toDay) {
    throw new ScheduleOperationError('SAME_DAY', 'fromDay and toDay must be different weekdays.');
  }

  const indexFrom = WEEKDAYS.indexOf(fromDay);
  const indexTo = WEEKDAYS.indexOf(toDay);
  const dateFrom = addDays(weekStart, indexFrom);
  const dateTo = addDays(weekStart, indexTo);

  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) {
    throw new ScheduleOperationError('NO_TRAINING_PROFILE', 'No training profile exists for this user yet — create one first (PUT /api/training-profile).');
  }

  const overridesRepo = new WeekActivityOverridesRepo(db);
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const programRepo = new WeeklyProgramRepo(db);

  const effectiveBefore = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overridesRepo.get(profile.id, weekStart));
  const activityFromBefore = deriveDailyActivity(fromDay, effectiveBefore.trainingDays, effectiveBefore.otherActivitySchedule);
  const programBefore = programRepo.getByWeekStart(weekStart);
  const persistedFrom = programBefore ? programRepo.getSession(programBefore.id, indexFrom) : undefined;
  const plannedOnFrom = sessionsRepo.listSessionsByDate(dateFrom).filter((x) => x.status === 'planned');
  const nothingToMove = activityFromBefore === 'unselected' && !persistedFrom && plannedOnFrom.length === 0;
  if (nothingToMove) {
    return { weekStart, fromDay, toDay, movedPlannedSessionIds: [] };
  }

  for (const date of [dateFrom, dateTo]) {
    if (isDayLocked(db, date)) {
      throw new ScheduleOperationError('DAY_LOCKED', `${date} already has a completed or in-progress workout and cannot be part of a schedule move.`, { date });
    }
  }

  const plannedOnTo = sessionsRepo.listSessionsByDate(dateTo).filter((x) => x.status === 'planned');
  const conflictingOnTo = plannedOnTo[0];
  if (conflictingOnTo) {
    throw new ScheduleOperationError(
      'DESTINATION_OCCUPIED',
      `${dateTo} already has an active planned workout session (${conflictingOnTo.session_id}). Move or cancel that session before moving another workout onto this date.`,
      { date: dateTo, conflictingSessionId: conflictingOnTo.session_id }
    );
  }

  const movedPlannedSessionIds: string[] = [];

  const tx = db.transaction(() => {
    overridesRepo.setOverride(profile.id, weekStart, toDay, activityFromBefore);
    overridesRepo.setOverride(profile.id, weekStart, fromDay, 'unselected');

    if (programBefore) {
      if (persistedFrom) {
        programRepo.upsertSession(programBefore.id, indexTo, persistedFrom.name, persistedFrom.planned_session_type, persistedFrom.snapshot);
      } else {
        // Nothing to move in from the source — the destination's own
        // prior deterministic prescription (if any) is discarded, per
        // this function's own "move discards destination's prior
        // content" contract.
        programRepo.deleteSession(programBefore.id, indexTo);
      }
      programRepo.deleteSession(programBefore.id, indexFrom);
    }

    for (const s of plannedOnFrom) {
      sessionsRepo.moveDate(s.session_id, dateTo);
      movedPlannedSessionIds.push(s.session_id);
    }
  });
  tx();

  return { weekStart, fromDay, toDay, movedPlannedSessionIds };
}
