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

blueprintRouter.get('/aesthetic-goals', (req, res) => {
  res.json(BlueprintAdapter.getAestheticGoals());
});

blueprintRouter.get('/functional-goals', (req, res) => {
  res.json(BlueprintAdapter.getFunctionalGoals());
});

blueprintRouter.get('/equipment', (req, res) => {
  res.json(BlueprintAdapter.getEquipmentList());
});
