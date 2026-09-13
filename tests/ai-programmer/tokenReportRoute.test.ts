// Real Dry-Run Token Report spec §8/§11: route-level tests for
// GET /api/ai-programmer/token-report through the real HTTP endpoint
// (supertest). Proves: dev/admin access protection (never available
// anonymously in production), clean validation errors for a missing
// date or an invalid mode, and that fetch/Velona is never invoked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let fetchMock: ReturnType<typeof vi.fn>;

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

  fetchMock = vi.fn(() => {
    throw new Error('fetch must never be called by the token-report route');
  });
  vi.stubGlobal('fetch', fetchMock);

  process.env.VELONA_API_KEY = 'test-key-not-real';
  process.env.VELONA_MODEL = 'test-model';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
  delete process.env.AI_TOKEN_REPORT_ENABLED;
  delete process.env.AI_TOKEN_REPORT_ACCESS_TOKEN;
  delete process.env.NODE_ENV;
});

describe('GET /api/ai-programmer/token-report — access control', () => {
  it('returns a bare 404 when AI_TOKEN_REPORT_ENABLED is not set (default: disabled)', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 in production even when enabled, unless an access token is configured', async () => {
    process.env.AI_TOKEN_REPORT_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY });
    expect(res.status).toBe(404);
  });

  it('allows access outside production once enabled, with no access token configured', async () => {
    process.env.AI_TOKEN_REPORT_ENABLED = 'true';
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY });
    expect(res.status).toBe(200);
  });

  it('requires a matching x-token-report-token header when an access token is configured, even in production', async () => {
    process.env.AI_TOKEN_REPORT_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    process.env.AI_TOKEN_REPORT_ACCESS_TOKEN = 'super-secret-report-token';

    const denied = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY });
    expect(denied.status).toBe(404);

    const wrongToken = await request(app)
      .get('/api/ai-programmer/token-report')
      .query({ mode: 'generate_session', date: SUNDAY })
      .set('x-token-report-token', 'wrong');
    expect(wrongToken.status).toBe(404);

    const allowed = await request(app)
      .get('/api/ai-programmer/token-report')
      .query({ mode: 'generate_session', date: SUNDAY })
      .set('x-token-report-token', 'super-secret-report-token');
    expect(allowed.status).toBe(200);
  });
});

describe('GET /api/ai-programmer/token-report — validation (item 9)', () => {
  beforeEach(() => {
    process.env.AI_TOKEN_REPORT_ENABLED = 'true';
  });

  it('rejects a missing date with a clear 400', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a non-calendar date with a clear 400', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: '2026-13-40' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing mode with a clear 400', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ date: SUNDAY });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid mode with a clear 400', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'not_a_real_mode', date: SUNDAY });
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric inputPricePerMillionTokens with a clear 400', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY, inputPricePerMillionTokens: 'free' });
    expect(res.status).toBe(400);
  });

  it('rejects a negative outputPricePerMillionTokens with a clear 400', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY, outputPricePerMillionTokens: '-1' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ai-programmer/token-report — success (never calls Velona)', () => {
  beforeEach(() => {
    process.env.AI_TOKEN_REPORT_ENABLED = 'true';
  });

  it('returns a generate_session report and never invokes fetch', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report.mode).toBe('generate_session');
    expect(res.body.report.targetDate).toBe(SUNDAY);
    expect(typeof res.body.report.measurements.wireBodyChars).toBe('number');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a reconcile_week report with cost projection applied and never invokes fetch', async () => {
    const res = await request(app)
      .get('/api/ai-programmer/token-report')
      .query({ mode: 'reconcile_week', date: SUNDAY, reason: 'testing', inputPricePerMillionTokens: '3', outputPricePerMillionTokens: '15' });
    expect(res.status).toBe(200);
    expect(res.body.report.mode).toBe('reconcile_week');
    expect(res.body.report.weekStart).toBe('2026-09-07');
    expect(res.body.report.costProjection.inputPricePerMillionTokens).toBe(3);
    expect(res.body.report.costProjection.estimatedInputCost).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the HTTP response never contains the API key or an Authorization header value (item 10)', async () => {
    const res = await request(app).get('/api/ai-programmer/token-report').query({ mode: 'generate_session', date: SUNDAY });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('test-key-not-real');
    expect(serialized.toLowerCase()).not.toContain('bearer ');
  });
});
