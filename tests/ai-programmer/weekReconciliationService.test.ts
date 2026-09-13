// AI-Powered Weekly Reconciliation (spec §13, provider/service tests):
// AIProgrammerService.reconcileWeek using a fake AIProgrammerProvider —
// no real Velona API key is ever used or required. Mirrors
// aiProgrammerService.test.ts's own generateSession test structure.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import { buildReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextBuilder.js';
import type { AIReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextTypes.js';
import { AI_WEEK_RECONCILIATION_SCHEMA_VERSION, type AIWeekReconciliationDay, type AIWeekReconciliationOutput } from '../../src/ai-programmer/contracts/weekReconciliationTypes.js';
import {
  AIProgrammerDisabledError,
  AIProviderUnavailableError,
  AIWeekReconciliationOutputDomainInvalidError,
  AIWeekReconciliationOutputSchemaInvalidError,
} from '../../src/ai-programmer/errors.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { AIWeekReconciliationRepo } from '../../src/repositories/aiWeekReconciliationRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;

const VALID_EXERCISE = {
  exerciseId: 'flat-barbell-bench-press',
  role: 'primary' as const,
  targetType: 'physique_target' as const,
  targetId: 'mid-pec',
  classification: 'specialization' as const,
  sets: 3,
  repsMin: 6,
  repsMax: 12,
  rirMin: 1,
  rirMax: 3,
  rationale: ['Direct mid-pec exposure.'],
  source: 'blueprint' as const,
};

function validWeekOutputJson(ctx: AIReconciliationContext, overrides: Record<string, unknown> = {}): AIWeekReconciliationOutput {
  const days: AIWeekReconciliationDay[] = ctx.existingProgram.map((existing) => {
    if (existing.locked) {
      return { date: existing.date, weekday: existing.weekday, activity: existing.activity, changeType: 'unchanged', locked: true, session: null };
    }
    if (existing.date === ctx.request.targetDate) {
      return {
        date: existing.date,
        weekday: existing.weekday,
        activity: 'gym',
        changeType: 'modified',
        locked: false,
        session: { sessionPurpose: 'chest', availableMinutes: 60, estimatedMinutes: 45, exercises: [VALID_EXERCISE], skipped: [] },
      };
    }
    return { date: existing.date, weekday: existing.weekday, activity: existing.activity, changeType: 'unchanged', locked: false, session: null };
  });
  return {
    schemaVersion: AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
    proposalId: 'model-provided-id-discarded',
    mode: 'reconcile_week',
    targetDate: ctx.request.targetDate,
    requestedActivity: 'gym',
    days,
    reconciliation: { changedDates: [ctx.request.targetDate], preservedLockedDates: [...ctx.lockedDates], rationale: 'Move the gym session to the requested day.', warnings: [] },
    ...overrides,
  } as AIWeekReconciliationOutput;
}

class FakeProvider implements AIProgrammerProvider {
  public calls: AIProgrammerProviderRequest[] = [];
  constructor(private readonly respond: (request: AIProgrammerProviderRequest) => AIProgrammerProviderResponse | Promise<AIProgrammerProviderResponse>) {}
  async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    this.calls.push(request);
    return this.respond(request);
  }
}

