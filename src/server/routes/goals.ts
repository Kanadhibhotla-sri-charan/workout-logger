import { Router } from 'express';
import type Database from 'better-sqlite3';
import { GoalsRepo, TooManyActiveAestheticGoalsError, UnknownBlueprintGoalReferenceError } from '../../repositories/goalsRepo.js';
import { GoalEventsRepo } from '../../repositories/goalEventsRepo.js';
import { matchGoalCandidates } from '../../engine/goalCreation.js';
import { AestheticAssessmentsRepo, InvalidAssessmentRatingError } from '../../repositories/aestheticAssessmentsRepo.js';
import { MeasurementsRepo } from '../../repositories/measurementsRepo.js';
import { GoalPhaseRepo } from '../../repositories/goalPhaseRepo.js';
import { GoalPhaseReviewsRepo, type ReviewRecommendation } from '../../repositories/goalPhaseReviewsRepo.js';
import {
  runGoalPhaseReview,
  applyReviewDecision,
  GoalPhaseNotFoundError,
  GoalPhaseAlreadyCompletedError,
  GoalPhaseReviewNotFoundError,
  ReviewAlreadyDecidedError,
} from '../../engine/goalPhaseEngine.js';
import { todayForUser } from '../../lib/userTimezone.js';

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

// A measurement need not belong to any one goal (spec: "do not assume
// every measurement applies to every goal") — this top-level route
// covers that case; /:id/measurements below covers the goal-scoped one.
// Registered here, BEFORE the generic GET /:id below, so a literal
// "/measurements" path is never swallowed as though "measurements"
// were a goal id.
goalsRouter.post('/measurements', (req, res) => {
  const { goal_id, date, metric_name, value, unit, notes } = req.body ?? {};
  if (typeof date !== 'string' || typeof metric_name !== 'string' || typeof value !== 'number' || typeof unit !== 'string') {
    return res.status(400).json({ error: 'date (string), metric_name (string), value (number), and unit (string) are required' });
  }
  if (goal_id !== undefined && goal_id !== null) {
    const goal = new GoalsRepo(db(req)).get(goal_id);
    if (!goal) return res.status(404).json({ error: 'goal not found' });
  }
  const measurement = new MeasurementsRepo(db(req)).record({ goal_id: goal_id ?? null, date, metric_name, value, unit, notes });
  res.status(201).json(measurement);
});

goalsRouter.get('/measurements', (req, res) => {
  res.json(new MeasurementsRepo(db(req)).list());
});

goalsRouter.get('/:id', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(goal);
});

// UI Build Phase §20: the only mutation the Goal priority UI is allowed
// to make — a user-driven rank change, straight through the existing
// GoalsRepo.setPriority (never inferred/auto-adjusted here).
goalsRouter.patch('/:id/priority', (req, res) => {
  const { priority } = req.body ?? {};
  if (typeof priority !== 'number') {
    return res.status(400).json({ error: 'priority (number) is required' });
  }
  const repo = new GoalsRepo(db(req));
  const goal = repo.setPriority(req.params.id, priority);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(goal);
});

// UI Build Phase §19: "[ Deactivate ]" — frees a slot under the
// active-aesthetic-goal cap; the goal row and its full history remain
// (GoalsRepo.deactivate never deletes).
goalsRouter.post('/:id/deactivate', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.deactivate(req.params.id, req.body?.notes ?? null);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(goal);
});

goalsRouter.post('/:id/reactivate', (req, res) => {
  const repo = new GoalsRepo(db(req));
  try {
    const goal = repo.reactivate(req.params.id);
    if (!goal) return res.status(404).json({ error: 'goal not found' });
    res.json(goal);
  } catch (err) {
    if (err instanceof TooManyActiveAestheticGoalsError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// UI Build Phase §21: real goal history (created/activated/deactivated/
// priority_changed/...), chronological — never fabricated in the
// frontend if this route is missing.
goalsRouter.get('/:id/events', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(new GoalEventsRepo(db(req)).listForGoal(req.params.id));
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

// Programming Redesign (Step 12) §14: aesthetic assessments already had
// real storage (AestheticAssessmentsRepo) but no route — exposing the
// existing repo rather than creating a duplicate storage mechanism.
goalsRouter.post('/:id/assessments', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });

  const { date, rating, notes } = req.body ?? {};
  if (typeof date !== 'string' || typeof rating !== 'number') {
    return res.status(400).json({ error: 'date (string) and rating (number) are required' });
  }
  try {
    const assessment = new AestheticAssessmentsRepo(db(req)).record({ goal_id: req.params.id, date, rating, notes });
    res.status(201).json(assessment);
  } catch (err) {
    if (err instanceof InvalidAssessmentRatingError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

goalsRouter.get('/:id/assessments', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(new AestheticAssessmentsRepo(db(req)).listForGoal(req.params.id));
});

// Programming Redesign (Step 12) §14: same story for body measurements
// (MeasurementsRepo) — real storage, no route until now.
goalsRouter.post('/:id/measurements', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });

  const { date, metric_name, value, unit, notes } = req.body ?? {};
  if (typeof date !== 'string' || typeof metric_name !== 'string' || typeof value !== 'number' || typeof unit !== 'string') {
    return res.status(400).json({ error: 'date (string), metric_name (string), value (number), and unit (string) are required' });
  }
  const measurement = new MeasurementsRepo(db(req)).record({ goal_id: req.params.id, date, metric_name, value, unit, notes });
  res.status(201).json(measurement);
});

goalsRouter.get('/:id/measurements', (req, res) => {
  const repo = new GoalsRepo(db(req));
  const goal = repo.get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(new MeasurementsRepo(db(req)).listForGoal(req.params.id));
});

// Programming Redesign (Step 12) §14: goal-phase persistence/lifecycle
// routes — src/repositories/goalPhaseRepo.ts and
// src/engine/goalPhaseEngine.ts already do the real work; these routes
// only expose them, per spec's "expose existing functionality rather
// than creating duplicate storage."
goalsRouter.post('/:id/phases', (req, res) => {
  const database = db(req);
  const goal = new GoalsRepo(database).get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });

  const { start_date, review_date, package_level, priority_snapshot, emphasis } = req.body ?? {};
  if (typeof start_date !== 'string' || typeof review_date !== 'string') {
    return res.status(400).json({ error: 'start_date (string) and review_date (string) are required' });
  }
  if (package_level !== undefined && package_level !== null && package_level !== 'complete' && package_level !== 'efficient') {
    return res.status(400).json({ error: 'package_level must be "complete" or "efficient"' });
  }

  const phaseRepo = new GoalPhaseRepo(database);
  // Spec §11: a goal has at most one non-completed phase at a time —
  // start a new one cleanly only once the prior one has actually ended.
  const existingActive = phaseRepo.getActiveForGoal(req.params.id);
  if (existingActive) {
    return res.status(400).json({ error: `Goal already has an active phase (${existingActive.id}) — complete it via a review decision before starting another` });
  }

  const phase = phaseRepo.create({ goal_id: req.params.id, start_date, review_date, package_level, priority_snapshot, emphasis });
  res.status(201).json(phase);
});

