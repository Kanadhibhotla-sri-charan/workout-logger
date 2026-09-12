// AI Programmer Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md
// §15): route-level tests for proposal persistence, retrieval,
// approval, and commit — through the real HTTP endpoints (supertest),
// same mocked-`fetch`-for-Velona pattern as
// tests/ai-programmer/aiProgrammerRoute.test.ts.

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
    proposalId: 'model-provided-id-discarded',
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

/** Generates one valid proposal through the real endpoint and returns
 * its persisted proposalId — the shared setup step for every
 * approve/commit test below. */
async function generateProposal(): Promise<string> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validProposalJson()) } }));
  const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
  expect(res.status).toBe(200);
  return res.body.proposalId as string;
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

describe('POST /api/ai-programmer/generate-session — persistence', () => {
  it('persists the proposal and returns proposalId/status alongside the existing fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validProposalJson()) } }));
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(res.status).toBe(200);
    expect(typeof res.body.proposalId).toBe('string');
    expect(res.body.status).toBe('pending');
    expect(res.body.proposalId).toBe(res.body.proposal.proposalId); // same id, by construction
  });

  it('a schema-validation failure creates no proposal record (nothing retrievable)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify({ garbage: true }) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(genRes.status).toBe(502);
    // No proposal id was ever returned to look up — assert indirectly via
    // the underlying table being empty.
    expect(db.prepare('SELECT COUNT(*) as c FROM ai_program_proposals').get()).toEqual({ c: 0 });
  });

  it('a provider failure creates no proposal record', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY });
    expect(genRes.status).toBe(502);
    expect(db.prepare('SELECT COUNT(*) as c FROM ai_program_proposals').get()).toEqual({ c: 0 });
  });

  it('each successful generation creates a separate proposal id (no automatic dedup)', async () => {
    const id1 = await generateProposal();
    // Same targetDate is still editable (no session was ever committed),
    // so a second generate-session call for the same date succeeds too.
    const id2 = await generateProposal();
    expect(id1).not.toBe(id2);
    expect(db.prepare('SELECT COUNT(*) as c FROM ai_program_proposals').get()).toEqual({ c: 2 });
  });
});

describe('GET /api/ai-programmer/proposals/:proposalId — retrieval', () => {
  it('returns the full validated proposal plus lifecycle metadata for a known id', async () => {
    const proposalId = await generateProposal();
    const res = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.proposalId).toBe(proposalId);
    expect(res.body.status).toBe('pending');
    expect(res.body.proposal.exercises).toHaveLength(1);
    expect(res.body.committedSessionId).toBeNull();
  });

  it('returns 404 AI_PROPOSAL_NOT_FOUND for an unknown id', async () => {
    const res = await request(app).get('/api/ai-programmer/proposals/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('AI_PROPOSAL_NOT_FOUND');
  });

  it('never returns a raw provider payload, an API key, or an authorization header', async () => {
    const proposalId = await generateProposal();
    const res = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('test-key-not-real');
    expect(raw.toLowerCase()).not.toContain('authorization');
  });

  it('respects the AI_PROGRAMMER_ENABLED flag — disabled retrieval returns 503, not the proposal', async () => {
    const proposalId = await generateProposal();
    delete process.env.AI_PROGRAMMER_ENABLED;
    const res = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI_PROGRAMMER_DISABLED');
  });
});

describe('POST /api/ai-programmer/proposals/:proposalId/approve', () => {
  it('approves a pending proposal, recording approvedAt, without committing it', async () => {
    const proposalId = await generateProposal();
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approvedAt).not.toBeNull();
    expect(res.body.committedSessionId).toBeNull();
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('re-approving an already-approved proposal is idempotent (200, unchanged)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const second = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('approved');
  });

  it('approving a committed proposal returns 409 AI_PROPOSAL_INVALID_STATE', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_INVALID_STATE');
  });

  it('approving an expired proposal returns 410 AI_PROPOSAL_EXPIRED and leaves it expired', async () => {
    const proposalId = await generateProposal();
    db.prepare("UPDATE ai_program_proposals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(proposalId);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('AI_PROPOSAL_EXPIRED');
    const getRes = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(getRes.body.status).toBe('expired');
  });

  it('the proposal content is byte-identical after approval', async () => {
    const proposalId = await generateProposal();
    const before = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const after = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(after.body.proposal).toEqual(before.body.proposal);
  });
});

