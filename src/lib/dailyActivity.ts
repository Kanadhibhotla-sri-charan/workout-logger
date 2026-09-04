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
