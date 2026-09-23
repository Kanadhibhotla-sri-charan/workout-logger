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
  AIOutputAdequacyInvalidError,
  AIOutputDomainInvalidError,
  AIOutputSchemaInvalidError,
  AIProgrammerDisabledError,
  AIProposalAlreadyPendingError,
  AIProviderOutputTruncatedError,
  AIProviderUnavailableError,
} from '../../src/ai-programmer/errors.js';
import { approveProposal, commitAIProposalToPlannedSession } from '../../src/ai-programmer/service/aiProposalLifecycle.js';
import { weekdayOfDate } from '../../src/engine/workoutBuilder.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { AIProposalRepo } from '../../src/repositories/aiProposalRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

// Computed relative to the real clock (unlike SUNDAY above, a fixed
// calendar date that goes stale/past-dated the moment real time passes
// it — see the pre-existing, unrelated failures this exposes) so the
// duplicate-generation guard tests below never rot into false failures.
function futureDate(): { date: string; weekday: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 60);
  const date = d.toISOString().slice(0, 10);
  return { date, weekday: weekdayOfDate(date) };
}

/** Same real-clock discipline as futureDate(), nudged forward until it
 * lands on a real Rest day for the training_days seeded below (Mon/Tue/
 * Thu/Fri) — the "no already-decided sessionPurpose of its own" case the
 * requestedSessionPurpose tests below specifically need. */
