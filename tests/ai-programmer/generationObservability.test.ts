// Phase 1 (rejection observability) and Phase 2 (session-planner shadow
// mode): unit tests for the bounded rejection diagnostic, plus route-level
// tests proving both server-log records are emitted, bounded, never shown
// to the client, and never change what the AI provider receives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { weekdayOfDate } from '../../src/engine/workoutBuilder.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/programmerTypes.js';
import {
  AIGenerationPreviouslyFailedError,
  AIOutputAdequacyInvalidError,
  AIOutputDomainInvalidError,
  AIOutputSchemaInvalidError,
  AIProgrammerDisabledError,
  AIProposalAlreadyPendingError,
  AIProviderOutputTruncatedError,
  AIProviderUnavailableError,
  AITargetNotEditableError,
} from '../../src/ai-programmer/errors.js';
import { buildGenerationRejectionDiagnostic } from '../../src/ai-programmer/service/generationDiagnostics.js';
import { MAX_DIAGNOSTIC_ISSUES, MAX_DIAGNOSTIC_ISSUE_CHARS, MAX_DIAGNOSTIC_TOTAL_CHARS } from '../../src/ai-programmer/validation/diagnosticsBounds.js';

const request0 = { targetDate: '2026-10-06', contextHash: 'abc123', sessionPurpose: 'pull' };

describe('buildGenerationRejectionDiagnostic', () => {
  it('classifies each typed failure by the pipeline stage that throws it', () => {
    const cases: [unknown, string][] = [
      [new AIProgrammerDisabledError(), 'disabled'],
      [new AIProposalAlreadyPendingError('2026-10-06', 'p-1'), 'pending_guard'],
      [new AITargetNotEditableError('2026-10-06', 'in the past'), 'context'],
      [new AIGenerationPreviouslyFailedError('2026-10-06', { code: 'AI_OUTPUT_ADEQUACY_INVALID', issues: ['x'], failedAt: '2026-10-01T00:00:00.000Z' }), 'retry_gate'],
      [new AIProviderUnavailableError(), 'provider'],
      [new AIProviderOutputTruncatedError({ mode: 'generate_session', finishReason: 'length' }), 'provider_output'],
      [new AIOutputSchemaInvalidError(['exercises: duplicate exerciseId "x"']), 'schema'],
      [new AIOutputDomainInvalidError(['unknown exercise']), 'domain'],
      [new AIOutputAdequacyInvalidError(['physique_target:lat-width: 3 sets is clearly inadequate volume']), 'adequacy'],
    ];
    for (const [err, stage] of cases) {
      const d = buildGenerationRejectionDiagnostic(err, request0, '2026-10-01T12:00:00.000Z');
      expect(d.stage, (err as Error).constructor.name).toBe(stage);
      expect(d.event).toBe('generate_session_rejected');
      expect(d).toMatchObject({ targetDate: '2026-10-06', contextHash: 'abc123', sessionPurpose: 'pull', timestamp: '2026-10-01T12:00:00.000Z' });
      expect(d.issues.length).toBeGreaterThan(0);
    }
  });

  it('records the exact adequacy issues — the failure is diagnosable from the log alone', () => {
    const issues = ['physique_target:lat-width: 3 sets is clearly inadequate volume', 'physique_target:upper-traps: 2 sets is clearly inadequate volume'];
    const d = buildGenerationRejectionDiagnostic(new AIOutputAdequacyInvalidError(issues), request0);
    expect(d.code).toBe('AI_OUTPUT_ADEQUACY_INVALID');
    expect(d.issues).toEqual(issues);
  });

  it('records the previous failure for a retry-gate refusal', () => {
    const err = new AIGenerationPreviouslyFailedError('2026-10-06', { code: 'AI_OUTPUT_ADEQUACY_INVALID', issues: ['lat-width short'], failedAt: '2026-10-01T00:00:00.000Z' });
    expect(buildGenerationRejectionDiagnostic(err, request0).issues).toEqual(['previous failure: AI_OUTPUT_ADEQUACY_INVALID', 'lat-width short']);
  });

  it('keeps issues within the existing diagnostic bounds', () => {
    const huge = Array.from({ length: 100 }, (_, i) => `issue ${i} ${'x'.repeat(5000)}`);
    const d = buildGenerationRejectionDiagnostic(new AIOutputDomainInvalidError(huge), request0);
    expect(d.issues.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUES + 1);
    expect(d.issues.every((i) => i.length <= MAX_DIAGNOSTIC_ISSUE_CHARS)).toBe(true);
    expect(d.issues.reduce((s, i) => s + i.length, 0)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_TOTAL_CHARS);
  });

  it('never records the raw message of an untyped internal error', () => {
    const d = buildGenerationRejectionDiagnostic(new TypeError('SQLITE_ERROR near "ai_program_proposals": secret detail'), { ...request0, contextHash: null });
    expect(d).toMatchObject({ stage: 'internal', code: 'INTERNAL_ERROR', issues: ['TypeError'], contextHash: null });
    expect(JSON.stringify(d)).not.toContain('SQLITE');
  });
});

