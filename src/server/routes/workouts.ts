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
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { reconcileAfterActualTraining } from '../../engine/weekProgramReconciliation.js';
import { computeFreshWeek, defaultBudgetMinutes } from './programming.js';

export const workoutsRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

/** Programming Redesign (Step 12) §7/§8: real completed training is
 * what actually triggers the remaining-week adaptation pass — never a
 * separate "recalculate" button. Scoped to the CURRENT week only (this
 * app's own "current week" framing throughout the spec): a session
 * logged/corrected for a past or future week never touches a program
 * this request has no reason to regenerate or adapt. A pure no-op (via
 * reconcileAfterActualTraining's own guard) when that week has never
 * been persisted at all — nothing exists yet to adapt. */
function adaptCurrentWeekIfNeeded(database: Database.Database, sessionDate: string): void {
  const weekStart = programmingWeekStart(sessionDate);
  if (weekStart !== programmingWeekStart(todayForUser(database))) return;
  const budgetMinutes = defaultBudgetMinutes(database);
  reconcileAfterActualTraining(database, weekStart, sessionDate, () => computeFreshWeek(database, weekStart, budgetMinutes));
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

// UI Build Phase §35: History page's exercise filter — real performances
// of one exact exercise, across every real session, most-recent-first.
// Registered before the generic '/:id' route below so 'exercises' is
// never swallowed as a session id.
workoutsRouter.get('/exercises/:exerciseId/history', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const performances = repo.listPerformancesForExercise(req.params.exerciseId);
  res.json({
    exercise_id: req.params.exerciseId,
    exercise_name: BlueprintAdapter.getExercise(req.params.exerciseId)?.name ?? req.params.exerciseId,
    performances,
  });
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
  const database = db(req);
  const repo = new WorkoutSessionsRepo(database);
  const wasCompletedBefore = repo.getSession(req.params.id)?.status === 'completed';
  const updated = repo.updateSession(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: 'workout session not found' });
  // Programming Redesign (Step 12) §7/§8: the session becoming
  // completed IS the real "actual training" event the remaining-week
  // adaptation pass reacts to — never re-triggered on every other
  // unrelated PATCH (e.g. a plain note edit) to an already-completed
  // session, only the transition itself.
  if (updated.status === 'completed' && !wasCompletedBefore) adaptCurrentWeekIfNeeded(database, updated.date);
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

  const database = db(req);
  const repo = new WorkoutSessionsRepo(database);
  try {
    const session = repo.getSession(req.params.id);
    const performance = repo.addExercisePerformance(req.params.id, { exercise_id, order, role, sets });
    // Programming Redesign (Step 12) §7/§8/rule #14: a correction to an
    // ALREADY-completed session's own actual logged work still counts
    // as real actual training and still needs the remaining week to
    // reflect it — this never rewrites the completed session itself
    // (isDayLocked in weekProgramReconciliation.ts keeps that day's own
    // persisted prescription untouched regardless), only whatever
    // UNLOCKED remaining days genuinely need to adapt. A session still
    // in_progress (not yet completed) is deliberately NOT re-triggered
    // here on every single set logged — its real total isn't final yet.
    if (session?.status === 'completed') adaptCurrentWeekIfNeeded(database, session.date);
    res.status(201).json(performance);
  } catch (err) {
    if (err instanceof UnknownBlueprintExerciseError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});
