// Coaching API (2026-10-11): the weekly coach review and its advice.
//   GET  /api/coaching/review            latest review (or null) + whether one can be generated
//   POST /api/coaching/review            generate this week's review: ONE paid AI call
//                                        (409 if this week already has one, unless {regenerate: true})
//   POST /api/coaching/advice/:id        {decision: 'accept' | 'dismiss'}
// Accepted advice reaches session generation (context.coachAdvice); an
// accepted swap also sets a 14-day avoid on the old exercise and a 14-day
// preference for the new one, unless the user already has a rule for it.

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { addDays } from '../../engine/dateMath.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { isAiProgrammerEnabled, loadVelonaConfig } from '../../ai-programmer/provider/config.js';
import { VelonaProvider } from '../../ai-programmer/provider/velonaProvider.js';
import type { AIProgrammerProvider } from '../../ai-programmer/contracts/providerTypes.js';
import { AIProgrammerDisabledError, AIProgrammerError } from '../../ai-programmer/errors.js';
import { generateCoachReview } from '../../coaching/review/coachReviewService.js';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { CoachRepo } from '../../repositories/coachRepo.js';
import { ExercisePreferencesRepo } from '../../repositories/exercisePreferencesRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { weekRequirement } from './insights.js';

export const coachingRouter = Router();

/** How long an accepted swap's avoid / prefer rules last. */
export const SWAP_RULE_DAYS = 14;

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db as Database.Database;
}

/** The provider: `app.locals.coachProvider` when set (tests), else Velona. */
function provider(req: import('express').Request): AIProgrammerProvider {
  return (req.app.locals.coachProvider as AIProgrammerProvider | undefined) ?? new VelonaProvider(loadVelonaConfig());
}

const withNames = <T extends { exerciseId: string; swapToExerciseId: string | null }>(a: T) => ({
  ...a,
  exerciseName: BlueprintAdapter.getExercise(a.exerciseId)?.name ?? a.exerciseId,
  swapToExerciseName: a.swapToExerciseId ? (BlueprintAdapter.getExercise(a.swapToExerciseId)?.name ?? a.swapToExerciseId) : null,
});

coachingRouter.get('/review', (req, res) => {
  const database = db(req);
  const latest = new CoachRepo(database).latestReview();
  const weekStart = programmingWeekStart(todayForUser(database));
  res.json({
    review: latest ? { ...latest, advice: latest.advice.map(withNames) } : null,
    thisWeekHasReview: new CoachRepo(database).hasReviewForWeek(weekStart),
    aiEnabled: isAiProgrammerEnabled(),
  });
});

coachingRouter.post('/review', async (req, res, next) => {
  const database = db(req);
  try {
    if (!isAiProgrammerEnabled()) throw new AIProgrammerDisabledError();
    const today = todayForUser(database);
    const weekStart = programmingWeekStart(today);
    if (new CoachRepo(database).hasReviewForWeek(weekStart) && req.body?.regenerate !== true) {
      throw new AIProgrammerError('AI_COACH_REVIEW_EXISTS', 'This week already has a coach review. Send {"regenerate": true} to write a new one (one more paid call).', 409);
    }
    const review = await generateCoachReview(database, provider(req), today, (ws) => weekRequirement(database, ws, weekStart));
    res.status(201).json({ review: { ...review, advice: review.advice.map(withNames) } });
  } catch (err) {
    if (err instanceof AIProgrammerError) return res.status(err.statusCode).json({ error: err.code, message: err.publicMessage, details: err.details });
    next(err);
  }
});

coachingRouter.post('/advice/:id', (req, res) => {
  const database = db(req);
  const repo = new CoachRepo(database);
  const advice = repo.getAdvice(req.params.id);
  if (!advice) return res.status(404).json({ error: 'No such advice.' });
  const decision = req.body?.decision;
  if (decision !== 'accept' && decision !== 'dismiss') return res.status(400).json({ error: 'decision must be "accept" or "dismiss"' });
  const today = todayForUser(database);
  repo.decide(advice.id, decision === 'accept' ? 'accepted' : 'dismissed', today);
  const rulesSet: string[] = [];
  if (decision === 'accept' && advice.kind === 'swap' && advice.swapToExerciseId) {
    const userId = new UsersRepo(database).getOrCreateDefault().id;
    const prefs = new ExercisePreferencesRepo(database);
    const until = addDays(today, SWAP_RULE_DAYS);
    const reason = 'Accepted coach advice (plateau swap)';
    if (!prefs.get(userId, advice.exerciseId)) {
      prefs.set(userId, { exerciseId: advice.exerciseId, preference: 'avoided', temporaryUntil: until, reason });
      rulesSet.push(`avoid ${advice.exerciseId} until ${until}`);
    }
    if (!prefs.get(userId, advice.swapToExerciseId)) {
      prefs.set(userId, { exerciseId: advice.swapToExerciseId, preference: 'preferred', temporaryUntil: until, reason });
      rulesSet.push(`prefer ${advice.swapToExerciseId} until ${until}`);
    }
  }
  res.json({ advice: withNames(repo.getAdvice(advice.id)!), rulesSet });
});