describe('POST /api/ai-programmer/proposals/:proposalId/commit', () => {
  it('commits an approved proposal, creating a real planned session with the proposed exercises', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('committed');
    expect(typeof res.body.committedSessionId).toBe('string');

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.getSession(res.body.committedSessionId);
    expect(session?.status).toBe('planned');
    expect(session?.date).toBe(SUNDAY);
    const exercises = sessionsRepo.getExercisePerformances(res.body.committedSessionId);
    expect(exercises).toHaveLength(1);
    expect(exercises[0]?.exercise_id).toBe('flat-barbell-bench-press');
    expect(exercises[0]?.sets).toHaveLength(3);
  });

  it('a pending (never-approved) proposal cannot be committed (409 AI_PROPOSAL_INVALID_STATE)', async () => {
    const proposalId = await generateProposal();
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_INVALID_STATE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('an expired proposal cannot be committed (410 AI_PROPOSAL_EXPIRED)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    db.prepare("UPDATE ai_program_proposals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(proposalId);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('AI_PROPOSAL_EXPIRED');
  });

  it('repeated commit is idempotent: same committedSessionId, no duplicate session created', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const first = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    const second = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(second.status).toBe(200);
    expect(second.body.committedSessionId).toBe(first.body.committedSessionId);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('concurrent commit attempts for the same proposal do not create duplicate sessions', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const [a, b] = await Promise.all([
      request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`),
      request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`),
    ]);
    const succeeded = [a, b].filter((r) => r.status === 200);
    expect(succeeded.length).toBe(2); // one actually commits, the other observes the idempotent already-committed result
    expect(succeeded[0]?.body.committedSessionId).toBe(succeeded[1]?.body.committedSessionId);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('a completed-session conflict is rejected (via the reused editable-date check)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'completed' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_TARGET_NOT_EDITABLE');
  });

  it('an in-progress-session conflict is rejected', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'in_progress' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_TARGET_NOT_EDITABLE');
  });

  it('an existing planned-session conflict is rejected per the documented default policy (409 AI_PROPOSAL_CONFLICT)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'planned' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_CONFLICT');
    // Only the pre-existing planned session exists — the proposal's own
    // session was never created.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('a changed Blueprint commit since generation is detected as staleness (422 AI_PROPOSAL_STALE)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    db.prepare('UPDATE ai_program_proposals SET blueprint_commit = ? WHERE id = ?').run('a-different-blueprint-commit', proposalId);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('AI_PROPOSAL_STALE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('an exercise that is no longer Blueprint-valid is caught by commit-time revalidation (422)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const stored = db.prepare('SELECT proposal_json FROM ai_program_proposals WHERE id = ?').get(proposalId) as { proposal_json: string };
    const tampered = JSON.parse(stored.proposal_json);
    tampered.exercises[0].exerciseId = 'totally-made-up-exercise-id';
    db.prepare('UPDATE ai_program_proposals SET proposal_json = ? WHERE id = ?').run(JSON.stringify(tampered), proposalId);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('AI_PROPOSAL_STALE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('malformed stored proposal JSON cannot be committed', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    db.prepare('UPDATE ai_program_proposals SET proposal_json = ? WHERE id = ?').run('{not valid json', proposalId);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).not.toBe(200);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('at aiproposalrepo'); // no stack trace leak
  });

  it('a persistence failure mid-commit rolls back: no orphaned session, proposal stays approved', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const spy = vi.spyOn(WorkoutSessionsRepo.prototype, 'addExercisePerformance').mockImplementation(() => {
      throw new Error('simulated mid-transaction persistence failure');
    });

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI_PROPOSAL_COMMIT_FAILED');
    spy.mockRestore();

    // Atomicity: the half-created session must not have been left behind.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    const getRes = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(getRes.body.status).toBe('approved'); // never advanced to committed
    expect(getRes.body.committedSessionId).toBeNull();
  });

  it('respects the AI_PROGRAMMER_ENABLED flag — disabled commit returns 503, never persists', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    delete process.env.AI_PROGRAMMER_ENABLED;
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(503);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('the commit response never contains a raw provider payload or API key', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-real');
  });
});
