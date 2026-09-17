// Coaching Depth Batch 1 spec §6.4: builds normalized
// `HistoricalExerciseExposure` records from the exact same real,
// already-persisted `workout_sessions`/`workout_exercises`/
// `workout_sets` data every other real-history reader in this codebase
// uses (`WorkoutSessionsRepo`) — never a second, competing history
// system (spec §3). Exercise-to-target attribution reuses
// `exerciseSelector.ts`'s own authoritative `roleFor` (the same
// resolution `goalPhaseEngine.ts`'s existing load-trend precedent
// already relies on), supplemented only for the one case `roleFor`
// structurally cannot see: an approved outside-Blueprint exercise
// (which BlueprintAdapter has no record of at all).

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { roleFor } from '../../engine/exerciseSelector.js';
import { OutsideBlueprintExercisesRepo } from '../../repositories/outsideBlueprintExercisesRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import type { ExercisePerformance, Set, WorkoutSession } from '../../contracts/types.js';
import type { HistoricalExerciseExposure, TargetHistoricalSummary } from './historicalTypes.js';
import { calculateBasicTrend, classifyDataQuality, type TrendLoadPoint } from './trendCalculations.js';

const PHYSIQUE_TARGET_TYPE = 'physique_target' as const;

/** Whether `exerciseId` trains `targetId` as PRIMARY work — reuses
 * `roleFor` (the same authoritative Blueprint primary/secondary
 * resolution `goalPhaseEngine.ts`'s own load-trend precedent already
 * uses, and deliberately excludes a merely-secondary/compound-overlap
 * relationship from direct performance evidence, matching that same
 * precedent's own documented reasoning), supplemented only for an
 * approved outside-Blueprint exercise (which `roleFor` cannot resolve
 * at all, since it only reads `BlueprintAdapter`). */
function isPrimaryForTarget(db: Database.Database, exerciseId: string, targetId: string): boolean {
  if (roleFor(exerciseId, PHYSIQUE_TARGET_TYPE, targetId) === 'primary') return true;
  const outside = new OutsideBlueprintExercisesRepo(db).get(exerciseId);
  return outside !== undefined && outside.approved && outside.target_type === PHYSIQUE_TARGET_TYPE && outside.target_id === targetId;
}

/** Every physique-target id `exerciseId` itself trains as PRIMARY work —
 * the reverse of `isPrimaryForTarget`, needed by `getExerciseHistory`
 * (which starts from an exercise, not a target). Reads the identical
 * source `roleFor` itself reads (`BlueprintExercise.physique_targets`),
 * never a second reconstruction of that mapping. */
function primaryTargetsForExercise(db: Database.Database, exerciseId: string): string[] {
  const blueprintExercise = BlueprintAdapter.getExercise(exerciseId);
  if (blueprintExercise) return [...(blueprintExercise.physique_targets ?? [])];
  const outside = new OutsideBlueprintExercisesRepo(db).get(exerciseId);
  if (outside && outside.approved && outside.target_type === PHYSIQUE_TARGET_TYPE) return [outside.target_id];
  return [];
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : undefined;
}

/** Spec §6.3's missing-data rules applied to one performance's own
 * completed sets: a set counts toward `load`/`rir`/`completedReps` only
 * when it is itself marked `completed` AND carries the specific real
 * value being extracted — a completed set with a null weight
 * contributes nothing to `load` (never treated as weight 0), etc. */
function buildExposureRecord(session: WorkoutSession, performance: ExercisePerformance, targetId: string): HistoricalExerciseExposure {
  const completedSets: Set[] = performance.sets.filter((s) => s.completed);

  const completedReps = completedSets.filter((s) => s.reps !== null).map((s) => s.reps!);
  const loadPoints = completedSets.filter((s) => s.weight !== null && s.reps !== null).map((s) => s.weight! * (1 + s.reps! / 30));
  const rirValues = completedSets.filter((s) => s.rir !== null).map((s) => s.rir!);

  const prescribedSets = performance.target_sets ?? undefined;
  const completedSetsCount = completedSets.length;

  let completionStatus: HistoricalExerciseExposure['completionStatus'];
  if (session.status === 'skipped') {
    // Explicitly recorded as skipped — the one case spec §6.3 allows
    // treating as genuinely missed, never inferred from mere absence.
    completionStatus = 'missed';
  } else if (session.status === 'completed') {
    if (completedSetsCount === 0) {
      // A 'completed' session with zero completed sets for THIS
      // specific exercise is ambiguous (e.g. a substitution mid-session)
      // — honestly 'unknown' rather than guessing 'missed' or 'partial'.
      completionStatus = 'unknown';
    } else if (prescribedSets !== undefined && completedSetsCount < prescribedSets) {
      completionStatus = 'partial';
    } else {
      completionStatus = 'completed';
    }
  } else {
    // 'planned' or 'in_progress' — not yet resolved either way.
    completionStatus = 'unknown';
  }

  return {
    date: session.date,
    programId: session.program_id ?? undefined,
    targetId,
    exerciseId: performance.exercise_id,
    prescribedSets,
    completedSets: completedSetsCount,
    prescribedRepsMin: performance.target_reps_min ?? undefined,
    prescribedRepsMax: performance.target_reps_max ?? undefined,
    completedReps: completedReps.length > 0 ? completedReps : undefined,
    load: average(loadPoints),
    rir: average(rirValues),
    completionStatus,
  };
}

