import type Database from 'better-sqlite3';
import { WEEKDAYS, type DailyActivity, type Weekday } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

/** Current-Week Reconciliation Fix §4/§10: per-day Gym/Badminton/Both/
 * Unselected activity overrides scoped to ONE specific week — entirely
 * separate storage from the recurring TrainingProfile default
 * (training_days/training_profile_activities, owned by
 * TrainingProfileRepo). Absence of a row for a given
 * (training_profile_id, week_start, day) means "use the profile's
 * recurring default" — that fallback is applied by the caller via
 * src/lib/dailyActivity.ts's applyWeekOverrides, never by this repo. */
export class WeekActivityOverridesRepo {
  constructor(private db: Database.Database) {}

  /** Every override stored for this training profile's given week,
   * keyed by weekday. Empty map if none exist yet — a real, valid state
   * meaning "this week has no overrides; use the profile default for
   * every day." */
  get(trainingProfileId: string, weekStart: string): Map<Weekday, DailyActivity> {
    const rows = this.db
      .prepare('SELECT day, activity FROM week_activity_overrides WHERE training_profile_id = ? AND week_start = ?')
      .all(trainingProfileId, weekStart) as Array<{ day: Weekday; activity: DailyActivity }>;
    return new Map(rows.map((r) => [r.day, r.activity]));
  }

  /** Upserts exactly one day's override for one week — never touches any
   * other day, any other week, or the recurring TrainingProfile itself. */
  setOverride(trainingProfileId: string, weekStart: string, day: Weekday, activity: DailyActivity): void {
    if (!WEEKDAYS.includes(day)) {
      throw new Error(`day must be one of ${WEEKDAYS.join('|')}`);
    }
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO week_activity_overrides (id, training_profile_id, week_start, day, activity, created_at, updated_at)
         VALUES (@id, @training_profile_id, @week_start, @day, @activity, @created_at, @updated_at)
         ON CONFLICT (training_profile_id, week_start, day)
         DO UPDATE SET activity = excluded.activity, updated_at = excluded.updated_at`
      )
      .run({
        id: newId('weekoverride'),
        training_profile_id: trainingProfileId,
        week_start: weekStart,
        day,
        activity,
        created_at: now,
        updated_at: now,
      });
  }
}
