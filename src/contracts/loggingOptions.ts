// Per-exercise logging options available on EVERY logged exercise
// (2026-10-11), alongside equipment: which attachment was used and what the
// set's count field measures. Both are universal: any exercise can carry
// any attachment and any unit; nothing is restricted by exercise.

/** What a set's count (`workout_sets.reps`) measures. Null/absent = reps. */
export const REP_UNITS = ['reps', 'steps', 'seconds', 'metres'] as const;
export type RepUnit = (typeof REP_UNITS)[number];

/** Attachment choices offered by the logger. The API also accepts any
 * other short string, like equipment. */
export const ATTACHMENT_CHOICES = [
  'straight bar', 'ez-bar', 'v-bar', 'rope', 'single handle', 'lat bar', 'close-grip handle',
  'neutral-grip handle', 'ankle strap', 'band', 'belt', 'other',
] as const;

export function isRepUnit(value: unknown): value is RepUnit {
  return typeof value === 'string' && (REP_UNITS as readonly string[]).includes(value);
}

/** The unit a performance's counts are in (null/unknown = reps). */
export function repUnitOf(performance: { rep_unit?: string | null }): RepUnit {
  return isRepUnit(performance.rep_unit) ? performance.rep_unit : 'reps';
}

/** True when the counts are repetitions, so weight × reps (estimated 1RM,
 * double progression) means something. Steps, seconds and metres are not. */
export function countsReps(performance: { rep_unit?: string | null }): boolean {
  return repUnitOf(performance) === 'reps';
}

/** Progress is compared only within one series: the same exercise with the
 * same equipment, attachment and unit. */
export function progressSeriesKey(p: { exerciseId: string; equipment?: string | null; attachment?: string | null; repUnit?: RepUnit }): string {
  return [p.exerciseId, p.equipment ?? '', p.attachment ?? '', p.repUnit ?? 'reps'].join('|');
}

export function parseProgressSeriesKey(key: string): { exerciseId: string; equipment: string | null; attachment: string | null; repUnit: RepUnit } {
  const [exerciseId, equipment, attachment, repUnit] = key.split('|') as [string, string, string, string];
  return { exerciseId, equipment: equipment || null, attachment: attachment || null, repUnit: isRepUnit(repUnit) ? repUnit : 'reps' };
}
