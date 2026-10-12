// Insights (2026-10-11): read-only facts about what is actually happening
// in training, computed from logged data only — no AI. Feeds the Insights
// page and the weekly coach review.
//
//   strengthProgress  — each exercise against itself (best estimated 1RM per
//                       session), with a status: new best / up / flat /
//                       down / stalled / new.
//   volumeHistory     — direct sets done vs required per muscle per week.
//   consistency       — gym days done vs scheduled, sets done vs prescribed.
//   goalCheckIns      — each active goal's last self-assessment and when the
//                       next one is due.

import { parseProgressSeriesKey, progressSeriesKey, repUnitOf, type RepUnit } from '../contracts/loggingOptions.js';
import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { WEEKDAYS, type Goal } from '../contracts/types.js';
import { addDays, daysBetween } from '../engine/dateMath.js';
import { buildTrainingState } from '../engine/trainingState.js';
import { programmingWeekStart } from '../engine/workoutBuilder.js';
import { applyWeekOverrides, deriveDailyActivity } from '../lib/dailyActivity.js';
import { calculateBasicTrend } from '../coaching/history/trendCalculations.js';
import { deloadDatesInRange, evaluateReactiveDeloadTrigger } from '../coaching/periodization/reactiveTrendEvaluator.js';
import { PeriodizationEventsRepo } from '../coaching/periodization/periodizationEventsRepo.js';
import { AestheticAssessmentsRepo } from '../repositories/aestheticAssessmentsRepo.js';
import { GoalsRepo } from '../repositories/goalsRepo.js';
import { MeasurementsRepo } from '../repositories/measurementsRepo.js';
import { measurementDirection, type MeasurementDirection } from '../contracts/measurementMetrics.js';
import { TrainingProfileRepo } from '../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../repositories/weekActivityOverridesRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { buildPriorityMap } from '../engine/goalResolver.js';

/** A session's best set must beat the previous best by this much to count as a new best. */
const NEW_BEST_MARGIN = 0.01;
/** Sessions without a new best before an exercise counts as stalled. */
export const STALL_SESSIONS = 3;

export type ProgressStatus = 'new_best' | 'up' | 'flat' | 'down' | 'stalled' | 'new';

export interface StrengthPoint {
  date: string;
  /** Best estimated 1RM (kg) that session; for steps/seconds/metres the
   * heaviest load (kg); unloaded: the best count. */
  value: number;
  bestSet: string;
  deload: boolean;
}

