// Athletic add-on (2026-10-18, owner request): when leg training is
// 'athletic', each Push / Pull / Upper session ends with 5-10 minutes of
// leg work for durability. Since 2026-11-10 it is made of parts the owner
// ticks before generating, by how fatigued, sore and recovered the legs are:
//   resilience    ankle / landing control (low jumps, hops, landings)
//   conditioning  one short whole-body conditioning drill
//   mobility      one dynamic hip / ankle range drill
//   flexibility   one lower-body hold (counts toward the weekly lower-body
//                 stretching minutes)
// The suggested ticks depend on the days around it. Owner, 2026-11-10:
// "not having add-ons on 2 consecutive days should not be a hard rule, it
// should be contextual" -- only a day heavy on the legs counts:
//   yesterday     badminton, the Athletic day or a Legs day
//   tomorrow      badminton or the Athletic day
// Next to one, nothing is suggested; otherwise every part is. A small
// add-on yesterday is not heavy (until 2026-11-10 any jump or conditioning
// drill the day before removed the add-on entirely).
// Selection is deterministic: the least recently done drill of each part
// (ties by id), Blueprint numbers at the low end, trimmed to fit
// ADD_ON_MAX_SECONDS. No add-on while the Legs injury pause is on, or when
// leg training is not athletic.

import type Database from 'better-sqlite3';
import { ATHLETIC_GOAL_IDS, isDrillId } from '../blueprint/athletic.js';
import type { TrainingMode } from '../blueprint/types.js';
import { addDays } from '../engine/dateMath.js';
import { programmingWeekStart } from '../engine/workoutBuilder.js';
import type { SessionPurpose } from '../engine/config.js';
import { LegTrainingRepo } from '../repositories/legTrainingRepo.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import type { AIWorkoutExerciseProposal } from '../ai-programmer/contracts/programmerTypes.js';
import { weekGymDays } from '../ai-programmer/service/weekGeneration.js';
import { athleticFilterFor, athleticPaused, drillCatalogue, drillEntry, effectiveActivity, type AthleticDrillContext } from './athleticSession.js';

export const ADD_ON_MAX_SECONDS = 10 * 60;

export const ADD_ON_PARTS = ['resilience', 'conditioning', 'mobility', 'flexibility'] as const;
export type AddOnPart = (typeof ADD_ON_PARTS)[number];
export const isAddOnPart = (v: unknown): v is AddOnPart => typeof v === 'string' && (ADD_ON_PARTS as readonly string[]).includes(v);

export const ADD_ON_PART_LABELS: Record<AddOnPart, { label: string; description: string }> = {
  resilience: { label: 'Resilience', description: 'ankle and landing control: low hops, landings' },
  conditioning: { label: 'Conditioning', description: 'one short whole-body conditioning drill' },
  mobility: { label: 'Mobility', description: 'one dynamic hip or ankle range drill' },
  flexibility: { label: 'Leg flexibility', description: 'one lower-body stretch hold' },
};

/** Which drills each part draws from: Blueprint modes, and the goals a drill must carry. */
const PART_SOURCES: Record<AddOnPart, { modes: readonly TrainingMode[]; goals?: readonly string[] }> = {
  resilience: { modes: ['power', 'agility'], goals: ['ankle-resilience', 'landing-control'] },
  conditioning: { modes: ['conditioning'] },
  mobility: { modes: ['mobility-dynamic'], goals: ['lower-body-mobility', 'ankle-resilience'] },
  flexibility: { modes: ['mobility-hold'], goals: ['lower-body-mobility', 'ankle-resilience'] },
};

export type AddOnKind = 'mobility' | 'active';

export interface AthleticAddOn {
  kind: AddOnKind;
  /** The parts this add-on was built from. */
  parts: AddOnPart[];
  minutes: number;
  reason: string;
  exercises: AIWorkoutExerciseProposal[];
}

/** Why `date` was (yesterday) or will be (tomorrow) heavy on the legs, or null. */
export function heavyLegDayReason(db: Database.Database, date: string, side: 'yesterday' | 'tomorrow'): string | null {
  const activity = effectiveActivity(db, date);
  const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(date).filter((s) => s.status !== 'skipped');
  if (activity === 'badminton' || activity === 'both' || sessions.some((s) => s.session_type === 'badminton')) return 'badminton';
  const purpose = weekGymDays(db, programmingWeekStart(date)).find((d) => d.date === date)?.purpose ?? null;
  if (purpose === 'athletic') return 'the Athletic day';
  if (side === 'yesterday' && purpose === 'legs') return 'a Legs day';
  return null;
}

export interface AddOnOptions {
  /** False when this day has no add-on at all (see unavailableReason). */
  available: boolean;
  unavailableReason: string | null;
  parts: Array<{ id: AddOnPart; label: string; description: string; suggested: boolean }>;
  /** Why the suggestion is what it is, in plain words. */
  suggestionReason: string;
}

/** Why this day can have no add-on, or null when it can. */
function unavailableReason(db: Database.Database, purpose: SessionPurpose | null): string | null {
  if (new LegTrainingRepo(db).get() !== 'athletic') return 'Leg training is not set to athletic.';
  if (purpose !== 'push' && purpose !== 'pull' && purpose !== 'upper') return 'Only Push, Pull and Upper days get leg add-ons.';
  if (athleticPaused(db)) return 'The Legs injury pause is on.';
  return null;
}

/** The parts suggested for `date`: every part when the legs are fresh,
 * none next to a day heavy on the legs. */
