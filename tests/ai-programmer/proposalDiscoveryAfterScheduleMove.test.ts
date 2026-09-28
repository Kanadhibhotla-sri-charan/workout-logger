// Production incident (2026-09-23): a user generated+committed a
// single-day AI proposal onto a Rest day, then later swapped that day
// with another gym day via /week/swap. The real committed session
// correctly moved (per scheduleOperations.ts's own contract), but the
// proposal record's own `target_date` column — written once, at
// generation time, and never touched by swap/move — kept pointing at
// the ORIGINAL date. Reopening that original day's modal therefore kept
// showing the proposal's frozen, commit-time exercise list (via GET
// /proposals/latest?targetDate=...) laid right alongside whatever real
// content the swap had put there instead — the exact "seeing both
// programs" symptom reported live. This never touches swapDayActivities/
// moveActivity themselves (they behave correctly); the fix lives entirely
// in discovery: a committed record whose real session has moved
// elsewhere (or been deleted) is no longer reported as the active
// proposal for its old date.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/programmerTypes.js';
import { AI_WEEK_RECONCILIATION_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/weekReconciliationTypes.js';
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

function validSessionProposalJson(targetDate: string, weekday: string, overrides: Record<string, unknown> = {}) {
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
    training_days: ['thursday'] as any, // Wednesday starts as Rest
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
  // Deliberately no active Goal: this test is about proposal/
  // reconciliation discovery after a schedule swap, not goal-adequacy
  // validation — matching aiProposalRoutes.test.ts's own baseline setup
  // (goal-adequacy scenarios there are opted into per-test, not global).

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Deliberately NOT enabled yet: the very first GET /week below (which
  // every test uses to read this week's real dates) must generate the
  // week deterministically, not via a real/mocked AI call. Each test
  // enables AI_PROGRAMMER_ENABLED itself, right before its own
  // generate-session/reconcile-week call, once that initial read is done.
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

describe('GET /proposals/latest — a committed proposal whose real session has since been swapped to a different date', () => {
  it('is no longer reported for its original date, once its committed session has moved elsewhere', async () => {
    const before = await getWeek();
    const wednesday = before.days.find((d: any) => d.weekday === 'wednesday'); // Rest
    const thursday = before.days.find((d: any) => d.weekday === 'thursday'); // Gym
    process.env.AI_PROGRAMMER_ENABLED = 'true';

    // Generate + approve + commit a single-day proposal onto Wednesday
    // (Rest -> Gym), exactly like the real single-day "Generate this day
    // with AI" flow.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    const proposalId = genRes.body.proposalId as string;
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`).expect(200);
    const commitRes = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' }).expect(200);
    const committedSessionId = commitRes.body.committedSessionId as string;
    expect(typeof committedSessionId).toBe('string');

    // Sanity: discovery correctly finds it on Wednesday right after commit.
    const rightAfterCommit = await request(app).get(`/api/ai-programmer/proposals/latest?targetDate=${wednesday.date}`).expect(200);
    expect(rightAfterCommit.body.found).toBe(true);
    expect(rightAfterCommit.body.committedSessionId).toBe(committedSessionId);

    // Swap Wednesday <-> Thursday — a pure schedule operation, no AI
    // involved, moving the just-committed session's real date along with
    // it (scheduleOperations.ts's own documented, tested behavior).
    await request(app).post('/api/programming/week/swap').send({ dayA: 'wednesday', dayB: 'thursday' }).expect(200);
    expect(new WorkoutSessionsRepo(db).getSession(committedSessionId)!.date).toBe(thursday.date); // really moved

    // The bug: without the fix, this still reports the proposal as
    // active for Wednesday, showing its frozen commit-time exercise list
    // there even though the real session now lives on Thursday.
    const afterSwap = await request(app).get(`/api/ai-programmer/proposals/latest?targetDate=${wednesday.date}`).expect(200);
    expect(afterSwap.body.found).toBe(false);

    // It's also never reported for Thursday (the new date) — the day's
    // own plannedSession field (verified elsewhere) is the correct way
    // to see the real, current content; a NEW proposal for Thursday
    // still shows nothing until one is actually generated for it.
    const forNewDate = await request(app).get(`/api/ai-programmer/proposals/latest?targetDate=${thursday.date}`).expect(200);
    expect(forNewDate.body.found).toBe(false);
  });

  it('is no longer reported once its committed session has been deleted entirely', async () => {
    const before = await getWeek();
    const wednesday = before.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);
    const proposalId = genRes.body.proposalId as string;
    await request(app).post(`/api/ai-programmer/proposals/${proposalId}/approve`).expect(200);
    const commitRes = await request(app).post(`/api/ai-programmer/proposals/${proposalId}/commit`).send({ intent: 'replace_day_activity' }).expect(200);

    db.prepare('DELETE FROM workout_sessions WHERE session_id = ?').run(commitRes.body.committedSessionId);

    const afterDelete = await request(app).get(`/api/ai-programmer/proposals/latest?targetDate=${wednesday.date}`).expect(200);
    expect(afterDelete.body.found).toBe(false);
  });

  it('a still-pending or still-approved proposal (never committed) is unaffected — discovery still finds it normally', async () => {
    const before = await getWeek();
    const wednesday = before.days.find((d: any) => d.weekday === 'wednesday');
    process.env.AI_PROGRAMMER_ENABLED = 'true';

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: JSON.stringify(validSessionProposalJson(wednesday.date, 'wednesday')) } }));
    const genRes = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: wednesday.date }).expect(200);

    const found = await request(app).get(`/api/ai-programmer/proposals/latest?targetDate=${wednesday.date}`).expect(200);
    expect(found.body.found).toBe(true);
    expect(found.body.status).toBe('pending');
    expect(found.body.proposalId).toBe(genRes.body.proposalId);
  });
});

describe('GET /week-reconciliations/latest — same fix, for a committed week reconciliation', () => {
  function validReconciliationJson(weekStart: string, targetDate: string, days: Array<{ date: string; weekday: string; activity: string; changeType: string; hasExercise: boolean }>) {
    return {
      schemaVersion: AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
      proposalId: 'model-provided-id-discarded',
      mode: 'reconcile_week',
      targetDate,
      requestedActivity: 'gym',
      days: days.map((d) => ({
        date: d.date,
        weekday: d.weekday,
        activity: d.activity,
        changeType: d.changeType,
        locked: false,
        session:
          d.activity === 'gym'
            ? {
                sessionPurpose: 'push',
                availableMinutes: 60,
                estimatedMinutes: 45,
                exercises: d.hasExercise
                  ? [
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
                    ]
                  : [],
                skipped: [],
              }
            : null,
      })),
      reconciliation: { changedDates: [targetDate], preservedLockedDates: [], rationale: 'Reorganize.', warnings: [] },
    };
  }

  it('a committed reconciliation is no longer reported for its original date once its real session has moved elsewhere', async () => {
    const before = await getWeek();
    const wednesday = before.days.find((d: any) => d.weekday === 'wednesday');
    const thursday = before.days.find((d: any) => d.weekday === 'thursday');
    const allDays = before.days.map((d: any) => ({
      date: d.date,
      weekday: d.weekday,
      activity: d.date === wednesday.date ? 'gym' : d.type === 'gym' ? 'gym' : 'unselected',
      changeType: d.date === wednesday.date ? 'modified' : 'unchanged',
      hasExercise: d.date === wednesday.date,
    }));
    process.env.AI_PROGRAMMER_ENABLED = 'true';

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { output: JSON.stringify(validReconciliationJson(before.weekStart, wednesday.date, allDays)) } })
    );
    const genRes = await request(app).post('/api/ai-programmer/reconcile-week').send({ targetDate: wednesday.date, requestedActivity: 'gym' }).expect(200);
    const reconciliationId = genRes.body.reconciliationId as string;
    await request(app).post(`/api/ai-programmer/week-reconciliations/${reconciliationId}/approve`).expect(200);
    const commitRes = await request(app).post(`/api/ai-programmer/week-reconciliations/${reconciliationId}/commit`).expect(200);
    const committedSessionId = commitRes.body.committedSessionId as string;

    await request(app).post('/api/programming/week/swap').send({ dayA: 'wednesday', dayB: 'thursday' }).expect(200);
    expect(new WorkoutSessionsRepo(db).getSession(committedSessionId)!.date).toBe(thursday.date);

    const afterSwap = await request(app).get(`/api/ai-programmer/week-reconciliations/latest?targetDate=${wednesday.date}`).expect(200);
    expect(afterSwap.body.found).toBe(false);
  });
});
