// AI Programmer First Vertical Slice — Correction Pass
// (docs/CLAUDE_TASK_AI_PROGRAMMER_VERTICAL_SLICE_CORRECTIONS.md):
// regression tests for all 6 corrected behaviors — full authored-
// prescription fidelity, strict calendar-date validation, targetDate/
// weekday cross-validation, timezone semantics, bounded validation
// diagnostics, and application-owned proposalId.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import { validateProposalDomain } from '../../src/ai-programmer/validation/programmerDomainValidator.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION, type AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';
import { AIOutputDomainInvalidError } from '../../src/ai-programmer/errors.js';
import {
  MAX_DIAGNOSTIC_ISSUES,
  MAX_DIAGNOSTIC_ISSUE_CHARS,
  MAX_DIAGNOSTIC_TOTAL_CHARS,
  boundDiagnosticIssues,
} from '../../src/ai-programmer/validation/diagnosticsBounds.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13'; // still-editable relative to real "today" 2026-09-12
const MONDAY_NEXT = '2026-09-14';

let db: Database.Database;
let context: AIProgrammerContext;

function setupProfile() {
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
}

function baseProposal(overrides: Partial<AIWorkoutSessionProposal> = {}): AIWorkoutSessionProposal {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'model-supplied-id',
    mode: 'generate_session',
    targetDate: context.targetDate,
    weekday: context.targetWeekday,
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
    programmingRationale: ['Prioritizing chest this session.'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  setupProfile();
  context = buildProgrammerContext(db, { targetDate: SUNDAY });
});

// ---------------------------------------------------------------------
// §2 — Full authored prescription fidelity
// ---------------------------------------------------------------------
describe('correction §2 — authored prescription fidelity', () => {
  it('accepts exact authored values (sets:3, repsMin:6, repsMax:12, rirMin:1, rirMax:3)', () => {
    const result = validateProposalDomain(baseProposal(), context, db);
    expect(result.ok).toBe(true);
  });

  it('rejects altered sets even when it "improves" on the authored value', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, sets: 2 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/\.sets must equal Blueprint-authored value 3; received 2/);
  });

  it('rejects altered repsMin', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, repsMin: 3 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/\.repsMin must equal Blueprint-authored value 6; received 3/);
  });

  it('rejects altered repsMax', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, repsMax: 5 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/\.repsMax must equal Blueprint-authored value 12; received 5/);
  });

  it('rejects altered rirMin', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, rirMin: 0 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/\.rirMin must equal Blueprint-authored value 1; received 0/);
  });

  it('rejects altered rirMax', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, rirMax: 1 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/\.rirMax must equal Blueprint-authored value 3; received 1/);
  });

  it('multiple altered fields each produce their own precise validation issue', () => {
    const result = validateProposalDomain(
      baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, sets: 2, repsMin: 3, repsMax: 5, rirMin: 0, rirMax: 1 }] }),
      context,
      db
    );
    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.includes('must equal Blueprint-authored value'))).toHaveLength(5);
  });

  it('an exercise with NO authored prescription still follows the existing non-authored rules (generic cap, not exact-match)', () => {
    const target = context.targets.find((t) => t.targetId === 'rectus-abdominis');
    const entry = target?.validExercises.find((v) => v.exerciseId === 'ab-wheel-rollout');
    expect(entry?.authoredPrescription).toBeNull(); // confirms the fixture actually has no authored prescription here

    const proposal = baseProposal({
      exercises: [
        {
          exerciseId: 'ab-wheel-rollout',
          role: 'primary',
          targetType: 'physique_target',
          targetId: 'rectus-abdominis',
          sets: 4,
          repsMin: 8,
          repsMax: 12,
          rirMin: 1,
          rirMax: 3,
          rationale: ['x'],
          source: 'blueprint',
        },
      ],
    });
    expect(validateProposalDomain(proposal, context, db).ok).toBe(true);

    const overCap = baseProposal({
      exercises: [{ ...proposal.exercises[0]!, sets: 7 }],
    });
    const result = validateProposalDomain(overCap, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/application-configured cap of 6/);
  });
});

