// "Duplicate AI programs" fix (2026-09-23): reported live — a user ended
// up with two separate AI-generated programs for the same day (one via
// single-day generate, one via week-reconciliation) with no way to
// remove either one short of waiting for natural expiry. Adds:
//   - DELETE /api/workouts/:id — removes a real (never in_progress/
//     completed) session outright.
//   - POST /api/ai-programmer/proposals/:id/reject and
//     /week-reconciliations/:id/reject — explicit discard for a
//     pending/approved (never committed) record.

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

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function validSessionProposalJson(targetDate: string, weekday: string) {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'model-provided-id-discarded',
    mode: 'generate_session',
    targetDate,
    weekday,
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
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['thursday'] as any,
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
  vi.restoreAllMocks();
  delete process.env.AI_PROGRAMMER_ENABLED;
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
});

async function getWeek() {
  const res = await request(app).get('/api/programming/week').expect(200);
  return res.body;
}

describe('DELETE /api/workouts/:id', () => {
  it('deletes a planned session outright, cascading to its exercises', async () => {
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: '2026-09-25', session_type: 'gym', status: 'planned', source_type: 'ai' });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: 'flat-barbell-bench-press',
      order: 0,
      role: 'primary',
      sets: [{ set_number: 1, weight: null, reps: null, completed: false }],
    });

    await request(app).delete(`/api/workouts/${session.session_id}`).expect(204);

    expect(sessionsRepo.getSession(session.session_id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) as c FROM workout_exercises WHERE workout_session_id = ?').get(session.session_id)).toEqual({ c: 0 });
  });

  it('refuses to delete an in-progress session (real training in progress)', async () => {
    const session = new WorkoutSessionsRepo(db).createSession({ date: '2026-09-25', session_type: 'gym', status: 'in_progress' });
    const res = await request(app).delete(`/api/workouts/${session.session_id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORKOUT_SESSION_NOT_DELETABLE');
    expect(new WorkoutSessionsRepo(db).getSession(session.session_id)).toBeDefined();
  });

  it('refuses to delete a completed session (real logged history)', async () => {
    const session = new WorkoutSessionsRepo(db).createSession({ date: '2026-09-25', session_type: 'gym', status: 'completed', duration_minutes: 45 });
    const res = await request(app).delete(`/api/workouts/${session.session_id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORKOUT_SESSION_NOT_DELETABLE');
  });

  it('404s for an unknown session id', async () => {
    await request(app).delete('/api/workouts/wsession_does-not-exist').expect(404);
  });

  it('nulls out committed_session_id on the proposal that committed it, rather than leaving it dangling', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/approve`).expect(200);
    const commitRes = await request(app)
      .post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/commit`)
      .send({ intent: 'replace_day_activity' })
      .expect(200);

    await request(app).delete(`/api/workouts/${commitRes.body.committedSessionId}`).expect(204);

    const proposal = await request(app).get(`/api/ai-programmer/proposals/${genRes.body.proposalId}`).expect(200);
    expect(proposal.body.committedSessionId).toBeNull();
    expect(proposal.body.status).toBe('committed'); // the proposal record itself is untouched, only the dangling FK
  });

  it('the day is generate-able again after deleting the session that was blocking it', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/approve`).expect(200);
    const commitRes = await request(app)
      .post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/commit`)
      .send({ intent: 'replace_day_activity' })
      .expect(200);

    const weekWithSession = await getWeek();
    expect(weekWithSession.days.find((d: any) => d.date === wednesday.date).plannedSession).not.toBeNull();

    await request(app).delete(`/api/workouts/${commitRes.body.committedSessionId}`).expect(204);

    const weekAfterDelete = await getWeek();
    expect(weekAfterDelete.days.find((d: any) => d.date === wednesday.date).plannedSession).toBeNull();

    // A brand new generate-session call for the same date now succeeds cleanly.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const secondGenRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date });
    expect(secondGenRes.status).toBe(200);
    expect(secondGenRes.body.proposalId).not.toBe(genRes.body.proposalId);
  });
});

