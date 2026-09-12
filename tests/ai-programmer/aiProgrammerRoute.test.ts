// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.4):
// route-level tests through the real HTTP endpoint (via supertest),
// with a mocked global `fetch` standing in for Velona — no real API
// key is ever used.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/programmerTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function validProposalJson(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'p-1',
    mode: 'generate_session',
    targetDate: SUNDAY,
    weekday: 'sunday',
    sessionFocus: ['chest'],
    exercises: [
      {
        exerciseId: 'flat-barbell-bench-press',
        role: 'primary',
        targetType: 'physique_target',
        targetId: 'mid-pec',
        sets: 3,
        repsMin: 6,
        repsMax: 12,
        rirMin: 1,
        rirMax: 3,
        rationale: ['Direct mid-pec exposure.'],
        source: 'blueprint',
      },
    ],
    programmingRationale: ['Chest focus this session.'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  process.env.VELONA_API_KEY = 'test-key-not-real';
  process.env.VELONA_MODEL = 'test-model';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_PROGRAMMER_ENABLED;
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
});

describe('POST /api/ai-programmer/generate-session', () => {
  it('returns 400 when targetDate is missing', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const res = await request(app).post('/api/ai-programmer/generate-session').send({});
    expect(res.status).toBe(400);
  });

  it('AI disabled behavior: returns 503 with AI_PROGRAMMER_DISABLED when the feature flag is off', async () => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('AI_PROGRAMMER_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled(); // never even calls the provider when disabled
  });

  it('successful generation with a mocked provider returns proposal/contextHash/provider/model/requestId', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validProposalJson()), model: 'resolved-model' } }));

    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.proposal.exercises).toHaveLength(1);
    expect(res.body.proposal.exercises[0].exerciseId).toBe('flat-barbell-bench-press');
    expect(res.body.provider).toBe('velona');
    expect(res.body.model).toBe('resolved-model');
    expect(typeof res.body.contextHash).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('invalid provider output (fails schema validation) returns 502 AI_OUTPUT_SCHEMA_INVALID', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));

    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('AI_OUTPUT_SCHEMA_INVALID');
  });

  it('provider failure (5xx exhausting retries) is handled safely with a typed error, no crash', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValue(jsonResponse(503, {}));

    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-real'); // never leaks the key
  });

  it('requesting a locked (completed) date returns 409 AI_TARGET_NOT_EDITABLE and never calls the provider', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'completed' });

    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_TARGET_NOT_EDITABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no persistence occurs on validation failure — no workout_sessions/program rows are created', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));

    const before = new WorkoutSessionsRepo(db).listSessions().length;
    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(new WorkoutSessionsRepo(db).listSessions().length).toBe(before);
  });

  it('never mutates completed/locked sessions elsewhere in the database on a successful generation', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const completed = sessionsRepo.createSession({ date: '2026-09-08', session_type: 'gym', status: 'completed' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validProposalJson()) } }));

    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(sessionsRepo.getSession(completed.session_id)?.status).toBe('completed');
  });
});