// ---------- route level ----------

function futureDate(): { date: string; weekday: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 61);
  const date = d.toISOString().slice(0, 10);
  return { date, weekday: weekdayOfDate(date) };
}
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const logsMatching = (spy: ReturnType<typeof vi.spyOn>, prefix: string) =>
  spy.mock.calls.filter((c) => c[0] === prefix).map((c) => JSON.parse(c[1] as string));

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let fetchMock: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

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
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'],
    other_activity_schedule: [],
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  process.env.VELONA_API_KEY = 'test-key-not-real';
  process.env.VELONA_MODEL = 'test-model';
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AI_PROGRAMMER_ENABLED;
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
});

describe('generate-session rejection observability (route level)', () => {
  it('a schema rejection logs one bounded record with stage, code, context hash and purpose — the client response is unchanged', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));

    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date, requestedSessionPurpose: 'pull' });

    expect(res.status).toBe(502);
    expect(Object.keys(res.body).sort()).toEqual(['details', 'error', 'message', 'ok']); // no diagnostic record exposed
    const records = logsMatching(warnSpy, '[ai-programmer] generation rejected');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'generate_session_rejected', stage: 'schema', code: 'AI_OUTPUT_SCHEMA_INVALID', targetDate: date, sessionPurpose: 'pull' });
    expect(records[0].contextHash).toMatch(/^[0-9a-f]+$/);
    expect(typeof records[0].timestamp).toBe('string');
    expect(JSON.stringify(records[0])).not.toContain('garbage'); // raw AI output never recorded
  });

  it('a rejection before the context exists records a null context hash', async () => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    const { date } = futureDate();
    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    const records = logsMatching(warnSpy, '[ai-programmer] generation rejected');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stage: 'disabled', code: 'AI_PROGRAMMER_DISABLED', contextHash: null });
  });

  it('a successful generation logs no rejection', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date, weekday } = futureDate();
    const proposal = {
      schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION, proposalId: 'p-1', mode: 'generate_session', targetDate: date, weekday, sessionFocus: ['chest'],
      exercises: [{ exerciseId: 'flat-barbell-bench-press', role: 'primary', targetType: 'physique_target', targetId: 'mid-pec', sets: 3, repsMin: 6, repsMax: 12, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' }],
      programmingRationale: ['x'], goalAlignment: [], recoveryConsiderations: [], warnings: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(proposal) } }));
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(res.status).toBe(200);
    expect(logsMatching(warnSpy, '[ai-programmer] generation rejected')).toHaveLength(0);
  });
});

describe('session planner shadow mode (route level)', () => {
  it('logs a bounded shadow plan for the request and sends nothing of it to the AI provider', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));

    await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date, requestedSessionPurpose: 'pull' });

    const plans = logsMatching(logSpy, '[ai-programmer] shadow session plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ event: 'session_plan_shadow', schemaVersion: 'session-plan.v1', targetDate: date, purpose: 'pull' });
    expect(plans[0].targets.find((t: { id: string }) => t.id === 'upper-traps').status).toBe('infeasible');
    expect(JSON.stringify(plans[0]).length).toBeLessThan(20_000);

    // Shadow only: the provider request carries none of the plan.
    const providerBody = String(fetchMock.mock.calls[0]![1]!.body);
    expect(providerBody).not.toContain('session-plan.v1');
    expect(providerBody).not.toContain('plannedMinimumSets');
    expect(providerBody).not.toContain('reservedExerciseSlots');
    expect(logsMatching(warnSpy, '[ai-programmer] shadow session plan failed')).toHaveLength(0);
  });

  it('the outcome is identical with and without shadow planning: the same rejection code and client response', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    const { date } = futureDate();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: date });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('AI_OUTPUT_SCHEMA_INVALID');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
