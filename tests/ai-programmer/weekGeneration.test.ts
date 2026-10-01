// Explicit week generation (2026-10-01): GET never generates; POST
// /generate-week creates per-day pending proposals through the SAME
// planned generate_session machinery, behind a durable per-week guard.
// Real Blueprint data, real context builder and SessionPlan; the AI is a
// fake that answers with a plan-conformant proposal built from the planned
// context it is sent (service tests), or a stubbed fetch through the real
// Velona client (route tests). No network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { AIProposalRepo } from '../../src/repositories/aiProposalRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WeekGenerationRunRepo } from '../../src/repositories/weekGenerationRunRepo.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import {
  allowedGenerationWeeks,
  endOfLocalDateIso,
  projectedSessionsBefore,
  readWeekGenerationState,
  startWeekGeneration,
  weekGymDays,
} from '../../src/ai-programmer/service/weekGeneration.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { applyProjectedSessions } from '../../src/ai-programmer/context/projectedExposure.js';
import { approveProposal, commitAIProposalToPlannedSession } from '../../src/ai-programmer/service/aiProposalLifecycle.js';
import { AIProviderAuthenticationError, AIProgrammerError } from '../../src/ai-programmer/errors.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { addDays } from '../../src/engine/dateMath.js';

// The REAL planner, with a refusal injected for chosen dates — when the planner
// refuses is proven in sessionPlanner.test.ts; here only the week service's
// handling of a refusal is under test.
const refuseDates = new Set<string>();
vi.mock('../../src/ai-programmer/planning/sessionPlanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai-programmer/planning/sessionPlanner.js')>();
  return {
    ...actual,
    planSession: (context: any, options: any) => {
      const plan = actual.planSession(context, options);
      return refuseDates.has(context.targetDate) ? { ...plan, refusals: [{ code: 'REQUIRED_GOAL_INFEASIBLE', targetIds: ['brachialis-arm-thickness'] }] } : plan;
    },
  };
});

// ---------------------------------------------------------------- clock + fixtures

/** A Monday ~2 months ahead (clock-relative, never rots into the past). */
function futureMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 61);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const MONDAY = futureMonday();
const TUESDAY = addDays(MONDAY, 1);
const THURSDAY = addDays(MONDAY, 3);
const FRIDAY = addDays(MONDAY, 4);
const SATURDAY = addDays(MONDAY, 5);
/** Pin "now" (Date only — timers stay real) to 08:30 Asia/Kolkata on `date`. */
const pinClock = (date: string) => vi.setSystemTime(new Date(`${date}T03:00:00.000Z`));

let db: Database.Database;

function seed(equipment = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate']) {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: equipment,
    other_activity_schedule: [],
  });
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });
}

/** A plan-conformant proposal for the planned context the AI was sent:
 * each exercise group filled to its reservation, members to their minimum,
 * shared-credit candidates first — the shape a well-behaved model returns. */
