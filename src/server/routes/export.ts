import { Router } from 'express';
import type Database from 'better-sqlite3';
import { getCompletedWorkouts, getWorkoutSessions } from '../../services/calorieTrackerExport.js';
import { todayForUser } from '../../lib/userTimezone.js';

export const exportRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

// Calorie Tracker's read contract: getCompletedWorkouts(date). Only
// status = 'completed' sessions — see docs/CALORIE_TRACKER_INTEGRATION.md.
// `date` defaults to "today" in the user's configured timezone, never the
// server process's own timezone — see docs/architecture.md's timezone
// contract.
exportRouter.get('/completed-workouts', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : todayForUser(db(req));
  res.json(getCompletedWorkouts(db(req), date));
});

// Broader history view (any status) — not the Calorie Tracker contract.
exportRouter.get('/workout-sessions', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : todayForUser(db(req));
  res.json(getWorkoutSessions(db(req), date));
});
