// Athletic add-on (2026-10-18, owner request): when leg training is
// 'athletic', each Push / Pull / Upper session ends with 5-10 minutes of
// athletic work, chosen with recovery in mind so the user never does
// endurance or jump work on back-to-back days:
//   - 'mobility' when yesterday or tomorrow is a hard day (badminton, the
//     Athletic day, or a day that already has active drills): one dynamic
//     mobility drill and one mobility hold — easy to recover from;
//   - 'active' otherwise: one footwork / ankle / power drill and one short
//     whole-body conditioning drill, at the low end of their ranges.
// A day with an active add-on counts as a hard day for its neighbours, so
// two active add-ons are never adjacent. Selection is deterministic: the
// least recently done drill of each kind (ties by id), Blueprint numbers at
// the low end, trimmed to fit ADD_ON_MAX_SECONDS. No add-on while the Legs
// injury pause is on, or when leg training is not athletic.

import type Database from 'better-sqlite3';
import { isDrillId, trainingModeOf } from '../blueprint/athletic.js';
import type { TrainingMode } from '../blueprint/types.js';
import { addDays } from '../engine/dateMath.js';
import { programmingWeekStart } from '../engine/workoutBuilder.js';
import type { SessionPurpose } from '../engine/config.js';
import { AIProposalRepo, effectiveStatus } from '../repositories/aiProposalRepo.js';
import { nowIso } from '../repositories/ids.js';
import { LegTrainingRepo } from '../repositories/legTrainingRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import type { AIWorkoutExerciseProposal } from '../ai-programmer/contracts/programmerTypes.js';
import { weekGymDays } from '../ai-programmer/service/weekGeneration.js';
import { athleticFilterFor, athleticPaused, drillCatalogue, drillEntry, effectiveActivity, type AthleticDrillContext } from './athleticSession.js';

export const ADD_ON_MAX_SECONDS = 10 * 60;
/** Modes that load the legs hard (impact or endurance). */
const ACTIVE_MODES: readonly TrainingMode[] = ['power', 'agility', 'conditioning'];

export type AddOnKind = 'mobility' | 'active';

export interface AthleticAddOn {
  kind: AddOnKind;
  minutes: number;
  reason: string;
  exercises: AIWorkoutExerciseProposal[];
}

const hasActiveDrill = (exerciseIds: readonly string[]) => exerciseIds.some((id) => isDrillId(id) && ACTIVE_MODES.includes(trainingModeOf(id)!));

/** Why `date` is a hard day for the legs, or null when it is not. */
export function hardDayReason(db: Database.Database, date: string): string | null {
  const activity = effectiveActivity(db, date);
  if (activity === 'badminton' || activity === 'both') return 'badminton';
  if (weekGymDays(db, programmingWeekStart(date)).some((d) => d.date === date && d.purpose === 'athletic')) return 'the Athletic day';
  const sessions = new WorkoutSessionsRepo(db);
  for (const s of sessions.listSessionsByDate(date).filter((x) => x.status !== 'skipped')) {
    if (s.session_type === 'badminton') return 'badminton';
    if (hasActiveDrill(sessions.getExercisePerformances(s.session_id).map((p) => p.exercise_id))) return 'jump or conditioning drills';
  }
  const latest = new AIProposalRepo(db).findLatestForTargetDate(date);
  if (latest && ['pending', 'approved'].includes(effectiveStatus(latest, nowIso()))) {
    const planned = [...latest.proposal.exercises, ...(latest.proposal.athleticAddOn?.exercises ?? [])].map((e) => e.exerciseId);
    if (hasActiveDrill(planned)) return 'jump or conditioning drills';
  }
  return null;
}

function secondsOf(e: AIWorkoutExerciseProposal, drill: AthleticDrillContext): number {
  const work = drill.unit === 'seconds' ? e.repsMax : e.repsMax * 3;
  return e.sets * (work * (drill.perSide ? 2 : 1) + (e.restSeconds ?? 0));
}

/** Last completed date of each drill in the 28 days before `date`. */
function lastDoneDrills(db: Database.Database, date: string): Map<string, string> {
  const sessions = new WorkoutSessionsRepo(db);
  const last = new Map<string, string>();
  for (const s of sessions.listSessionsInRange(addDays(date, -28), addDays(date, -1)).filter((x) => x.status === 'completed').sort((a, b) => a.date.localeCompare(b.date))) {
    for (const p of sessions.getExercisePerformances(s.session_id)) if (isDrillId(p.exercise_id) && p.sets.some((x) => x.completed)) last.set(p.exercise_id, s.date);
  }
  return last;
}

/** The add-on for a Push / Pull / Upper session on `date`, or null. */
export function planAthleticAddOn(db: Database.Database, date: string, purpose: SessionPurpose | null): AthleticAddOn | null {
  if (new LegTrainingRepo(db).get() !== 'athletic') return null;
  if (purpose !== 'push' && purpose !== 'pull' && purpose !== 'upper') return null;
  if (athleticPaused(db)) return null;

  const before = hardDayReason(db, addDays(date, -1));
  const after = hardDayReason(db, addDays(date, 1));
  const kind: AddOnKind = before || after ? 'mobility' : 'active';
  const reason =
    kind === 'mobility'
      ? `Mobility only: ${before ? `${before} yesterday` : ''}${before && after ? ' and ' : ''}${after ? `${after} tomorrow` : ''}, so the legs recover.`
      : 'Short ankle/landing resilience and conditioning: no hard leg day yesterday or tomorrow.';

  // Only drills the user can do in their gym and has not set to avoid.
  const catalogue = drillCatalogue(lastDoneDrills(db, date), athleticFilterFor(db, date));
  const leastRecent = (modes: readonly TrainingMode[], goals?: readonly string[]) =>
    catalogue
      .filter((d) => modes.includes(d.mode) && (!goals || d.goals.some((g) => goals.includes(g))))
      .sort((a, b) => (a.lastDone ?? '').localeCompare(b.lastDone ?? '') || a.exerciseId.localeCompare(b.exerciseId))[0];
  // Active: resilience (ankle / landing control), not footwork skill (owner, 2026-10-18).
  const picks = (kind === 'mobility'
    ? [leastRecent(['mobility-dynamic']), leastRecent(['mobility-hold'])]
    : [leastRecent(['power', 'agility'], ['ankle-resilience', 'landing-control']), leastRecent(['conditioning'])]
  ).filter(
    (d): d is AthleticDrillContext => d !== undefined
  );

  const repairs: string[] = [];
  const exercises = picks.map((d) => ({
    drill: d,
    ex: {
      ...drillEntry(d, { sets: d.sets.min, amountMin: d.amount.min, amountMax: d.amount.min + Math.floor((d.amount.max - d.amount.min) / 2), restSeconds: d.restSeconds.min, rationale: `athletic add-on (${kind})` }, repairs),
      role: 'accessory' as const,
      block: 'addon' as const,
    },
  }));
  // Fit the time box: take sets off the longest item while over it (never below 1).
  const total = () => exercises.reduce((sum, x) => sum + secondsOf(x.ex, x.drill), 0);
  while (total() > ADD_ON_MAX_SECONDS) {
    const longest = [...exercises].filter((x) => x.ex.sets > 1).sort((a, b) => secondsOf(b.ex, b.drill) - secondsOf(a.ex, a.drill))[0];
    if (!longest) break;
    longest.ex = { ...longest.ex, sets: longest.ex.sets - 1 };
  }
  return { kind, minutes: Math.max(1, Math.round(total() / 60)), reason, exercises: exercises.map((x) => x.ex) };
}
