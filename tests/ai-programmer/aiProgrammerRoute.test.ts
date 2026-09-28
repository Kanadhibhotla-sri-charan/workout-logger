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
import { weekdayOfDate } from '../../src/engine/workoutBuilder.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { findGenerationFailure } from '../../src/ai-programmer/service/generationFailureMemory.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

// Computed relative to the real clock, unlike SUNDAY above (a fixed
// calendar date that goes stale/past-dated once real time passes it),
// so this test never rots into a false failure.
function futureDate(): { date: string; weekday: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 61);
  const date = d.toISOString().slice(0, 10);
  return { date, weekday: weekdayOfDate(date) };
}

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

  // UPDATED (Aggregate Target-Cap Repair Fix, 2026-09-24): repair's new
  // trimToTargetCaps step now catches this exact aggregate overage BEFORE
  // adequacy validation ever runs (see aiProgrammerService.test.ts's own
  // updated sibling test for the full rationale and the corrected real
  // cap value — 5, not the file's prior stale "8" comment). The route now
  // returns 200 with the repaired proposal persisted, not a 502.
  it('a structurally/domain-valid proposal whose aggregate exceeds a target\'s real per-exposure cap is now repaired one layer earlier, not rejected', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date, weekday } = futureDate();
    // incline-dumbbell-press (no authored cap, freely up to 6) +
    // incline-barbell-press (authored exactly 3 sets) sum to 9 direct
    // sets for upper-pec, well over that muscle's real Efficient
    // per-exposure cap (5).
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          output: JSON.stringify(
            validProposalJson({
              targetDate: date,
              weekday,
              exercises: [
                { exerciseId: 'incline-dumbbell-press', role: 'primary', targetType: 'physique_target', targetId: 'upper-pec', sets: 6, repsMin: 8, repsMax: 12, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' },
                { exerciseId: 'incline-barbell-press', role: 'primary', targetType: 'physique_target', targetId: 'upper-pec', sets: 3, repsMin: 6, repsMax: 12, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' },
              ],
            })
          ),
        },
      })
    );

    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(res.status).toBe(200);
    const upperPecTotal = res.body.proposal.exercises.filter((e: { targetId: string }) => e.targetId === 'upper-pec').reduce((sum: number, e: { sets: number }) => sum + e.sets, 0);
    expect(upperPecTotal).toBeLessThanOrEqual(5);
    expect(res.body.proposal.warnings.some((w: string) => w.includes('Aggregate target-cap trim') && w.includes('upper-pec'))).toBe(true);

    const latest = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: date });
    expect(latest.body.found).toBe(true); // the repaired, valid proposal was persisted
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

  it('rejects a second generate-session call for a date with an existing pending proposal, without a second provider call', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date, weekday } = futureDate();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validProposalJson({ targetDate: date, weekday })) } }));

    const first = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
    expect(second.body.error).toBe('AI_PROPOSAL_ALREADY_PENDING');
    expect(fetchMock).toHaveBeenCalledTimes(1); // never called Velona a second time
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

// Same-context retry gate: a quality failure for an exact targetDate +
// contextHash blocks an identical follow-up request BEFORE the paid
// provider call, unless the request explicitly sends confirmRetry: true.
describe('POST /api/ai-programmer/generate-session — same-context retry gate', () => {
  const garbageOutput = () => jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } });
  const contextHashFor = (targetDate: string, requestedSessionPurpose?: 'push' | 'pull' | 'legs' | 'upper') =>
    buildProgrammerContext(db, { targetDate, requestedSessionPurpose }).contextHash;

  it('a first AI-output quality failure records a failure marker for that targetDate + contextHash', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValueOnce(garbageOutput());

    const first = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(first.status).toBe(502);
    expect(first.body.error).toBe('AI_OUTPUT_SCHEMA_INVALID');

    const marker = findGenerationFailure(db, date, contextHashFor(date));
    expect(marker).toBeDefined();
    expect(marker!.code).toBe('AI_OUTPUT_SCHEMA_INVALID');
    expect(marker!.issues.length).toBeGreaterThan(0);
  });

  it('a second identical request makes zero provider calls and returns AI_GENERATION_PREVIOUSLY_FAILED with the stored reason', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValueOnce(garbageOutput());

    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
    expect(second.body.error).toBe('AI_GENERATION_PREVIOUSLY_FAILED');
    expect(second.body.details.previousErrorCode).toBe('AI_OUTPUT_SCHEMA_INVALID');
    expect(second.body.details.previousIssues.length).toBeGreaterThan(0);
    expect(second.body.details.retryOverride).toBe('confirmRetry');
    expect(fetchMock).toHaveBeenCalledTimes(1); // never called the provider a second time
  });

  it('a second request with explicit confirmRetry: true calls the provider despite the gate', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValueOnce(garbageOutput()).mockResolvedValueOnce(garbageOutput());

    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    const retried = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date, confirmRetry: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retried.body.error).toBe('AI_OUTPUT_SCHEMA_INVALID'); // the real outcome of the new attempt, not the gate
  });

  it('confirmRetry must be an explicit boolean — a truthy string is rejected, never treated as confirmation', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date, confirmRetry: 'yes' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a changed contextHash (a different requested purpose) bypasses the gate and calls the provider normally', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    expect(contextHashFor(date, 'pull')).not.toBe(contextHashFor(date));
    fetchMock.mockResolvedValueOnce(garbageOutput()).mockResolvedValueOnce(garbageOutput());

    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    const different = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date, requestedSessionPurpose: 'pull' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(different.body.error).not.toBe('AI_GENERATION_PREVIOUSLY_FAILED');
  });

  it('a provider/transient failure never creates a blocking marker — the next request calls the provider again', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'upstream exploded' }));

    const first = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(first.body.error).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(findGenerationFailure(db, date, contextHashFor(date))).toBeUndefined();
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(second.body.error).not.toBe('AI_GENERATION_PREVIOUSLY_FAILED');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('a successful generation clears the corresponding failure marker', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date, weekday } = futureDate();
    fetchMock
      .mockResolvedValueOnce(garbageOutput())
      .mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validProposalJson({ targetDate: date, weekday })) } }));

    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(findGenerationFailure(db, date, contextHashFor(date))).toBeDefined();

    const retried = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date, confirmRetry: true });
    expect(retried.status).toBe(200);
    expect(findGenerationFailure(db, date, contextHashFor(date))).toBeUndefined();
  });
});
