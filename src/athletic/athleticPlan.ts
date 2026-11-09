// Athletic day as one package (2026-10-31, owner): "On a specific day If I
// choose it as athletic day, it should be considered for strength,
// mobility, endurance, flexibility all together ... It is not necessary to
// pick everything on every athletic day. The choice can be made using other
// aspects like recovery and badminton session on previous or next days.
// Like I can't be doing the recovery, mobility on the 2 consecutive
// athletic days without touching flexibility and strength."
// Leg size counts only where it makes the legs harder to injure and quicker
// to recover (owner, same day); there is one Athletic day a week, with
// add-ons (no strength) on other days.
//
// The package's components and the blocks that hold them:
//   strength     strength block (leg lifts)
//   resilience   quality block (landing, ankle, low jumps)
//   endurance    conditioning block
//   mobility     mobility block (2-3 dynamic drills), after the main work
//   flexibility  cool-down block of holds (2-3)
// There is no warm-up block (owner, 2026-11-05): warming up is the owner's choice.
//
// Today's components are chosen by the app, before the model runs. Since
// 2026-11-09 the package is fixed (owner OK'd the week layout: "Thu
// Athletic: strength + resilience + endurance every week, plus 2-3
// holds"; and left mobility vs resilience to the coach, for staying
// injury free):
//   - a normal day: strength, resilience, endurance and flexibility (2-3
//     holds). Strength is the legs' only strength work of the week;
//     resilience (landing, ankles, low jumps) has the strongest evidence
//     for preventing leg injuries, so it comes every week rather than
//     taking turns with mobility; endurance keeps the legs lasting through
//     badminton. Mobility is covered by the dynamic drills of the gym days'
//     flexibility blocks.
//   - badminton yesterday or tomorrow makes it a light day: no resilience
//     (jumps) or endurance, strength kept easy (RIR 2+, at most 3 sets),
//     plus mobility and flexibility.
// Until 2026-11-09 it was strength plus the two components waiting
// longest; "last done" (read from logged sets) is still reported.

import type Database from 'better-sqlite3';
import { trainingModeOf, isDrillId } from '../blueprint/athletic.js';
import type { TrainingMode } from '../blueprint/types.js';
import { addDays } from '../engine/dateMath.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';

export const ATHLETIC_COMPONENTS = ['strength', 'resilience', 'endurance', 'mobility', 'flexibility'] as const;
export type AthleticComponent = (typeof ATHLETIC_COMPONENTS)[number];

/** The fixed package of a normal and of a light Athletic day. */
export const NORMAL_DAY: readonly AthleticComponent[] = ['strength', 'resilience', 'endurance', 'flexibility'];
export const LIGHT_DAY: readonly AthleticComponent[] = ['strength', 'mobility', 'flexibility'];
/** How far back past Athletic days are read. */
export const ATHLETIC_PLAN_HISTORY_DAYS = 70;

export const COMPONENT_LABELS: Record<AthleticComponent, string> = {
  strength: 'Strength',
  resilience: 'Resilience (landing, ankles, low jumps)',
  endurance: 'Endurance',
  mobility: 'Mobility',
  flexibility: 'Flexibility',
};

export interface AthleticDayPlan {
  components: AthleticComponent[];
  /** Badminton yesterday or tomorrow: easy strength, no jumps or endurance. */
  light: boolean;
  /** One line per component chosen, plus what a light day left out. */
  reasons: string[];
  /** When each component was last done on an Athletic day (null = never). */
  lastDone: Record<AthleticComponent, string | null>;
}

const RESILIENCE_MODES: readonly TrainingMode[] = ['power', 'agility', 'movement-strength'];
const FLEXIBILITY_MODES: readonly TrainingMode[] = ['mobility-hold', 'soft-tissue'];

/** Components a logged session covered (completed sets only). One
 * mobility drill is not mobility work, and one closing hold is not
 * flexibility work: those need two drills each. */
