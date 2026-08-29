import { Router } from 'express';
import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { ProgramsRepo } from '../../repositories/programsRepo.js';

export const programsRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

programsRouter.get('/', (req, res) => {
  const repo = new ProgramsRepo(db(req));
  res.json(repo.listPrograms());
});

programsRouter.post('/', (req, res) => {
  const { name, goal_ids, status, start_date, end_date, notes } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!Array.isArray(goal_ids)) {
    return res.status(400).json({ error: 'goal_ids must be an array of goal ids' });
  }

  const repo = new ProgramsRepo(db(req));
  const program = repo.createProgram({ name, goal_ids, status, start_date, end_date, notes });
  res.status(201).json(program);
});

programsRouter.get('/:id', (req, res) => {
  const repo = new ProgramsRepo(db(req));
  const program = repo.getProgram(req.params.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  res.json(program);
});

programsRouter.get('/:id/sessions', (req, res) => {
  const repo = new ProgramsRepo(db(req));
  res.json(repo.listProgramSessions(req.params.id));
});

programsRouter.post('/:id/sessions', (req, res) => {
  const { day_index, name, planned_session_type, exercises, notes } = req.body ?? {};
  if (typeof day_index !== 'number' || typeof name !== 'string' || typeof planned_session_type !== 'string') {
    return res.status(400).json({ error: 'day_index (number), name (string), planned_session_type (string) are required' });
  }
  if (!Array.isArray(exercises)) {
    return res.status(400).json({ error: 'exercises must be an array' });
  }
  for (const ex of exercises) {
    if (!BlueprintAdapter.isKnownExercise(ex.exercise_id)) {
      return res.status(400).json({ error: `exercise_id "${ex.exercise_id}" is not a known Blueprint exercise id` });
    }
  }

  const repo = new ProgramsRepo(db(req));
  const session = repo.createProgramSession({
    program_id: req.params.id,
    day_index,
    name,
    planned_session_type,
    exercises,
    notes,
  });
  res.status(201).json(session);
});
