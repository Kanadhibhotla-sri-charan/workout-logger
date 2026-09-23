// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.4):
// service-level tests using a fake AIProgrammerProvider — no real
// Velona API key is ever used or required.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { AIProgrammerService, buildProgrammerSystemInstruction } from '../../src/ai-programmer/service/aiProgrammerService.js';
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
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
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

  // "Generation layer" fix (2026-09-24): the forensic trace above proved
  // the failure is real AFTER repair; this investigates whether
  // generate_session's own prompt gave the model enough information and
  // freedom to construct a valid multi-exercise proposal in the first
  // place. Two changes, both to buildProgrammerSystemInstruction() only —
  // no validator, repair, cap, or threshold touched anywhere:
  //   Fix A: the parent/sub-target shared-credit rule (already present,
  //     verbatim, in buildWeekReconciliationSystemInstruction and
  //     buildGenerateWeekSystemInstruction) was missing from
  //     generate_session specifically.
  //   Fix B: rule 12(6) ("assigning sets") previously said "add A SECOND
  //     valid exercise" — capping the model's own guidance at exactly one
  //     addition even when a target's floor genuinely needs a third.
  describe('"generation layer" fix — shared-credit rule + uncapped multi-exercise guidance', () => {
    it('Fix A: generate_session\'s system instruction now carries the shared-credit rule', () => {
      const instruction = buildProgrammerSystemInstruction();
      expect(instruction).toMatch(/credited by the app toward the broader target's own weekly number too/);
      expect(instruction).toMatch(/the exact same exerciseId appears in both targets' own validExercises lists/);
      // Never counted twice — the anti-double-counting half of the rule.
      expect(instruction).toMatch(/never counted as two separate sets/);
      expect(instruction).toMatch(/must never list the same exercise under both target ids to try to credit it twice/);
    });

    it('the copied rule\'s own internal cross-reference is corrected for this function\'s real rule numbers (not silently pointing at the donor functions\' rule 19)', () => {
      const instruction = buildProgrammerSystemInstruction();
      // The donor functions' own "rules 5 and 19" would, in THIS
      // function's numbering, point at "plausibleIntensityTechniques" —
      // unrelated. Verifies the reference was corrected, not copied blind.
      expect(instruction).toMatch(/the same judgment rules 5 and 9 already give you/);
      expect(instruction).not.toMatch(/the same judgment rules 5 and 19 already give you/);
    });

    it('Fix B: rule 12(6) no longer caps the guidance at exactly one additional exercise', () => {
      const instruction = buildProgrammerSystemInstruction();
      expect(instruction).not.toMatch(/add a second valid exercise/);
      expect(instruction).toMatch(/add additional valid exercises for that muscle as needed/);
      expect(instruction).toMatch(/until the muscle's recommended minimum is reached or the realistic valid exercise options are exhausted/);
    });

    it('Fix B still explicitly forbids exceeding any individual exercise\'s own authored/per-exposure ceiling, even while adding more exercises', () => {
      const instruction = buildProgrammerSystemInstruction();
      expect(instruction).toMatch(/without exceeding any individual exercise's authored sets or per-exposure ceiling/);
      expect(instruction).toMatch(/never inflating any one exercise beyond its own ceiling to avoid adding another/);
    });

    // The exact Push fixture from the trace above, but with a
    // STRUCTURALLY VALID multi-exercise solution this time — proving the
    // GENERATOR (not the validator) is the layer that needed fixing: the
    // same context, same targets, same authored ceilings, now satisfied
    // by combining exercises exactly as rule 12(6) now instructs.
    it('the same Push scenario now succeeds when the (fake) provider returns a valid multi-exercise combination', async () => {
      const { date, weekday } = futureRestDate();
      const provider = new FakeProvider(() =>
        fakeResponse(
          validProposalJson({
            targetDate: date,
            weekday,
            sessionFocus: ['push'],
            exercises: [
              // triceps floor 7: close-grip-bench-press(3) + overhead-
              // triceps-extension(2) + cable-pushdown(2) = 7, none
              // exceeding its own authored ceiling, no target-specific
              // exercise-count cap applies to triceps.
              { ...validProposalJson().exercises[0], exerciseId: 'close-grip-bench-press', targetId: 'triceps', sets: 3 },
              { ...validProposalJson().exercises[0], exerciseId: 'overhead-triceps-extension', targetId: 'triceps', sets: 2 },
              { ...validProposalJson().exercises[0], exerciseId: 'cable-pushdown', targetId: 'triceps', sets: 2 },
              // obliques: the adequacy floor is only 50% of recommended
              // min (UNDER_PRESCRIPTION_TOLERANCE — 4 of an 8-set min),
              // never the full min itself, and ABS_SESSION_EXERCISE_
              // SHARE_MAX (engine/config.ts) hard-caps abs/obliques at 2
              // exercises per session regardless of floor — discovered
              // directly (an earlier 3-exercise version of this fixture
              // was silently trimmed to 2 by repair's own session caps).
              // cable-crunch(3) + pallof-press(2) = 5, clearing the real
              // 4-set threshold within the real 2-exercise cap.
              { ...validProposalJson().exercises[0], exerciseId: 'cable-crunch', targetId: 'obliques', sets: 3 },
              { ...validProposalJson().exercises[0], exerciseId: 'pallof-press', targetId: 'obliques', sets: 2 },
            ],
          })
        )
      );
      const service = new AIProgrammerService(db, provider);

      const result = await service.generateSession({ targetDate: date, requestedSessionPurpose: 'push' });
      expect(result.proposal.exercises).toHaveLength(5);
      expect(new AIProposalRepo(db).findLatestForTargetDate(date)).toBeDefined();
    });

    // Shared-credit "preserved" means, precisely: the ADEQUACY VALIDATOR's
    // own per-target check is completely unchanged by either fix — it
    // still sums sets strictly by each exercise's own literal targetId,
    // with NO cross-target crediting logic anywhere (verified directly
    // against programmerAdequacyValidator.ts's own setsByTarget(), which
    // groups only by `${ex.targetType}:${ex.targetId}`). Rule 7 is
    // information for the MODEL's own reasoning about what remains
    // unmet; it does not, and was never asked to, change what the
    // validator itself requires. This test proves that boundary holds:
    // sets given only under the sub-target (triceps-long-head) do NOT
    // satisfy the broader target's (triceps) own floor at the validator
    // level, exactly as before either fix.
    it('shared-credit is a prompt-level instruction only — the validator still requires a GOAL-ORIENTED target\'s OWN literal sets, with no automatic crediting from a shared sub-target exercise', async () => {
      // triceps-back-depth's primary_targets is ['triceps'] (Blueprint) —
      // makes context.targets.find('triceps').isGoalOriented === true, so
      // the validator's own "an active-goal target...received no direct
      // work at all" check (which — confirmed below — does NOT apply to
      // a non-goal target left at zero, a pre-existing, unrelated
      // legitimate-omission allowance) actually applies here.
      new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
      const { date, weekday } = futureRestDate();
      const provider = new FakeProvider(() =>
        fakeResponse(
          validProposalJson({
            targetDate: date,
            weekday,
            sessionFocus: ['push'],
            exercises: [
              // Adequate work for mid-pec so it's not what fails here.
              { ...validProposalJson().exercises[0], exerciseId: 'flat-barbell-bench-press', targetId: 'mid-pec', sets: 3 },
              // ALL triceps volume given only under the sub-target
              // (triceps-long-head) — per rule 7, this is a legitimate,
              // real 2 sets of long-head-emphasis work, but it carries
              // targetId: 'triceps-long-head', never 'triceps' itself.
              { ...validProposalJson().exercises[0], exerciseId: 'overhead-triceps-extension', targetId: 'triceps-long-head', sets: 2 },
            ],
          })
        )
      );
      const service = new AIProgrammerService(db, provider);

      const err = await service.generateSession({ targetDate: date, requestedSessionPurpose: 'push' }).catch((e) => e);
      expect(err).toBeInstanceOf(AIOutputAdequacyInvalidError);
      // triceps itself received zero directly-targeted sets — still
      // flagged, exactly as it would have been before either fix. Shared
      // credit never suppresses this check; it is prompt-only guidance
      // for the model's own reasoning about how much MORE it still needs
      // to add, never a change to what the validator itself requires.
      expect(err.details.issues.some((i: string) => i.includes('physique_target:triceps:') && i.includes('no direct work at all'))).toBe(true);
    });

    // The pre-existing, unrelated allowance the test above depends on —
    // confirmed directly so its own premise is documented, not assumed.
    it('(pre-existing, unrelated behavior, confirmed for context) a non-goal target left at zero direct sets is a legitimate omission, not flagged — unaffected by either fix', async () => {
      const { date, weekday } = futureRestDate();
      const provider = new FakeProvider(() =>
        fakeResponse(
          validProposalJson({
            targetDate: date,
            weekday,
            sessionFocus: ['push'],
            exercises: [
              { ...validProposalJson().exercises[0], exerciseId: 'flat-barbell-bench-press', targetId: 'mid-pec', sets: 3 },
              { ...validProposalJson().exercises[0], exerciseId: 'overhead-triceps-extension', targetId: 'triceps-long-head', sets: 2 },
            ],
          })
        )
      );
      const service = new AIProgrammerService(db, provider); // no goal seeded — triceps is non-goal here

      const result = await service.generateSession({ targetDate: date, requestedSessionPurpose: 'push' });
      expect(new AIProposalRepo(db).findLatestForTargetDate(date)).toBeDefined();
      expect(result.proposal.exercises.some((e) => e.targetId === 'triceps')).toBe(false);
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
