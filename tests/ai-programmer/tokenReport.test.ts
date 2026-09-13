// Token Measurement iteration
// (docs/DEV_INSTRUCTIONS_TOKEN_MEASUREMENT_NEXT_ITERATION.md §8): unit
// tests against buildTokenReport() directly (no HTTP/CLI layer),
// proving the dry run reuses the exact production context builders and
// the exact shared Velona serialization builder — never a second,
// hand-approximated payload — never calls the network, and represents
// an unavailable typical-output estimate as `null`, never `0`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { buildTokenReport } from '../../src/ai-programmer/service/tokenReport.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { buildReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextBuilder.js';
import { getProgrammerOutputSchema } from '../../src/ai-programmer/contracts/programmerOutputSchema.js';
import { getWeekReconciliationOutputSchema } from '../../src/ai-programmer/contracts/weekReconciliationOutputSchema.js';
import { buildProgrammerSystemInstruction, buildWeekReconciliationSystemInstruction } from '../../src/ai-programmer/service/aiProgrammerService.js';
import { buildVelonaRequestBody } from '../../src/ai-programmer/provider/velonaProvider.js';
import { loadVelonaConfig } from '../../src/ai-programmer/provider/config.js';
import { estimateTokensFromChars } from '../../src/ai-programmer/service/tokenDiagnostics.js';
import type { AIProgrammerProviderRequest } from '../../src/ai-programmer/contracts/providerTypes.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

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

  // Proves the dry run never calls the network — a global fetch spy
  // that fails the test the instant it is invoked.
  fetchMock = vi.fn(() => {
    throw new Error('fetch must never be called by a dry-run token report');
  });
  vi.stubGlobal('fetch', fetchMock);

  process.env.VELONA_API_KEY = 'test-key-not-real';
  process.env.VELONA_MODEL = 'test-model';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
  delete process.env.VELONA_BASE_URL;
  delete process.env.VELONA_MAX_TOKENS;
});

describe('buildTokenReport — generate_session', () => {
  it('never invokes fetch', () => {
    buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the real Generate context builder and the shared Velona serializer, matching production byte-for-byte, without double-counting context/schema', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.mode).toBe('generate_session');
    expect(report.targetDate).toBe(SUNDAY);
    expect(report.weekStart).toBeNull();

    // Reconstruct the exact production request independently, using the
    // report's own requestId (a fixed-length UUID) so the reconstructed
    // wire body is byte-identical in length to the one the report itself
    // measured — proving there is no second, drifting implementation.
    const config = loadVelonaConfig();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    const systemInstruction = buildProgrammerSystemInstruction();
    const outputSchema = getProgrammerOutputSchema();
    const providerRequest: AIProgrammerProviderRequest = {
      mode: 'generate_session',
      systemInstruction,
      context,
      outputSchema,
      requestId: report.requestId,
    };
    const { body, userTurnContent, outputSchemaJson } = buildVelonaRequestBody(providerRequest, config);

    expect(report.measurements.systemInstructionChars).toBe(systemInstruction.length);
    expect(report.measurements.userTurnContentChars).toBe(userTurnContent.length);
    expect(report.measurements.outputSchemaJsonChars).toBe(outputSchemaJson.length);
    expect(report.measurements.wireBodyChars).toBe(JSON.stringify(body).length);
    // Context/schema are not double-counted — modelInputChars is exactly
    // systemInstruction + userTurnContent (which already embeds context
    // and outputSchema once each), not a sum that also adds
    // contextJsonChars/outputSchemaJsonChars a second time.
    expect(report.measurements.modelInputChars).toBe(systemInstruction.length + userTurnContent.length);
    expect(report.measurements.contextJsonChars).toBe(JSON.stringify(context).length);
    // Wire-body measurements are distinct from model-input measurements
    // (the wire body is a strict superset — envelope/config bytes too).
    expect(report.measurements.wireBodyChars).toBeGreaterThan(report.measurements.modelInputChars);
  });

  it('UTF-8 byte counts are calculated correctly, including modelInputUtf8Bytes as the sum of its two parts', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    const config = loadVelonaConfig();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    const systemInstruction = buildProgrammerSystemInstruction();
    const outputSchema = getProgrammerOutputSchema();
    const providerRequest: AIProgrammerProviderRequest = { mode: 'generate_session', systemInstruction, context, outputSchema, requestId: report.requestId };
    const { body, userTurnContent, outputSchemaJson } = buildVelonaRequestBody(providerRequest, config);

    expect(report.measurements.systemInstructionUtf8Bytes).toBe(Buffer.byteLength(systemInstruction, 'utf8'));
    expect(report.measurements.userTurnContentUtf8Bytes).toBe(Buffer.byteLength(userTurnContent, 'utf8'));
    expect(report.measurements.modelInputUtf8Bytes).toBe(report.measurements.systemInstructionUtf8Bytes + report.measurements.userTurnContentUtf8Bytes);
    expect(report.measurements.wireBodyUtf8Bytes).toBe(Buffer.byteLength(JSON.stringify(body), 'utf8'));
    expect(report.measurements.outputSchemaJsonUtf8Bytes).toBe(Buffer.byteLength(outputSchemaJson, 'utf8'));
    expect(report.measurements.contextJsonUtf8Bytes).toBe(Buffer.byteLength(JSON.stringify(context), 'utf8'));
    expect(report.measurements.wireBodyUtf8Bytes).toBeGreaterThanOrEqual(report.measurements.wireBodyChars);
  });

  it('reports estimatedInputTokens using the documented chars/4 heuristic, clearly labeled (never claimed exact)', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.tokenEstimate.tokenEstimateMethod).toBe('chars_div_4_estimate');
    expect(report.tokenEstimate.estimatedInputTokens).toBe(estimateTokensFromChars(report.measurements.modelInputChars));
  });

  it('reports a defensible output-token planning value under the default config, and separates it from configuredMaxOutputTokens', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.tokenEstimate.configuredMaxOutputTokens).toBe(4096); // provider default
    expect(report.tokenEstimate.estimatedTypicalOutputTokens).toBe(2000); // recommended Generate value, fits under 4096
    expect(report.tokenEstimate.estimatedTotalTokens).toBe(report.tokenEstimate.estimatedInputTokens + 2000);
    expect(report.tokenEstimate.note).toMatch(/planning value/i);
    expect(report.tokenEstimate.note).toMatch(/actual completion length is only known after a live request/i);
  });

  it('represents an unavailable typical-output estimate as null — never 0 — and estimatedTotalTokens also becomes null, while configuredMaxOutputTokens is still reported', () => {
    process.env.VELONA_MAX_TOKENS = '1000'; // below the 2000 recommended for generate_session
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.tokenEstimate.configuredMaxOutputTokens).toBe(1000);
    expect(report.tokenEstimate.estimatedTypicalOutputTokens).toBeNull();
    expect(report.tokenEstimate.estimatedTypicalOutputTokens).not.toBe(0);
    expect(report.tokenEstimate.estimatedTotalTokens).toBeNull();
    expect(report.tokenEstimate.note).toMatch(/exceeds the configured max_tokens/);
  });
});

