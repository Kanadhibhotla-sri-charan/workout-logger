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

/** Illustrative only (task's own Part 1.1 caveat: "adapt to the
 * existing architecture") — this vertical slice implements `swap` as
 * the one general-purpose schedule-rearrangement primitive, exposed as
 * `POST /api/programming/week/swap`. Activity Scheduling and AI
 * Alignment Fixes, Fix 4 (Option A): there is deliberately no `move`
 * route — a prior release exposed `/week/move` as a thin alias for swap,
 * but swap (A<->B) and a true move (A->B, discarding B's own prior
 * activity) are not equivalent in general, so claiming a `move` name for
 * swap semantics was misleading and has been removed; `'move'` stays in
 * this union only as a documented, UNIMPLEMENTED future mode (Fix 4
 * Option B — explicit source/destination semantics), never routed to
 * anything today. `replace` is the existing single-day
 * `PUT /week/days/:day/activity` endpoint (unchanged lifecycle, now with
 * lock/planned-session guards and an explicit `prescriptionPolicy` —
 * see programming.ts). `regenerate` is that same endpoint's explicit
 * planner-call path. */
export type ScheduleChangeMode = 'swap' | 'move' | 'replace' | 'regenerate';

export type ScheduleOperationErrorCode = 'SAME_DAY' | 'DAY_LOCKED' | 'NO_TRAINING_PROFILE';

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