function futureRestDate(): { date: string; weekday: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 60);
  while (['monday', 'tuesday', 'thursday', 'friday'].includes(weekdayOfDate(d.toISOString().slice(0, 10)))) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const date = d.toISOString().slice(0, 10);
  return { date, weekday: weekdayOfDate(date) };
}

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

  // "Ask what to generate" fix (2026-09-23): Sunday has no training day
  // of its own (training_days above), so its own default sessionPurpose
  // is null — exactly the "day has no already-decided purpose" case an
  // explicit requestedSessionPurpose is for. `provider.lastRequest` is
  // captured the moment the (fake) provider is called, well before the
  // response is parsed/validated — these tests only care what CONTEXT
  // was built and sent, so a fake response that doesn't happen to also
  // satisfy the real adequacy validator's own volume floors is fine to
  // ignore (`.catch(() => {})`) rather than needing to be a fully
  // blueprint-compliant proposal (that's already covered by the domain/
  // adequacy validator's own dedicated test suites).
  describe('requestedSessionPurpose — "ask what to generate" fix', () => {
    it('is null in context.programmingBrief.session.purpose when omitted, for a day with no rotation slot of its own (unchanged prior behavior)', async () => {
      const { date, weekday } = futureRestDate();
      const provider = new FakeProvider(() => fakeResponse(validProposalJson({ targetDate: date, weekday })));
      const service = new AIProgrammerService(db, provider);
      await service.generateSession({ targetDate: date }).catch(() => {});
      expect((provider.lastRequest?.context as any).programmingBrief.session.purpose).toBeNull();
    });

    it('sets context.programmingBrief.session.purpose to the explicit choice when provided', async () => {
      const { date, weekday } = futureRestDate();
      const provider = new FakeProvider(() => fakeResponse(validProposalJson({ targetDate: date, weekday, sessionFocus: ['legs'] })));
      const service = new AIProgrammerService(db, provider);
      await service.generateSession({ targetDate: date, requestedSessionPurpose: 'legs' }).catch(() => {});
      expect((provider.lastRequest?.context as any).programmingBrief.session.purpose).toBe('legs');
    });

    it('a different requested purpose changes the expected coverage targets too, not just the label', async () => {
      const { date, weekday } = futureRestDate();
      const legsProvider = new FakeProvider(() => fakeResponse(validProposalJson({ targetDate: date, weekday, sessionFocus: ['legs'] })));
      const legsService = new AIProgrammerService(db, legsProvider);
      await legsService.generateSession({ targetDate: date, requestedSessionPurpose: 'legs' }).catch(() => {});
      const legsTargets = (legsProvider.lastRequest?.context as any).programmingBrief.session.expectedCoverageTargetIds;

      const pushProvider = new FakeProvider(() => fakeResponse(validProposalJson({ targetDate: date, weekday, sessionFocus: ['push'] })));
      const pushService = new AIProgrammerService(db, pushProvider);
      await pushService.generateSession({ targetDate: date, requestedSessionPurpose: 'push' }).catch(() => {});
      const pushTargets = (pushProvider.lastRequest?.context as any).programmingBrief.session.expectedCoverageTargetIds;

      expect(legsTargets).not.toEqual(pushTargets);
      expect(legsTargets).toContain('quads');
      expect(pushTargets).toContain('mid-pec');
    });

    // Real production failure (2026-09-23), reproduced live against the
    // real qwen model with requestedSessionPurpose: 'push', then traced
    // stage by stage (schema -> repairProposal -> domain -> adequacy)
    // through the real, UNMODIFIED pipeline with this exact scenario:
    //
    //   exercise (target)              model sets -> repaired sets   floor
    //   flat-barbell-bench-press (mid-pec)   8    ->      3            5
    //   cable-pushdown (triceps)             8    ->      2            7
    //   cable-woodchop (obliques)            3    ->      2            8
    //
    // The FIRST stage that actually fails is validateProposalAdequacy —
    // schema and domain validation both pass; repairProposal clamps every
    // exercise down to its own Blueprint-authored per-exposure ceiling
    // BEFORE adequacy ever runs (cable-woodchop's own authored ceiling is
    // only 2 sets — the model's "3" was never the number adequacy actually
    // saw). Adequacy then correctly flags BOTH triceps (2 of a 7-set
    // floor, 29%) and obliques (2 of an 8-set floor, 25%) as "clearly
    // inadequate" (its own <50%-of-floor threshold) — mid-pec's 3-of-5
    // (60%) does NOT trip it, confirming the threshold is a real band, not
    // a blanket "any shortfall fails" rule. This is real, verified-AFTER-
    // repair invalid output — not an assumption, and not something a
    // validator-rule change would fix: no single Blueprint-authored
    // obliques/triceps exercise here has a high enough per-exposure
    // ceiling to reach its own target's recommended floor alone; a valid
    // proposal needs the model to select MULTIPLE exercises per such
    // target, which it did not do in this reproduction. No repair rule,
    // adequacy threshold, or authored ceiling was changed to produce or
    // explain this result.
    it('reproduces the real live Push failure end-to-end, matching the exact traced mechanism: repair clamps every exercise to its own authored ceiling, then adequacy correctly flags triceps AND obliques as still below floor', async () => {
      const { date, weekday } = futureRestDate();
      const provider = new FakeProvider(() =>
        fakeResponse(
          validProposalJson({
            targetDate: date,
            weekday,
            sessionFocus: ['push'],
            exercises: [
              { ...validProposalJson().exercises[0], exerciseId: 'flat-barbell-bench-press', targetId: 'mid-pec', sets: 8 },
              { ...validProposalJson().exercises[0], exerciseId: 'cable-pushdown', targetId: 'triceps', sets: 8 },
              // obliques is UNIVERSAL_PHYSIQUE_TARGETS (engine/config.ts)
              // — 'push' always expects real coverage of it too. Traced:
              // cable-woodchop's own authored ceiling is 2 sets, so this
              // "3" is repaired down to 2 before adequacy ever sees it.
              { ...validProposalJson().exercises[0], exerciseId: 'cable-woodchop', targetId: 'obliques', sets: 3 },
            ],
          })
        )
      );
      const service = new AIProgrammerService(db, provider);

      const err = await service.generateSession({ targetDate: date, requestedSessionPurpose: 'push' }).catch((e) => e);
      expect(err).toBeInstanceOf(AIOutputAdequacyInvalidError);
      // Both flagged targets, exactly as traced — not just one.
      expect(err.details.issues.some((i: string) => i.includes('physique_target:triceps'))).toBe(true);
      expect(err.details.issues.some((i: string) => i.includes('physique_target:obliques'))).toBe(true);
      // mid-pec's 3-of-5 (60%) is genuinely fine — never flagged.
      expect(err.details.issues.some((i: string) => i.includes('physique_target:mid-pec'))).toBe(false);
      // The proposal is never persisted — bad AI output is rejected
      // outright, never silently accepted as if valid.
      expect(new AIProposalRepo(db).findLatestForTargetDate(date)).toBeUndefined();
    });
  });

  it('rejects a second generateSession for the same targetDate while a proposal is still pending, without calling the provider again', async () => {
    const { date, weekday } = futureDate();
    let callCount = 0;
    const provider = new FakeProvider(() => {
      callCount += 1;
      return fakeResponse(validProposalJson({ targetDate: date, weekday }));
    });
    const service = new AIProgrammerService(db, provider);
    await service.generateSession({ targetDate: date });
    expect(callCount).toBe(1);

    await expect(service.generateSession({ targetDate: date })).rejects.toBeInstanceOf(AIProposalAlreadyPendingError);
    expect(callCount).toBe(1); // provider never invoked for the rejected second call
  });

  it('does not block generation for a different targetDate while another date has a pending proposal', async () => {
    const { date: dateA, weekday: weekdayA } = futureDate();
    const dateB = (() => {
      const d = new Date(dateA);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const weekdayB = weekdayOfDate(dateB);
    const provider = new FakeProvider((request) => {
      const context = request.context as { targetDate: string };
      const isA = context.targetDate === dateA;
      return fakeResponse(validProposalJson({ targetDate: isA ? dateA : dateB, weekday: isA ? weekdayA : weekdayB }));
    });
    const service = new AIProgrammerService(db, provider);
    await service.generateSession({ targetDate: dateA });

    await expect(service.generateSession({ targetDate: dateB })).resolves.toMatchObject({ status: 'pending' });
  });

  it('allows generateSession again once the prior proposal for that date has been committed', async () => {
    const { date, weekday } = futureDate();
    const provider = new FakeProvider(() => fakeResponse(validProposalJson({ targetDate: date, weekday })));
    const service = new AIProgrammerService(db, provider);
    const first = await service.generateSession({ targetDate: date });

    approveProposal(db, first.proposalId);
    // This fixture's training_days is ['monday','tuesday','thursday','friday'];
    // the computed future date may or may not land on one of those, so
    // 'replace_day_activity' (no precondition on current activity) is the
    // intent guaranteed to succeed regardless of which weekday it lands on.
    commitAIProposalToPlannedSession(db, first.proposalId, { intent: 'replace_day_activity' });

    const second = await service.generateSession({ targetDate: date });
    expect(second.proposalId).not.toBe(first.proposalId);
  });

  it('allows generateSession again once the prior proposal for that date has expired', async () => {
    const { date, weekday } = futureDate();
    const provider = new FakeProvider(() => fakeResponse(validProposalJson({ targetDate: date, weekday })));
    const service = new AIProgrammerService(db, provider);
    const first = await service.generateSession({ targetDate: date });

    db.prepare('UPDATE ai_program_proposals SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', first.proposalId);

    const second = await service.generateSession({ targetDate: date });
    expect(second.proposalId).not.toBe(first.proposalId);
  });

  it('rejects a structurally/domain-valid but programmatically INADEQUATE proposal (exceeds the target\'s deterministic volume cap), and persists nothing', async () => {
    const { date, weekday } = futureDate();
    // incline-dumbbell-press has no Blueprint-authored prescription for
    // upper-pec (freely settable, capped only by the generic 6-set
    // ceiling), while incline-barbell-press does (exactly 3 sets/6-12
    // reps/1-3 RIR in the real Efficient chest package) — together they
    // sum to 9 direct sets for upper-pec, one more than that muscle's
    // real Efficient per-exposure cap of 8 (src/blueprint/snapshot/
    // programming.json: chest efficient package = 8 sets/session).
    // Structurally/domain-valid (every individual rule still holds);
    // only the NEW adequacy check should catch the aggregate.
    const provider = new FakeProvider(() =>
      fakeResponse(
        validProposalJson({
          targetDate: date,
          weekday,
          exercises: [
            {
              exerciseId: 'incline-dumbbell-press',
              role: 'primary',
              targetType: 'physique_target',
              targetId: 'upper-pec',
              sets: 6,
              repsMin: 8,
              repsMax: 12,
              rirMin: 1,
              rirMax: 3,
              rationale: ['x'],
              source: 'blueprint',
            },
            {
              exerciseId: 'incline-barbell-press',
              role: 'primary',
              targetType: 'physique_target',
              targetId: 'upper-pec',
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
    const before = new AIProposalRepo(db).findLatestForTargetDate(date);
    expect(before).toBeUndefined();

    await expect(service.generateSession({ targetDate: date })).rejects.toBeInstanceOf(AIOutputAdequacyInvalidError);

    expect(new AIProposalRepo(db).findLatestForTargetDate(date)).toBeUndefined(); // nothing persisted
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

  // Coaching Depth follow-up fix regression coverage: a provider
  // response whose completion was cut off by the output-token limit
  // (observed live in production after the Coaching Depth rollout —
  // `actualOutputTokens` landing exactly on `configuredMaxOutputTokens`,
  // producing incomplete/invalid JSON) must be reported as a distinct
  // AIProviderOutputTruncatedError, never the generic
  // AIOutputSchemaInvalidError — the two have different causes (a
  // provider budget problem vs. a genuinely malformed response) and the
  // truncated case should never be treated as if schema validation ran
  // against real, complete content.
  it('reports a truncated (incomplete-JSON) provider response as AIProviderOutputTruncatedError, not a generic schema-invalid error', async () => {
    const { date } = futureDate();
    const provider = new FakeProvider(() => ({
      provider: 'fake',
      model: 'm',
      requestId: 'r',
      rawText: '{"schemaVersion": 1, "exercises": [{"exerciseId": "flat-barbell-bench-press", "rationale": ["incomplete',
      finishReason: 'length',
      usage: { inputTokens: 29000, outputTokens: 4096, totalTokens: 33096 },
      requestDiagnostics: { systemInstructionChars: 1, userTurnChars: 1, wirePayloadChars: 1, configuredMaxOutputTokens: 4096 },
    }));
    const service = new AIProgrammerService(db, provider);
    const err = await service.generateSession({ targetDate: date }).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderOutputTruncatedError);
    expect(err).not.toBeInstanceOf(AIOutputSchemaInvalidError);
  });

  it('a numeric truncation signal (completion tokens at the configured cap) is detected even when the provider reports no recognized finishReason', async () => {
    const { date } = futureDate();
    const provider = new FakeProvider(() => ({
      provider: 'fake',
      model: 'm',
      requestId: 'r',
      rawText: '{"incomplete truncated json',
      usage: { inputTokens: 100, outputTokens: 4096, totalTokens: 4196 },
      requestDiagnostics: { systemInstructionChars: 1, userTurnChars: 1, wirePayloadChars: 1, configuredMaxOutputTokens: 4096 },
    }));
    const service = new AIProgrammerService(db, provider);
    await expect(service.generateSession({ targetDate: date })).rejects.toBeInstanceOf(AIProviderOutputTruncatedError);
  });

  it('malformed JSON with NO truncation signal (well under the token cap, ordinary finish reason) is still the generic schema-invalid error', async () => {
    const { date } = futureDate();
    const provider = new FakeProvider(() => ({
      provider: 'fake',
      model: 'm',
      requestId: 'r',
      rawText: 'not json at all',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      requestDiagnostics: { systemInstructionChars: 1, userTurnChars: 1, wirePayloadChars: 1, configuredMaxOutputTokens: 4096 },
    }));
    const service = new AIProgrammerService(db, provider);
    const err = await service.generateSession({ targetDate: date }).catch((e) => e);
    expect(err).toBeInstanceOf(AIOutputSchemaInvalidError);
    expect(err).not.toBeInstanceOf(AIProviderOutputTruncatedError);
  });

  it('never persists a proposal when the provider output was truncated', async () => {
    const { date } = futureDate();
    const before = new AIProposalRepo(db).findLatestForTargetDate(date);
    expect(before).toBeUndefined();
    const provider = new FakeProvider(() => ({
      provider: 'fake',
      model: 'm',
      requestId: 'r',
      rawText: '{"incomplete',
      finishReason: 'length',
      usage: { inputTokens: 100, outputTokens: 4096, totalTokens: 4196 },
      requestDiagnostics: { systemInstructionChars: 1, userTurnChars: 1, wirePayloadChars: 1, configuredMaxOutputTokens: 4096 },
    }));
    const service = new AIProgrammerService(db, provider);
    await service.generateSession({ targetDate: date }).catch(() => undefined);
    expect(new AIProposalRepo(db).findLatestForTargetDate(date)).toBeUndefined();
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
