import { Router } from 'express';
import type Database from 'better-sqlite3';
import { InvalidOutsideBlueprintExerciseError, OutsideBlueprintExercisesRepo } from '../../repositories/outsideBlueprintExercisesRepo.js';
import type { OutsideBlueprintJustification } from '../../contracts/types.js';

export const outsideBlueprintExercisesRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

const JUSTIFICATION_CATEGORIES: OutsideBlueprintJustification[] = [
  'blueprint_inadequate',
  'contextual_constraint',
  'meaningful_advantage',
];

outsideBlueprintExercisesRouter.get('/', (req, res) => {
  const repo = new OutsideBlueprintExercisesRepo(db(req));
  res.json(repo.list());
});

// Spec §4.2: proposing an outside-Blueprint exercise never makes it
// prescribable by itself — `approved` starts false. A separate POST
// /:id/approve call is required before src/engine/exerciseUniverse.ts
// will resolve it.
outsideBlueprintExercisesRouter.post('/', (req, res) => {
  const {
    name,
    description,
    justification_category,
    justification_text,
    target_type,
    target_id,
    role,
    equipment,
    reps_range,
    rir_range,
  } = req.body ?? {};

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!JUSTIFICATION_CATEGORIES.includes(justification_category)) {
    return res.status(400).json({
      error: `justification_category must be one of: ${JUSTIFICATION_CATEGORIES.join(', ')}`,
    });
  }
  if (typeof justification_text !== 'string' || !justification_text.trim()) {
    return res.status(400).json({ error: 'justification_text is required — explain why Blueprint cannot serve this need' });
  }
  if (target_type !== 'physique_target' && target_type !== 'functional_goal') {
    return res.status(400).json({ error: 'target_type must be "physique_target" or "functional_goal"' });
  }
  if (typeof target_id !== 'string' || !target_id.trim()) {
    return res.status(400).json({ error: 'target_id is required' });
  }
  if (role !== 'primary' && role !== 'secondary') {
    return res.status(400).json({ error: 'role must be "primary" or "secondary"' });
  }
  if (!Array.isArray(equipment) || equipment.some((e) => typeof e !== 'string')) {
    return res.status(400).json({ error: 'equipment must be an array of strings' });
  }
  if (typeof reps_range !== 'string' || typeof rir_range !== 'string') {
    return res.status(400).json({ error: 'reps_range and rir_range are required (e.g. "8-12", "1-3")' });
  }

  const repo = new OutsideBlueprintExercisesRepo(db(req));
  try {
    const exercise = repo.propose({
      name,
      description,
      justification_category,
      justification_text,
      target_type,
      target_id,
      role,
      equipment,
      reps_range,
      rir_range,
    });
    res.status(201).json(exercise);
  } catch (err) {
    if (err instanceof InvalidOutsideBlueprintExerciseError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

outsideBlueprintExercisesRouter.get('/:id', (req, res) => {
  const repo = new OutsideBlueprintExercisesRepo(db(req));
  const exercise = repo.get(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'outside-Blueprint exercise not found' });
  res.json(exercise);
});

// The only way an outside-Blueprint exercise becomes prescribable — an
// explicit, separate act of user approval. Never automatic.
outsideBlueprintExercisesRouter.post('/:id/approve', (req, res) => {
  const repo = new OutsideBlueprintExercisesRepo(db(req));
  const exercise = repo.approve(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'outside-Blueprint exercise not found' });
  res.json(exercise);
});
