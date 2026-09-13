// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.4):
// service-level tests using a fake AIProgrammerProvider — no real
// Velona API key is ever used or required.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/programmerTypes.js';
import {
  AIOutputDomainInvalidError,
  AIOutputSchemaInvalidError,
  AIProgrammerDisabledError,
  AIProviderUnavailableError,
} from '../../src/ai-programmer/errors.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;

function validProposalJson(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'p-1',
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

describe('AIProgrammerService', () => {
  it('throws AIProgrammerDisabledError when AI_PROGRAMMER_ENABLED is not "true"', async () => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    const provider = new FakeProvider(() => fakeResponse(validProposalJson()));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: SUNDAY })).rejects.toBeInstanceOf(AIProgrammerDisabledError);
  });

  it('succeeds end-to-end with a mocked provider, returning contextHash/provider/model/requestId', async () => {
    const provider = new FakeProvider(() => fakeResponse(validProposalJson()));
    const service = new AIProgrammerService(db, provider);
    const result = await service.generateSession({ targetDate: SUNDAY });
    expect(result.proposal.exercises).toHaveLength(1);
    expect(result.provider).toBe('fake');
    expect(result.model).toBe('fake-model');
    expect(result.requestId).toBe('req-x');
    expect(typeof result.contextHash).toBe('string');
    expect(result.contextHash.length).toBeGreaterThan(0);
  });

  it('passes the real built context and fixed system instruction to the provider', async () => {
    const provider = new FakeProvider(() => fakeResponse(validProposalJson()));
    const service = new AIProgrammerService(db, provider);
    await service.generateSession({ targetDate: SUNDAY });
    expect(provider.lastRequest?.mode).toBe('generate_session');
    expect(provider.lastRequest?.systemInstruction).toMatch(/Aesthetics\/physique/i);
    expect((provider.lastRequest?.context as any).targetDate).toBe(SUNDAY);
  });

  it('rejects invalid (schema-level) provider output and never returns a proposal', async () => {
    const provider = new FakeProvider(() => fakeResponse({ not: 'a valid proposal' }));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: SUNDAY })).rejects.toBeInstanceOf(AIOutputSchemaInvalidError);
  });

  it('rejects malformed (non-JSON) provider rawText', async () => {
    const provider = new FakeProvider(() => ({ provider: 'fake', model: 'm', requestId: 'r', rawText: 'not json at all' }));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: SUNDAY })).rejects.toBeInstanceOf(AIOutputSchemaInvalidError);
  });

  it('rejects output that fails domain validation (unknown exercise) and never returns a proposal', async () => {
    const provider = new FakeProvider(() =>
      fakeResponse(
        validProposalJson({
          exercises: [
            {
              exerciseId: 'totally-made-up-exercise',
              role: 'primary',
              targetType: 'physique_target',
              targetId: 'mid-pec',
              sets: 3,
              repsMin: 6,
              repsMax: 12,
              rirMin: 1,
              rirMax: 3,
              rationale: ['x'],
              source: 'blueprint',
            },
          ],
        })
      )
    );
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: SUNDAY })).rejects.toBeInstanceOf(AIOutputDomainInvalidError);
  });

  it('propagates a provider failure without persisting or fabricating a proposal', async () => {
    const provider = new FakeProvider(() => {
      throw new AIProviderUnavailableError('simulated outage');
    });
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: SUNDAY })).rejects.toBeInstanceOf(AIProviderUnavailableError);
  });

  it('never creates any workout_sessions/program rows on any failure path', async () => {
    const before = new WorkoutSessionsRepo(db).listSessions().length;
    const provider = new FakeProvider(() => fakeResponse({ garbage: true }));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: SUNDAY })).rejects.toThrow();
    expect(new WorkoutSessionsRepo(db).listSessions().length).toBe(before);
  });

  it('never mutates an existing completed session when generating for a different date', async () => {
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const completed = sessionsRepo.createSession({ date: '2026-09-08', session_type: 'gym', status: 'completed' });
    const provider = new FakeProvider(() => fakeResponse(validProposalJson()));
    const service = new AIProgrammerService(db, provider);
    await service.generateSession({ targetDate: SUNDAY });
    const stillThere = sessionsRepo.getSession(completed.session_id);
    expect(stillThere?.status).toBe('completed');
  });
});