describe('POST /api/ai-programmer/proposals/:proposalId/reject', () => {
  it('discards a pending proposal', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);

    const rejectRes = await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/reject`).expect(200);
    expect(rejectRes.body.status).toBe('rejected');
    expect(rejectRes.body.rejectedAt).toBeTruthy();
  });

  it('discards an approved (but not committed) proposal', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/approve`).expect(200);

    const rejectRes = await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/reject`).expect(200);
    expect(rejectRes.body.status).toBe('rejected');
  });

  it('is idempotent on an already-rejected proposal', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/reject`).expect(200);

    const second = await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/reject`).expect(200);
    expect(second.body.status).toBe('rejected');
  });

  it('refuses to reject a committed proposal — a real session already exists for it', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/approve`).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/commit`).send({ intent: 'replace_day_activity' }).expect(200);

    const res = await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/reject`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_PROPOSAL_INVALID_STATE');
  });

  it('the day is generate-able again after rejecting the proposal that was blocking it', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    await request(app).post(`/api/ai-programmer/proposals/${genRes.body.proposalId}/reject`).expect(200);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const secondGenRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date });
    expect(secondGenRes.status).toBe(200);
  });
});

describe('POST /api/ai-programmer/week-reconciliations/:reconciliationId/reject', () => {
  function validReconciliationJson(targetDate: string, days: Array<{ date: string; weekday: string }>) {
    return {
      schemaVersion: 'ai-week-reconciliation.v1',
      proposalId: 'model-provided-id-discarded',
      mode: 'reconcile_week',
      targetDate,
      requestedActivity: 'gym',
      days: days.map((d) => ({
        date: d.date,
        weekday: d.weekday,
        activity: d.date === targetDate ? 'gym' : 'unselected',
        changeType: d.date === targetDate ? 'modified' : 'unchanged',
        locked: false,
        session:
          d.date === targetDate
            ? {
                sessionPurpose: 'push',
                availableMinutes: 60,
                estimatedMinutes: 45,
                exercises: [
                  {
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
                    rationale: [],
                    source: 'blueprint',
                  },
                ],
                skipped: [],
              }
            : null,
      })),
      reconciliation: { changedDates: [targetDate], preservedLockedDates: [], rationale: 'Reorganize.', warnings: [] },
    };
  }

  it('discards a pending reconciliation, and the day is generate-able again', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validReconciliationJson(wednesday.date, weekBefore.days)) } }));
    const genRes = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: wednesday.date, requestedActivity: 'gym' }).expect(200);

    const rejectRes = await request(app).post(`/api/ai-programmer/week-reconciliations/${genRes.body.reconciliationId}/reject`).expect(200);
    expect(rejectRes.body.status).toBe('rejected');

    const found = await request(app).get(`/api/ai-programmer/week-reconciliations/latest?targetDate=${wednesday.date}`).expect(200);
    expect(found.body.status).toBe('rejected'); // discovery still reports it, just as rejected — no longer actionable
  });

  it('refuses to reject a committed reconciliation', async () => {
    const weekBefore = await getWeek();
    const wednesday = weekBefore.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validReconciliationJson(wednesday.date, weekBefore.days)) } }));
    const genRes = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: wednesday.date, requestedActivity: 'gym' }).expect(200);
    await request(app).post(`/api/ai-programmer/week-reconciliations/${genRes.body.reconciliationId}/approve`).expect(200);
    await request(app).post(`/api/ai-programmer/week-reconciliations/${genRes.body.reconciliationId}/commit`).expect(200);

    const res = await request(app).post(`/api/ai-programmer/week-reconciliations/${genRes.body.reconciliationId}/reject`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI_WEEK_RECONCILIATION_INVALID_STATE');
  });
});