export interface ExerciseProgress {
  exerciseId: string;
  /** Equipment of this series; null when not specified. One exercise done
   * with different equipment is reported as separate series. */
  equipment: string | null;
  /** Attachment of this series (rope, V-bar...); null when not specified. */
  attachment: string | null;
  /** What the sets counted: reps, steps, seconds or metres. */
  countUnit: RepUnit;
  name: string;
  targetIds: string[];
  /** Trains a target of an active goal. */
  goal: boolean;
  unit: 'kg' | RepUnit;
  sessions: number;
  first: number;
  last: number;
  best: number;
  changePct: number | null;
  status: ProgressStatus;
  lastDate: string;
  points: StrengthPoint[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Every active goal's target ids (primary and supporting). */
export function goalTargetIds(db: Database.Database): Set<string> {
  return new Set(new GoalsRepo(db).list({ active: true }).flatMap((g) => buildPriorityMap(g).targets.map((t) => t.target_id)));
}

/** Each exercise logged in the `days` before `asOf` (inclusive), compared
 * only with itself and only within the same equipment (an untagged series
 * is its own series). Status is read from non-deload sessions: a new best
 * (beats every earlier session by 1%), stalled (no new best in the last
 * STALL_SESSIONS sessions, with at least STALL_SESSIONS + 1 sessions),
 * else the early-vs-late trend. */
export function strengthProgress(db: Database.Database, asOf: string, days = 56): ExerciseProgress[] {
  const start = addDays(asOf, -(days - 1));
  const repo = new WorkoutSessionsRepo(db);
  const programId = new UsersRepo(db).getOrCreateDefault().id;
  const deload = deloadDatesInRange(db, programId, start, asOf);
  const goalTargets = goalTargetIds(db);

  const byExercise = new Map<string, Map<string, { value: number; bestSet: string; unit: 'kg' | RepUnit }>>();
  for (const session of repo.listSessionsInRange(start, asOf).filter((s) => s.status === 'completed')) {
    for (const perf of repo.getExercisePerformances(session.session_id)) {
      const sets = perf.sets.filter((s) => s.completed && s.reps !== null && s.reps > 0);
      if (sets.length === 0) continue;
      const loaded = sets.filter((s) => s.weight !== null && s.weight > 0);
      const countUnit = repUnitOf(perf);
      // The set's logged reps in reserve, when there is one, so the coach
      // review can tell a hard set from an easy one.
      const rirNote = (s: { rir: number | null }) => (s.rir !== null && s.rir !== undefined ? ` @ RIR ${s.rir}` : '');
      // Weight x reps (estimated 1RM) only for reps; for steps, seconds or
      // metres the heaviest load carried/held, else the best count.
      const best = loaded.length > 0
        ? countUnit === 'reps'
          ? loaded.map((s) => ({ value: s.weight! * (1 + s.reps! / 30), bestSet: `${s.weight} kg × ${s.reps}${rirNote(s)}`, unit: 'kg' as const })).sort((a, b) => b.value - a.value)[0]!
          : loaded.map((s) => ({ value: s.weight!, bestSet: `${s.weight} kg × ${s.reps} ${countUnit}${rirNote(s)}`, unit: 'kg' as const })).sort((a, b) => b.value - a.value)[0]!
        : sets.map((s) => ({ value: s.reps!, bestSet: `${s.reps} ${countUnit}${rirNote(s)}`, unit: countUnit })).sort((a, b) => b.value - a.value)[0]!;
      const key = progressSeriesKey({ exerciseId: perf.exercise_id, equipment: perf.equipment, attachment: perf.attachment, repUnit: countUnit });
      const dates = byExercise.get(key) ?? byExercise.set(key, new Map()).get(key)!;
      const prev = dates.get(session.date);
      if (!prev || best.value > prev.value) dates.set(session.date, best);
    }
  }

  const result: ExerciseProgress[] = [];
  for (const [key, dates] of byExercise) {
    const { exerciseId, equipment, attachment, repUnit } = parseProgressSeriesKey(key);
    const all = [...dates].sort(([a], [b]) => a.localeCompare(b));
    const unit = all.some(([, p]) => p.unit === 'kg') ? 'kg' : repUnit;
    const points: StrengthPoint[] = all.filter(([, p]) => p.unit === unit).map(([date, p]) => ({ date, value: round1(p.value), bestSet: p.bestSet, deload: deload.has(date) }));
    if (points.length === 0) continue;
    const counted = points.filter((p) => !p.deload);
    const values = counted.map((p) => p.value);
    let status: ProgressStatus = 'new';
    if (values.length >= 2) {
      const last = values[values.length - 1]!;
      const before = values.slice(0, -1);
      const recent = values.slice(-STALL_SESSIONS);
      const earlier = values.slice(0, -STALL_SESSIONS);
      if (last > Math.max(...before) * (1 + NEW_BEST_MARGIN)) status = 'new_best';
      else if (values.length > STALL_SESSIONS && Math.max(...recent) <= Math.max(...earlier) * (1 + NEW_BEST_MARGIN)) status = 'stalled';
      else {
        // The trend must agree with where the exercise started and ended:
        // one odd session in the middle can tip the averages either way.
        const trend = calculateBasicTrend(counted.map((p) => ({ date: p.date, load: p.value })));
        const first = values[0]!;
        status = trend === 'up' && last > first ? 'up' : trend === 'down' && last < first ? 'down' : 'flat';
      }
    }
    const exercise = BlueprintAdapter.getExercise(exerciseId);
    const targetIds = [...(exercise?.physique_targets ?? [])];
    const first = (counted[0] ?? points[0]!).value;
    const last = (counted[counted.length - 1] ?? points[points.length - 1]!).value;
    result.push({
      exerciseId,
      equipment,
      attachment,
      countUnit: repUnit,
      name: exercise?.name ?? exerciseId,
      targetIds,
      goal: targetIds.some((t) => goalTargets.has(t)),
      unit,
      sessions: points.length,
      first,
      last,
      best: Math.max(...points.map((p) => p.value)),
      changePct: counted.length >= 2 && first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null,
      status,
      lastDate: points[points.length - 1]!.date,
      points,
    });
  }
  return result.sort((a, b) => Number(b.goal) - Number(a.goal) || b.sessions - a.sessions || b.lastDate.localeCompare(a.lastDate));
}

export interface WeekRequirement {
  /** requiredDirectSets per physique target id. */
  required: Map<string, number>;
  /** Display goal label per target id ("Goal 1", "Normal development", ...). */
  goalLabel: Map<string, string | null>;
}

export interface VolumeRow {
  targetId: string;
  name: string;
  goalLabel: string | null;
  weeks: Array<{ weekStart: string; done: number; required: number | null }>;
}

/** Direct sets done vs required per muscle for the `weeks` programming
 * weeks ending with the week of `asOf`. `requirementFor` supplies each
 * week's requirement (saved week program, or the planner as of that week's
 * start). Muscles with no requirement and no work are left out. */
export function volumeHistory(db: Database.Database, asOf: string, weeks: number, requirementFor: (weekStart: string) => WeekRequirement): VolumeRow[] {
  const currentWeek = programmingWeekStart(asOf);
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(currentWeek, -7 * (weeks - 1 - i)));
  const rows = new Map<string, VolumeRow>();
  for (const weekStart of weekStarts) {
    const weekEnd = addDays(weekStart, 6);
    const doneAsOf = weekEnd < asOf ? weekEnd : asOf;
    const done = new Map(buildTrainingState(db, doneAsOf).weekly_exposure.filter((e) => e.target_type === 'physique_target').map((e) => [e.target_id, e.primary_sets]));
    const req = requirementFor(weekStart);
    for (const target of BlueprintAdapter.getTargets()) {
      const row = rows.get(target.id) ?? { targetId: target.id, name: target.name, goalLabel: null, weeks: [] };
      row.goalLabel = req.goalLabel.get(target.id) ?? row.goalLabel;
      row.weeks.push({ weekStart, done: done.get(target.id) ?? 0, required: req.required.get(target.id) ?? null });
      rows.set(target.id, row);
    }
  }
  // Leave out leading weeks with no logged work at all (before training was logged).
  const all = [...rows.values()];
  const firstActive = weekStarts.findIndex((_, i) => all.some((r) => r.weeks[i]!.done > 0));
  if (firstActive > 0) for (const r of all) r.weeks = r.weeks.slice(firstActive);
  const order = (label: string | null) => (label?.startsWith('Goal') ? 0 : label === 'Normal development' ? 1 : label === 'Maintenance' ? 2 : 3);
  return [...rows.values()]
    .filter((r) => r.weeks.some((w) => w.done > 0 || (w.required ?? 0) > 0))
    .sort((a, b) => order(a.goalLabel) - order(b.goalLabel) || (a.goalLabel ?? '').localeCompare(b.goalLabel ?? '') || a.name.localeCompare(b.name));
}

export interface ConsistencyWeek {
  weekStart: string;
  /** Scheduled gym days so far this week (all seven for a finished week). */
  gymDaysScheduled: number;
  gymDaysDone: number;
  setsPrescribed: number;
  setsDone: number;
}

/** Gym days done vs scheduled, and sets done vs prescribed, per week. */
export function consistency(db: Database.Database, asOf: string, weeks: number): ConsistencyWeek[] {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  const repo = new WorkoutSessionsRepo(db);
  const currentWeek = programmingWeekStart(asOf);
  const out: ConsistencyWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = addDays(currentWeek, -7 * i);
    const overrides = profile ? new WeekActivityOverridesRepo(db).get(profile.id, weekStart) : new Map();
    const effective = profile ? applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides) : { trainingDays: [], otherActivitySchedule: [] };
    let scheduled = 0;
    let done = 0;
    let setsPrescribed = 0;
    let setsDone = 0;
    WEEKDAYS.forEach((weekday, d) => {
      const date = addDays(weekStart, d);
      if (date > asOf) return;
      const activity = deriveDailyActivity(weekday, effective.trainingDays, effective.otherActivitySchedule);
      const completed = repo.listSessionsByDate(date).filter((s) => s.status === 'completed' && s.session_type !== 'badminton');
      if (activity === 'gym' || activity === 'both') scheduled++;
      if (completed.length > 0) done++;
      for (const s of completed) {
        for (const perf of repo.getExercisePerformances(s.session_id)) {
          setsPrescribed += perf.target_sets ?? perf.sets.length;
          setsDone += perf.sets.filter((x) => x.completed).length;
        }
      }
    });
    out.push({ weekStart, gymDaysScheduled: scheduled, gymDaysDone: done, setsPrescribed, setsDone });
  }
  return out;
}

