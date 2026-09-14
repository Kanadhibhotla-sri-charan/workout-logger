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
import { OutsideBlueprintExercisesRepo } from '../../src/repositories/outsideBlueprintExercisesRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../src/lib/dailyActivity.js';
import { programmingWeekStart, weekdayOfDate } from '../../src/engine/workoutBuilder.js';

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
async function generateProposal(exerciseOverrides: Record<string, unknown> = {}): Promise<string> {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, {
      data: {
        output: JSON.stringify(
          validProposalJson({
            exercises: [{ ...validProposalJson().exercises[0], ...exerciseOverrides }],
          })
        ),
      },
    })
  );
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
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
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
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('committed');
    expect(typeof res.body.committedSessionId).toBe('string');

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.getSession(res.body.committedSessionId);
    expect(session?.status).toBe('planned');
    expect(session?.date).toBe(SUNDAY);
    // Cleanup pass §3: the note references the persisted proposal
    // record's own id (record.id), not a separately-held in-memory
    // value — verified by checking it contains the exact id this test
    // itself used to look the proposal up.
    expect(session?.notes).toContain(proposalId);
    const exercises = sessionsRepo.getExercisePerformances(res.body.committedSessionId);
    expect(exercises).toHaveLength(1);
    expect(exercises[0]?.exercise_id).toBe('flat-barbell-bench-press');
    expect(exercises[0]?.sets).toHaveLength(3);
  });

  it('a pending (never-approved) proposal cannot be committed (409 AI_PROPOSAL_INVALID_STATE)', async () => {
    const proposalId = await generateProposal();
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_INVALID_STATE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('an expired proposal cannot be committed (410 AI_PROPOSAL_EXPIRED)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    db.prepare("UPDATE ai_program_proposals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(proposalId);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('AI_PROPOSAL_EXPIRED');
  });

  it('repeated commit is idempotent: same committedSessionId, no duplicate session created', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const first = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    const second = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(second.status).toBe(200);
    expect(second.body.committedSessionId).toBe(first.body.committedSessionId);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('concurrent commit attempts for the same proposal do not create duplicate sessions', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const [a, b] = await Promise.all([
      request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' }),
      request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' }),
    ]);
    const succeeded = [a, b].filter((r) => r.status === 200);
    expect(succeeded.length).toBe(2); // one actually commits, the other observes the idempotent already-committed result
    expect(succeeded[0]?.body.committedSessionId).toBe(succeeded[1]?.body.committedSessionId);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  // Final Selected Session Resolution and AI/Deterministic Precedence
  // Fixes §11.B: "Two AI commits target the same date concurrently" —
  // here, two DIFFERENT proposals (not the same proposal committed
  // twice, already covered above) both targeting the same date. The
  // first commit succeeds; the second must be rejected as a conflict
  // against the session the first one just created, never silently
  // create a second competing selected workout for that date.
  it('two different proposals targeting the same date: the first commit succeeds, the second is rejected as a conflict', async () => {
    const proposalA = await generateProposal();
    const proposalB = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalA}/approve`);
    await request(app).post(`/api/ai-programmer/proposals/${proposalB}/approve`);

    const first = await request(app).post(`/api/ai-programmer/proposals/${proposalA}/commit`).send({ intent: 'replace_day_activity' }).expect(200);
    const second = await request(app).post(`/api/ai-programmer/proposals/${proposalB}/commit`).send({ intent: 'replace_day_activity' });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('AI_PROPOSAL_CONFLICT');
    expect(second.body.details.conflictingSessionId).toBe(first.body.committedSessionId);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('a completed-session conflict is rejected (via the reused editable-date check), with no partial write', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'completed' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_TARGET_NOT_EDITABLE');
    // Actionable vs Historical fix's own write-path requirement: no
    // partial write — only the pre-existing completed session exists,
    // the proposal's own session was never created.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
    const record = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`).expect(200);
    expect(record.body.status).toBe('approved');
  });

  it('an in-progress-session conflict is rejected, with no partial write', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'in_progress' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_TARGET_NOT_EDITABLE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
    const record = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`).expect(200);
    expect(record.body.status).toBe('approved');
  });

  it('an existing planned-session conflict is rejected per the documented default policy (409 AI_PROPOSAL_CONFLICT)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'planned' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_CONFLICT');
    // Only the pre-existing planned session exists — the proposal's own
    // session was never created.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  // Final Selected Session Resolution and AI/Deterministic Precedence
  // Fixes §10/§11.C: an explicit mixed-source case named in the required
  // regression matrix — "AI commit targets a date with selected manual
  // session." The conflict check (`findActiveGymSessionConflict`,
  // shared with the generic POST /api/workouts route — see
  // aiProposalLifecycle.ts) does not discriminate by `source_type`, so
  // this proves that explicitly rather than only via the source_type-
  // agnostic 'planned' case above.
  it('an existing MANUAL selected session on the target date is also rejected as a conflict (mixed-source §10)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    new WorkoutSessionsRepo(db).createSession({ date: SUNDAY, session_type: 'gym', status: 'planned', source_type: 'manual' });
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_CONFLICT');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(1);
  });

  it('a changed Blueprint commit since generation is detected as staleness (422 AI_PROPOSAL_STALE)', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    db.prepare('UPDATE ai_program_proposals SET blueprint_commit = ? WHERE id = ?').run('a-different-blueprint-commit', proposalId);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
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

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('AI_PROPOSAL_STALE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('malformed stored proposal JSON cannot be committed', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    db.prepare('UPDATE ai_program_proposals SET proposal_json = ? WHERE id = ?').run('{not valid json', proposalId);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).not.toBe(200);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('at aiproposalrepo'); // no stack trace leak
  });

  it('a persistence failure mid-commit rolls back: no orphaned session, proposal stays approved', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    // Cleanup pass §1: this distinctive internal message must never
    // reach the client OR be persisted into `failure_reason` — it
    // stands in for something a raw error could plausibly contain (a
    // SQL constraint name, a column name, etc.).
    const DISTINCTIVE_INTERNAL_MESSAGE = 'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed on internal_table_xyz';
    const spy = vi.spyOn(WorkoutSessionsRepo.prototype, 'addExercisePerformance').mockImplementation(() => {
      throw new Error(DISTINCTIVE_INTERNAL_MESSAGE);
    });

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('AI_PROPOSAL_COMMIT_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(DISTINCTIVE_INTERNAL_MESSAGE); // API response stays generic
    spy.mockRestore();

    // Atomicity: the half-created session must not have been left behind.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    const getRes = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(getRes.body.status).toBe('approved'); // never advanced to committed
    expect(getRes.body.committedSessionId).toBeNull();

    // The persisted failure_reason must be a safe, fixed category — not
    // the raw error message or a stack trace.
    const stored = db.prepare('SELECT failure_reason FROM ai_program_proposals WHERE id = ?').get(proposalId) as {
      failure_reason: string | null;
    };
    expect(stored.failure_reason).not.toContain(DISTINCTIVE_INTERNAL_MESSAGE);
    expect(stored.failure_reason).not.toContain('SQLITE_CONSTRAINT');
    expect(stored.failure_reason).toBe('commit_transaction_failed');
  });

  it('respects the AI_PROGRAMMER_ENABLED flag — disabled commit returns 503, never persists', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    delete process.env.AI_PROGRAMMER_ENABLED;
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(503);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('the commit response never contains a raw provider payload or API key', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-real');
  });
});

describe('commit preserves the full prescription (correction: reps/RIR/rest were previously dropped)', () => {
  it('an approved proposal with distinctive reps/RIR/rest is committed with that exact prescription intact, not written into performed-value fields', async () => {
    // ab-wheel-rollout/rectus-abdominis has no Blueprint-authored
    // prescription (confirmed in earlier phases' fixtures), so these
    // exact, deliberately unusual numbers are NOT overridden by an
    // authored-prescription exact-match check — they are genuinely the
    // AI's own free choice, and are exactly what must survive commit.
    const proposalId = await generateProposal({
      exerciseId: 'ab-wheel-rollout',
      targetType: 'physique_target',
      targetId: 'rectus-abdominis',
      sets: 5,
      repsMin: 7,
      repsMax: 11,
      rirMin: 2,
      rirMax: 4,
      restSeconds: 137,
    });
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const commitRes = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(commitRes.status).toBe(200);
    const sessionId = commitRes.body.committedSessionId as string;

    // Read the resulting planned workout back through the real HTTP API
    // (GET /api/workouts/:id), the same endpoint any client would use —
    // not just the internal repo state.
    const sessionRes = await request(app).get(`/api/workouts/${sessionId}`);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.status).toBe('planned');
    const exercise = sessionRes.body.exercises[0];
    expect(exercise.exercise_id).toBe('ab-wheel-rollout');

    // The PLANNED prescription is fully preserved...
    expect(exercise.target_sets).toBe(5);
    expect(exercise.target_reps_min).toBe(7);
    expect(exercise.target_reps_max).toBe(11);
    expect(exercise.target_rir_min).toBe(2);
    expect(exercise.target_rir_max).toBe(4);
    expect(exercise.target_rest_seconds).toBe(137);

    // ...and it lives in the prescription fields, never smuggled into
    // the PERFORMED per-set fields, which must all still read as "not
    // yet performed" (null/false) despite this rich prescription.
    expect(exercise.sets).toHaveLength(5);
    for (const set of exercise.sets) {
      expect(set.reps).toBeNull();
      expect(set.weight).toBeNull();
      expect(set.rir).toBeNull();
      expect(set.rpe).toBeNull();
      expect(set.rest_seconds).toBeNull();
      expect(set.completed).toBe(false);
    }
  });
});

describe('commit-time staleness detection beyond Blueprint-commit equality', () => {
  it('contextHash is audit metadata, not an equality gate: an unrelated context-affecting change (a new active goal) does not by itself block commit', async () => {
    // Directly demonstrates the documented design decision: adding a
    // goal changes what a freshly-built AIProgrammerContext (and thus
    // its contextHash) looks like, but has no bearing on whether THIS
    // proposal's own exercises/prescription are still valid, so commit
    // must still succeed.
    const proposalId = await generateProposal();
    const { GoalsRepo } = await import('../../src/repositories/goalsRepo.js');
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1, active: true });

    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(200);
  });

  it('a proposal whose stored sets/reps/RIR drifted from Blueprint\'s authored prescription is rejected at commit (422 AI_PROPOSAL_STALE)', async () => {
    // flat-barbell-bench-press/mid-pec has an authored prescription of
    // exactly {sets:3, repsMin:6, repsMax:12, rirMin:1, rirMax:3}
    // (used unmodified by generateProposal()'s default fixture) — a
    // fresh domain revalidation at commit time re-derives that SAME
    // authored truth from Blueprint and must catch a stored value that
    // no longer matches it, exactly as if the model had proposed
    // something invalid in the first place.
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const stored = db.prepare('SELECT proposal_json FROM ai_program_proposals WHERE id = ?').get(proposalId) as { proposal_json: string };
    const tampered = JSON.parse(stored.proposal_json);
    tampered.exercises[0].sets = 8; // authored cap is 3 — this is a drift/tamper, not the original valid value
    db.prepare('UPDATE ai_program_proposals SET proposal_json = ? WHERE id = ?').run(JSON.stringify(tampered), proposalId);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('AI_PROPOSAL_STALE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('a proposal retargeted (post-generation) at an approved outside-Blueprint exercise is still rejected — this milestone accepts source: "blueprint" only', async () => {
    // The outside-Blueprint catalogue is a SEPARATE, application-level
    // approval gate (src/repositories/outsideBlueprintExercisesRepo.ts)
    // from Blueprint's own exercise pool. Even a fully-approved entry
    // there is not a "known Blueprint exercise" — BlueprintAdapter.
    // isKnownExercise() (used inside validateProposalDomain) never
    // resolves it, so it must still be rejected at commit-time
    // revalidation exactly like any other unknown exerciseId.
    const outsideEx = new OutsideBlueprintExercisesRepo(db).propose({
      name: 'Test Outside Exercise',
      justification_category: 'meaningful_advantage',
      justification_text: 'test fixture',
      target_type: 'physique_target',
      target_id: 'mid-pec',
      role: 'primary',
      equipment: ['bodyweight'],
      reps_range: '8-12',
      rir_range: '1-3',
    });
    new OutsideBlueprintExercisesRepo(db).approve(outsideEx.id);

    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const stored = db.prepare('SELECT proposal_json FROM ai_program_proposals WHERE id = ?').get(proposalId) as { proposal_json: string };
    const tampered = JSON.parse(stored.proposal_json);
    tampered.exercises[0].exerciseId = outsideEx.id;
    tampered.exercises[0].source = 'blueprint'; // stored shape must still structurally validate; only the id is swapped
    db.prepare('UPDATE ai_program_proposals SET proposal_json = ? WHERE id = ?').run(JSON.stringify(tampered), proposalId);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('AI_PROPOSAL_STALE');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });
});

// Discovery/Rehydration
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PROPOSAL_DISCOVERY_REHYDRATION.md
// §3/§8): "is there an existing relevant AI proposal for this target
// date?" — the frontend's rehydration entry point. Reuses the exact
// same response shape (`serializeProposal`) as GET /proposals/:id, so
// most of these tests assert against that shared contract rather than a
// new one.
describe('GET /api/ai-programmer/proposals/latest', () => {
  const MONDAY = '2026-09-14';

  /** Same shape as the shared `generateProposal()` helper above, but for
   * an arbitrary target date/weekday — needed to exercise the "belongs
   * to a different date" and ordering tests below without disturbing
   * any existing test's use of the SUNDAY-only helper. */
  async function generateProposalForDate(targetDate: string, weekday: string, exerciseOverrides: Record<string, unknown> = {}): Promise<string> {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          output: JSON.stringify(
            validProposalJson({
              targetDate,
              weekday,
              exercises: [{ ...validProposalJson().exercises[0], ...exerciseOverrides }],
            })
          ),
        },
      })
    );
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate });
    expect(res.status).toBe(200);
    return res.body.proposalId as string;
  }

  it('returns found:false when no proposal has ever been generated for the date (not an error)', async () => {
    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, found: false });
  });

  it('returns the latest relevant proposal for a target date, matching GET /proposals/:id exactly', async () => {
    const proposalId = await generateProposal();
    const byId = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    const latest = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(latest.status).toBe(200);
    expect(latest.body).toEqual({ ok: true, found: true, ...byId.body });
  });

  it('uses deterministic ordering — the most recently CREATED proposal for the date wins, regardless of table insertion order', async () => {
    const olderId = await generateProposal();
    const newerId = await generateProposal();
    // Force explicit, unambiguous created_at values so this asserts
    // real ordering by timestamp, not incidental insertion speed.
    db.prepare('UPDATE ai_program_proposals SET created_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', olderId);
    db.prepare('UPDATE ai_program_proposals SET created_at = ? WHERE id = ?').run('2026-09-02T00:00:00.000Z', newerId);

    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.body.proposalId).toBe(newerId);
  });

  it('does not return an expired proposal as active — reports (and persists) effective status "expired" once past expiresAt', async () => {
    const proposalId = await generateProposal();
    db.prepare("UPDATE ai_program_proposals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(proposalId);

    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.body.found).toBe(true);
    expect(res.body.status).toBe('expired');
    expect(db.prepare('SELECT status FROM ai_program_proposals WHERE id = ?').get(proposalId)).toEqual({ status: 'expired' });
  });

  it('a rejected proposal is reported as rejected, not treated as active', async () => {
    const proposalId = await generateProposal();
    db.prepare("UPDATE ai_program_proposals SET status = 'rejected', rejected_at = ? WHERE id = ?").run('2026-09-13T00:00:00.000Z', proposalId);

    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.body.found).toBe(true);
    expect(res.body.status).toBe('rejected');
  });

  it('handles a missing targetDate query parameter with a 400, not a crash or a false "not found"', async () => {
    const res = await request(app).get('/api/ai-programmer/proposals/latest');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('handles a malformed targetDate with a 400', async () => {
    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: 'not-a-real-date' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('never exposes provider payloads, API keys, or internal fields — same sanitized shape as GET /proposals/:id, plus only "found"', async () => {
    const proposalId = await generateProposal();
    const byId = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(Object.keys(res.body).sort()).toEqual([...Object.keys(byId.body), 'found'].sort());
    const raw = JSON.stringify(res.body);
    expect(raw.toLowerCase()).not.toMatch(/velona_api_key|test-key-not-real|authorization|stack/);
  });

  it('correctly reflects pending, approved, and committed states as the proposal progresses', async () => {
    const proposalId = await generateProposal();
    let res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.body.status).toBe('pending');

    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.body.status).toBe('approved');

    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.body.status).toBe('committed');
    expect(res.body.committedSessionId).toBeTruthy();
  });

  it('never returns a proposal belonging to a different target date', async () => {
    const sundayId = await generateProposal();
    const mondayId = await generateProposalForDate(MONDAY, 'monday');

    const sundayRes = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(sundayRes.body.proposalId).toBe(sundayId);
    expect(sundayRes.body.targetDate).toBe(SUNDAY);

    const mondayRes = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: MONDAY });
    expect(mondayRes.body.proposalId).toBe(mondayId);
    expect(mondayRes.body.targetDate).toBe(MONDAY);
  });

  it('respects the AI_PROGRAMMER_ENABLED flag — disabled discovery returns 503, before touching the database', async () => {
    const proposalId = await generateProposal();
    delete process.env.AI_PROGRAMMER_ENABLED;
    const res = await request(app).get('/api/ai-programmer/proposals/latest').query({ targetDate: SUNDAY });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI_PROGRAMMER_DISABLED');
    void proposalId; // only asserting the flag short-circuits before any lookup
  });
});

// AI Activity Alignment / Non-Regenerative Schedule Fixes
// (docs/CLAUDE_TASK_AI_ACTIVITY_ALIGNMENT_AND_NON_REGENERATIVE_SCHEDULE_FIXES.md
// Part 3): commit's `intent` field and its weekly-activity alignment
// side effect. SUNDAY (2026-09-13) is NOT in this fixture's
// training_days (['monday','tuesday','thursday','friday']) and has no
// other_activity_schedule entry, so it is 'unselected' (Rest) by
// default — exactly the "Rest day" case Part 3 describes. MONDAY
// (2026-09-14) IS a training day, so it starts out already Gym.
describe('POST /api/ai-programmer/proposals/:proposalId/commit — intent (Part 3)', () => {
  const MONDAY = '2026-09-14';

  async function generateProposalForDate(targetDate: string, weekday: string, exercises?: unknown[]): Promise<string> {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: { output: JSON.stringify(validProposalJson(exercises ? { targetDate, weekday, exercises } : { targetDate, weekday })) },
      })
    );
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate });
    expect(res.status).toBe(200);
    return res.body.proposalId as string;
  }

  function effectiveActivityFor(targetDate: string): string {
    // Mirrors src/ai-programmer/service/aiProposalLifecycle.ts's own
    // effectiveActivityForDate — re-derived here from the real repos
    // rather than imported, so this test independently verifies the
    // real persisted override state, not the same code path under test.
    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    const weekStart = programmingWeekStart(targetDate);
    const weekday = weekdayOfDate(targetDate);
    const overrides = new WeekActivityOverridesRepo(db).get(profile.id, weekStart);
    const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
    return deriveDailyActivity(weekday, effective.trainingDays, effective.otherActivitySchedule);
  }

  it('Fix 1 (Option A): intent omitted is rejected with 400 — no session created, no override written, proposal not committed', async () => {
    expect(effectiveActivityFor(SUNDAY)).toBe('unselected');
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/intent/i);

    expect(effectiveActivityFor(SUNDAY)).toBe('unselected'); // never touched
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0); // no session created
    const getRes = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(getRes.body.status).toBe('approved'); // never advanced to committed
  });

  it('Fix 1: intent omitted on a Badminton day is also rejected with 400', async () => {
    const BADMINTON_DAY = '2026-09-16'; // Wednesday — not a training day in this fixture
    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    new WeekActivityOverridesRepo(db).setOverride(profile.id, programmingWeekStart(BADMINTON_DAY), 'wednesday', 'badminton');
    expect(effectiveActivityFor(BADMINTON_DAY)).toBe('badminton');

    const proposalId = await generateProposalForDate(BADMINTON_DAY, 'wednesday');
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`);
    expect(res.status).toBe(400);
    expect(effectiveActivityFor(BADMINTON_DAY)).toBe('badminton');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(BADMINTON_DAY)).toHaveLength(0);
  });

  it('intent: "replace_day_activity" on a Rest day aligns the weekly override to Gym, in the same request', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(200);
    expect(effectiveActivityFor(SUNDAY)).toBe('gym');
  });

  it('Fix 2: "replace_day_activity" never invokes full program generation — no program_sessions row is created for the day', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' }).expect(200);

    // The deterministic planner/reconciliation writes `program_sessions`
    // rows (WeeklyProgramRepo) — commit must never call it, so this
    // week's persisted program (if it even exists yet) has no row for
    // Sunday's day_index.
    const weekStart = programmingWeekStart(SUNDAY);
    const program = new WeeklyProgramRepo(db).getByWeekStart(weekStart);
    const sundayDayIndex = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].indexOf(weekdayOfDate(SUNDAY));
    expect(program?.sessions.find((s) => s.day_index === sundayDayIndex)).toBeUndefined();
  });

  it('intent: "fill_existing_gym_day" on a Rest day is rejected (409 AI_COMMIT_INTENT_MISMATCH) — the caller\'s assumption about the day is wrong', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'fill_existing_gym_day' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_COMMIT_INTENT_MISMATCH');
    // Rejected before writing anything.
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
    expect(effectiveActivityFor(SUNDAY)).toBe('unselected');
    const getRes = await request(app).get(`/api/ai-programmer/proposals/${proposalId}`);
    expect(getRes.body.status).toBe('approved'); // never advanced to committed
  });

  it('intent: "fill_existing_gym_day" on an ALREADY-gym day succeeds and never writes an override', async () => {
    expect(effectiveActivityFor(MONDAY)).toBe('gym');
    const proposalId = await generateProposalForDate(MONDAY, 'monday');
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'fill_existing_gym_day' });
    expect(res.status).toBe(200);
    expect(effectiveActivityFor(MONDAY)).toBe('gym');
  });

  it('Final AI-Deterministic Precedence Fixes §1: fill_existing_gym_day on a day with an EXISTING deterministic prescription supersedes it and records provenance', async () => {
    // Trigger real deterministic generation for Monday's week first, so
    // a persisted program_sessions row genuinely exists to supersede —
    // this is the exact "AI fills a day that already has a generated
    // prescription" scenario the spec describes.
    const weekRes = await request(app).get('/api/programming/week').query({ date: MONDAY });
    const mondayBefore = weekRes.body.days.find((d: any) => d.weekday === 'monday');
    expect(mondayBefore.plannedWork.length).toBeGreaterThan(0);
    expect(mondayBefore.plannedSession).toBeNull();

    // A richer, Push-adequate proposal (Monday's persisted deterministic
    // session is 'push' by this point, so the new programming-adequacy
    // validation — see programmerAdequacyValidator.ts — now applies;
    // the single-exercise default fixture used elsewhere in this file
    // is deliberately NOT adequate for a real Push session).
    const proposalId = await generateProposalForDate(MONDAY, 'monday', [
      { exerciseId: 'incline-dumbbell-press', role: 'primary', targetType: 'physique_target', targetId: 'upper-pec', sets: 3, repsMin: 8, repsMax: 12, rirMin: 1, rirMax: 2, rationale: ['Upper pec coverage.'], source: 'blueprint' },
      { exerciseId: 'overhead-triceps-extension', role: 'primary', targetType: 'physique_target', targetId: 'triceps-long-head', sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3, rationale: ['Triceps long-head coverage.'], source: 'blueprint' },
      { exerciseId: 'cable-lateral-raise', role: 'primary', targetType: 'physique_target', targetId: 'side-delt', sets: 2, repsMin: 8, repsMax: 15, rirMin: 1, rirMax: 3, rationale: ['Side-delt coverage.'], source: 'blueprint' },
    ]);
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);
    const commitRes = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'fill_existing_gym_day' });
    expect(commitRes.status).toBe(200);

    const weekAfter = await request(app).get('/api/programming/week').query({ date: MONDAY });
    const mondayAfter = weekAfter.body.days.find((d: any) => d.weekday === 'monday');
    expect(mondayAfter.plannedWork).toEqual([]); // deterministic plan no longer shown as current
    expect(mondayAfter.plannedSession).toMatchObject({ id: commitRes.body.committedSessionId, source: 'ai', status: 'planned' });
    expect(typeof mondayAfter.supersedesProgramSessionId).toBe('string');

    const todayRes = await request(app).get('/api/programming/today').query({ date: MONDAY });
    expect(todayRes.body.plannedSession).toMatchObject({ id: commitRes.body.committedSessionId, source: 'ai' });
  });

  it('intent: "replace_day_activity" on an already-gym day is a harmless no-op for the override (still succeeds)', async () => {
    const proposalId = await generateProposalForDate(MONDAY, 'monday');
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(200);
    expect(effectiveActivityFor(MONDAY)).toBe('gym');
  });

  it('rejects an unrecognized intent value with 400, before touching the database', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'do_something_else' });
    expect(res.status).toBe(400);
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });

  it('repeated commit with intent is still idempotent — the second call returns the same committed session without re-checking intent', async () => {
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const first = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(first.status).toBe(200);
    // A second call with a MISMATCHED intent must still succeed
    // idempotently — the proposal is already committed, so intent
    // validation (which only applies to the pending->committed
    // transition) never runs again.
    const second = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'fill_existing_gym_day' });
    expect(second.status).toBe(200);
    expect(second.body.committedSessionId).toBe(first.body.committedSessionId);
  });

  it('a persistence failure mid-commit rolls back the alignment override too — no orphaned override on a failed commit', async () => {
    expect(effectiveActivityFor(SUNDAY)).toBe('unselected');
    const proposalId = await generateProposal();
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`);

    const spy = vi.spyOn(WorkoutSessionsRepo.prototype, 'addExercisePerformance').mockImplementation(() => {
      throw new Error('SQLITE_CONSTRAINT: simulated failure');
    });

    const res = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' });
    expect(res.status).toBe(500);
    spy.mockRestore();

    // The override write happened INSIDE the same transaction as
    // session creation — a mid-transaction failure must roll back both,
    // never leaving the week's activity silently changed to Gym while
    // no real session actually exists for that date.
    expect(effectiveActivityFor(SUNDAY)).toBe('unselected');
    expect(new WorkoutSessionsRepo(db).listSessionsByDate(SUNDAY)).toHaveLength(0);
  });
});
