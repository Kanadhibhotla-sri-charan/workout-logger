// Shoulder care (2026-11-09; owner OK'd the week layout with "shoulder
// resilience" on Mon Push and Fri Upper). The shoulders take every pressing
// and pulling day plus badminton's overhead work, and Blueprint's two
// shoulder-health exercises (rotator cuff external rotation, push-up plus
// for the serratus) were never planned: no ledger number, no package.
//
// Every Push and Upper session gets ONE of them after the main exercises,
// the one done least recently (never done first; ties in list order), at
// SHOULDER_CARE_SETS easy sets (RIR 2 or more). Deterministic, outside the
// AI output and its checks, like the add-on and the flexibility block. It
// is a few minutes and is never cut for time: it is the shoulder's injury
// insurance, which the owner's goal of staying injury free puts first.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { defaultPrescriptionFor } from '../blueprint/programmingProfiles.js';
import type { SessionPurpose } from '../engine/config.js';
import { addDays } from '../engine/dateMath.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import type { AIWorkoutExerciseProposal } from '../ai-programmer/contracts/programmerTypes.js';
import { athleticFilterFor } from './athleticSession.js';

export const SHOULDER_CARE_EXERCISES: ReadonlyArray<{ exerciseId: string; goalId: string; label: string }> = [
  { exerciseId: 'cable-band-external-rotation', goalId: 'rotator-cuff', label: 'rotator cuff' },
  { exerciseId: 'push-up-plus', goalId: 'scapular-stability', label: 'shoulder-blade control' },
];
export const SHOULDER_CARE_PURPOSES: readonly SessionPurpose[] = ['push', 'upper'];
export const SHOULDER_CARE_SETS = 2;
/** Shoulder care is kept easy: never closer than this to failure. */
export const SHOULDER_CARE_MIN_RIR = 2;
const LOOKBACK_DAYS = 28;

export interface ShoulderCare {
  minutes: number;
  reason: string;
  exercises: AIWorkoutExerciseProposal[];
}

/** When each shoulder-care exercise was last done (completed sets), in the
 * LOOKBACK_DAYS before `date`. */
function lastDone(db: Database.Database, date: string): Map<string, string> {
  const ids = new Set(SHOULDER_CARE_EXERCISES.map((e) => e.exerciseId));
  const sessions = new WorkoutSessionsRepo(db);
  const last = new Map<string, string>();
  for (const s of sessions.listSessionsInRange(addDays(date, -LOOKBACK_DAYS), addDays(date, -1)).filter((x) => x.status === 'completed')) {
    for (const p of sessions.getExercisePerformances(s.session_id)) {
      if (ids.has(p.exercise_id) && p.sets.some((x) => x.completed) && (last.get(p.exercise_id) ?? '') < s.date) last.set(p.exercise_id, s.date);
    }
  }
  return last;
}

export function planShoulderCare(db: Database.Database, date: string, purpose: SessionPurpose | null): ShoulderCare | null {
  if (purpose === null || !SHOULDER_CARE_PURPOSES.includes(purpose)) return null;
  const filter = athleticFilterFor(db, date);
  const usable = SHOULDER_CARE_EXERCISES.filter(({ exerciseId }) => {
    const exercise = BlueprintAdapter.getExercise(exerciseId);
    if (!exercise || filter.avoided.has(exerciseId)) return false;
    return !filter.available || exercise.equipment.some((item) => item === 'bodyweight' || filter.available!.has(item));
  });
  const last = lastDone(db, date);
  const pick = [...usable].sort((a, b) => (last.get(a.exerciseId) ?? '').localeCompare(last.get(b.exerciseId) ?? '') || usable.indexOf(a) - usable.indexOf(b))[0];
  if (!pick) return null;
  const rx = defaultPrescriptionFor(pick.exerciseId);
  const time = BlueprintAdapter.getExercise(pick.exerciseId)?.time;
  if (!rx || !time) return null;
  const rest = time.rest_seconds[0];
  const rirMin = Math.max(SHOULDER_CARE_MIN_RIR, rx.rir.min);
  const entry: AIWorkoutExerciseProposal = {
    exerciseId: pick.exerciseId,
    role: 'accessory',
    targetType: 'functional_goal',
    targetId: pick.goalId,
    sets: SHOULDER_CARE_SETS,
    repsMin: rx.reps.min,
    repsMax: rx.reps.max,
    rirMin,
    rirMax: Math.max(rirMin, rx.rir.max),
    restSeconds: rest,
    rationale: [`shoulder care (${pick.label})`],
    source: 'blueprint',
  };
  const seconds = time.setup_minutes * 60 + SHOULDER_CARE_SETS * (time.seconds_per_set * (time.per_side ? 2 : 1) + rest);
  const when = last.get(pick.exerciseId);
  return {
    minutes: Math.max(1, Math.round(seconds / 60)),
    reason: `Shoulder care for pressing, pulling and badminton: ${pick.label}, easy (${when ? `last done ${when}` : 'not done in the last 4 weeks'}).`,
    exercises: [entry],
  };
}
