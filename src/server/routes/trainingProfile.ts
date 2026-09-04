import { Router } from 'express';
import type Database from 'better-sqlite3';
import { NoTrainingProfileError, UnknownBlueprintEquipmentError, TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { DAILY_ACTIVITIES, WEEKDAYS, type DailyActivity, type Weekday } from '../../contracts/types.js';
import { deriveWeeklyActivities } from '../../lib/dailyActivity.js';

export const trainingProfileRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

trainingProfileRouter.get('/', (req, res) => {
  const user = new UsersRepo(db(req)).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db(req)).get(user.id);
  res.json(profile ?? null);
});

trainingProfileRouter.put('/', (req, res) => {
  const {
    timezone,
    week_start_day,
    training_days,
    preferred_split,
    default_session_duration_minutes,
    minimum_session_duration_minutes,
    maximum_session_duration_minutes,
    available_equipment,
    other_activity_schedule,
  } = req.body ?? {};

  if (typeof timezone !== 'string' || !timezone) {
    return res.status(400).json({ error: 'timezone (IANA name, e.g. "Asia/Kolkata") is required' });
  }
  if (typeof week_start_day !== 'string' || !WEEKDAYS.includes(week_start_day as any)) {
    return res.status(400).json({ error: `week_start_day must be one of ${WEEKDAYS.join('|')}` });
  }
  if (!Array.isArray(training_days) || training_days.some((d: unknown) => !WEEKDAYS.includes(d as any))) {
    return res.status(400).json({ error: `training_days must be an array of ${WEEKDAYS.join('|')}` });
  }
  for (const field of [
    'default_session_duration_minutes',
    'minimum_session_duration_minutes',
    'maximum_session_duration_minutes',
  ]) {
    if (typeof req.body?.[field] !== 'number') {
      return res.status(400).json({ error: `${field} (number) is required` });
    }
  }
  if (!Array.isArray(available_equipment)) {
    return res.status(400).json({ error: 'available_equipment must be an array' });
  }
  if (other_activity_schedule !== undefined && !Array.isArray(other_activity_schedule)) {
    return res.status(400).json({ error: 'other_activity_schedule must be an array' });
  }

  const user = new UsersRepo(db(req)).getOrCreateDefault();
  const repo = new TrainingProfileRepo(db(req));
  try {
    const profile = repo.upsert(user.id, {
      timezone,
      week_start_day: week_start_day as Weekday,
      training_days,
      preferred_split: preferred_split ?? null,
      default_session_duration_minutes,
      minimum_session_duration_minutes,
      maximum_session_duration_minutes,
      available_equipment,
      other_activity_schedule: other_activity_schedule ?? [],
    });
    res.json(profile);
  } catch (err) {
    if (err instanceof UnknownBlueprintEquipmentError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// Blueprint Picker/Daily Activity spec §14: "reading daily activity
// assignments" / "obtaining the current week's activity state" — there is
// no separate per-specific-week override in this app (every week reads
// this same recurring profile fresh, see programming.ts), so the current
// week's state IS this derived weekly pattern. Unauthenticated/no-profile
// state is a real, valid state (spec §46: "the user should NOT need to
// modify source code" to start using the app) — represented as all seven
// days 'unselected', not an error.
trainingProfileRouter.get('/daily-activities', (req, res) => {
  const user = new UsersRepo(db(req)).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db(req)).get(user.id);
  if (!profile) {
    return res.json(WEEKDAYS.map((weekday) => ({ weekday, activity: 'unselected' as const })));
  }
  res.json(deriveWeeklyActivities(profile.training_days, profile.other_activity_schedule));
});

// PUT /api/training-profile/daily-activities/:day — spec §9/§14: change
// one weekday's activity without resubmitting the whole profile form.
// "Reconciling the current/future weekly plan" is automatic (see
// setDailyActivity's doc comment) — the response is simply the fresh
// full week of derived activities so the caller can re-render without a
// second round-trip.
trainingProfileRouter.put('/daily-activities/:day', (req, res) => {
  const day = req.params.day;
  if (!WEEKDAYS.includes(day as Weekday)) {
    return res.status(400).json({ error: `day must be one of ${WEEKDAYS.join('|')}` });
  }
  const { activity } = req.body ?? {};
  if (!DAILY_ACTIVITIES.includes(activity)) {
    return res.status(400).json({ error: `activity must be one of ${DAILY_ACTIVITIES.join('|')}` });
  }

  const user = new UsersRepo(db(req)).getOrCreateDefault();
  const repo = new TrainingProfileRepo(db(req));
  try {
    const profile = repo.setDailyActivity(user.id, day as Weekday, activity as DailyActivity);
    res.json(deriveWeeklyActivities(profile.training_days, profile.other_activity_schedule));
  } catch (err) {
    if (err instanceof NoTrainingProfileError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof Error) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});
