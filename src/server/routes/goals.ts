import { Router } from 'express';
import type Database from 'better-sqlite3';
import { GoalsRepo, TooManyActiveAestheticGoalsError, UnknownBlueprintGoalReferenceError } from '../../repositories/goalsRepo.js';
import { matchGoalCandidates } from '../../engine/goalCreation.js';

export const goalsRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

goalsRouter.get('/', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const active = req.query.active === undefined ? undefined : req.query.active === 'true';
  res.json(repo.list({ active }));
});

// Spec §2.1 step 1-4: the natural-language half of the hybrid flow.
// Read-only — never persists a goal. The client shows these candidates
// to the user, who must then explicitly confirm one via POST / below
// (with source: 'natural_language', source_text: the original text) for
// it to actually exist. An empty candidates array is expected for vague
// text; it is not an error.
goalsRouter.post('/match', (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  res.json({ candidates: matchGoalCandidates(text) });
});

goalsRouter.post('/', (req, res) => {
  const { goal_type, blueprint_ref, priority, notes, active, review_cadence_days, source, source_text } = req.body ?? {};

  if (goal_type !== 'aesthetic' && goal_type !== 'functional') {
    return res.status(400).json({ error: 'goal_type must be "aesthetic" or "functional"' });
  }
  if (typeof blueprint_ref !== 'string') {
    return res.status(400).json({ error: 'blueprint_ref is required' });
  }
  if (typeof priority !== 'number') {
    return res.status(400).json({ error: 'priority (number) is required' });
  }
  if (source !== undefined && source !== 'structured' && source !== 'natural_language') {
    return res.status(400).json({ error: 'source must be "structured" or "natural_language"' });
  }
  // Spec §2.1: a natural-language goal is never persisted without the
  // user's original statement attached — this is what makes the
  // eventual GoalsRepo row provably a confirmed, attributed activation
  // rather than a silently inferred one.
  if (source === 'natural_language' && (typeof source_text !== 'string' || !source_text.trim())) {
    return res.status(400).json({ error: 'source_text is required when source is "natural_language"' });
  }

  const repo = new GoalsRepo(db(req));
  try {
    const goal = repo.create({
      goal_type,
      blueprint_ref,
      priority,
      notes,
      active,
      review_cadence_days,
      source,
      source_text: source === 'natural_language' ? source_text : null,
    });
    res.status(201).json(goal);
  } catch (err) {
    if (err instanceof UnknownBlueprintGoalReferenceError || err instanceof TooManyActiveAestheticGoalsError) {
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