function fakeResponse(rawJson: unknown): AIProgrammerProviderResponse {
  return { provider: 'fake', model: 'fake-model', requestId: 'req-week-1', rawText: JSON.stringify(rawJson) };
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

describe('AIProgrammerService.reconcileWeek', () => {
  it('throws AIProgrammerDisabledError when AI_PROGRAMMER_ENABLED is not "true", and never calls the provider', async () => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const provider = new FakeProvider(() => fakeResponse(validWeekOutputJson(context)));
    const service = new AIProgrammerService(db, provider);
    await expect(service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' })).rejects.toBeInstanceOf(AIProgrammerDisabledError);
    expect(provider.calls).toHaveLength(0);
  });

  it('succeeds end-to-end with a mocked provider, persisting a PENDING reconciliation record', async () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const provider = new FakeProvider(() => fakeResponse(validWeekOutputJson(context)));
    const service = new AIProgrammerService(db, provider);
    const result = await service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' });

    expect(result.output.days).toHaveLength(7);
    expect(result.status).toBe('pending');
    expect(result.provider).toBe('fake');
    expect(result.model).toBe('fake-model');
    expect(result.requestId).toBe('req-week-1');
    expect(typeof result.contextHash).toBe('string');
    expect(result.contextHash.length).toBeGreaterThan(0);
    expect(result.diagnostics.mode).toBe('reconcile_week');

    const persisted = new AIWeekReconciliationRepo(db).getById(result.reconciliationId);
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe('pending');
    expect(persisted?.targetDate).toBe(SUNDAY);
  });

  it('passes mode "reconcile_week" and the real built context (including request.targetDate) to the provider', async () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const provider = new FakeProvider(() => fakeResponse(validWeekOutputJson(context)));
    const service = new AIProgrammerService(db, provider);
    await service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.mode).toBe('reconcile_week');
    expect(provider.calls[0]?.systemInstruction).toMatch(/EXACTLY 7 entries/);
    const sentContext = provider.calls[0]?.context as AIReconciliationContext;
    expect(sentContext.mode).toBe('reconcile_week');
    expect(sentContext.request.targetDate).toBe(SUNDAY);
    expect(sentContext.existingProgram).toHaveLength(7);
  });

  it('generates a unique application-owned proposalId, discarding whatever the model returned', async () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const provider = new FakeProvider(() => fakeResponse(validWeekOutputJson(context, { proposalId: 'model-tried-to-pick-this' })));
    const service = new AIProgrammerService(db, provider);
    const result = await service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' });
    expect(result.output.proposalId).not.toBe('model-tried-to-pick-this');
    expect(result.reconciliationId).toBe(result.output.proposalId);
  });

  it('rejects malformed (non-JSON) provider rawText with AIWeekReconciliationOutputSchemaInvalidError, persisting nothing', async () => {
    const provider: AIProgrammerProvider = { generate: async () => ({ provider: 'fake', model: 'm', requestId: 'r', rawText: 'not json at all' }) };
    const service = new AIProgrammerService(db, provider);
    await expect(service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' })).rejects.toBeInstanceOf(AIWeekReconciliationOutputSchemaInvalidError);
    expect(new AIWeekReconciliationRepo(db).findLatestForTargetDate(SUNDAY)).toBeUndefined();
  });

  it('rejects output that fails schema validation, persisting nothing', async () => {
    const provider = new FakeProvider(() => fakeResponse({ not: 'a valid reconciliation output' }));
    const service = new AIProgrammerService(db, provider);
    await expect(service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' })).rejects.toBeInstanceOf(AIWeekReconciliationOutputSchemaInvalidError);
    expect(new AIWeekReconciliationRepo(db).findLatestForTargetDate(SUNDAY)).toBeUndefined();
  });

  it('rejects output that fails domain validation (unknown exercise), persisting nothing', async () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const badOutput = validWeekOutputJson(context);
    const targetDay = badOutput.days.find((d) => d.date === SUNDAY)!;
    targetDay.session = { ...targetDay.session!, exercises: [{ ...VALID_EXERCISE, exerciseId: 'totally-made-up-exercise' }] };
    const provider = new FakeProvider(() => fakeResponse(badOutput));
    const service = new AIProgrammerService(db, provider);
    await expect(service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' })).rejects.toBeInstanceOf(AIWeekReconciliationOutputDomainInvalidError);
    expect(new AIWeekReconciliationRepo(db).findLatestForTargetDate(SUNDAY)).toBeUndefined();
  });

  it('propagates a provider failure without persisting a reconciliation record', async () => {
    const provider: AIProgrammerProvider = {
      generate: async () => {
        throw new AIProviderUnavailableError('simulated outage');
      },
    };
    const service = new AIProgrammerService(db, provider);
    await expect(service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym' })).rejects.toBeInstanceOf(AIProviderUnavailableError);
    expect(new AIWeekReconciliationRepo(db).findLatestForTargetDate(SUNDAY)).toBeUndefined();
  });

  it('threads reason/swapUnavailableReason into the context sent to the provider', async () => {
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const provider = new FakeProvider(() => fakeResponse(validWeekOutputJson(context)));
    const service = new AIProgrammerService(db, provider);
    await service.reconcileWeek({ targetDate: SUNDAY, requestedActivity: 'gym', reason: 'friend invited me', swapUnavailableReason: 'no eligible swap day' });
    const sentContext = provider.calls[0]?.context as AIReconciliationContext;
    expect(sentContext.request.reason).toBe('friend invited me');
    expect(sentContext.request.swapUnavailableReason).toBe('no eligible swap day');
  });
});