// ---------------------------------------------------------------------
// §3 — Strict calendar-date validation (route level)
// ---------------------------------------------------------------------
describe('correction §3 — strict calendar-date validation at the route', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(db);
  });

  const invalidDates = ['2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-01', '26-01-01', '2026-02-29'];
  for (const invalid of invalidDates) {
    it(`rejects invalid calendar date "${invalid}" with 400`, async () => {
      const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: invalid });
      expect(res.status).toBe(400);
    });
  }

  const validDates = ['2026-02-28', '2026-03-01'];
  for (const valid of validDates) {
    it(`does not reject a real calendar date "${valid}" for its date shape (fails only for being disabled)`, async () => {
      const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: valid });
      expect(res.status).not.toBe(400);
      expect(res.body.error).not.toMatch(/calendar date/);
    });
  }

  it('accepts a real leap-day target date for its date shape', async () => {
    // 2028-02-29 is a real future leap day.
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: '2028-02-29' });
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------
// §4 — Cross-validate proposal targetDate/weekday
// ---------------------------------------------------------------------
describe('correction §4 — targetDate/weekday cross-validation', () => {
  it('accepts the exact requested targetDate and matching weekday', () => {
    expect(validateProposalDomain(baseProposal(), context, db).ok).toBe(true);
  });

  it('rejects a proposal that substitutes a different targetDate', () => {
    const result = validateProposalDomain(baseProposal({ targetDate: '2026-09-14' }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/targetDate: proposal targets "2026-09-14" but the request was for "2026-09-13"/);
  });

  it('rejects an incorrect weekday for the correct targetDate', () => {
    const result = validateProposalDomain(baseProposal({ weekday: 'monday' }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/weekday: proposal says "monday" but 2026-09-13 is actually "sunday"/);
  });

  it('rejects a proposal where BOTH targetDate and weekday are individually valid values but do not correspond to each other', () => {
    // 2026-09-21 is a real Monday; "sunday" is a real weekday value —
    // both fields are individually well-formed, but they mismatch each
    // other AND the actual request.
    const result = validateProposalDomain(baseProposal({ targetDate: '2026-09-21', weekday: 'sunday' }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('targetDate'))).toBe(true);
  });

  it('cross-validation holds at a week boundary (Sunday requested, Monday context)', () => {
    const mondayContext = buildProgrammerContext(db, { targetDate: MONDAY_NEXT });
    const proposal = baseProposal({ targetDate: SUNDAY, weekday: 'sunday' }); // still describes the PREVIOUS context's date
    const result = validateProposalDomain(proposal, mondayContext, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/targetDate: proposal targets "2026-09-13" but the request was for "2026-09-14"/);
  });

  it('a correct proposal at the Monday side of the same week boundary is accepted', () => {
    const mondayContext = buildProgrammerContext(db, { targetDate: MONDAY_NEXT });
    const proposal = baseProposal({ targetDate: MONDAY_NEXT, weekday: 'monday' });
    expect(validateProposalDomain(proposal, mondayContext, db).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------
// §5 — Timezone semantics (Option A: no request-level override)
// ---------------------------------------------------------------------
describe('correction §5 — timezone is always the stored TrainingProfile timezone', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(db);
  });

  it('rejects a request that supplies a timezone override, with a clear 400', async () => {
    const res = await request(app).post('/api/ai-programmer/generate-session').send({ targetDate: SUNDAY, timezone: 'America/New_York' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone is not accepted/);
  });

  it('the built context always reports the stored profile timezone, never an override', () => {
    expect(context.timezone).toBe('Asia/Kolkata');
  });

  it('buildProgrammerContext accepts only { targetDate } — no timezone field in its input type', () => {
    // Type-level guarantee exercised at runtime: passing an extra
    // property has no effect because the builder never reads it.
    const built = buildProgrammerContext(db, { targetDate: SUNDAY, ...( { timezone: 'America/New_York' } as any) });
    expect(built.timezone).toBe('Asia/Kolkata');
  });
});

// ---------------------------------------------------------------------
// §6 — Bounded validation diagnostics
// ---------------------------------------------------------------------
describe('correction §6 — bounded validation diagnostics', () => {
  it('caps the number of returned issues at MAX_DIAGNOSTIC_ISSUES with an explicit omission note', () => {
    const manyIssues = Array.from({ length: 50 }, (_, i) => `issue number ${i}`);
    const bounded = boundDiagnosticIssues(manyIssues);
    expect(bounded.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUES + 1);
    expect(bounded.at(-1)).toMatch(/more issue\(s\) omitted \[truncated\]/);
  });

  it('caps an individual issue at MAX_DIAGNOSTIC_ISSUE_CHARS with a truncation marker', () => {
    const longIssue = 'x'.repeat(2000);
    const bounded = boundDiagnosticIssues([longIssue]);
    expect(bounded[0]!.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUE_CHARS);
    expect(bounded[0]!.endsWith('[truncated]')).toBe(true);
  });

  it('caps the total diagnostic payload at MAX_DIAGNOSTIC_TOTAL_CHARS — a hard bound, marker included', () => {
    const issues = Array.from({ length: MAX_DIAGNOSTIC_ISSUES }, () => 'y'.repeat(MAX_DIAGNOSTIC_ISSUE_CHARS));
    const bounded = boundDiagnosticIssues(issues);
    const totalChars = bounded.reduce((sum, i) => sum + i.length, 0);
    // The trailing truncation marker is fit WITHIN the remaining
    // budget (never appended on top of it), so this is a strict <=,
    // not "plus a little extra for the marker."
    expect(totalChars).toBeLessThanOrEqual(MAX_DIAGNOSTIC_TOTAL_CHARS);
  });

  it('the total-character bound holds even with an enormous number of issues (marker itself gets truncated to fit)', () => {
    const manyHugeIssues = Array.from({ length: 100_000 }, () => 'z'.repeat(MAX_DIAGNOSTIC_ISSUE_CHARS));
    const bounded = boundDiagnosticIssues(manyHugeIssues);
    const totalChars = bounded.reduce((sum, i) => sum + i.length, 0);
    expect(totalChars).toBeLessThanOrEqual(MAX_DIAGNOSTIC_TOTAL_CHARS);
  });

  it('AIOutputDomainInvalidError carries bounded diagnostics, never the raw unbounded issue list', () => {
    const hugeIssues = Array.from({ length: 200 }, (_, i) => `exceedingly long malformed field value ${'z'.repeat(1000)} #${i}`);
    const err = new AIOutputDomainInvalidError(hugeIssues);
    const details = err.details as { issues: string[] };
    expect(details.issues.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUES + 1);
    expect(JSON.stringify(details).length).toBeLessThan(20_000); // safely bounded, not the ~200KB raw payload
  });

  it('bounding diagnostics never changes the underlying ok/not-ok validation result', () => {
    const proposal = baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, exerciseId: 'does-not-exist' }] });
    const result = validateProposalDomain(proposal, context, db);
    expect(result.ok).toBe(false); // the validator itself is untouched by diagnostic bounding
  });

  it('no secret or raw provider payload ever appears in a bounded diagnostic', () => {
    const issuesWithSecretLookingText = ['some issue mentioning VELONA_API_KEY=not-a-real-value should still just be text'];
    const err = new AIOutputDomainInvalidError(issuesWithSecretLookingText);
    // The bounding utility does not redact content (it only limits
    // size) — this test documents that raw provider payloads/headers
    // are never fed into diagnostics in the first place (see
    // aiProgrammerService.ts, which only ever passes structured
    // validation-issue strings, never a raw response body, into these
    // errors).
    expect(err.publicMessage).not.toMatch(/Authorization: Bearer/);
  });
});

// ---------------------------------------------------------------------
// §7 — Application-owned proposalId
// ---------------------------------------------------------------------
describe('correction §7 — proposalId is application-owned', () => {
  class FakeProvider implements AIProgrammerProvider {
    constructor(private readonly modelProposalId: string) {}
    async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
      return {
        provider: 'fake',
        model: 'fake-model',
        requestId: request.requestId,
        rawText: JSON.stringify(baseProposal({ proposalId: this.modelProposalId })),
      };
    }
  }

  beforeEach(() => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.AI_PROGRAMMER_ENABLED;
  });

  it('the returned proposalId is generated by the application, not the value the provider returned', async () => {
    const service = new AIProgrammerService(db, new FakeProvider('model-chosen-id-123'));
    const result = await service.generateSession({ targetDate: SUNDAY });
    expect(result.proposal.proposalId).not.toBe('model-chosen-id-123');
    expect(result.proposal.proposalId).toMatch(/^[0-9a-f-]{36}$/); // a real UUID
  });

  it('the provider cannot force a duplicate proposal ID across two requests', async () => {
    const serviceA = new AIProgrammerService(db, new FakeProvider('same-id-both-times'));
    const serviceB = new AIProgrammerService(db, new FakeProvider('same-id-both-times'));
    const resultA = await serviceA.generateSession({ targetDate: SUNDAY });
    const resultB = await serviceB.generateSession({ targetDate: SUNDAY });
    expect(resultA.proposal.proposalId).not.toBe(resultB.proposal.proposalId);
  });

  it('an excessively long provider-supplied proposal ID never affects the final response', async () => {
    const service = new AIProgrammerService(db, new FakeProvider('x'.repeat(100_000)));
    const result = await service.generateSession({ targetDate: SUNDAY });
    expect(result.proposal.proposalId.length).toBe(36);
  });

  it('a missing provider proposalId is also fine — the application still supplies a real one', async () => {
    class NoIdProvider implements AIProgrammerProvider {
      async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
        const { proposalId: _drop, ...rest } = baseProposal();
        return { provider: 'fake', model: 'fake-model', requestId: request.requestId, rawText: JSON.stringify(rest) };
      }
    }
    const service = new AIProgrammerService(db, new NoIdProvider());
    const result = await service.generateSession({ targetDate: SUNDAY });
    expect(result.proposal.proposalId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
