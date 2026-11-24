// Opus coach (2026-11-22): the routine-side API and the two hard limits.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { InjuryPausesRepo } from '../../src/repositories/injuryPausesRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { AIProposalRepo } from '../../src/repositories/aiProposalRepo.js';
import { LegTrainingRepo } from '../../src/repositories/legTrainingRepo.js';

const TOKEN = 'test-coach-token-0123456789abcdef0123456789';
const DATE = '2026-11-23'; // Monday
const auth = { authorization: `Bearer ${TOKEN}` };

let db: Database.Database;
let app: ReturnType<typeof createApp>;

function body(overrides: Record<string, unknown> = {}) {
  return {
    targetDate: DATE,
    purpose: 'push',
    coachNote: ['Push day; side delts first while fresh.'],
    exercises: [
      { exerciseId: 'cable-lateral-raise', sets: 4, repsMin: 10, repsMax: 15, rirMin: 0, rirMax: 1, targetLoadKg: 7.5, cue: 'Lead with the elbow' },
      { exerciseId: 'flat-barbell-bench-press', sets: 3, repsMin: 6, repsMax: 10, rirMin: 1, rirMax: 2 },
    ],
    weeklyTable: [{ targetId: 'side-delt', weeklyTarget: 16, loggedSoFar: 0, plannedToday: 4, plannedRestOfWeek: 12 }],
    decisions: [{ subject: 'side delt', decision: 'cable lateral raise first', reason: 'stalled when trained last', successCheck: 'load up by 2.5 kg', checkOn: '2026-12-07' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T02:30:00Z'));
  process.env.COACH_API_TOKEN = TOKEN;
  process.env.AI_PROGRAMMER_ENABLED = 'true';
  db = openDb(':memory:');
  app = createApp(db);
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 40,
    maximum_session_duration_minutes: 90,
    available_equipment: ['cable', 'barbell', 'bench'],
    other_activity_schedule: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COACH_API_TOKEN;
  delete process.env.AI_PROGRAMMER_ENABLED;
});

describe('coach token', () => {
  it('refuses without the token, and is off when no token is configured', async () => {
    await request(app).get(`/api/coach/context?date=${DATE}`).expect(401);
    await request(app).get(`/api/coach/context?date=${DATE}`).set({ authorization: 'Bearer wrong' }).expect(401);
    delete process.env.COACH_API_TOKEN;
    await request(app).get(`/api/coach/context?date=${DATE}`).set(auth).expect(503);
  });
});

describe('GET /api/coach/context', () => {
  it('returns raw data with the day request and the library', async () => {
    await request(app).put('/api/coach/day-request').send({ date: DATE, mode: 'add_ons' }).expect(200);
    const res = await request(app).get(`/api/coach/context?date=${DATE}`).set(auth).expect(200);
    const c = res.body.context;
    expect(c.targetDate).toBe(DATE);
    expect(c.dayRequest).toBe('add_ons');
    expect(c.library.length).toBeGreaterThan(100);
    expect(c.thisWeek.gymDays.map((d: any) => d.weekday)).toEqual(['monday', 'tuesday', 'thursday', 'friday']);
  });
});

describe('POST /api/coach/proposals', () => {
  it('saves a pending coach proposal with note, table and decisions; no coaching checks', async () => {
    // 12 sets of one exercise and no other muscle: no cap, count or share rule applies.
    const res = await request(app)
      .post('/api/coach/proposals')
      .set(auth)
      .send(body({ exercises: [{ exerciseId: 'cable-lateral-raise', sets: 12, repsMin: 10, repsMax: 30, rirMin: 0, rirMax: 0 }] }))
      .expect(201);
    const day = await request(app).get(`/api/coach/day?date=${DATE}`).expect(200);
    expect(day.body.proposal.proposalId).toBe(res.body.proposalId);
    expect(day.body.proposal.status).toBe('pending');
    expect(day.body.proposal.proposal.coach.coachNote).toEqual(['Push day; side delts first while fresh.']);
    expect(day.body.proposal.proposal.exercises[0].targetId).toBe('side-delt');
    expect(day.body.run.outcome).toBe('saved');
    const decisions = await request(app).get('/api/coach/decisions').expect(200);
    expect(decisions.body.decisions[0].subject).toBe('side delt');
  });

  it('refuses an exercise outside the library, naming it', async () => {
    const res = await request(app)
      .post('/api/coach/proposals')
      .set(auth)
      .send(body({ exercises: [{ exerciseId: 'made-up-raise', sets: 3, repsMin: 8, repsMax: 12 }] }))
      .expect(422);
    expect(res.body.problems).toEqual([{ index: 0, exerciseId: 'made-up-raise', problem: 'not in the exercise library' }]);
  });

  it('refuses work on an injury-paused area', async () => {
    new InjuryPausesRepo(db).pause('legs', '2026-11-20', 'knee');
    const res = await request(app)
      .post('/api/coach/proposals')
      .set(auth)
      .send(body({ purpose: 'athletic', exercises: [{ exerciseId: 'back-squat', sets: 3, repsMin: 5, repsMax: 8 }] }))
      .expect(422);
    expect(res.body.problems[0].problem).toContain('injury-paused');
  });

  it('a new run replaces the previous pending coach proposal for the date', async () => {
    const first = await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    const second = await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    const old = new AIProposalRepo(db).getById(first.body.proposalId)!;
    expect(old.status).toBe('rejected');
    expect(old.rejectionReason).toBe('Replaced by a newer coach run');
    const day = await request(app).get(`/api/coach/day?date=${DATE}`).expect(200);
    expect(day.body.proposal.proposalId).toBe(second.body.proposalId);
  });

  it('does not block the Qwen path: its latest-proposal lookup ignores coach proposals', async () => {
    await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    const latest = await request(app).get(`/api/ai-programmer/proposals/latest?targetDate=${DATE}`).expect(200);
    expect(latest.body.found).toBe(false);
  });
});

describe('approve and commit a coach proposal', () => {
  it('commits to a planned session with the coach exercises', async () => {
    const saved = await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/approve`).expect(200);
    const committed = await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/commit`).send({ intent: 'fill_existing_gym_day' }).expect(200);
    const session = new WorkoutSessionsRepo(db).getSession(committed.body.committedSessionId)!;
    expect(session.notes).toContain('Coach-planned session');
    const exercises = new WorkoutSessionsRepo(db).getExercisePerformances(session.session_id);
    expect(exercises.map((e) => e.exercise_id)).toEqual(['cable-lateral-raise', 'flat-barbell-bench-press']);
    expect(exercises[0]!.target_sets).toBe(4);
  });

  it('refuses the commit when a pause was set after saving', async () => {
    const saved = await request(app)
      .post('/api/coach/proposals')
      .set(auth)
      .send(body({ exercises: [{ exerciseId: 'leg-press', sets: 3, repsMin: 8, repsMax: 12 }] }))
      .expect(201);
    await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/approve`).expect(200);
    new InjuryPausesRepo(db).pause('legs', '2026-11-23', null);
    const res = await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/commit`).send({ intent: 'fill_existing_gym_day' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('injury-paused');
  });
});

describe('real exercise order from set times (2026-11-24)', () => {
  it('keeps the first save time per set and gives the coach the order the lifter did', async () => {
    const saved = await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/approve`).expect(200);
    const committed = await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/commit`).send({ intent: 'fill_existing_gym_day' }).expect(200);
    const sid = committed.body.committedSessionId;
    const [lateral, bench] = new WorkoutSessionsRepo(db).getExercisePerformances(sid);
    // Planned: lateral raise first. Done: bench first (machine taken).
    vi.setSystemTime(new Date('2026-11-23T04:00:00Z'));
    await request(app).patch(`/api/workouts/${sid}/exercises/${bench!.id}`).send({ sets: [{ set_number: 1, weight: 60, reps: 8, completed: true }, { set_number: 2, weight: null, reps: null, completed: false }] }).expect(200);
    vi.setSystemTime(new Date('2026-11-23T04:10:00Z'));
    await request(app).patch(`/api/workouts/${sid}/exercises/${bench!.id}`).send({ sets: [{ set_number: 1, weight: 60, reps: 9, completed: true }, { set_number: 2, weight: 60, reps: 8, completed: true }] }).expect(200);
    vi.setSystemTime(new Date('2026-11-23T04:20:00Z'));
    await request(app).patch(`/api/workouts/${sid}/exercises/${lateral!.id}`).send({ sets: [{ set_number: 1, weight: 7.5, reps: 14, completed: true }] }).expect(200);

    vi.setSystemTime(new Date('2026-11-24T02:30:00Z'));
    const ctx = await request(app).get('/api/coach/context?date=2026-11-24').set(auth).expect(200);
    const session = ctx.body.context.sessions.find((s: any) => s.date === DATE);
    expect(session.exercises.map((e: any) => e.exerciseId)).toEqual(['cable-lateral-raise', 'flat-barbell-bench-press']);
    expect(session.performedOrder).toEqual(['flat-barbell-bench-press', 'cable-lateral-raise']);
    const benchSets = session.exercises[1].sets;
    expect(benchSets[0].loggedAt).toBe('2026-11-23T04:00:00.000Z'); // edited later, first time kept
    expect(benchSets[1].loggedAt).toBe('2026-11-23T04:10:00.000Z');
    expect(session.exercises[1].firstLoggedAt).toBe('2026-11-23T04:00:00.000Z');
  });
});

describe('note per exercise (2026-11-24)', () => {
  it('saves, shows, clears a note on one exercise and gives it to the coach', async () => {
    const saved = await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/approve`).expect(200);
    const committed = await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/commit`).send({ intent: 'fill_existing_gym_day' }).expect(200);
    const sid = committed.body.committedSessionId;
    const [lateral, bench] = new WorkoutSessionsRepo(db).getExercisePerformances(sid);
    const res = await request(app).patch(`/api/workouts/${sid}/exercises/${bench!.id}`).send({ note: '  Did this first, cable station taken  ' }).expect(200);
    expect(res.body.note).toBe('Did this first, cable station taken');
    await request(app).patch(`/api/workouts/${sid}/exercises/${bench!.id}`).send({ note: 42 }).expect(400);
    const ctx = await request(app).get(`/api/coach/context?date=${DATE}`).set(auth).expect(200);
    const ex = ctx.body.context.sessions.find((s: any) => s.date === DATE).exercises;
    expect(ex[1].note).toBe('Did this first, cable station taken');
    expect(ex[0].note).toBeUndefined();
    const cleared = await request(app).patch(`/api/workouts/${sid}/exercises/${bench!.id}`).send({ note: '' }).expect(200);
    expect(cleared.body.note).toBeNull();
    expect(new WorkoutSessionsRepo(db).getExercisePerformances(sid).find((p) => p.id === lateral!.id)!.note).toBeNull();
  });

  it('the logger has a note button on each saved exercise card', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../public/logger.html', import.meta.url), 'utf8');
    expect(html).toContain("card.appendChild(buildExerciseNote(perf));");
    expect(html).toContain("body: { note: value }");
  });
});