function plannedOutput(ctx: any): any {
  const sp = ctx.sessionPlan;
  const used = new Set<string>();
  const exercises: any[] = [];
  for (const g of sp.exerciseGroups) {
    const credit = new Map<string, number>(g.targetIds.map((id: string) => [id, 0]));
    let count = 0;
    const add = (targetId: string, c: any) => {
      used.add(c.exerciseId);
      count++;
      for (const id of [targetId, ...c.alsoCredits]) if (credit.has(id)) credit.set(id, credit.get(id)! + c.maxSets);
      exercises.push({ exerciseId: c.exerciseId, role: 'primary', targetType: 'physique_target', targetId, sets: c.maxSets, repsMin: c.repsMin, repsMax: c.repsMax, rirMin: c.rirMin, rirMax: c.rirMax, rationale: ['fake'], source: 'blueprint' });
    };
    const candidatesOf = (id: string) =>
      [...sp.targets.find((t: any) => t.targetId === id).candidates]
        .filter((c: any) => !used.has(c.exerciseId))
        .sort((a: any, b: any) => b.alsoCredits.filter((x: string) => credit.has(x)).length - a.alsoCredits.filter((x: string) => credit.has(x)).length || b.maxSets - a.maxSets);
    for (const id of g.targetIds) {
      for (const c of candidatesOf(id)) {
        if (credit.get(id)! >= g.memberMinimumSets[id] || count >= g.reservedExercises) break;
        if (!used.has(c.exerciseId)) add(id, c);
      }
    }
    for (const id of g.targetIds) for (const c of candidatesOf(id)) if (count < g.reservedExercises) add(id, c);
  }
  return {
    schemaVersion: 'ai-workout-session-proposal.v1',
    proposalId: 'p',
    mode: 'generate_session',
    targetDate: ctx.targetDate,
    weekday: ctx.targetWeekday,
    sessionFocus: [sp.purpose],
    exercises,
    programmingRationale: ['fake'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
  };
}

type Behaviour = 'valid' | 'schema_invalid' | 'auth' | 'transient';

/** Fake AI: answers each call per `script` (default 'valid'); `hold` makes the next call wait until released. */
class FakeProvider implements AIProgrammerProvider {
  calls: AIProgrammerProviderRequest[] = [];
  script: Behaviour[] = [];
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  hold() {
    this.gate = new Promise((r) => (this.release = r));
  }
  releaseHold() {
    this.release?.();
    this.gate = null;
  }
  async generate(req: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    this.calls.push(req);
    if (this.gate) await this.gate;
    const behaviour = this.script.shift() ?? 'valid';
    if (behaviour === 'auth') throw new AIProviderAuthenticationError();
    if (behaviour === 'transient') throw new (await import('../../src/ai-programmer/errors.js')).AIProviderUnavailableError('Velona returned HTTP 502.');
    const body = behaviour === 'schema_invalid' ? { nonsense: true } : plannedOutput(req.context);
    return { provider: 'fake', model: 'fake-model', requestId: req.requestId, rawText: JSON.stringify(body) };
  }
}

let provider: FakeProvider;
const service = () => new AIProgrammerService(db, provider);
const runs = () => db.prepare('SELECT COUNT(*) AS n FROM ai_week_generation_runs').get() as { n: number };
const programs = () => db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  pinClock(MONDAY);
  seed();
  provider = new FakeProvider();
  process.env.AI_PROGRAMMER_ENABLED = 'true';
  process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
  process.env.AI_WEEK_GENERATION_MODE = 'explicit';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of ['AI_PROGRAMMER_ENABLED', 'AI_PLANNED_GENERATION_ENABLED', 'AI_WEEK_GENERATION_MODE', 'VELONA_API_KEY', 'VELONA_MODEL']) delete process.env[k];
});

async function startAndFinish(weekStart = MONDAY, options = {}) {
  const r = startWeekGeneration(db, service(), weekStart, options);
  if (r.kind !== 'started') throw new Error(`expected a started run, got ${r.kind}`);
  return r.done;
}

// ---------------------------------------------------------------- read boundary

