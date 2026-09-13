import { Router } from 'express';
import { BlueprintAdapter } from '../../blueprint/adapter.js';

export const blueprintRouter = Router();

blueprintRouter.get('/exercises', (req, res) => {
  const exercises = BlueprintAdapter.getExercises().map((e) => ({
    id: e.id,
    name: e.name,
    body_regions: e.body_regions,
    equipment: e.equipment,
    exercise_type: e.exercise_type,
  }));
  res.json(exercises);
});

blueprintRouter.get('/exercises/:id', (req, res) => {
  const exercise = BlueprintAdapter.getExercise(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'unknown exercise id' });
  res.json(exercise);
});

// AI Programmer Proposal Review UI: the client needs to resolve a
// physique_target id (e.g. an AI proposal's targetId) to its real
// Blueprint display name — the same lookup src/server/routes/
// programming.ts's resolveTargetName already does server-side via
// BlueprintAdapter.getTarget, just exposed as a read-only list here
// (mirroring /exercises exactly) rather than adding a second,
// competing name-resolution mechanism or guessing from the raw id.
blueprintRouter.get('/targets', (req, res) => {
  const targets = BlueprintAdapter.getTargets().map((t) => ({
    id: t.id,
    name: t.name,
    parent_region: t.parent_region,
  }));
  res.json(targets);
});

blueprintRouter.get('/aesthetic-goals', (req, res) => {
  res.json(BlueprintAdapter.getAestheticGoals());
});

blueprintRouter.get('/functional-goals', (req, res) => {
  res.json(BlueprintAdapter.getFunctionalGoals());
});

blueprintRouter.get('/equipment', (req, res) => {
  res.json(BlueprintAdapter.getEquipmentList());
});
