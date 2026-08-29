import { Router } from 'express';
import type Database from 'better-sqlite3';
import { GoalsRepo, UnknownBlueprintGoalReferenceError } from '../../repositories/goalsRepo.js';

export const goalsRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

goalsRouter.get('/', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const active = req.query.active === undefined ? undefined : req.query.active === 'true';
  res.json(repo.list({ active }));
});

goalsRouter.post('/', (req, res) => {
  const { goal_type, blueprint_ref, priority, notes, active } = req.body ?? {};

  if (goal_type !== 'aesthetic' && goal_type !== 'functional') {
    return res.status(400).json({ error: 'goal_type must be "aesthetic" or "functional"' });
  }
  if (typeof blueprint_ref !== 'string') {
    return res.status(400).json({ error: 'blueprint_ref is required' });
  }
  if (typeof priority !== 'number') {
    return res.status(400).json({ error: 'priority (number) is required' });
  }

  const repo = new GoalsRepo(db(req));
  try {
    const goal = repo.create({ goal_type, blueprint_ref, priority, notes, active });
    res.status(201).json(goal);
  } catch (err) {
    if (err instanceof UnknownBlueprintGoalReferenceError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

goalsRouter.get('/:id', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(goal);
});

// Resolves a local goal's blueprint_ref through BlueprintAdapter — proves
// goal.id and goal.blueprint_ref are two distinct identifiers, resolved in
// one direction only (id -> blueprint_ref -> Blueprint knowledge).
goalsRouter.get('/:id/blueprint', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  try {
    res.json(repo.resolveBlueprint(req.params.id));
  } catch (err) {
    if (err instanceof UnknownBlueprintGoalReferenceError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});
