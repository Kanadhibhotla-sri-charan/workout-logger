// Load hint (2026-10-30, owner: "D looks good for all muscles"): a nudge
// shown in the logger for every weighted exercise, read from the last
// completed session of the same exercise with the same equipment,
// attachment and unit (progressSeriesKey). Blueprint's double progression
// at the heaviest weight used last time (warm-up / ramp sets at lighter
// weights are ignored):
//   heavier   its best set reached the top of today's rep range -> about
//             PROGRESSION_INCREMENTS.loadKg more (dumbbells: the next pair,
//             DUMBBELL_STEP_KG up)
//   reps      within the range -> same weight, one more rep
//   hold      below the range -> same weight until it is back in range
// `sameWeightSessions` counts the sessions in a row (newest first) whose
// heaviest weight was this one, so a load stuck for weeks is visible.

import type Database from 'better-sqlite3';
import type { ExercisePerformance } from '../contracts/types.js';
import { progressSeriesKey, type RepUnit } from '../contracts/loggingOptions.js';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { PROGRESSION_INCREMENTS } from './config.js';

/** Dumbbell racks go up in pairs 2 kg apart (the owner logs 12, 14, ...). */
const DUMBBELL_STEP_KG = 2;

export interface LoadHint {
  kind: 'heavier' | 'reps' | 'hold';
  lastDate: string;
  lastWeight: number;
  lastReps: number;
  /** Suggested weight today. */
  weight: number;
  /** Rep goal at that weight (the range bottom after going heavier). */
  reps: number | null;
  sameWeightSessions: number;
  text: string;
}

interface PastPerformance {
  date: string;
  equipment: string | null;
  attachment: string | null;
  repUnit: string | null;
  sets: Array<{ weight: number | null; reps: number | null; completed: boolean }>;
}

const MAX_LOOKBACK = 12;

function pastPerformances(db: Database.Database, exerciseId: string, beforeDate: string): PastPerformance[] {
  const rows = db
    .prepare(
      `SELECT we.id, s.date, we.equipment, we.attachment, we.rep_unit AS repUnit
         FROM workout_exercises we JOIN workout_sessions s ON s.session_id = we.workout_session_id
        WHERE we.exercise_id = ? AND s.status = 'completed' AND s.date < ?
        ORDER BY s.date DESC, s.created_at DESC LIMIT 40`
    )
    .all(exerciseId, beforeDate) as Array<{ id: string; date: string; equipment: string | null; attachment: string | null; repUnit: string | null }>;
  const setsStmt = db.prepare('SELECT weight, reps, completed FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number');
  return rows.map((r) => ({
    ...r,
    sets: (setsStmt.all(r.id) as Array<{ weight: number | null; reps: number | null; completed: number }>).map((s) => ({ ...s, completed: s.completed === 1 })),
  }));
}

/** The heaviest weight with completed reps, and the best reps at it. */
function topSet(p: PastPerformance): { weight: number; reps: number } | null {
  const sets = p.sets.filter((s) => s.completed && s.weight != null && s.weight > 0 && s.reps != null && s.reps > 0);
  if (sets.length === 0) return null;
  const weight = Math.max(...sets.map((s) => s.weight!));
  return { weight, reps: Math.max(...sets.filter((s) => s.weight === weight).map((s) => s.reps!)) };
}

/** The equipment logged, else the Blueprint exercise's first (main) option. */
function loadStep(perf: ExercisePerformance): number {
  const equipment = perf.equipment ?? BlueprintAdapter.getExercise(perf.exercise_id)?.equipment[0] ?? null;
  return equipment === 'dumbbell' ? DUMBBELL_STEP_KG : PROGRESSION_INCREMENTS.loadKg;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function loadHintFor(db: Database.Database, perf: ExercisePerformance, sessionDate: string): LoadHint | null {
  const unit = (perf.rep_unit ?? 'reps') as RepUnit;
  if (unit !== 'reps') return null;
  const key = progressSeriesKey({ exerciseId: perf.exercise_id, equipment: perf.equipment, attachment: perf.attachment, repUnit: unit });
  const series = pastPerformances(db, perf.exercise_id, sessionDate)
    .filter((p) => progressSeriesKey({ exerciseId: perf.exercise_id, equipment: p.equipment, attachment: p.attachment, repUnit: (p.repUnit ?? 'reps') as RepUnit }) === key)
    .map((p) => ({ date: p.date, top: topSet(p) }))
    .filter((p): p is { date: string; top: { weight: number; reps: number } } => p.top !== null)
    .slice(0, MAX_LOOKBACK);
  const last = series[0];
  if (!last) return null;

  const { weight, reps } = last.top;
  let sameWeightSessions = 0;
  while (sameWeightSessions < series.length && series[sameWeightSessions]!.top.weight === weight) sameWeightSessions++;

  const min = perf.target_reps_min;
  const max = perf.target_reps_max;
  const lastText = `Last time ${fmt(weight)} kg × ${reps}`;
  const stuck = sameWeightSessions >= 3 ? ` (${sameWeightSessions} sessions at ${fmt(weight)} kg)` : '';
  if (max != null && reps >= max) {
    const next = weight + loadStep(perf);
    const repGoal = min ?? null;
    return {
      kind: 'heavier', lastDate: last.date, lastWeight: weight, lastReps: reps, weight: next, reps: repGoal, sameWeightSessions,
      text: `${lastText}, top of ${min ?? max}-${max}${stuck}. Go heavier: about ${fmt(next)} kg${repGoal != null ? ` for ${repGoal}+` : ''}.`,
    };
  }
  if (min != null && reps < min) {
    return {
      kind: 'hold', lastDate: last.date, lastWeight: weight, lastReps: reps, weight, reps: min, sameWeightSessions,
      text: `${lastText}, below ${min}-${max ?? min}. Stay at ${fmt(weight)} kg and aim for ${min}.`,
    };
  }
  return {
    kind: 'reps', lastDate: last.date, lastWeight: weight, lastReps: reps, weight, reps: reps + PROGRESSION_INCREMENTS.reps, sameWeightSessions,
    text: `${lastText}${stuck}. Same weight, aim for ${reps + PROGRESSION_INCREMENTS.reps} reps.`,
  };
}

/** Hints for every exercise of a session, keyed by performance id. */
export function loadHintsForSession(db: Database.Database, performances: readonly ExercisePerformance[], sessionDate: string): Record<string, LoadHint> {
  const out: Record<string, LoadHint> = {};
  for (const perf of performances) {
    const hint = loadHintFor(db, perf, sessionDate);
    if (hint) out[perf.id] = hint;
  }
  return out;
}
