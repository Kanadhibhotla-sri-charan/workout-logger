import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { WEEKDAYS, type RecurringActivity, type TrainingProfile, type Weekday } from '../contracts/types.js';
import { isValidTimezone } from '../lib/timezone.js';
import { newId, nowIso } from './ids.js';

export class UnknownBlueprintEquipmentError extends Error {
  constructor(public equipmentId: string) {
    super(`"${equipmentId}" is not a known Blueprint equipment id`);
    this.name = 'UnknownBlueprintEquipmentError';
  }
}

export class InvalidTimezoneError extends Error {
  constructor(public timezone: string) {
    super(`"${timezone}" is not a valid IANA timezone name`);
    this.name = 'InvalidTimezoneError';
  }
}

export interface UpsertTrainingProfileInput {
  timezone: string;
  week_start_day: Weekday;
  training_days: Weekday[];
  preferred_split?: string | null;
  default_session_duration_minutes: number;
  minimum_session_duration_minutes: number;
  maximum_session_duration_minutes: number;
  available_equipment: string[];
  other_activity_schedule: Array<{ day: Weekday; activity_type: string; notes?: string | null }>;
}

interface TrainingProfileRow {
  id: string;
  user_id: string;
  timezone: string;
  week_start_day: Weekday;
  training_days: string;
  preferred_split: string | null;
  default_session_duration_minutes: number;
  minimum_session_duration_minutes: number;
  maximum_session_duration_minutes: number;
  available_equipment: string;
  created_at: string;
  updated_at: string;
}

export class TrainingProfileRepo {
  constructor(private db: Database.Database) {}

  upsert(userId: string, input: UpsertTrainingProfileInput): TrainingProfile {
    if (!isValidTimezone(input.timezone)) {
      throw new InvalidTimezoneError(input.timezone);
    }
    if (!WEEKDAYS.includes(input.week_start_day)) {
      throw new Error(`week_start_day must be one of ${WEEKDAYS.join('|')}`);
    }
    for (const equipmentId of input.available_equipment) {
      if (!BlueprintAdapter.getEquipment(equipmentId)) {
        throw new UnknownBlueprintEquipmentError(equipmentId);
      }
    }
    if (input.minimum_session_duration_minutes > input.maximum_session_duration_minutes) {
      throw new Error('minimum_session_duration_minutes cannot exceed maximum_session_duration_minutes');
    }

    const existing = this.db.prepare('SELECT id FROM training_profiles WHERE user_id = ?').get(userId) as
      | { id: string }
      | undefined;

    const now = nowIso();
    const id = existing?.id ?? newId('profile');

    const row = {
      id,
      user_id: userId,
      timezone: input.timezone,
      week_start_day: input.week_start_day,
      training_days: JSON.stringify(input.training_days),
      preferred_split: input.preferred_split ?? null,
      default_session_duration_minutes: input.default_session_duration_minutes,
      minimum_session_duration_minutes: input.minimum_session_duration_minutes,
      maximum_session_duration_minutes: input.maximum_session_duration_minutes,
      available_equipment: JSON.stringify(input.available_equipment),
      created_at: existing ? undefined : now,
      updated_at: now,
    };

    const tx = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE training_profiles SET
               timezone = @timezone,
               week_start_day = @week_start_day,
               training_days = @training_days,
               preferred_split = @preferred_split,
               default_session_duration_minutes = @default_session_duration_minutes,
               minimum_session_duration_minutes = @minimum_session_duration_minutes,
               maximum_session_duration_minutes = @maximum_session_duration_minutes,
               available_equipment = @available_equipment,
               updated_at = @updated_at
             WHERE id = @id`
          )
          .run(row);
        this.db.prepare('DELETE FROM training_profile_activities WHERE training_profile_id = ?').run(id);
      } else {
        this.db
          .prepare(
            `INSERT INTO training_profiles
               (id, user_id, timezone, week_start_day, training_days, preferred_split, default_session_duration_minutes,
                minimum_session_duration_minutes, maximum_session_duration_minutes, available_equipment,
                created_at, updated_at)
             VALUES
               (@id, @user_id, @timezone, @week_start_day, @training_days, @preferred_split, @default_session_duration_minutes,
                @minimum_session_duration_minutes, @maximum_session_duration_minutes, @available_equipment,
                @created_at, @updated_at)`
          )
          .run(row);
      }

      const insertActivity = this.db.prepare(
        `INSERT INTO training_profile_activities (id, training_profile_id, day, activity_type, notes)
         VALUES (@id, @training_profile_id, @day, @activity_type, @notes)`
      );
      for (const activity of input.other_activity_schedule) {
        insertActivity.run({
          id: newId('activity'),
          training_profile_id: id,
          day: activity.day,
          activity_type: activity.activity_type,
          notes: activity.notes ?? null,
        });
      }
    });
    tx();

    return this.get(userId)!;
  }

  get(userId: string): TrainingProfile | undefined {
    const row = this.db.prepare('SELECT * FROM training_profiles WHERE user_id = ?').get(userId) as
      | TrainingProfileRow
      | undefined;
    if (!row) return undefined;

    const activityRows = this.db
      .prepare('SELECT day, activity_type, notes FROM training_profile_activities WHERE training_profile_id = ?')
      .all(row.id) as Array<{ day: Weekday; activity_type: string; notes: string | null }>;

    const other_activity_schedule: RecurringActivity[] = activityRows.map((a) => ({
      day: a.day,
      activity_type: a.activity_type,
      notes: a.notes,
    }));

    return {
      id: row.id,
      user_id: row.user_id,
      timezone: row.timezone,
      week_start_day: row.week_start_day,
      training_days: JSON.parse(row.training_days),
      preferred_split: row.preferred_split,
      default_session_duration_minutes: row.default_session_duration_minutes,
      minimum_session_duration_minutes: row.minimum_session_duration_minutes,
      maximum_session_duration_minutes: row.maximum_session_duration_minutes,
      available_equipment: JSON.parse(row.available_equipment),
      other_activity_schedule,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