describe('buildTokenReport — reconcile_week', () => {
  it('never invokes fetch', () => {
    buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the real Reconcile context builder and the shared Velona serializer, matching production byte-for-byte', () => {
    const report = buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY, reason: 'gym slot moved' });
    expect(report.mode).toBe('reconcile_week');
    expect(report.weekStart).toBe('2026-09-07'); // Monday of the week containing SUNDAY

    const config = loadVelonaConfig();
    const context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym', reason: 'gym slot moved', swapUnavailableReason: undefined });
    const systemInstruction = buildWeekReconciliationSystemInstruction();
    const outputSchema = getWeekReconciliationOutputSchema();
    const providerRequest: AIProgrammerProviderRequest = {
      mode: 'reconcile_week',
      systemInstruction,
      context,
      outputSchema,
      requestId: report.requestId,
    };
    const { body, userTurnContent, outputSchemaJson } = buildVelonaRequestBody(providerRequest, config);

    expect(report.measurements.systemInstructionChars).toBe(systemInstruction.length);
    expect(report.measurements.userTurnContentChars).toBe(userTurnContent.length);
    expect(report.measurements.outputSchemaJsonChars).toBe(outputSchemaJson.length);
    expect(report.measurements.wireBodyChars).toBe(JSON.stringify(body).length);
    expect(report.measurements.modelInputChars).toBe(systemInstruction.length + userTurnContent.length);
    expect(report.measurements.contextJsonChars).toBe(JSON.stringify(context).length);
  });

  it('reports the recommended Reconcile planning value (3000) under the default config', () => {
    const report = buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(report.tokenEstimate.estimatedTypicalOutputTokens).toBe(3000);
    expect(report.tokenEstimate.estimatedTotalTokens).toBe(report.tokenEstimate.estimatedInputTokens + 3000);
  });

  it('represents an unavailable typical-output estimate as null for reconcile_week too', () => {
    process.env.VELONA_MAX_TOKENS = '2500'; // below the 3000 recommended for reconcile_week
    const report = buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(report.tokenEstimate.estimatedTypicalOutputTokens).toBeNull();
    expect(report.tokenEstimate.estimatedTotalTokens).toBeNull();
    expect(report.tokenEstimate.configuredMaxOutputTokens).toBe(2500);
  });
});