describe('GET /week and /today in explicit mode never generate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  for (const route of ['/api/programming/week', '/api/programming/today']) {
    for (const [label, date] of [['current week', MONDAY], ['past week', addDays(MONDAY, -14)], ['far-future week', addDays(MONDAY, 700)]] as const) {
      it(`${route} for an unsaved ${label}: no provider call, nothing written, skeleton + not_generated`, async () => {
        const res = await request(createApp(db)).get(`${route}?date=${date}`).expect(200);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(programs().n).toBe(0);
        expect(runs().n).toBe(0);
        expect(res.body.generation.status).toBe('not_generated');
        if (route.endsWith('/week')) {
          expect(res.body.days).toHaveLength(7);
          for (const d of res.body.days) expect(d.plannedWork).toEqual([]);
        }
      });
    }
  }

  it('the generation field reports the window: current week can generate, a past week cannot', async () => {
    const app = createApp(db);
    const current = (await request(app).get(`/api/programming/week?date=${MONDAY}`)).body.generation;
    expect(current).toMatchObject({ status: 'not_generated', canGenerate: true });
    expect(current.perDay.map((d: any) => [d.date, d.purpose, d.status])).toEqual([
      [MONDAY, 'push', 'not_generated'],
      [TUESDAY, 'pull', 'not_generated'],
      [THURSDAY, 'legs', 'not_generated'],
      [FRIDAY, 'upper', 'not_generated'],
    ]);
    const past = (await request(app).get(`/api/programming/week?date=${addDays(MONDAY, -7)}`)).body.generation;
    expect(past).toMatchObject({ canGenerate: false, reason: 'outside_window' });
  });

  it('a saved week stays readable exactly as in legacy mode (plus the generation field)', async () => {
    const repo = new WeeklyProgramRepo(db);
    const program = repo.create(MONDAY, addDays(MONDAY, 6));
    repo.upsertSession(program.id, 0, 'push', 'gym', { plannedWork: [] });
    const explicit = (await request(createApp(db)).get(`/api/programming/week?date=${MONDAY}`).expect(200)).body;
    process.env.AI_WEEK_GENERATION_MODE = 'legacy';
    delete process.env.AI_PROGRAMMER_ENABLED; // legacy deterministic read of an already-saved week
    const legacy = (await request(createApp(db)).get(`/api/programming/week?date=${MONDAY}`).expect(200)).body;
    const { generation, ...rest } = explicit;
    expect(rest).toEqual(legacy);
    expect(generation.status).toBe('saved');
    expect(legacy).not.toHaveProperty('generation');
  });

  it('legacy mode is unchanged: no generation field, and the first read still creates the week', async () => {
    process.env.AI_WEEK_GENERATION_MODE = 'legacy';
    delete process.env.AI_PROGRAMMER_ENABLED; // deterministic path, no provider
    const res = await request(createApp(db)).get(`/api/programming/week?date=${MONDAY}`).expect(200);
    expect(res.body).not.toHaveProperty('generation');
    expect(programs().n).toBe(1);
  });
});

// ---------------------------------------------------------------- window