/** A goal's display name: an aesthetic outcome's own wording, or the functional goal's name. */
export function goalDisplayName(g: Pick<Goal, 'goal_type' | 'blueprint_ref'>): string {
  return g.goal_type === 'aesthetic'
    ? (BlueprintAdapter.getAestheticGoal(g.blueprint_ref)?.display_name ?? g.blueprint_ref)
    : (BlueprintAdapter.getFunctionalGoal(g.blueprint_ref)?.name ?? g.blueprint_ref);
}

export interface GoalCheckIn {
  goalId: string;
  name: string;
  lastAssessment: { date: string; rating: number } | null;
  nextDue: string;
  overdue: boolean;
  measurements: number;
}

/** Each active goal's last self-assessment and when the next is due
 * (last + review cadence; today when there has never been one). */
export function goalCheckIns(db: Database.Database, asOf: string): GoalCheckIn[] {
  const assessments = new AestheticAssessmentsRepo(db);
  const measurements = new MeasurementsRepo(db);
  return new GoalsRepo(db)
    .list({ active: true })
    .sort((a, b) => a.priority - b.priority)
    .map((g) => {
      const last = [...assessments.listForGoal(g.id)].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
      const nextDue = last ? addDays(last.date, g.review_cadence_days) : asOf;
      const name = goalDisplayName(g);
      return {
        goalId: g.id,
        name,
        lastAssessment: last ? { date: last.date, rating: last.rating } : null,
        nextDue,
        overdue: last === null || daysBetween(nextDue, asOf) > 0,
        measurements: measurements.listForGoal(g.id).length,
      };
    });
}