/** Every real exposure of `targetId` (as PRIMARY work) within
 * [startDate, endDate], regardless of the owning session's status — the
 * `completionStatus` field on each record differentiates
 * scheduled-only/partial/completed/missed/unknown (spec §6.4). Ordered
 * chronologically. */
export function getTargetHistory(db: Database.Database, targetId: string, startDate: string, endDate: string): HistoricalExerciseExposure[] {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const records: HistoricalExerciseExposure[] = [];
  for (const session of sessionsRepo.listSessionsInRange(startDate, endDate)) {
    for (const performance of sessionsRepo.getExercisePerformances(session.session_id)) {
      if (!isPrimaryForTarget(db, performance.exercise_id, targetId)) continue;
      records.push(buildExposureRecord(session, performance, targetId));
    }
  }
  records.sort((a, b) => a.date.localeCompare(b.date));
  return records;
}

/** Every real exposure of `exerciseId` itself within [startDate,
 * endDate] — one record per (performance, target) pair for whichever
 * physique target(s) this exact exercise trains as primary work. Two
 * different exercises are never merged into one record here — spec
 * §6.4: "do not combine incomparable exercises... as one performance
 * trend" (a caller wanting a target-level rollup across many exercises
 * should use `getTargetHistory`/`getTargetSummary` instead). */
export function getExerciseHistory(db: Database.Database, exerciseId: string, startDate: string, endDate: string): HistoricalExerciseExposure[] {
  const targetIds = primaryTargetsForExercise(db, exerciseId);
  if (targetIds.length === 0) return [];

  const sessionsRepo = new WorkoutSessionsRepo(db);
  const records: HistoricalExerciseExposure[] = [];
  for (const session of sessionsRepo.listSessionsInRange(startDate, endDate)) {
    for (const performance of sessionsRepo.getExercisePerformances(session.session_id)) {
      if (performance.exercise_id !== exerciseId) continue;
      for (const targetId of targetIds) {
        records.push(buildExposureRecord(session, performance, targetId));
      }
    }
  }
  records.sort((a, b) => a.date.localeCompare(b.date));
  return records;
}

/** Aggregates `getTargetHistory`'s own records into one summary — every
 * number here is derived strictly from real records already returned
 * above, never fabricated for a metric no record actually reported
 * (spec §6.3: missing stays missing all the way through the rollup). */
export function getTargetSummary(db: Database.Database, targetId: string, startDate: string, endDate: string): TargetHistoricalSummary {
  const exposures = getTargetHistory(db, targetId, startDate, endDate);

  const exposureCount = exposures.length;
  const completedExposureCount = exposures.filter((e) => e.completionStatus === 'completed').length;
  const scheduledExposureCount = exposures.filter((e) => e.prescribedSets !== undefined).length;

  const prescribedSetsValues = exposures.map((e) => e.prescribedSets).filter((v): v is number => v !== undefined);
  const prescribedSets = prescribedSetsValues.length > 0 ? prescribedSetsValues.reduce((a, b) => a + b, 0) : undefined;

  const completedSetsValues = exposures.map((e) => e.completedSets).filter((v): v is number => v !== undefined);
  const completedSets = completedSetsValues.length > 0 ? completedSetsValues.reduce((a, b) => a + b, 0) : undefined;

  // Spec §6.4: only when both values are known AND prescribedSets > 0.
  const completionRatio = prescribedSets !== undefined && completedSets !== undefined && prescribedSets > 0 ? completedSets / prescribedSets : undefined;

  const loadValues = exposures.map((e) => e.load).filter((v): v is number => v !== undefined);
  const averageLoad = average(loadValues);

  const datesWithAnyExposure = exposures.map((e) => e.date);
  const latestExposureDate = datesWithAnyExposure.length > 0 ? datesWithAnyExposure[datesWithAnyExposure.length - 1] : undefined;

  const trendPoints: TrendLoadPoint[] = exposures.filter((e): e is typeof e & { load: number } => e.load !== undefined).map((e) => ({ date: e.date, load: e.load }));

  return {
    targetId,
    windowStart: startDate,
    windowEnd: endDate,
    exposureCount,
    completedExposureCount,
    scheduledExposureCount,
    prescribedSets,
    completedSets,
    completionRatio,
    averageLoad,
    latestExposureDate,
    trend: calculateBasicTrend(trendPoints),
    dataQuality: classifyDataQuality(completedExposureCount),
  };
}
