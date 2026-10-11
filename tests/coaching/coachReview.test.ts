// Weekly coach review (2026-10-11): facts from logs, one provider call
// (faked here), strict output checks, accept/dismiss advice, and accepted
// advice + exercise preferences reaching AI session generation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { ExercisePreferencesRepo } from '../../src/repositories/exercisePreferencesRepo.js';
import { CoachRepo } from '../../src/repositories/coachRepo.js';
import { buildCoachFacts, validateCoachReview } from '../../src/coaching/review/coachReviewService.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { buildPlannedAIContext } from '../../src/ai-programmer/planning/plannedContext.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest } from '../../src/ai-programmer/contracts/providerTypes.js';

let db: Database.Database;
let userId: string;
const TODAY = '2026-11-20';
const noRequirement = () => ({ required: new Map<string, number>(), goalLabel: new Map<string, string | null>() });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T03:00:00Z`));
  process.env.AI_PROGRAMMER_ENABLED = 'true';
  db = openDb(':memory:');
  userId = new UsersRepo(db).getOrCreateDefault().id;
  new TrainingProfileRepo(db).upsert(userId, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar'],
    other_activity_schedule: [],
  });
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
  // A stalled goal lift and an improving one.
  const repo = new WorkoutSessionsRepo(db);
  for (const [i, [d, w]] of ([['2026-10-26', 30], ['2026-10-30', 30], ['2026-11-03', 29], ['2026-11-07', 30], ['2026-11-11', 29]] as const).entries()) {
    const s = repo.createSession({ date: d, session_type: 'gym', status: 'completed' });
    repo.addExercisePerformance(s.session_id, { exercise_id: 'cable-pushdown', order: 0, role: 'primary', target_sets: 3, sets: [{ set_number: 1, weight: w, reps: 10, completed: true }] });
    repo.addExercisePerformance(s.session_id, { exercise_id: 'close-grip-bench-press', order: 1, role: 'primary', target_sets: 3, sets: [{ set_number: 1, weight: 40 + 2.5 * i, reps: 8, completed: true }] });
  }
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AI_PROGRAMMER_ENABLED;
});

const answer = (facts: any, overrides: Record<string, unknown> = {}) => ({
  headline: 'Steady block; triceps pushdown has stalled.',
  wentWell: ['Close-grip bench went from 40 to 50 kg x 8.'],
  needsAttention: ['Cable pushdown has not improved in 3 sessions (30 kg x 10).'],
  focusThisWeek: ['Swap pushdowns for a fresh triceps angle.'],
  recovery: 'No deloads recently and no notes.',
  plateaus: [{ exerciseId: 'cable-pushdown', kind: 'swap', observation: 'Stuck at 30 kg x 10.', suggestion: 'Rotate to a new triceps exercise for two weeks.', swapToExerciseId: facts.swapOptions['cable-pushdown'][0].exerciseId }],
  ...overrides,
});

class FakeCoach implements AIProgrammerProvider {
  calls: AIProgrammerProviderRequest[] = [];
  constructor(private readonly make: (facts: any) => unknown) {}
  async generate(req: AIProgrammerProviderRequest) {
    this.calls.push(req);
    return { provider: 'fake', model: 'fake-model', requestId: req.requestId, rawText: JSON.stringify(this.make(req.context)), usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

describe('facts and checks', () => {
  it('facts list the stalled lift with swap options that train the same muscle', () => {
    const facts = buildCoachFacts(db, TODAY, noRequirement);
    expect(facts.strength.find((s) => s.exerciseId === 'cable-pushdown')!.status).toBe('stalled');
    expect(facts.swapOptions['cable-pushdown']!.length).toBeGreaterThan(0);
    expect(facts.swapOptions['cable-pushdown']!.map((o) => o.exerciseId)).not.toContain('cable-pushdown');
    expect(facts.goals[0]!.targets.length).toBeGreaterThan(0);
  });

  it('accepts a grounded answer, drops made-up, non-stalled and unlisted-swap advice, and rejects a malformed review', () => {
    const facts = buildCoachFacts(db, TODAY, noRequirement);
    expect(validateCoachReview(answer(facts), facts)).toMatchObject({ ok: true, dropped: [] });
    const withPlateau = (plateau: Record<string, unknown>) => validateCoachReview(answer(facts, { plateaus: [{ ...answer(facts).plateaus[0], ...plateau }] }), facts);
    // 2026-10-11: one off-rule advice item is dropped; the review is kept.
    for (const plateau of [{ exerciseId: 'made-up-curl' }, { exerciseId: 'close-grip-bench-press', kind: 'load', swapToExerciseId: null }, { swapToExerciseId: 'barbell-back-squat' }]) {
      const r = withPlateau(plateau);
      expect(r).toMatchObject({ ok: true, plateaus: [] });
      expect((r as { dropped: string[] }).dropped).toHaveLength(1);
    }
    expect(withPlateau({ kind: 'rep_range' })).toMatchObject({ ok: true, plateaus: [{ kind: 'rep_range', swapToExerciseId: null }] }); // swap target ignored on a non-swap
    expect(validateCoachReview(answer(facts, { focusThisWeek: ['a', 'b', 'c', 'd'] }), facts)).toMatchObject({ ok: false });
    expect(validateCoachReview(answer(facts, { headline: '' }), facts)).toMatchObject({ ok: false });
  });

  it('an exercise qualifies when any of its series (per equipment) is stalled or down', () => {
    const facts = buildCoachFacts(db, TODAY, noRequirement);
    const stalled = facts.strength.find((x) => x.status === 'stalled' || x.status === 'down')!;
    const twoSeries = { ...facts, strength: [{ ...stalled, status: 'flat' as const }, stalled] };
    const r = validateCoachReview(answer(facts, { plateaus: [{ ...answer(facts).plateaus[0], exerciseId: stalled.exerciseId }] }), twoSeries);
    expect(r).toMatchObject({ ok: true, dropped: [] });
  });
});

describe('routes', () => {
  it('writes one review per week, saves advice, and accepting a swap sets 14-day rules', async () => {
    const app = createApp(db);
    const coach = new FakeCoach((facts) => answer(facts));
    app.locals.coachProvider = coach;
    expect((await request(app).get('/api/coaching/review').expect(200)).body).toMatchObject({ review: null, thisWeekHasReview: false, aiEnabled: true });

    const created = (await request(app).post('/api/coaching/review').send({}).expect(201)).body.review;
    expect(coach.calls).toHaveLength(1);
    expect(coach.calls[0]!.mode).toBe('coach_review');
    expect(created.review.headline).toMatch(/stalled/);
    const [advice] = created.advice;
    expect(advice).toMatchObject({ exerciseId: 'cable-pushdown', kind: 'swap', status: 'open', exerciseName: 'Cable Pushdown' });

    await request(app).post('/api/coaching/review').send({}).expect(409);
    expect(coach.calls).toHaveLength(1);

    const decided = (await request(app).post(`/api/coaching/advice/${advice.id}`).send({ decision: 'accept' }).expect(200)).body;
    expect(decided.advice.status).toBe('accepted');
    const prefs = new ExercisePreferencesRepo(db);
    expect(prefs.get(userId, 'cable-pushdown')).toMatchObject({ preference: 'avoided', temporaryUntil: '2026-12-04' });
    expect(prefs.get(userId, advice.swapToExerciseId)).toMatchObject({ preference: 'preferred', temporaryUntil: '2026-12-04' });

    await request(app).post('/api/coaching/review').send({ regenerate: true }).expect(201);
    expect(coach.calls).toHaveLength(2);
  });

  it('an invalid answer saves nothing', async () => {
    const app = createApp(db);
    app.locals.coachProvider = new FakeCoach((facts) => answer(facts, { headline: '' }));
    const res = (await request(app).post('/api/coaching/review').send({}).expect(502)).body;
    expect(res.error).toBe('AI_COACH_REVIEW_OUTPUT_INVALID');
    expect(new CoachRepo(db).latestReview()).toBeNull();
  });

  it('is refused without AI enabled, and dismissing changes no rules', async () => {
    const app = createApp(db);
    app.locals.coachProvider = new FakeCoach((facts) => answer(facts));
    const advice = (await request(app).post('/api/coaching/review').send({}).expect(201)).body.review.advice[0];
    await request(app).post(`/api/coaching/advice/${advice.id}`).send({ decision: 'dismiss' }).expect(200);
    expect(new ExercisePreferencesRepo(db).get(userId, 'cable-pushdown')).toBeNull();
    await request(app).post(`/api/coaching/advice/${advice.id}`).send({ decision: 'maybe' }).expect(400);
    delete process.env.AI_PROGRAMMER_ENABLED;
    await request(app).post('/api/coaching/review').send({ regenerate: true }).expect(503);
  });
});

describe('off-rule advice (2026-10-11 production case)', () => {
  it('advice on a flat exercise is dropped and the review is saved', async () => {
    const app = createApp(db);
    app.locals.coachProvider = new FakeCoach((facts) => answer(facts, { plateaus: [{ exerciseId: 'close-grip-bench-press', kind: 'load', observation: 'x', suggestion: 'y', swapToExerciseId: null }] }));
    const saved = (await request(app).post('/api/coaching/review').send({}).expect(201)).body.review;
    expect(saved.advice).toEqual([]);
    expect(new CoachRepo(db).latestReview()).not.toBeNull();
  });
});

describe('AI session generation sees preferences and accepted advice', () => {
  const context = () => buildProgrammerContext(db, { targetDate: '2026-11-23', requestedSessionPurpose: 'push', exercisePoolMode: 'wide' });

  it('an avoided exercise is never prescribed; a preferred one leads its rotation', () => {
    const prefs = new ExercisePreferencesRepo(db);
    prefs.set(userId, { exerciseId: 'cable-pushdown', preference: 'avoided' });
    prefs.set(userId, { exerciseId: 'machine-triceps-extension', preference: 'preferred' });
    const triceps = context().targets.find((t) => t.targetId === 'triceps')!;
    expect(triceps.validExercises.find((v) => v.exerciseId === 'cable-pushdown')!.authoredPrescription).toBeNull();
    const machine = triceps.validExercises.find((v) => v.exerciseId === 'machine-triceps-extension')!;
    expect(machine.userPreference).toBe('preferred');
    expect(machine.authoredPrescription).not.toBeNull();
  });

  it('accepted advice is in the planned context', async () => {
    const app = createApp(db);
    app.locals.coachProvider = new FakeCoach((facts) => answer(facts));
    const advice = (await request(app).post('/api/coaching/review').send({}).expect(201)).body.review.advice[0];
    await request(app).post(`/api/coaching/advice/${advice.id}`).send({ decision: 'accept' }).expect(200);
    const c = context();
    const planned = buildPlannedAIContext(c, planSession(c, { nonGoalRotationCursor: 0 }));
    expect(planned.coachAdvice).toEqual([expect.objectContaining({ exerciseId: 'cable-pushdown', kind: 'swap' })]);
  });
});
