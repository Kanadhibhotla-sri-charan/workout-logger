// Blueprint Picker/Daily Activity spec §6-§8: the single source of truth
// for turning a TrainingProfile's existing storage (`training_days` +
// `other_activity_schedule`) into the explicit per-weekday Gym/
// Badminton/Both/Unselected model, and back again for a single-day
// write. Deliberately NOT a new storage location — see
// src/contracts/types.ts's DailyActivity doc comment — so the
// programming engine (src/engine/workoutBuilder.ts,
// src/engine/frequencyEngine.ts), which already reads `training_days`
// for gym-day eligibility and `other_activity_schedule`'s 'badminton'
// entries for recovery awareness, needs no changes at all: a badminton-
// only day was already excluded from gym eligibility before this module
// existed (it was never in `training_days`), and a "Both" day was
// already both (it's simply in both places). This module only makes
// that existing meaning explicit for the API/UI, and provides the one
// place that writes a single day's activity consistently.

import { WEEKDAYS, type DailyActivity, type RecurringActivity, type Weekday } from '../contracts/types.js';

/** Derives the one canonical activity for `day` from a profile's
 * existing `training_days` (gym) and `other_activity_schedule` (badminton
 * entries) — pure, no I/O. Any non-badminton recurring activity on this
 * day (e.g. a hypothetical 'hiking' entry) does not participate in this
 * four-state model and is ignored here (it is still preserved in storage
 * — see setDailyActivity in trainingProfileRepo.ts). */
export function deriveDailyActivity(
  day: Weekday,
  trainingDays: readonly Weekday[],
  otherActivitySchedule: ReadonlyArray<Pick<RecurringActivity, 'day' | 'activity_type'>>
): DailyActivity {
  const gym = trainingDays.includes(day);
  const badminton = otherActivitySchedule.some((a) => a.day === day && a.activity_type === 'badminton');
  if (gym && badminton) return 'both';
  if (gym) return 'gym';
  if (badminton) return 'badminton';
  return 'unselected';
}

/** All seven weekdays' derived activity, in canonical Monday-first order
 * (never the storage order of either underlying array). */
export function deriveWeeklyActivities(
  trainingDays: readonly Weekday[],
  otherActivitySchedule: ReadonlyArray<Pick<RecurringActivity, 'day' | 'activity_type'>>
): Array<{ weekday: Weekday; activity: DailyActivity }> {
  return WEEKDAYS.map((weekday) => ({ weekday, activity: deriveDailyActivity(weekday, trainingDays, otherActivitySchedule) }));
}

/** Current-Week Reconciliation Fix §4/§7: applies a set of Gym/
 * Badminton/Both/Unselected activity overrides on top of a profile's
 * `training_days`/`other_activity_schedule`, producing an EFFECTIVE pair
 * of the same shapes — never persisted by this function itself, and
 * never mutating its inputs. This is the one place both
 * `TrainingProfileRepo.setDailyActivity` (which persists the result back
 * onto the recurring profile) and the current-week override read path
 * (`assembleWeeklyPlanInput`, `GET/PUT .../week`) compute "what does day
 * X actually mean," so the two can never drift into different
 * gym/badminton derivation rules.
 *
 * Only the targeted day's own gym membership and 'badminton'-typed
 * schedule entry are ever touched per override — any other recurring
 * activity on that same day (e.g. a hypothetical 'hiking' entry) is
 * carried through untouched (spec §5: do not delete old data), and
 * every other day is untouched. Applying overrides one at a time (in
 * `overrides`' iteration order) means the LAST entry for a given day
 * wins if the same day somehow appears twice — callers are expected to
 * pass at most one entry per day (a Map or a real DB row set already
 * guarantees this). */
export function applyWeekOverrides(
  trainingDays: readonly Weekday[],
  otherActivitySchedule: readonly RecurringActivity[],
  overrides: ReadonlyMap<Weekday, DailyActivity> | ReadonlyArray<{ day: Weekday; activity: DailyActivity }>
): { trainingDays: Weekday[]; otherActivitySchedule: RecurringActivity[] } {
  let days: readonly Weekday[] = trainingDays;
  let schedule: readonly RecurringActivity[] = otherActivitySchedule;

  const entries: ReadonlyArray<readonly [Weekday, DailyActivity]> = Array.isArray(overrides)
    ? overrides.map((o) => [o.day, o.activity] as const)
    : [...(overrides as ReadonlyMap<Weekday, DailyActivity>).entries()];

  for (const [day, activity] of entries) {
    const wantsGym = activity === 'gym' || activity === 'both';
    const wantsBadminton = activity === 'badminton' || activity === 'both';

    days = wantsGym ? (days.includes(day) ? days : [...days, day]) : days.filter((d) => d !== day);

    const existingBadmintonEntry = schedule.find((a) => a.day === day && a.activity_type === 'badminton');
    const untouched = schedule.filter((a) => !(a.day === day && a.activity_type === 'badminton'));
    schedule = wantsBadminton ? [...untouched, { day, activity_type: 'badminton', notes: existingBadmintonEntry?.notes ?? null }] : untouched;
  }

  return {
    trainingDays: WEEKDAYS.filter((d) => days.includes(d)),
    otherActivitySchedule: [...schedule],
  };
}
