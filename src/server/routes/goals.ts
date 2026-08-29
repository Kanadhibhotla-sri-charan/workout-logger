import { Router } from 'express';
import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { GoalsRepo } from '../../repositories/goalsRepo.js';

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
  const resolved =
    goal_type === 'aesthetic' ? BlueprintAdapter.getAestheticGoal(blueprint_ref) : BlueprintAdapter.getFunctionalGoal(blueprint_ref);
  if (!resolved) {
    return res.status(400).json({ error: `blueprint_ref "${blueprint_ref}" is not a known Blueprint ${goal_type} goal id` });
  }
  if (typeof priority !== 'number') {
    return res.status(400).json({ error: 'priority (number) is required' });
  }

  const repo = new GoalsRepo(db(req));
  const goal = repo.create({ goal_type, blueprint_ref, priority, notes, active });
  res.status(201).json(goal);
});

goalsRouter.get('/:id', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(goal);
});
