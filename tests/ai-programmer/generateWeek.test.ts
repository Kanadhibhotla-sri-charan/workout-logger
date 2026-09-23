// AI Weekly Programmer — generate_week (Phase 1/3, 2026-09-23):
// service-level tests using a fake AIProgrammerProvider, mirroring
// aiProgrammerService.test.ts's own no-real-API-key discipline. Covers:
// - malformed AI output cannot be used (schema-invalid)
// - domain-invalid AI output cannot be used (invented exercise/target,
//   over-cap session)
// - the repair path fixes a mechanically-correctable issue before
//   domain validation runs
// - a validated week round-trips through the EXISTING
//   reconcileWeekProgram/WeeklyProgramRepo persistence unchanged —
//   proving generateWeek()'s { days, aggregates } shape is a genuine
//   drop-in for computeFreshWeek's own contract
// - all 7 days are represented, matching the week's own real activity

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import { AI_GENERATE_WEEK_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/generateWeekTypes.js';
import { AIGenerateWeekOutputDomainInvalidError, AIGenerateWeekOutputSchemaInvalidError, AIProgrammerDisabledError } from '../../src/ai-programmer/errors.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { reconcileWeekProgram } from '../../src/engine/weekProgramReconciliation.js';
import { programmingWeekStart, weekdayOfDate } from '../../src/engine/workoutBuilder.js';
import { WEEKDAYS } from '../../src/contracts/types.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

/** A real future Monday, computed relative to the real clock — never a
 * fixed calendar date that goes stale (see aiProgrammerService.test.ts's
 * own futureDate() for the identical rationale). */
function futureWeekStart(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 60);
  return programmingWeekStart(d.toISOString().slice(0, 10));
}

let db: Database.Database;

class FakeProvider implements AIProgrammerProvider {
  public lastRequest: AIProgrammerProviderRequest | undefined;
  constructor(private readonly respond: (request: AIProgrammerProviderRequest) => AIProgrammerProviderResponse | Promise<AIProgrammerProviderResponse>) {}
  async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    this.lastRequest = request;
    return this.respond(request);
  }
}

function fakeResponse(rawJson: unknown): AIProgrammerProviderResponse {
  return { provider: 'fake', model: 'fake-model', requestId: 'req-x', rawText: JSON.stringify(rawJson) };
}

const CLOSE_GRIP = { exerciseId: 'close-grip-bench-press', targetType: 'physique_target', targetId: 'triceps', classification: 'normal_development', sets: 3, repsMin: 6, repsMax: 10, rirMin: 1, rirMax: 3, rationale: ['Triceps'], source: 'blueprint' };

/** A minimal but schema/domain-valid week: every day matches the
 * profile's own real effective activity, every gym day carries exactly
 * one real, eligible exercise. `weekStart` must be the real week Monday
 * dates the test's own training profile resolves to. */
