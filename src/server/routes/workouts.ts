import { Router } from 'express';
import type Database from 'better-sqlite3';
import { UnknownBlueprintExerciseError, WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import {
  BadmintonSessionDetailsRepo,
  InvalidBadmintonSessionDetailsError,
  NotABadmintonSessionError,
  UnknownWorkoutSessionError,
} from '../../repositories/badmintonSessionDetailsRepo.js';
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
  const badminton_details =
    session.session_type === 'badminton' ? new BadmintonSessionDetailsRepo(db(req)).get(session.session_id) ?? null : null;
  res.json({ ...session, exercises: repo.getExercisePerformances(session.session_id), badminton_details });
});

workoutsRouter.patch('/:id', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const updated = repo.updateSession(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: 'workout session not found' });
  res.json(updated);
});

// Spec §15: badminton-specific detail on a workout session whose
// session_type = 'badminton' — intensity, singles/doubles, games,
// quality, fatigue. record() upserts (a session's detail can be filled
// in and later corrected), so PUT is the right verb here rather than
// POST.
workoutsRouter.put('/:id/badminton-details', (req, res) => {
  const { intensity, format, games_count, session_quality, post_session_fatigue, notes } = req.body ?? {};

  const repo = new BadmintonSessionDetailsRepo(db(req));
  try {
    const details = repo.record({
      workout_session_id: req.params.id,
      intensity,
      format,
      games_count,
      session_quality,
      post_session_fatigue,
      notes,
    });
    res.json(details);
  } catch (err) {
    if (err instanceof UnknownWorkoutSessionError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof NotABadmintonSessionError || err instanceof InvalidBadmintonSessionDetailsError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

workoutsRouter.get('/:id/badminton-details', (req, res) => {
  const repo = new BadmintonSessionDetailsRepo(db(req));
  const details = repo.get(req.params.id);
  if (!details) return res.status(404).json({ error: 'no badminton session details recorded for this session' });
  res.json(details);
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
