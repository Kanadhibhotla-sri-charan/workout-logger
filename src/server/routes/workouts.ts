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
import { findActiveGymSessionConflict, logSessionConflict } from '../../engine/selectedSessionResolver.js';

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
 * been persisted at all — nothing exists yet to adapt.
 *
 * Same-Week History & Day-Specific Recovery Fix §4/§14: the real
 * current date (`today`, not `weekStart`) is threaded through to
 * `computeFreshWeek` as its own explicit `historyAsOfDate` — this is
 * exactly the canonical reconciliation path spec §14 requires: after
 * completing e.g. a Tuesday workout, this recomputes the week with real
 * history read through TODAY (which already includes that just-
 * completed Tuesday session), not through the week's Monday. */
function adaptCurrentWeekIfNeeded(database: Database.Database, sessionDate: string): void {
  const weekStart = programmingWeekStart(sessionDate);
  const today = todayForUser(database);
  if (weekStart !== programmingWeekStart(today)) return;
  const budgetMinutes = defaultBudgetMinutes(database);
  reconcileAfterActualTraining(database, weekStart, sessionDate, () => computeFreshWeek(database, weekStart, budgetMinutes, today));
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

const SESSION_SOURCE_TYPES = ['ai', 'deterministic', 'manual'] as const;

workoutsRouter.post('/', (req, res) => {
  const { date, start_time, end_time, duration_minutes, session_type, program_id, program_session_id, goal_context, status, notes, source_type } =
    req.body ?? {};
  if (typeof date !== 'string' || typeof session_type !== 'string') {
    return res.status(400).json({ error: 'date and session_type are required' });
  }
  // Final AI-Deterministic Precedence and Scheduling Fixes §1: optional
  // — omitted defaults to 'deterministic' at the repo layer (this
  // endpoint's own pre-existing, only-ever-deterministic behavior). A
  // present-but-invalid value is rejected explicitly rather than
  // silently coerced.
  if (source_type !== undefined && !SESSION_SOURCE_TYPES.includes(source_type)) {
    return res.status(400).json({ error: `source_type, if given, must be one of ${SESSION_SOURCE_TYPES.join('|')}` });
  }

  const repo = new WorkoutSessionsRepo(db(req));

  // Final Selected Session Resolution and AI/Deterministic Precedence
  // Fixes §3/§10, widened by the Actionable vs Historical fix §2/§7:
  // this is the ONE generic session-creation entry point (used directly
  // by "Start workout"/"Log something else" on today.html, with no
  // conflict checking of its own before those fixes) — the AI-commit
  // path (aiProposalLifecycle.ts) already guards against creating a
  // second active gym session for a date via its own pre-commit checks;
  // this closes the same gap here, using the SAME shared rule
  // (`findActiveGymSessionConflict`), so "no hidden replacement planned
  // Gym session" holds through every supported write path, not just the
  // AI one. A `completed` session now ALSO blocks this (Actionable vs
  // Historical fix §2 — reversing the prior phase's "completed never
  // blocks" behavior; a same-day makeup session is explicitly deferred
  // to a future, separate feature per that spec's own scope note), using
  // the distinct, spec-suggested error code so callers can tell "there's
  // a still-actionable session in the way" apart from "this date is
  // already historically closed out."
  if (session_type === 'gym') {
    const conflict = findActiveGymSessionConflict(repo.listSessionsByDate(date));
    if (conflict) {
      const isHistorical = conflict.status === 'completed' || conflict.status === 'in_progress';
      const code = isHistorical ? 'DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION' : 'ACTIVE_GYM_SESSION_EXISTS';
      logSessionConflict({ operation: 'POST /api/workouts', date, sessionType: session_type, code, conflictingSessionIds: [conflict.session_id] });
      return res.status(409).json({
        error: isHistorical
          ? `${date} already has a ${conflict.status} gym session. It cannot be replaced by a new planned workout.`
          : `${date} already has an active gym session (${conflict.status}). Complete or cancel it before starting another.`,
        code,
        conflictingSessionId: conflict.session_id,
      });
    }
  }

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
    source_type,
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
  const {
    exercise_id,
    order,
    role,
    sets,
    target_sets,
    target_reps_min,
    target_reps_max,
    target_rir_min,
    target_rir_max,
    target_rest_seconds,
    target_type,
    target_id,
  } = req.body ?? {};
  if (typeof exercise_id !== 'string' || typeof order !== 'number' || typeof role !== 'string' || !Array.isArray(sets)) {
    return res.status(400).json({ error: 'exercise_id (string), order (number), role (string), sets (array) are required' });
  }

  const database = db(req);
  const repo = new WorkoutSessionsRepo(database);
  try {
    const session = repo.getSession(req.params.id);
    // Fix: optional planned prescription — e.g. Substitute (logger.html)
    // preserves the replaced exercise's own target_* fields on the new
    // row. Omitted fields stay undefined -> stored NULL, same as before
    // this fix for every existing caller that never sends them.
    const performance = repo.addExercisePerformance(req.params.id, {
      exercise_id,
      order,
      role,
      sets,
      target_sets,
      target_reps_min,
      target_reps_max,
      target_rir_min,
      target_rir_max,
      target_rest_seconds,
      target_type,
      target_id,
    });
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

/** Fix: the counterpart to `addExercisePerformance` for an exercise row
 * that already exists — e.g. an AI-committed session
 * (src/ai-programmer/service/aiProposalLifecycle.ts), whose exercises
 * are pre-created with empty, uncompleted sets at commit time. Without
 * this route there was no way to log weight/reps against them at all.
 * `exerciseId` must belong to `:id`'s own session — never trusted from
 * the request body alone — so one session's logging can never leak into
 * another's exercise rows. */
workoutsRouter.patch('/:id/exercises/:exerciseId', (req, res) => {
  const { sets } = req.body ?? {};
  if (!Array.isArray(sets)) {
    return res.status(400).json({ error: 'sets (array) is required' });
  }

  const database = db(req);
  const repo = new WorkoutSessionsRepo(database);
  const session = repo.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: `No workout session with id "${req.params.id}"` });
  }
  const existing = repo.getExercisePerformances(req.params.id).find((p) => p.id === req.params.exerciseId);
  if (!existing) {
    return res.status(404).json({ error: `No exercise "${req.params.exerciseId}" on workout session "${req.params.id}"` });
  }

  const performance = repo.updateExercisePerformanceSets(req.params.exerciseId, sets);
  if (session.status === 'completed') adaptCurrentWeekIfNeeded(database, session.date);
  res.json(performance);
});

/** Fix: "Skip" for an already-persisted, not-yet-logged exercise (e.g.
 * an AI-committed session's pre-created row) — the deterministic
 * flow's own "Skip" is purely client-side because a generated-preview
 * item was never persisted in the first place (see logger.html's own
 * comment on `skippedExerciseIds`); an already-existing row needs a
 * real delete so it doesn't reappear on the next reload. Same
 * ownership check as the PATCH route above. */
workoutsRouter.delete('/:id/exercises/:exerciseId', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const session = repo.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: `No workout session with id "${req.params.id}"` });
  }
  const existing = repo.getExercisePerformances(req.params.id).find((p) => p.id === req.params.exerciseId);
  if (!existing) {
    return res.status(404).json({ error: `No exercise "${req.params.exerciseId}" on workout session "${req.params.id}"` });
  }

  repo.deleteExercisePerformance(req.params.exerciseId);
  res.status(204).end();
});

/** "Duplicate AI programs" fix (2026-09-23): lets the user remove an
 * unwanted real session outright — e.g. one of two AI-generated programs
 * that ended up on the same day, or one they simply want to redo. Only
 * ever a `planned` session may be deleted here — `in_progress`/
 * `completed` real training history is never deletable through this
 * route (or any other), matching every other lock rule in this codebase
 * (schedule swap/move, activity change). The session's own exercises/
 * sets cascade via the schema's own FK; any proposal/reconciliation that
 * committed this session has its own committed_session_id nulled by its
 * FK, never left pointing at a dangling id. */
workoutsRouter.delete('/:id', (req, res) => {
  const repo = new WorkoutSessionsRepo(db(req));
  const session = repo.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: `No workout session with id "${req.params.id}"` });
  }
  if (session.status !== 'planned') {
    return res.status(409).json({
      error: `Cannot delete a session that is "${session.status}" — only a planned (not yet started) session can be deleted.`,
      code: 'WORKOUT_SESSION_NOT_DELETABLE',
    });
  }
  repo.deleteSession(req.params.id);
  res.status(204).end();
});