export function componentsDone(performances: ReadonlyArray<{ exercise_id: string; sets: ReadonlyArray<{ completed: boolean }> }>): Set<AthleticComponent> {
  const done = new Set<AthleticComponent>();
  let dynamic = 0;
  let holds = 0;
  for (const p of performances) {
    if (!p.sets.some((s) => s.completed)) continue;
    if (!isDrillId(p.exercise_id)) {
      done.add('strength');
      continue;
    }
    const mode = trainingModeOf(p.exercise_id)!;
    if (RESILIENCE_MODES.includes(mode)) done.add('resilience');
    else if (mode === 'conditioning') done.add('endurance');
    else if (mode === 'mobility-dynamic') dynamic++;
    else if (FLEXIBILITY_MODES.includes(mode)) holds++;
  }
  if (dynamic >= 2) done.add('mobility');
  if (holds >= 2) done.add('flexibility');
  return done;
}

/** Past Athletic days before `date` (committed Athletic proposals whose
 * session was completed) and what each covered, oldest first. */
export function athleticDayHistory(db: Database.Database, date: string): Array<{ date: string; components: AthleticComponent[] }> {
  const dates = (
    db
      .prepare(
        `SELECT DISTINCT target_date AS date FROM ai_program_proposals
          WHERE status = 'committed' AND json_extract(proposal_json, '$.sessionKind') = 'athletic' AND target_date >= ? AND target_date < ?
          ORDER BY target_date`
      )
      .all(addDays(date, -ATHLETIC_PLAN_HISTORY_DAYS), date) as Array<{ date: string }>
  ).map((r) => r.date);
  const sessions = new WorkoutSessionsRepo(db);
  const out: Array<{ date: string; components: AthleticComponent[] }> = [];
  for (const d of dates) {
    const done = new Set<AthleticComponent>();
    for (const s of sessions.listSessionsByDate(d).filter((x) => x.status === 'completed')) {
      for (const c of componentsDone(sessions.getExercisePerformances(s.session_id))) done.add(c);
    }
    if (done.size > 0) out.push({ date: d, components: ATHLETIC_COMPONENTS.filter((c) => done.has(c)) });
  }
  return out;
}

/** Pure choice of today's components. `badminton` names the neighbouring
 * badminton day(s), empty when there is none. */
export function chooseAthleticComponents(history: ReadonlyArray<{ date: string; components: readonly AthleticComponent[] }>, badminton: { yesterday: boolean; tomorrow: boolean }): AthleticDayPlan {
  const lastDone = Object.fromEntries(ATHLETIC_COMPONENTS.map((c) => [c, null])) as Record<AthleticComponent, string | null>;
  for (const day of history) for (const c of day.components) if (!lastDone[c] || day.date > lastDone[c]!) lastDone[c] = day.date;

  const light = badminton.yesterday || badminton.tomorrow;
  const when = badminton.yesterday && badminton.tomorrow ? 'yesterday and tomorrow' : badminton.yesterday ? 'yesterday' : 'tomorrow';
  const reasons: string[] = [light ? `Strength: every Athletic day, kept easy (badminton ${when}).` : 'Strength: every Athletic day (the only day the legs get strength work).'];
  const WHY: Record<AthleticComponent, string> = {
    strength: '',
    resilience: 'every week: landing and ankle work does the most to keep the legs injury free',
    endurance: 'every week: legs that last through badminton',
    mobility: 'on a light day, in place of jumps and endurance',
    flexibility: '2-3 holds every Athletic day',
  };
  const package_ = light ? LIGHT_DAY : NORMAL_DAY;
  for (const c of package_.filter((x) => x !== 'strength')) reasons.push(`${COMPONENT_LABELS[c]}: ${WHY[c]} (${lastDone[c] ? `last done ${lastDone[c]}` : 'not done on an Athletic day yet'}).`);
  if (light) reasons.push(`Resilience and endurance left out: badminton ${when}.`);
  return { components: ATHLETIC_COMPONENTS.filter((c) => package_.includes(c)), light, reasons, lastDone };
}