describe('discard reason and runs', () => {
  it('stores the owner\'s discard reason and shows it to the coach', async () => {
    const saved = await request(app).post('/api/coach/proposals').set(auth).send(body()).expect(201);
    await request(app).post(`/api/ai-programmer/proposals/${saved.body.proposalId}/reject`).send({ reason: 'gym crowded, no bench' }).expect(200);
    const ctx = await request(app).get(`/api/coach/context?date=${DATE}`).set(auth).expect(200);
    expect(ctx.body.context.proposals[0].discardReason).toBe('gym crowded, no bench');
  });

  it('records a failed run for the app to show', async () => {
    await request(app).post('/api/coach/runs').set(auth).send({ targetDate: DATE, outcome: 'failed', reason: 'library check failed 3 times' }).expect(201);
    const day = await request(app).get(`/api/coach/day?date=${DATE}`).expect(200);
    expect(day.body.run).toMatchObject({ outcome: 'failed', reason: 'library check failed 3 times' });
    expect(day.body.rerunAvailable).toBe(false);
  });
});

describe('re-run', () => {
  it('fires the routine API trigger with the required headers', async () => {
    process.env.COACH_RERUN_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
    process.env.COACH_RERUN_TOKEN = 'sk-ant-oat01-test';
    const fetchMock = vi.fn(async () => new Response('{"type":"routine_fire"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await request(app).get(`/api/coach/day?date=${DATE}`).expect(200)).body.rerunAvailable).toBe(true);
      await request(app).post('/api/coach/rerun').send({ date: DATE }).expect(202);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(process.env.COACH_RERUN_URL);
      expect(init.headers).toMatchObject({ authorization: 'Bearer sk-ant-oat01-test', 'anthropic-version': '2023-06-01' });
      expect(JSON.parse(String(init.body)).text).toContain(DATE);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.COACH_RERUN_URL;
      delete process.env.COACH_RERUN_TOKEN;
    }
  });
});

describe("the day request presets Qwen's leg add-on ticks (owner: always a full session; the choice is the add-ons)", () => {
  it('session only ticks none, session + add-ons ticks every part, no request keeps the suggestion', async () => {
    new LegTrainingRepo(db).set('athletic');
    const ticks = async () => (await request(app).get(`/api/ai-programmer/add-on-options?targetDate=${DATE}&purpose=push`).expect(200)).body;
    const none = await ticks();
    expect(none.dayRequest).toBeNull();
    await request(app).put('/api/coach/day-request').send({ date: DATE, mode: 'full' }).expect(200);
    const only = await ticks();
    expect(only.parts.every((p: any) => p.suggested === false)).toBe(true);
    await request(app).put('/api/coach/day-request').send({ date: DATE, mode: 'add_ons' }).expect(200);
    const all = await ticks();
    expect(all.parts.length).toBeGreaterThan(0);
    expect(all.parts.every((p: any) => p.suggested === true)).toBe(true);
    await request(app).put('/api/coach/day-request').send({ date: DATE, mode: null }).expect(200);
    expect((await ticks()).parts).toEqual(none.parts);
  });
});