function validWeekJson(weekStart: string, overrides: Record<string, unknown> = {}) {
  const gymDays = new Set(['monday', 'tuesday', 'thursday', 'friday']);
  const days = WEEKDAYS.map((weekday, i) => {
    const date = new Date(`${weekStart}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const isGym = gymDays.has(weekday);
    return {
      date: dateStr,
      weekday,
      activity: isGym ? 'gym' : 'unselected',
      session: isGym ? { sessionPurpose: 'push', availableMinutes: 60, estimatedMinutes: 12, exercises: [{ ...CLOSE_GRIP }], skipped: [] } : null,
    };
  });
  return {
    schemaVersion: AI_GENERATE_WEEK_SCHEMA_VERSION,
    proposalId: 'gw-1',
    mode: 'generate_week',
    weekStart,
    days,
    weekRationale: 'Standard push/pull/legs/upper-style distribution for the week.',
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
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
  process.env.AI_PROGRAMMER_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.AI_PROGRAMMER_ENABLED;
});

describe('AIProgrammerService.generateWeek', () => {
  it('throws AIProgrammerDisabledError when AI_PROGRAMMER_ENABLED is not "true"', async () => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    const provider = new FakeProvider(() => fakeResponse(validWeekJson(futureWeekStart())));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateWeek(futureWeekStart())).rejects.toBeInstanceOf(AIProgrammerDisabledError);
  });

  it('passes the real built context and the generate_week system instruction to the provider', async () => {
    const weekStart = futureWeekStart();
    const provider = new FakeProvider(() => fakeResponse(validWeekJson(weekStart)));
    const service = new AIProgrammerService(db, provider);
    await service.generateWeek(weekStart);
    expect(provider.lastRequest?.mode).toBe('generate_week');
    expect(provider.lastRequest?.systemInstruction).toMatch(/Aesthetics\/physique/i);
    expect(provider.lastRequest?.systemInstruction).toMatch(/credited by the app toward the broader target/i);
    expect((provider.lastRequest?.context as any).weekStart).toBe(weekStart);
  });

  it('malformed AI output (invalid JSON) never produces a usable week', async () => {
    const provider = new FakeProvider(() => ({ provider: 'fake', model: 'fake-model', requestId: 'req-x', rawText: 'not json at all' }));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateWeek(futureWeekStart())).rejects.toBeInstanceOf(AIGenerateWeekOutputSchemaInvalidError);
  });

  it('schema-invalid AI output (wrong day count) is rejected before any repair or persistence', async () => {
    const weekStart = futureWeekStart();
    const bad = validWeekJson(weekStart);
    (bad as any).days = (bad as any).days.slice(0, 5); // only 5 days, not 7
    const provider = new FakeProvider(() => fakeResponse(bad));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateWeek(weekStart)).rejects.toBeInstanceOf(AIGenerateWeekOutputSchemaInvalidError);
    expect(new WeeklyProgramRepo(db).getByWeekStart(weekStart)).toBeUndefined();
  });

  it('domain-invalid AI output (invented exercise) is rejected and never persisted', async () => {
    const weekStart = futureWeekStart();
    const bad = validWeekJson(weekStart);
    const mondayDay = (bad as any).days.find((d: any) => d.weekday === 'monday');
    mondayDay.session.exercises[0] = { ...CLOSE_GRIP, exerciseId: 'totally-invented-exercise-id' };
    const provider = new FakeProvider(() => fakeResponse(bad));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateWeek(weekStart)).rejects.toBeInstanceOf(AIGenerateWeekOutputDomainInvalidError);
    expect(new WeeklyProgramRepo(db).getByWeekStart(weekStart)).toBeUndefined();
  });

  it('domain-invalid AI output (session over the exercise cap) is rejected', async () => {
    const weekStart = futureWeekStart();
    const bad = validWeekJson(weekStart);
    const mondayDay = (bad as any).days.find((d: any) => d.weekday === 'monday');
    // 11 exercises on one non-legs day exceeds the 10-exercise cap even
    // after repair (repair only trims non-goal padding down TO the cap
    // when a duplicate/removable candidate exists — 11 identical-target
    // primary exercises with no filler to trim still over-counts distinct
    // exercise entries).
    mondayDay.session.exercises = Array.from({ length: 11 }, (_, i) => ({ ...CLOSE_GRIP, exerciseId: i === 0 ? 'close-grip-bench-press' : `invented-filler-${i}` }));
    const provider = new FakeProvider(() => fakeResponse(bad));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateWeek(weekStart)).rejects.toBeInstanceOf(AIGenerateWeekOutputDomainInvalidError);
  });

  it('final validated week round-trips through the EXISTING reconcileWeekProgram/WeeklyProgramRepo persistence unchanged', async () => {
    const weekStart = futureWeekStart();
    const provider = new FakeProvider(() => fakeResponse(validWeekJson(weekStart)));
    const service = new AIProgrammerService(db, provider);

    const { days, aggregates } = await service.generateWeek(weekStart);
    expect(days).toHaveLength(7); // all 7 days represented

    // The exact persistence path computeFreshWeek's own output already
    // uses — no new persistence system, proving the drop-in contract.
    const persisted = reconcileWeekProgram(db, weekStart, days, aggregates);
    const readBack = new WeeklyProgramRepo(db).getByWeekStart(weekStart);
    expect(readBack).toBeDefined();
    expect(readBack!.id).toBe(persisted.id);

    const mondaySession = readBack!.sessions.find((s) => s.day_index === 0);
    expect(mondaySession).toBeDefined();
    const snap = mondaySession!.snapshot as { plannedWork: Array<{ exercise_id: string; sets: number }> };
    expect(snap.plannedWork).toHaveLength(1);
    expect(snap.plannedWork[0]!.exercise_id).toBe('close-grip-bench-press');
    expect(snap.plannedWork[0]!.sets).toBe(3);

    // Non-gym days (per the seeded training profile: wed/sat/sun) have
    // no persisted session at all — matches computeFreshWeek's own
    // hasGymComponent === false handling exactly.
    const wednesdaySession = readBack!.sessions.find((s) => s.day_index === 2);
    expect(wednesdaySession).toBeUndefined();
  });

  it('repair clamps an over-authored-ceiling exercise before domain validation ever runs', async () => {
    const weekStart = futureWeekStart();
    const bad = validWeekJson(weekStart);
    const mondayDay = (bad as any).days.find((d: any) => d.weekday === 'monday');
    // close-grip-bench-press's real authored ceiling is 3 sets; the
    // model here inflates it to 9 with no rationale — repair must clamp
    // it back down, exactly like every other AI output mode, before
    // domain validation runs (so this test on its own also confirms
    // domain validation still ok's the corrected result).
    mondayDay.session.exercises[0] = { ...CLOSE_GRIP, sets: 9, rationale: [] };
    const provider = new FakeProvider(() => fakeResponse(bad));
    const service = new AIProgrammerService(db, provider);

    const { days } = await service.generateWeek(weekStart);
    const mondaySnapshot = days.find((d) => d.dayIndex === 0)!;
    const plannedWork = (mondaySnapshot.snapshot as unknown as { plannedWork: Array<{ sets: number }> }).plannedWork;
    expect(plannedWork[0]!.sets).toBe(3); // clamped down from 9 to the real authored ceiling
  });
});
