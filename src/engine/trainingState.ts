// Training State — spec §12 (docs/TRAINING_ENGINE_DESIGN.md). The
// deterministic representation of "where is this user right now,"
// derived entirely from persisted data — never manually maintained.
//
// This is the impure boundary layer (§32): it reads the database via the
// repositories and hands pure, plain data to the pure engine functions
// (goalResolver, exposureEngine). Nothing below this module should read
// the database directly — everything above it should be pure.

import type Database from 'better-sqlite3';
import { GoalsRepo } from '../repositories/goalsRepo.js';
import { ProgramsRepo } from '../repositories/programsRepo.js';
import { TrainingProfileRepo } from '../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import type { Goal, Program, TrainingExposure, TrainingProfile, WorkoutSession } from '../contracts/types.js';
import { aggregateRollingExposure, aggregateWeeklyExposure, type SessionExposureInput } from './exposureEngine.js';
import { buildPriorityMap, type PriorityMap } from './goalResolver.js';
import { rollingRangeEnding, weekRangeContaining } from './dateMath.js';
import { DEFAULT_TIMEZONE, todayInTimezone } from '../lib/timezone.js';

export interface TrainingState {
  as_of_date: string;
  training_profile: TrainingProfile | null;
  /** The single most-recently-created program with status 'active', or
   * null if none. A simple, deterministic rule — not "the" definition of
   * current, just this app's chosen one (see docs/TRAINING_ENGINE_DESIGN.md
   * §10/§11 for why multi-program concurrency isn't handled yet). */
  current_program: Program | null;
  active_goals: Goal[];
  /** One PriorityMap per entry in active_goals, same order. Throws (does
   * not silently drop) if any active goal's blueprint_ref no longer
   * resolves — see UnresolvedGoalReferenceError. */
  priority_maps: PriorityMap[];
  /** Sessions in [rolling_window_start, as_of_date] — the raw data window
   * both exposure aggregates below are computed from, also useful
   * directly for "recent exercise performance" (§12). */
  recent_sessions: WorkoutSession[];
  weekly_exposure: TrainingExposure[];
  rolling_exposure: TrainingExposure[];
  rolling_window_days: number;
}

export interface BuildTrainingStateOptions {
  /** Rolling exposure window — no silent default at the exposureEngine
   * layer (see docs/TRAINING_EXPOSURE_MODEL.md §G), but a caller-facing
   * default is reasonable here since this is the application boundary,
   * not the pure engine. 14 days matches the spec §14 example. */
  rollingWindowDays?: number;
}

/**
 * Assembles the current TrainingState for the single app user (see
 * docs/architecture.md's single-user scope) as of `asOfDate`. Every field
 * is derived from persisted data — nothing here is user-entered directly.
 */
export function buildTrainingState(db: Database.Database, asOfDate?: string, options: BuildTrainingStateOptions = {}): TrainingState {
  const rollingWindowDays = options.rollingWindowDays ?? 14;

  const user = new UsersRepo(db).getOrCreateDefault();
  const trainingProfile = new TrainingProfileRepo(db).get(user.id) ?? null;
  const timezone = trainingProfile?.timezone ?? DEFAULT_TIMEZONE;
  const resolvedAsOfDate = asOfDate ?? todayInTimezone(timezone);
  const weekStartDay = trainingProfile?.week_start_day ?? 'monday';

  const programsRepo = new ProgramsRepo(db);
  const currentProgram =
    programsRepo
      .listPrograms()
      .filter((p) => p.status === 'active')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;

  const goalsRepo = new GoalsRepo(db);
  const activeGoals = goalsRepo.list({ active: true });
  // Deliberately not caught: an active Goal whose blueprint_ref no longer
  // resolves is a real data-integrity problem (see
  // UnresolvedGoalReferenceError's doc comment) that should fail loudly,
  // not be silently dropped from the training state.
  const priorityMaps = activeGoals.map((goal) => buildPriorityMap(goal));

  const workoutSessionsRepo = new WorkoutSessionsRepo(db);
  const weekRange = weekRangeContaining(resolvedAsOfDate, weekStartDay);
  const rollingRange = rollingRangeEnding(resolvedAsOfDate, rollingWindowDays);
  // Fetch the union of both windows in one query.
  const fetchStart = rollingRange.start < weekRange.start ? rollingRange.start : weekRange.start;
  const fetchEnd = resolvedAsOfDate;
  const recentSessions = workoutSessionsRepo.listSessionsInRange(fetchStart, fetchEnd);

  const exposureInputs: SessionExposureInput[] = recentSessions.map((session) => ({
    date: session.date,
    exercises: workoutSessionsRepo.getExercisePerformances(session.session_id).map((p) => ({
      exercise_id: p.exercise_id,
      sets: p.sets.map((s) => ({ completed: s.completed })),
    })),
  }));

  return {
    as_of_date: resolvedAsOfDate,
    training_profile: trainingProfile,
    current_program: currentProgram,
    active_goals: activeGoals,
    priority_maps: priorityMaps,
    recent_sessions: recentSessions,
    weekly_exposure: aggregateWeeklyExposure(exposureInputs, resolvedAsOfDate, weekStartDay),
    rolling_exposure: aggregateRollingExposure(exposureInputs, resolvedAsOfDate, rollingWindowDays),
    rolling_window_days: rollingWindowDays,
  };
}
