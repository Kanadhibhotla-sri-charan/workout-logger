import { Router } from 'express';
import type Database from 'better-sqlite3';
import { getCompletedWorkouts, getWorkoutSessions } from '../../services/calorieTrackerExport.js';

export const exportRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

// Calorie Tracker's read contract: getCompletedWorkouts(date). Only
// status = 'completed' sessions — see docs/CALORIE_TRACKER_INTEGRATION.md.
exportRouter.get('/completed-workouts', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  res.json(getCompletedWorkouts(db(req), date));
});

// Broader history view (any status) — not the Calorie Tracker contract.
exportRouter.get('/workout-sessions', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  res.json(getWorkoutSessions(db(req), date));
});
