// AI-Powered Weekly Reconciliation (spec §13, route tests): the real
// HTTP endpoints (supertest), same mocked-`fetch`-for-Velona pattern as
// tests/ai-programmer/aiProposalRoutes.test.ts. Also proves the existing
// deterministic day-activity route never calls the AI provider — only
// the new reconcile-week route family does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { AI_WEEK_RECONCILIATION_SCHEMA_VERSION, type AIWeekReconciliationDay, type AIWeekReconciliationOutput } from '../../src/ai-programmer/contracts/weekReconciliationTypes.js';
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

const VALID_EXERCISE = {
  exerciseId: 'flat-barbell-bench-press',
  role: 'primary',
  targetType: 'physique_target',
  targetId: 'mid-pec',
  classification: 'specialization',
  sets: 3,
  repsMin: 6,
  repsMax: 12,
  rirMin: 1,
  rirMax: 3,
  rationale: ['Direct mid-pec exposure.'],
  source: 'blueprint',
};

/** Builds a valid reconcile_week output by first asking the running app
 * (via its own real context-building code path) is not directly
 * accessible here, so this constructs the well-known-shape output using
 * the same weekday ordering the context always uses — Monday..Sunday
 * starting at the target week's Monday — mirroring the fixture used in
 * weekReconciliationValidators.test.ts. */
function validWeekOutputJson(overrides: Record<string, unknown> = {}): AIWeekReconciliationOutput {
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'];
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const days: AIWeekReconciliationDay[] = dates.map((date, i) => {
    if (date === SUNDAY) {
      return {
        date,
        weekday: weekdays[i]!,
        activity: 'gym',
        changeType: 'modified',
        locked: false,
        session: { sessionPurpose: 'chest', availableMinutes: 60, estimatedMinutes: 45, exercises: [VALID_EXERCISE as any], skipped: [] },
      };
    }
    return { date, weekday: weekdays[i]!, activity: 'unselected', changeType: 'unchanged', locked: false, session: null };
  });
  return {
    schemaVersion: AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
    proposalId: 'model-provided-id-discarded',
    mode: 'reconcile_week',
    targetDate: SUNDAY,
    requestedActivity: 'gym',
    days,
    reconciliation: { changedDates: [SUNDAY], preservedLockedDates: [], rationale: 'Move the gym session to Sunday.', warnings: [] },
    ...overrides,
  } as AIWeekReconciliationOutput;
}

async function reconcileWeek(): Promise<{ status: number; body: any }> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validWeekOutputJson()) } }));
  const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY, requestedActivity: 'gym' });
  return { status: res.status, body: res.body };
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
  process.env.AI_PROGRAMMER_ENABLED = 'true';
  process.env.VELONA_API_KEY = 'test-key-not-real';
  process.env.VELONA_MODEL = 'test-model';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AI_PROGRAMMER_ENABLED;
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
});

describe('POST /api/ai-programmer/reconcile-week', () => {
  it('accepts a valid request, calls the AI provider, and returns a pending reconciliation', async () => {
    const { status, body } = await reconcileWeek();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('reconcile_week');
    expect(body.status).toBe('pending');
    expect(typeof body.reconciliationId).toBe('string');
    expect(body.output.days).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.diagnostics.mode).toBe('reconcile_week');
  });

  it('rejects a missing targetDate', async () => {
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ requestedActivity: 'gym' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid calendar-date targetDate', async () => {
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: '2026-13-40', requestedActivity: 'gym' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing requestedActivity', async () => {
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a requestedActivity other than "gym"', async () => {
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY, requestedActivity: 'badminton' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string reason', async () => {
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY, requestedActivity: 'gym', reason: 123 });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a typed error and leaves the week unchanged when the provider fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    const latest = await request(app).get('/api/ai-programmer/week-reconciliations/latest').query({ targetDate: SUNDAY });
    expect(latest.body.found).toBe(false);
  });

  it('returns a typed error and persists nothing when the provider returns invalid output', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('AI_WEEK_RECONCILIATION_OUTPUT_SCHEMA_INVALID');
    const latest = await request(app).get('/api/ai-programmer/week-reconciliations/latest').query({ targetDate: SUNDAY });
    expect(latest.body.found).toBe(false);
  });

  it('respects the AI_PROGRAMMER_ENABLED flag — disabled reconcile-week never calls the provider', async () => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    const res = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PUT /api/programming/week/days/:day/activity — deterministic swap never calls AI', () => {
  it('a plain deterministic activity change makes zero provider/fetch calls', async () => {
    const res = await request(app).put('/api/programming/week/days/sunday/activity').send({ activity: 'unselected', prescriptionPolicy: 'schedule-only' });
    expect(res.status).toBeLessThan(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/ai-programmer/week-reconciliations/latest and /:id', () => {
  it('returns found: false when no reconciliation exists yet for a date', async () => {
    const res = await request(app).get('/api/ai-programmer/week-reconciliations/latest').query({ targetDate: SUNDAY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, found: false });
  });

  it('finds the latest reconciliation for a date after one is created', async () => {
    const { body } = await reconcileWeek();
    const latest = await request(app).get('/api/ai-programmer/week-reconciliations/latest').query({ targetDate: SUNDAY });
    expect(latest.body.found).toBe(true);
    expect(latest.body.reconciliationId).toBe(body.reconciliationId);
  });

  it('retrieves a reconciliation by id', async () => {
    const { body } = await reconcileWeek();
    const res = await request(app).get(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}`);
    expect(res.status).toBe(200);
    expect(res.body.reconciliationId).toBe(body.reconciliationId);
    expect(res.body.status).toBe('pending');
  });

  it('returns a 404-family error for an unknown reconciliation id', async () => {
    const res = await request(app).get('/api/ai-programmer/week-reconciliations/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ai-programmer/week-reconciliations/:id/approve and /commit', () => {
  it('approves a pending reconciliation', async () => {
    const { body } = await reconcileWeek();
    const res = await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  it('rejects committing before approval', async () => {
    const { body } = await reconcileWeek();
    const res = await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/commit`);
    expect(res.status).toBe(409);
  });

  it('commits an approved reconciliation, creating exactly one real session on the target date', async () => {
    const { body } = await reconcileWeek();
    await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/approve`);
    const res = await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/commit`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('committed');
    expect(typeof res.body.committedSessionId).toBe('string');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('rejects committing when an active conflicting session already exists on the target date (409)', async () => {
    const { body } = await reconcileWeek();
    await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'planned' });
    const res = await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/commit`);
    expect(res.status).toBe(409);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('the commit response never contains a raw provider payload or API key', async () => {
    const { body } = await reconcileWeek();
    await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/approve`);
    const res = await request(app).post(`/api/ai-programmer/week-reconciliations/${body.reconciliationId}/commit`);
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-real');
  });
});
