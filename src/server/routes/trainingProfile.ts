import { Router } from 'express';
import type Database from 'better-sqlite3';
import { UnknownBlueprintEquipmentError, TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WEEKDAYS, type Weekday } from '../../contracts/types.js';

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