describe('allowed generation weeks', () => {
  it('Monday: current week only; past, +1, +2 and non-Monday starts are refused without a provider call', () => {
    expect(allowedGenerationWeeks(db)).toEqual([MONDAY]);
    for (const bad of [addDays(MONDAY, -7), addDays(MONDAY, 7), addDays(MONDAY, 14), TUESDAY]) {
      expect(() => startWeekGeneration(db, service(), bad), bad).toThrow(expect.objectContaining({ code: 'AI_WEEK_GENERATION_NOT_ALLOWED', statusCode: 400 }));
    }
    expect(provider.calls).toHaveLength(0);
    expect(runs().n).toBe(0);
  });

  it('Saturday: next week becomes allowed (never week+2)', () => {
    pinClock(SATURDAY);
    expect(allowedGenerationWeeks(db)).toEqual([MONDAY, addDays(MONDAY, 7)]);
    expect(() => startWeekGeneration(db, service(), addDays(MONDAY, 14))).toThrow(expect.objectContaining({ code: 'AI_WEEK_GENERATION_NOT_ALLOWED' }));
  });

  it('a current week with every gym day already past → nothing to do (409), no run, no call', () => {
    pinClock(SATURDAY);
    expect(() => startWeekGeneration(db, service(), MONDAY)).toThrow(expect.objectContaining({ code: 'AI_WEEK_GENERATION_NOTHING_TO_DO', statusCode: 409 }));
    expect(runs().n).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('legacy mode refuses the action (409) — explicit mode only', () => {
    process.env.AI_WEEK_GENERATION_MODE = 'legacy';
    expect(() => startWeekGeneration(db, service(), MONDAY)).toThrow(expect.objectContaining({ code: 'AI_WEEK_GENERATION_DISABLED' }));
  });
});

// ---------------------------------------------------------------- happy path

describe('a full run', () => {
  it('creates one PENDING proposal per remaining gym day, through the shared planned pipeline, with end-of-day expiry', async () => {
    const run = await startAndFinish();
    expect(run.status).toBe('completed');
    expect(run.days.map((d) => [d.date, d.purpose, d.outcome])).toEqual([
      [MONDAY, 'push', 'proposal_pending'],
      [TUESDAY, 'pull', 'proposal_pending'],
      [THURSDAY, 'legs', 'proposal_pending'],
      [FRIDAY, 'upper', 'proposal_pending'],
    ]);
    expect(provider.calls).toHaveLength(4);
    for (const call of provider.calls) {
      expect((call.context as any).schemaVersion).toBe('ai-programmer-planned-context.v1'); // the planned contract
      expect(call.mode).toBe('generate_session');
    }
    const repo = new AIProposalRepo(db);
    for (const d of run.days) {
      const p = repo.getById(d.proposalId!)!;
      expect(p.status).toBe('pending');
      expect(p.weekRunId).toBe(run.id);
      expect(p.targetDate).toBe(d.date);
      expect(p.expiresAt).toBe(endOfLocalDateIso(d.date, 'Asia/Kolkata'));
      expect(p.expiresAt).toBe(new Date(`${addDays(d.date, 1)}T00:00:00+05:30`).toISOString());
    }
    expect(programs().n).toBe(0); // never written into programs/program_sessions
  });

  it('a week-run proposal goes through the existing approve and commit unchanged', async () => {
    const run = await startAndFinish();
    const id = run.days[0]!.proposalId!;
    expect(approveProposal(db, id).status).toBe('approved');
    commitAIProposalToPlannedSession(db, id, { intent: 'fill_existing_gym_day' });
    const after = new AIProposalRepo(db).getById(id)!;
    expect(after.status).toBe('committed');
    expect(after.committedSessionId).toBeTruthy();
  });

  it('single-day generate_session proposals keep their 24h TTL', async () => {
    const before = Date.now();
    const result = await service().generateSession({ targetDate: MONDAY, requestedSessionPurpose: 'push' });
    const p = new AIProposalRepo(db).getById(result.proposalId)!;
    expect(new Date(p.expiresAt).getTime() - before).toBe(24 * 60 * 60 * 1000);
    expect(p.weekRunId).toBeNull();
  });
});

// ---------------------------------------------------------------- concurrency

describe('one run per week; the guard is held before the provider is awaited', () => {
  it('a second start while the first is mid-call gets in_progress — no new run, no new call', async () => {
    provider.hold();
    const first = startWeekGeneration(db, service(), MONDAY);
    expect(first.kind).toBe('started');
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const second = startWeekGeneration(db, service(), MONDAY);
    expect(second).toMatchObject({ kind: 'in_progress', run: { id: first.run.id } });
    expect(provider.calls).toHaveLength(1);
    expect(runs().n).toBe(1);
    provider.releaseHold();
    await (first as any).done;
    expect(provider.calls).toHaveLength(4);
  });

  it('concurrent POSTs through the real route: exactly one run and one provider sequence', async () => {
    process.env.VELONA_API_KEY = 'test-key-not-real';
    process.env.VELONA_MODEL = 'test-model';
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      await held;
      const userTurn = JSON.parse(JSON.parse(init.body).turns[1].content);
      return new Response(JSON.stringify({ status: 'success', data: { output: JSON.stringify(plannedOutput(userTurn.context)), model: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(db);
    const responses = await Promise.all([1, 2, 3].map(() => request(app).post('/api/ai-programmer/generate-week').send({ weekStart: MONDAY })));
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
    expect(responses.filter((r) => r.body.status === 'running')).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.runId)).size).toBe(1);
    expect(runs().n).toBe(1);
    release();
    await vi.waitFor(() => expect(new WeekGenerationRunRepo(db).latestFinished(MONDAY)?.status).toBe('completed'), { timeout: 10000 });
    expect(fetchMock).toHaveBeenCalledTimes(4); // one per gym day, never duplicated
  });

  it('an abandoned run (stale heartbeat) is recovered; days that already have a proposal are not regenerated', async () => {
    const repo = new WeekGenerationRunRepo(db);
    // A crashed run: Monday was generated before the crash, the rest never ran.
    const crashed = repo.acquire(MONDAY, [{ date: MONDAY, purpose: 'push', outcome: 'planned' }], new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(0).toISOString());
    expect(crashed.kind).toBe('acquired');
    const mondayOnly = await (async () => {
      const r = await service().generatePlannedDayProposal(
        buildProgrammerContext(db, { targetDate: MONDAY, requestedSessionPurpose: 'push' }),
        (await import('../../src/ai-programmer/planning/sessionPlanner.js')).planSession(buildProgrammerContext(db, { targetDate: MONDAY, requestedSessionPurpose: 'push' }), { nonGoalRotationCursor: 0 }),
        { weekRunId: crashed.kind === 'acquired' ? crashed.run.id : '', expiresAt: endOfLocalDateIso(MONDAY, 'Asia/Kolkata') }
      );
      return r.proposalId;
    })();
    provider.calls = [];
    const run = await startAndFinish();
    expect(repo.getById(crashed.kind === 'acquired' ? crashed.run.id : '')!.status).toBe('abandoned');
    expect(run.days.map((d) => d.date)).toEqual([TUESDAY, THURSDAY, FRIDAY]); // Monday already has its proposal
    expect(provider.calls).toHaveLength(3);
    expect(new AIProposalRepo(db).findLatestForTargetDate(MONDAY)!.id).toBe(mondayOnly);
  });

  it('an in-flight provider call longer than the stale threshold keeps its lease: no takeover, no second paid call', async () => {
    // Fake Date AND intervals so the in-flight heartbeat really fires while time passes.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    pinClock(MONDAY);
    provider.hold();
    const first = startWeekGeneration(db, service(), MONDAY);
    expect(first.kind).toBe('started');
    expect(provider.calls).toHaveLength(1); // Monday's call is in flight (held)

    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes: past the 5-minute stale threshold
    const row = new WeekGenerationRunRepo(db).running(MONDAY)!;
    expect(row.id).toBe(first.run.id);
    expect(Date.now() - new Date(row.heartbeatAt).getTime()).toBeLessThanOrEqual(30 * 1000); // refreshed during the call

    const second = startWeekGeneration(db, service(), MONDAY);
    expect(second).toMatchObject({ kind: 'in_progress', run: { id: first.run.id } });
    expect(provider.calls).toHaveLength(1); // no duplicate paid call for the active day
    expect(runs().n).toBe(1);
    expect(new WeekGenerationRunRepo(db).getById(first.run.id)!.status).toBe('running'); // never marked abandoned

    provider.releaseHold();
    const done = await (first as any).done;
    expect(done.status).toBe('completed');
    expect(provider.calls.map((c) => (c.context as any).targetDate)).toEqual([MONDAY, TUESDAY, THURSDAY, FRIDAY]); // each day exactly once
  });

  it('a dead run (no heartbeat for longer than the threshold) is still recoverable', () => {
    const repo = new WeekGenerationRunRepo(db);
    const dead = repo.acquire(MONDAY, [{ date: MONDAY, purpose: 'push', outcome: 'planned' }], new Date(Date.now() - 6 * 60 * 1000).toISOString(), new Date(0).toISOString());
    const taken = startWeekGeneration(db, service(), MONDAY);
    expect(taken.kind).toBe('started');
    expect(repo.getById(dead.kind === 'acquired' ? dead.run.id : '')!.status).toBe('abandoned');
    return (taken as any).done;
  });

  it('a fresh running run is never taken over', () => {
    const repo = new WeekGenerationRunRepo(db);
    const live = repo.acquire(MONDAY, [{ date: TUESDAY, purpose: 'pull', outcome: 'planned' }], new Date().toISOString(), new Date(0).toISOString());
    expect(startWeekGeneration(db, service(), MONDAY)).toMatchObject({ kind: 'in_progress', run: { id: live.kind === 'acquired' ? live.run.id : '' } });
    expect(provider.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- failures

describe('failure handling', () => {
  it('partial success: a quality failure on one day keeps the others; the rerun only attempts that day, and only with confirmRetry', async () => {
    provider.script = ['valid', 'schema_invalid', 'valid', 'valid'];
    const run = await startAndFinish();
    expect(run.status).toBe('partially_completed');
    expect(run.days.map((d) => d.outcome)).toEqual(['proposal_pending', 'failed_quality', 'proposal_pending', 'proposal_pending']);
    expect(run.days[1]!.code).toBe('AI_OUTPUT_SCHEMA_INVALID');

    // Same context → gated, no paid call.
    provider.calls = [];
    const gated = await startAndFinish();
    expect(gated.days.map((d) => [d.date, d.outcome])).toEqual([[TUESDAY, 'gated']]);
    expect(provider.calls).toHaveLength(0);

    // Explicit confirmRetry → paid again, succeeds, gate cleared.
    const retried = await startAndFinish(MONDAY, { confirmRetry: true });
    expect(retried.days.map((d) => [d.date, d.outcome])).toEqual([[TUESDAY, 'proposal_pending']]);
    expect(provider.calls).toHaveLength(1);
    expect(new WeekGenerationRunRepo(db).dayFailure(TUESDAY, retried.days[0]!.contextHash!)).toBeUndefined();
  });

  it('provider auth failure stops the run, backs off, and GET stays usable', async () => {
    provider.script = ['valid', 'auth'];
    const run = await startAndFinish();
    expect(run).toMatchObject({ status: 'partially_completed', failureClass: 'provider_auth' });
    expect(run.days.map((d) => d.outcome)).toEqual(['proposal_pending', 'failed_provider', 'not_attempted', 'not_attempted']);
    expect(provider.calls).toHaveLength(2);
    expect(run.nextAllowedAt! > new Date().toISOString()).toBe(true);

    // During the backoff: no new paid call.
    expect(() => startWeekGeneration(db, service(), MONDAY)).toThrow(expect.objectContaining({ code: 'AI_WEEK_GENERATION_BACKOFF', statusCode: 503 }));
    expect(provider.calls).toHaveLength(2);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const week = await request(createApp(db)).get(`/api/programming/week?date=${MONDAY}`).expect(200);
    expect(week.body.generation).toMatchObject({ canGenerate: false, reason: 'provider_unavailable', retryAfter: run.nextAllowedAt });
    expect(week.body.generation.perDay.map((d: any) => d.status)).toEqual(['proposal_pending', 'failed_provider', 'not_generated', 'not_generated']);
    await request(createApp(db)).get(`/api/programming/today?date=${MONDAY}`).expect(200);
    expect(fetchMock).not.toHaveBeenCalled();

    // After the backoff window: allowed again, only the remaining days.
    vi.setSystemTime(new Date(new Date(run.nextAllowedAt!).getTime() + 1000));
    const next = await startAndFinish();
    expect(next.days.map((d) => d.date)).toEqual([TUESDAY, THURSDAY, FRIDAY]);
  });

  it('transient provider failures back off progressively (2, 10, 30, 60 minutes)', async () => {
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      provider.script = ['transient'];
      const run = await startAndFinish();
      expect(run.failureClass).toBe('provider_transient');
      waits.push(Math.round((new Date(run.nextAllowedAt!).getTime() - Date.now()) / 60000));
      vi.setSystemTime(new Date(new Date(run.nextAllowedAt!).getTime() + 1000));
    }
    expect(waits).toEqual([2, 10, 30]);
  });

  it('a SessionPlan refusal is never paid for, and other days proceed', async () => {
    refuseDates.add(TUESDAY);
    try {
      const run = await startAndFinish();
      expect(run.days.map((d) => [d.date, d.outcome, d.code ?? null])).toEqual([
        [MONDAY, 'proposal_pending', null],
        [TUESDAY, 'refused', 'REQUIRED_GOAL_INFEASIBLE'],
        [THURSDAY, 'proposal_pending', null],
        [FRIDAY, 'proposal_pending', null],
      ]);
      expect(provider.calls.map((c) => (c.context as any).targetDate)).toEqual([MONDAY, THURSDAY, FRIDAY]);
      expect(run.status).toBe('partially_completed');
    } finally {
      refuseDates.clear();
    }
  });
});

// ---------------------------------------------------------------- projection

describe('projected exposure from earlier planned days', () => {
  it('applyProjectedSessions is a no-op without projections and never mutates its input', () => {
    const ctx = buildProgrammerContext(db, { targetDate: FRIDAY, requestedSessionPurpose: 'upper' });
    const again = buildProgrammerContext(db, { targetDate: FRIDAY, requestedSessionPurpose: 'upper', projectedSessions: [] });
    expect(again.contextHash).toBe(ctx.contextHash);
    const targets = [{ target_type: 'physique_target', target_id: 'triceps', current_weekly_primary_sets: 0, weekly_secondary_sets: 0, weekly_exposure_units: 0, rolling_exposure_units: 0, last_trained_date: null, recent_exercise_ids: [], current_exercise_id: null, exercise_history: {} }] as any;
    const snapshot = JSON.stringify(targets);
    const out = applyProjectedSessions(targets, [{ date: MONDAY, exercises: [{ exerciseId: 'close-grip-bench-press', sets: 3 }] }], FRIDAY);
    expect(JSON.stringify(targets)).toBe(snapshot);
    expect(out[0]!.current_weekly_primary_sets).toBe(3);
    expect(out[0]!.last_trained_date).toBe(MONDAY);
    expect(applyProjectedSessions(targets, [{ date: FRIDAY, exercises: [{ exerciseId: 'close-grip-bench-press', sets: 3 }] }], FRIDAY)[0]!.current_weekly_primary_sets).toBe(0); // same/later days never count
  });

  it('a later day is planned knowing the earlier days\' planned work (Friday Upper sees Monday Push triceps)', async () => {
    const run = await startAndFinish();
    const fridayCall = provider.calls.find((c) => (c.context as any).targetDate === FRIDAY)!;
    const withoutProjection = buildProgrammerContext(db, { targetDate: FRIDAY, requestedSessionPurpose: 'upper' });
    const projected = projectedSessionsBefore(db, MONDAY, FRIDAY);
    expect(projected.map((p) => p.date)).toEqual([MONDAY, TUESDAY, THURSDAY]);
    const withProjection = buildProgrammerContext(db, { targetDate: FRIDAY, requestedSessionPurpose: 'upper', projectedSessions: projected });
    const sets = (ctx: any, id: string) => ctx.programmingBrief.muscles.find((m: any) => m.targetId === id).currentWeeklyDirectSets;
    expect(sets(withProjection, 'triceps')).toBeGreaterThan(sets(withoutProjection, 'triceps'));
    expect(withProjection.targets.find((t) => t.targetId === 'triceps')!.lastTrainedDate).toBe(MONDAY);
    // What the AI actually received for Friday was built with the projection.
    expect((fridayCall.context as any).sessionPlan).toBeDefined();
    expect(run.days.find((d) => d.date === FRIDAY)!.contextHash).toBe(withProjection.contextHash);
  });
});

// ---------------------------------------------------------------- generate-session interaction

describe('generate-session vs an active week run', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.VELONA_API_KEY = 'test-key-not-real';
    process.env.VELONA_MODEL = 'test-model';
    fetchMock = vi.fn(async (_url: string, init: any) => {
      const userTurn = JSON.parse(JSON.parse(init.body).turns[1].content);
      return new Response(JSON.stringify({ status: 'success', data: { output: JSON.stringify(plannedOutput(userTurn.context)), model: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('blocked (409) only for a date a live run is about to generate; other dates proceed', async () => {
    const live = new WeekGenerationRunRepo(db).acquire(MONDAY, [{ date: TUESDAY, purpose: 'pull', outcome: 'planned' }], new Date().toISOString(), new Date(0).toISOString());
    const app = createApp(db);
    const blocked = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: TUESDAY, requestedSessionPurpose: 'pull' });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: 'AI_WEEK_GENERATION_IN_PROGRESS', details: { runId: live.kind === 'acquired' ? live.run.id : '' } });
    expect(fetchMock).not.toHaveBeenCalled();
    const other = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: THURSDAY, requestedSessionPurpose: 'legs' });
    expect(other.status).toBe(200);
  });

  it('not blocked once the run is finished, nor in legacy mode', async () => {
    const repo = new WeekGenerationRunRepo(db);
    const live = repo.acquire(MONDAY, [{ date: TUESDAY, purpose: 'pull', outcome: 'planned' }], new Date().toISOString(), new Date(0).toISOString());
    process.env.AI_WEEK_GENERATION_MODE = 'legacy';
    expect((await request(createApp(db)).post('/api/ai-programmer/generate-session').send({ targetDate: TUESDAY, requestedSessionPurpose: 'pull' })).status).toBe(200);
    process.env.AI_WEEK_GENERATION_MODE = 'explicit';
    new AIProposalRepo(db); // proposal for Tuesday now exists; finish the run and use another date
    repo.finish(live.kind === 'acquired' ? live.run.id : '', 'completed', [], null, null);
    expect((await request(createApp(db)).post('/api/ai-programmer/generate-session').send({ targetDate: FRIDAY, requestedSessionPurpose: 'upper' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------- route + state

describe('POST /generate-week route and GET state', () => {
  it('202 + per-day plan; GET reports generating, then per-day pending proposals', async () => {
    process.env.VELONA_API_KEY = 'test-key-not-real';
    process.env.VELONA_MODEL = 'test-model';
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        await held;
        const userTurn = JSON.parse(JSON.parse(init.body).turns[1].content);
        return new Response(JSON.stringify({ status: 'success', data: { output: JSON.stringify(plannedOutput(userTurn.context)), model: 'm' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const app = createApp(db);
    const post = await request(app).post('/api/ai-programmer/generate-week').send({ weekStart: MONDAY }).expect(202);
    expect(post.body).toMatchObject({ ok: true, status: 'running', weekStart: MONDAY });
    expect(post.body.days.map((d: any) => d.date)).toEqual([MONDAY, TUESDAY, THURSDAY, FRIDAY]);
    const during = (await request(app).get(`/api/programming/week?date=${MONDAY}`).expect(200)).body.generation;
    expect(during).toMatchObject({ status: 'generating', canGenerate: false, reason: 'in_progress', runId: post.body.runId });
    release();
    await vi.waitFor(() => expect(new WeekGenerationRunRepo(db).latestFinished(MONDAY)?.status).toBe('completed'), { timeout: 10000 });
    const after = (await request(app).get(`/api/programming/week?date=${MONDAY}`).expect(200)).body.generation;
    expect(after.status).toBe('generated');
    expect(after.perDay.map((d: any) => d.status)).toEqual(['proposal_pending', 'proposal_pending', 'proposal_pending', 'proposal_pending']);
    expect(readWeekGenerationState(db, MONDAY, false).canGenerate).toBe(false);
  });

  it('400 on a malformed weekStart; 409 in legacy mode', async () => {
    const app = createApp(db);
    expect((await request(app).post('/api/ai-programmer/generate-week').send({ weekStart: '${state.weekStart}' })).status).toBe(400);
    process.env.AI_WEEK_GENERATION_MODE = 'legacy';
    const legacy = await request(app).post('/api/ai-programmer/generate-week').send({ weekStart: MONDAY });
    expect(legacy.status).toBe(409);
    expect(legacy.body.error).toBe('AI_WEEK_GENERATION_DISABLED');
  });

  it('weekGymDays follows the deterministic weekly split', () => {
    expect(weekGymDays(db, MONDAY).map((d) => `${d.weekday}:${d.purpose}`)).toEqual(['monday:push', 'tuesday:pull', 'thursday:legs', 'friday:upper']);
    void AIProgrammerError;
  });
});