export function suggestedAddOnParts(db: Database.Database, date: string): { parts: AddOnPart[]; reason: string } {
  const before = heavyLegDayReason(db, addDays(date, -1), 'yesterday');
  if (before) return { parts: [], reason: `Yesterday was ${before}, so the legs rest unless you tick something.` };
  const after = heavyLegDayReason(db, addDays(date, 1), 'tomorrow');
  if (after) return { parts: [], reason: `Tomorrow is ${after}, so the legs stay fresh unless you tick something.` };
  return { parts: [...ADD_ON_PARTS], reason: 'No heavy leg day yesterday or tomorrow. Untick what has not recovered.' };
}

export function addOnOptions(db: Database.Database, date: string, purpose: SessionPurpose | null): AddOnOptions {
  const why = unavailableReason(db, purpose);
  const suggested = why ? { parts: [] as AddOnPart[], reason: '' } : suggestedAddOnParts(db, date);
  return {
    available: why === null,
    unavailableReason: why,
    parts: ADD_ON_PARTS.map((id) => ({ id, ...ADD_ON_PART_LABELS[id], suggested: suggested.parts.includes(id) })),
    suggestionReason: suggested.reason,
  };
}

function secondsOf(e: AIWorkoutExerciseProposal, drill: AthleticDrillContext): number {
  const work = drill.unit === 'seconds' ? e.repsMax : e.repsMax * 3;
  return e.sets * (work * (drill.perSide ? 2 : 1) + (e.restSeconds ?? 0));
}

/** Last completed date of each drill in the 28 days before `date`. */
export function lastDoneDrills(db: Database.Database, date: string): Map<string, string> {
  const sessions = new WorkoutSessionsRepo(db);
  const last = new Map<string, string>();
  for (const s of sessions.listSessionsInRange(addDays(date, -28), addDays(date, -1)).filter((x) => x.status === 'completed').sort((a, b) => a.date.localeCompare(b.date))) {
    for (const p of sessions.getExercisePerformances(s.session_id)) if (isDrillId(p.exercise_id) && p.sets.some((x) => x.completed)) last.set(p.exercise_id, s.date);
  }
  return last;
}

const isAddOnGoal = (g: string) => (ATHLETIC_GOAL_IDS as readonly string[]).includes(g) || g === 'lower-body-mobility';

/** The add-on for a Push / Pull / Upper session on `date`, or null. `parts`
 * is what the owner ticked; when omitted, the day's suggestion is used. */
export function planAthleticAddOn(db: Database.Database, date: string, purpose: SessionPurpose | null, parts?: readonly AddOnPart[]): AthleticAddOn | null {
  if (unavailableReason(db, purpose)) return null;
  const suggestion = parts === undefined ? suggestedAddOnParts(db, date) : null;
  const wanted = ADD_ON_PARTS.filter((p) => (parts ?? suggestion!.parts).includes(p));
  if (wanted.length === 0) return null;

  // Only drills the user can do in their gym and has not set to avoid.
  const catalogue = drillCatalogue(lastDoneDrills(db, date), athleticFilterFor(db, date), isAddOnGoal);
  const picked: Array<{ part: AddOnPart; drill: AthleticDrillContext }> = [];
  for (const part of wanted) {
    const { modes, goals } = PART_SOURCES[part];
    const drill = catalogue
      .filter((d) => modes.includes(d.mode) && (!goals || d.goals.some((g) => goals.includes(g))) && !picked.some((p) => p.drill === d))
      .sort((a, b) => (a.lastDone ?? '').localeCompare(b.lastDone ?? '') || a.exerciseId.localeCompare(b.exerciseId))[0];
    if (drill) picked.push({ part, drill });
  }
  if (picked.length === 0) return null;
  const built = picked.map((p) => p.part);
  const kind: AddOnKind = built.some((p) => p === 'resilience' || p === 'conditioning') ? 'active' : 'mobility';
  const names = built.map((p) => ADD_ON_PART_LABELS[p].label.toLowerCase()).join(', ');
  const reason = suggestion ? `Leg work today: ${names}. ${suggestion.reason}` : `Leg work you chose for today: ${names}.`;

  const repairs: string[] = [];
  const exercises = picked.map(({ part, drill: d }) => {
    const goals = PART_SOURCES[part].goals;
    return {
      drill: d,
      ex: {
        ...drillEntry(
          d,
          {
            targetId: goals ? d.goals.find((g) => goals.includes(g)) : undefined,
            sets: d.sets.min,
            amountMin: d.amount.min,
            amountMax: d.amount.min + Math.floor((d.amount.max - d.amount.min) / 2),
            restSeconds: d.restSeconds.min,
            rationale: `athletic add-on (${ADD_ON_PART_LABELS[part].label.toLowerCase()})`,
          },
          repairs
        ),
        role: 'accessory' as const,
        block: 'addon' as const,
      },
    };
  });
  // Fit the time box: take sets off the longest item while over it (never below 1).
  const total = () => exercises.reduce((sum, x) => sum + secondsOf(x.ex, x.drill), 0);
  while (total() > ADD_ON_MAX_SECONDS) {
    const longest = [...exercises].filter((x) => x.ex.sets > 1).sort((a, b) => secondsOf(b.ex, b.drill) - secondsOf(a.ex, a.drill))[0];
    if (!longest) break;
    longest.ex = { ...longest.ex, sets: longest.ex.sets - 1 };
  }
  return { kind, parts: built, minutes: Math.max(1, Math.round(total() / 60)), reason, exercises: exercises.map((x) => x.ex) };
}
