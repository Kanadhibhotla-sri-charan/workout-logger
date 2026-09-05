// Final Current-Week Reconciliation Fix §4-§9/§20: turns
// "current-week override + full regeneration" into "current-week
// override + persisted plan reconciliation." This module owns ONLY the
// decision of what to write to the persisted store
// (src/repositories/weeklyProgramRepo.ts) given a freshly-computed week
// (from the UNMODIFIED planner — src/engine/workoutBuilder.ts's
// buildWeeklyProgrammingPlan, called by src/server/routes/
// programming.ts) — it never calls the planner itself, and it never
// touches workout_sessions/workout_exercises/workout_sets (a
// completely separate table it never reads or writes).
//
// The two rules that make this "reconciliation" rather than "blind
// regeneration":
//
//   1. LOCKED days (a real WorkoutSession already exists for that date
//      with status 'in_progress' or 'completed') are never touched, no
//      matter what the fresh computation says — spec §8/§14/§16.
//   2. UNLOCKED days whose fresh prescription is unchanged from what's
//      already persisted are left completely untouched too — including
//      their exact persisted reasoning/explanation text, which may
//      legitimately differ from a fresh recompute's explanation for
//      OTHER days (see corePrescriptionEqual's own comment) without
//      that meaning THIS day's prescription changed.
//
// Only days that are unlocked AND genuinely differ (the explicitly
// changed day, or a day whose workload was redistributed as an actual,
// necessary consequence — spec §8.3/§13's "redistribute only if
// required") are written.

import type Database from 'better-sqlite3';
import { addDays } from './dateMath.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { WeeklyProgramRepo, type PersistedWeekProgram } from '../repositories/weeklyProgramRepo.js';

/** One day's freshly-computed state, as the caller (programming.ts,
 * which owns display-enrichment) has already shaped it. `snapshot` is
 * persisted verbatim (JSON) when this day needs to be written. */
export interface FreshDayInput {
  dayIndex: number; // 0=Monday..6=Sunday
  date: string;
  hasGymComponent: boolean; // false for a badminton-only or unselected/rest day — no prescription to persist
  sessionPurpose: string | null;
  snapshot: { plannedWork: ReadonlyArray<{ exercise_id: string; target_id: string; target_type: string; sets: number; reps_min: number; reps_max: number }> } & Record<string, unknown>;
}

export interface WeekAggregates {
  activeGoals: unknown;
  targetAllocations: unknown;
}

function isDayLocked(db: Database.Database, date: string): boolean {
  const logged = new WorkoutSessionsRepo(db).listSessionsByDate(date);
  return logged.some((s) => s.status === 'completed' || s.status === 'in_progress');
}

/** Compares two plannedWork arrays on ONLY the fields that constitute
 * "the prescribed workout" (spec §6/§22.1's "prescription") — which
 * exercises, how many sets, what rep range. Deliberately ignores
 * `reasoning`/`decision` and every other explainability field: the
 * existing (unmodified) "normal development" layer's explanations
 * accurately describe the CURRENT eligible-day count whenever a fresh
 * computation runs, which can legitimately differ from what was true
 * when a day was last persisted even though that day's own actual
 * prescription hasn't changed — see docs/CURRENT_WEEK_RECONCILIATION_
 * REPORT.md's "over-strict assertion" finding from the prior pass. */
function corePrescriptionEqual(a: FreshDayInput['snapshot']['plannedWork'], b: FreshDayInput['snapshot']['plannedWork']): boolean {
  const core = (list: FreshDayInput['snapshot']['plannedWork']) =>
    list.map((w) => ({ exercise_id: w.exercise_id, target_id: w.target_id, target_type: w.target_type, sets: w.sets, reps_min: w.reps_min, reps_max: w.reps_max }));
  return JSON.stringify(core(a)) === JSON.stringify(core(b));
}

/** Writes the minimum necessary changes so the persisted week program
 * matches `freshDays`, per the two rules above. Creates the `programs`
 * row first if this week has never been persisted at all (this is also
 * how first-ever generation happens — there is nothing "persisted" yet,
 * so every unlocked day with a gym component is written). Always
 * refreshes the week-level aggregate fields (`activeGoals`/
 * `targetAllocations`) — these are live summaries, not per-day
 * prescriptions, so they're cheap to keep current. */
export function reconcileWeekProgram(db: Database.Database, weekStart: string, freshDays: readonly FreshDayInput[], aggregates: WeekAggregates): PersistedWeekProgram {
  const repo = new WeeklyProgramRepo(db);
  const existing = repo.getByWeekStart(weekStart);
  const program = existing ?? repo.create(weekStart, addDays(weekStart, 6));

  for (const day of freshDays) {
    if (isDayLocked(db, day.date)) continue; // spec §8.1/§14/§16: a locked day is never touched

    const persisted = program.sessions.find((s) => s.day_index === day.dayIndex);

    if (!day.hasGymComponent) {
      if (persisted) repo.deleteSession(program.id, day.dayIndex);
      continue;
    }

    if (persisted && corePrescriptionEqual((persisted.snapshot as any).plannedWork, day.snapshot.plannedWork)) {
      continue; // unaffected — keep the persisted row (and its exact reasoning) untouched
    }

    repo.upsertSession(program.id, day.dayIndex, day.sessionPurpose ?? 'gym', 'gym', day.snapshot);
  }

  repo.updateAggregates(program.id, aggregates.activeGoals, aggregates.targetAllocations);
  return repo.getByWeekStart(weekStart)!;
}

/** A pure read if `weekStart` already has a persisted program (spec
 * §18: a plain GET must never blindly regenerate) — `computeFresh` is
 * NOT called in that case. Only calls `computeFresh` (which runs the
 * planner) the first time this week has ever been requested. */
export function ensureWeekProgramGenerated(db: Database.Database, weekStart: string, computeFresh: () => { days: FreshDayInput[]; aggregates: WeekAggregates }): PersistedWeekProgram {
  const repo = new WeeklyProgramRepo(db);
  const existing = repo.getByWeekStart(weekStart);
  if (existing) return existing;
  const { days, aggregates } = computeFresh();
  return reconcileWeekProgram(db, weekStart, days, aggregates);
}