export interface MeasurementSeries {
  metric: string;
  unit: string;
  /** Which way is progress (measurementMetrics.ts). */
  better: MeasurementDirection;
  /** Goals these readings are tied to (by goal_id), if any. */
  goals: string[];
  readings: Array<{ id: string; date: string; value: number; notes: string | null }>;
  /** Latest minus first, rounded; null with one reading. */
  change: number | null;
  /** The change judged by `better`: 'better' | 'worse' | 'same', 'not judged'
   * (neutral metric) or 'one reading'. */
  verdict: 'better' | 'worse' | 'same' | 'not judged' | 'one reading';
}

/** Body measurements grouped by name and unit, oldest reading first.
 * Different units are separate series and never compared. */
export function bodyMeasurements(db: Database.Database): MeasurementSeries[] {
  const goals = new Map(new GoalsRepo(db).list().map((g) => [g.id, goalDisplayName(g)]));
  const series = new Map<string, MeasurementSeries>();
  for (const m of new MeasurementsRepo(db).list()) {
    const key = `${m.metric_name.toLowerCase()}|${m.unit}`;
    const s = series.get(key) ?? series.set(key, { metric: m.metric_name, unit: m.unit, better: measurementDirection(m.metric_name), goals: [], readings: [], change: null, verdict: 'one reading' }).get(key)!;
    s.readings.push({ id: m.id, date: m.date, value: m.value, notes: m.notes });
    const goal = m.goal_id ? goals.get(m.goal_id) : undefined;
    if (goal && !s.goals.includes(goal)) s.goals.push(goal);
  }
  for (const s of series.values()) {
    s.readings.sort((a, b) => a.date.localeCompare(b.date));
    if (s.readings.length < 2) continue;
    s.change = round1(s.readings[s.readings.length - 1]!.value - s.readings[0]!.value);
    s.verdict = s.better === 'neutral' ? 'not judged'
      : s.change === 0 ? 'same'
      : (s.change > 0) === (s.better === 'higher') ? 'better' : 'worse';
  }
  return [...series.values()];
}

export interface DeloadPeriod {
  start: string;
  end: string;
  kind: 'scheduled' | 'reactive';
  /** Reactive only: whether the current trigger rule would still start
   * this deload on its first day (false = an artifact of the old rule). */
  confirmedByCurrentRule?: boolean;
}

/** Deload periods overlapping [start, end], from the periodization event
 * log (each event's state holds until the next event), clipped to the
 * range. A combined scheduled + reactive stretch reports as reactive. */
export function deloadHistory(db: Database.Database, start: string, end: string): DeloadPeriod[] {
  const programId = new UsersRepo(db).getOrCreateDefault().id;
  const events = new PeriodizationEventsRepo(db).listForProgram(programId).map((e) => ({
    date: (e.evidence as { evaluationTimestamp?: string } | null)?.evaluationTimestamp ?? e.occurredAt.slice(0, 10),
    state: e.newState,
  }));
  const periods: DeloadPeriod[] = [];
  events.forEach((e, i) => {
    if (e.state === 'ACTIVE') return;
    const kind = e.state === 'REACTIVE_DELOAD' ? 'reactive' : 'scheduled';
    const from = e.date < start ? start : e.date;
    const nextDate = events[i + 1]?.date;
    const to = nextDate ? addDays(nextDate, -1) : end;
    const clipped = to > end ? end : to;
    if (from > clipped) return;
    const prev = periods[periods.length - 1];
    if (prev && prev.kind === kind && addDays(prev.end, 1) >= from) prev.end = clipped > prev.end ? clipped : prev.end;
    else periods.push({ start: from, end: clipped, kind });
  });
  for (const p of periods.filter((x) => x.kind === 'reactive')) {
    p.confirmedByCurrentRule = evaluateReactiveDeloadTrigger(db, { programId, referenceDate: p.start, isInCooldown: false, isAlreadyInReactiveDeload: false }).triggered;
  }
  return periods;
}
