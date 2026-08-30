import { Router } from 'express';
import type Database from 'better-sqlite3';
import { UnknownBlueprintExerciseError, WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { todayForUser } from '../../lib/userTimezone.js';

export const workoutsRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

workoutsRouter.get('/', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  res.json(date ? repo.listSessionsByDate(date) : repo.listSessions());
});

// "Today" per the user's configured TrainingProfile.timezone — never the
// server process's own timezone. See docs/architecture.md's timezone
// contract and src/lib/timezone.ts.
workoutsRouter.get('/today', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  res.json(repo.listSessionsByDate(todayForUser(db(req))));
});

workoutsRouter.post('/', (req, res) => {
  const { date, start_time, end_time, duration_minutes, session_type, program_id, program_session_id, goal_context, status, notes } =
    req.body ?? {};
  if (typeof date !== 'string' || typeof session_type !== 'string') {
    return res.status(400).json({ error: 'date and session_type are required' });
  }

  const repo = new WorkoutSessionsRepo(db(req));
  const session = repo.createSession({
    date,
    start_time,
    end_time,
    duration_minutes,
    session_type,
    program_id,
    program_session_id,
    goal_context,
    status,
    notes,
  });
  res.status(201).json(session);
});

workoutsRouter.get('/:id', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const session = repo.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'workout session not found' });
  res.json({ ...session, exercises: repo.getExercisePerformances(session.session_id) });
});

workoutsRouter.patch('/:id', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const updated = repo.updateSession(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: 'workout session not found' });
  res.json(updated);
});

workoutsRouter.post('/:id/exercises', (req, res) => {
  const { exercise_id, order, role, sets } = req.body ?? {};
  if (typeof exercise_id !== 'string' || typeof order !== 'number' || typeof role !== 'string' || !Array.isArray(sets)) {
    return res.status(400).json({ error: 'exercise_id (string), order (number), role (string), sets (array) are required' });
  }

  const repo = new WorkoutSessionsRepo(db(req));
  try {
    const performance = repo.addExercisePerformance(req.params.id, { exercise_id, order, role, sets });
    res.status(201).json(performance);
  } catch (err) {
    if (err instanceof UnknownBlueprintExerciseError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});