describe('buildTokenReport — context summary', () => {
  it('generate_session: reports real activeGoalCount/weeklyProgramDayCount, marks plannedSessionCount as not applicable', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.contextSummary.activeGoalCount).toBe(0);
    expect(report.contextSummary.weeklyProgramDayCount).toBe(7);
    expect(report.contextSummary.lockedDayCount).toBe(0);
    expect(report.contextSummary.plannedSessionCount).toBeNull();
    expect(report.contextSummary.historySessionCount).toBe(0);
    expect(report.contextSummary.overrideCount).toBe(0);
  });

  it('reconcile_week: reports real plannedSessionCount/lockedDayCount from the existing program', () => {
    const report = buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(report.contextSummary.weeklyProgramDayCount).toBe(7);
    expect(report.contextSummary.lockedDayCount).toBe(0);
    expect(report.contextSummary.plannedSessionCount).toBe(0);
    expect(report.contextSummary.overrideCount).toBe(0);
  });
});

describe('buildTokenReport — cost projection', () => {
  it('is null when no pricing is supplied, and labeled projected_cost, never actual', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.costProjection.label).toBe('projected_cost');
    expect(report.costProjection.pricingSource).toBeNull();
    expect(report.costProjection.inputUsdPerMillionTokens).toBeNull();
    expect(report.costProjection.inputCost).toBeNull();
    expect(report.costProjection.typicalOutputCost).toBeNull();
    expect(report.costProjection.typicalTotalCost).toBeNull();
    expect(report.costProjection.maximumOutputCost).toBeNull();
    expect(report.costProjection.maximumTotalCost).toBeNull();
  });

  it('computes typical and maximum projections using the documented formulas when the configured model has a pricing entry', () => {
    const report = buildTokenReport(db, {
      mode: 'generate_session',
      targetDate: SUNDAY,
      pricing: { source: 'unit-test', models: { 'test-model': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 } } },
    });
    const expectedInputCost = (report.tokenEstimate.estimatedInputTokens / 1_000_000) * 3;
    const expectedTypicalOutputCost = (report.tokenEstimate.estimatedTypicalOutputTokens! / 1_000_000) * 15;
    const expectedMaximumOutputCost = (report.tokenEstimate.configuredMaxOutputTokens / 1_000_000) * 15;
    expect(report.costProjection.pricingSource).toBe('unit-test');
    expect(report.costProjection.inputCost).toBeCloseTo(expectedInputCost, 12);
    expect(report.costProjection.typicalOutputCost).toBeCloseTo(expectedTypicalOutputCost, 12);
    expect(report.costProjection.typicalTotalCost).toBeCloseTo(expectedInputCost + expectedTypicalOutputCost, 12);
    expect(report.costProjection.maximumOutputCost).toBeCloseTo(expectedMaximumOutputCost, 12);
    expect(report.costProjection.maximumTotalCost).toBeCloseTo(expectedInputCost + expectedMaximumOutputCost, 12);
  });

  it('does not guess a price when the configured model has no pricing entry — every cost stays null', () => {
    const report = buildTokenReport(db, {
      mode: 'generate_session',
      targetDate: SUNDAY,
      pricing: { source: 'unit-test', models: { 'some-other-model': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 } } },
    });
    expect(report.costProjection.inputUsdPerMillionTokens).toBeNull();
    expect(report.costProjection.outputUsdPerMillionTokens).toBeNull();
    expect(report.costProjection.inputCost).toBeNull();
    expect(report.costProjection.typicalTotalCost).toBeNull();
    expect(report.costProjection.maximumTotalCost).toBeNull();
  });

  it('the maximum projection stays computable even when the typical estimate is unavailable (a ceiling, not an expected cost)', () => {
    process.env.VELONA_MAX_TOKENS = '1000'; // forces estimatedTypicalOutputTokens: null for generate_session
    const report = buildTokenReport(db, {
      mode: 'generate_session',
      targetDate: SUNDAY,
      pricing: { source: 'unit-test', models: { 'test-model': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 } } },
    });
    expect(report.tokenEstimate.estimatedTypicalOutputTokens).toBeNull();
    expect(report.costProjection.typicalOutputCost).toBeNull();
    expect(report.costProjection.typicalTotalCost).toBeNull();
    expect(report.costProjection.maximumOutputCost).not.toBeNull();
    expect(report.costProjection.maximumTotalCost).not.toBeNull();
  });

  it('computes only the input side when only an input price is configured', () => {
    const report = buildTokenReport(db, {
      mode: 'generate_session',
      targetDate: SUNDAY,
      pricing: { source: 'unit-test', models: { 'test-model': { inputUsdPerMillionTokens: 3 } } },
    });
    expect(report.costProjection.inputCost).not.toBeNull();
    expect(report.costProjection.typicalOutputCost).toBeNull();
    expect(report.costProjection.typicalTotalCost).toBeNull();
    expect(report.costProjection.maximumOutputCost).toBeNull();
    expect(report.costProjection.maximumTotalCost).toBeNull();
  });
});

describe('buildTokenReport — secrets never appear in the report', () => {
  it('the serialized report never contains the API key', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(JSON.stringify(report)).not.toContain('test-key-not-real');
  });

  it('the serialized report never contains an Authorization header value', () => {
    const report = buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(JSON.stringify(report).toLowerCase()).not.toContain('bearer ');
    expect(JSON.stringify(report).toLowerCase()).not.toContain('authorization');
  });
});