goalsRouter.get('/:id/phases', (req, res) => {
  const goal = new GoalsRepo(db(req)).get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  res.json(new GoalPhaseRepo(db(req)).listForGoal(req.params.id));
});

goalsRouter.get('/:id/phases/active', (req, res) => {
  const goal = new GoalsRepo(db(req)).get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  const active = new GoalPhaseRepo(db(req)).getActiveForGoal(req.params.id);
  if (!active) return res.status(404).json({ error: 'no active phase for this goal' });
  res.json(active);
});

// Runs a real review for this phase against current real evidence and
// persists the system's recommendation — spec §12: this alone never
// changes anything about the phase's own programming; see the decision
// route below for that.
goalsRouter.post('/:id/phases/:phaseId/reviews', (req, res) => {
  const database = db(req);
  const goal = new GoalsRepo(database).get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  const phase = new GoalPhaseRepo(database).get(req.params.phaseId);
  if (!phase || phase.goal_id !== req.params.id) return res.status(404).json({ error: 'goal phase not found' });

  const asOfDate = typeof req.body?.as_of_date === 'string' ? req.body.as_of_date : todayForUser(database);
  try {
    const review = runGoalPhaseReview(database, req.params.phaseId, asOfDate);
    res.status(201).json(review);
  } catch (err) {
    if (err instanceof GoalPhaseAlreadyCompletedError) return res.status(400).json({ error: err.message });
    if (err instanceof GoalPhaseNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
});

goalsRouter.get('/:id/phases/:phaseId/reviews', (req, res) => {
  const goal = new GoalsRepo(db(req)).get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  const phase = new GoalPhaseRepo(db(req)).get(req.params.phaseId);
  if (!phase || phase.goal_id !== req.params.id) return res.status(404).json({ error: 'goal phase not found' });
  res.json(new GoalPhaseReviewsRepo(db(req)).listForPhase(req.params.phaseId));
});

// Spec §12: "the engine recommends, the user decides" — this is the
// ONLY route that actually applies a lifecycle transition (continue/
// adjust/graduate); running a review above never does.
goalsRouter.put('/:id/phases/:phaseId/reviews/:reviewId/decision', (req, res) => {
  const database = db(req);
  const goal = new GoalsRepo(database).get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'goal not found' });
  const phase = new GoalPhaseRepo(database).get(req.params.phaseId);
  if (!phase || phase.goal_id !== req.params.id) return res.status(404).json({ error: 'goal phase not found' });
  const review = new GoalPhaseReviewsRepo(database).get(req.params.reviewId);
  if (!review || review.goal_phase_id !== req.params.phaseId) return res.status(404).json({ error: 'goal phase review not found' });

  const { decision } = req.body ?? {};
  const validDecisions: ReviewRecommendation[] = ['continue', 'adjust', 'graduate'];
  if (!validDecisions.includes(decision)) {
    return res.status(400).json({ error: 'decision must be one of continue|adjust|graduate' });
  }

  const asOfDate = typeof req.body?.as_of_date === 'string' ? req.body.as_of_date : todayForUser(database);
  try {
    const result = applyReviewDecision(database, req.params.reviewId, decision, asOfDate);
    res.json(result);
  } catch (err) {
    if (err instanceof ReviewAlreadyDecidedError) return res.status(400).json({ error: err.message });
    if (err instanceof GoalPhaseReviewNotFoundError || err instanceof GoalPhaseNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
});
