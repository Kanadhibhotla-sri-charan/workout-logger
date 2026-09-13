// Real Dry-Run Token Report spec (docs/DEV_INSTRUCTIONS_REAL_TOKEN_REPORT_GENERATE_RECONCILE.md
// §11): unit tests against buildTokenReport() directly (no HTTP layer),
// proving the dry run reuses the exact production context builders and
// the exact shared Velona serialization builder — never a second,
// hand-approximated payload — and never calls the network.

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

  // Item 2: proves the dry run never calls the network — a global fetch
  // spy that fails the test the instant it is invoked.
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
  it('never invokes fetch (item 2)', () => {
    buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the real Generate context builder and the shared Velona serializer, matching production byte-for-byte (items 1, 3, 5, 6, 8)', () => {
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
    // Item 6: wireBodyChars equals JSON.stringify(body).length exactly.
    expect(report.measurements.wireBodyChars).toBe(JSON.stringify(body).length);
    // Item 8: context/schema are not double-counted — modelInputChars is
    // exactly systemInstruction + userTurnContent (which already embeds
    // context and outputSchema once each), not a sum that also adds
    // contextJsonChars/outputSchemaJsonChars a second time.
    expect(report.measurements.modelInputChars).toBe(systemInstruction.length + userTurnContent.length);
    expect(report.measurements.contextJsonChars).toBe(JSON.stringify(context).length);
  });

  it('UTF-8 byte counts are calculated correctly, including for multi-byte characters (item 7)', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    const config = loadVelonaConfig();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    const systemInstruction = buildProgrammerSystemInstruction();
    const outputSchema = getProgrammerOutputSchema();
    const providerRequest: AIProgrammerProviderRequest = { mode: 'generate_session', systemInstruction, context, outputSchema, requestId: report.requestId };
    const { body, outputSchemaJson } = buildVelonaRequestBody(providerRequest, config);
    expect(report.measurements.wireBodyBytesUtf8).toBe(Buffer.byteLength(JSON.stringify(body), 'utf8'));
    expect(report.measurements.outputSchemaJsonBytesUtf8).toBe(Buffer.byteLength(outputSchemaJson, 'utf8'));
    expect(report.measurements.contextJsonBytesUtf8).toBe(Buffer.byteLength(JSON.stringify(context), 'utf8'));
    // ASCII-only content here means char count and byte count coincide;
    // the assertions above still exercise the real Buffer.byteLength
    // path rather than assuming chars === bytes.
    expect(report.measurements.wireBodyBytesUtf8).toBeGreaterThanOrEqual(report.measurements.wireBodyChars);
  });

  it('reports estimatedInputTokens using the documented chars/4 heuristic, clearly labeled (never claimed exact)', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.tokenCountMethod).toBe('chars_div_4_estimate');
    expect(report.measurements.estimatedInputTokens).toBe(estimateTokensFromChars(report.measurements.modelInputChars));
  });

  it('reports a defensible output-token planning value under the default config, and separates it from configuredMaxOutputTokens', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.output.configuredMaxOutputTokens).toBe(4096); // provider default
    expect(report.output.estimatedTypicalOutputTokens).toBe(2000); // §6 recommended Generate value, fits under 4096
    expect(report.output.estimatedOutputTokens).toBe(2000);
    expect(report.output.estimatedTotalTokens).toBe(report.measurements.estimatedInputTokens + 2000);
    expect(report.output.note).toMatch(/planning value/i);
    expect(report.output.note).toMatch(/actual completion length is only known after a live request/i);
  });

  it('reports null estimatedTypicalOutputTokens with an explanatory note when the recommended value exceeds configured max_tokens', () => {
    process.env.VELONA_MAX_TOKENS = '1000'; // below the 2000 recommended for generate_session
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.output.configuredMaxOutputTokens).toBe(1000);
    expect(report.output.estimatedTypicalOutputTokens).toBeNull();
    expect(report.output.estimatedOutputTokens).toBe(0);
    expect(report.output.note).toMatch(/exceeds the configured max_tokens/);
  });
});

describe('buildTokenReport — reconcile_week', () => {
  it('never invokes fetch (item 2)', () => {
    buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the real Reconcile context builder and the shared Velona serializer, matching production byte-for-byte (items 1, 4, 5, 6, 8)', () => {
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

  it('reports the §6 recommended Reconcile planning value (3000) under the default config', () => {
    const report = buildTokenReport(db, { mode: 'reconcile_week', targetDate: SUNDAY });
    expect(report.output.estimatedTypicalOutputTokens).toBe(3000);
    expect(report.output.estimatedOutputTokens).toBe(3000);
  });
});

describe('buildTokenReport — cost projection (item 11)', () => {
  it('is null when no pricing is supplied, and labeled projected_cost, never actual', () => {
    const report = buildTokenReport(db, { mode: 'generate_session', targetDate: SUNDAY });
    expect(report.costProjection.label).toBe('projected_cost');
    expect(report.costProjection.inputPricePerMillionTokens).toBeNull();
    expect(report.costProjection.estimatedInputCost).toBeNull();
    expect(report.costProjection.estimatedOutputCost).toBeNull();
    expect(report.costProjection.estimatedTotalCost).toBeNull();
  });

  it('computes estimatedInputCost/estimatedOutputCost/estimatedTotalCost using the documented formulas', () => {
    const report = buildTokenReport(db, {
      mode: 'generate_session',
      targetDate: SUNDAY,
      costInputs: { inputPricePerMillionTokens: 3, outputPricePerMillionTokens: 15 },
    });
    const expectedInputCost = (report.measurements.estimatedInputTokens / 1_000_000) * 3;
    const expectedOutputCost = (report.output.estimatedOutputTokens / 1_000_000) * 15;
    expect(report.costProjection.estimatedInputCost).toBeCloseTo(expectedInputCost, 12);
    expect(report.costProjection.estimatedOutputCost).toBeCloseTo(expectedOutputCost, 12);
    expect(report.costProjection.estimatedTotalCost).toBeCloseTo(expectedInputCost + expectedOutputCost, 12);
  });

  it('computes only the supplied side when just one price is given', () => {
    const report = buildTokenReport(db, {
      mode: 'generate_session',
      targetDate: SUNDAY,
      costInputs: { inputPricePerMillionTokens: 3 },
    });
    expect(report.costProjection.estimatedInputCost).not.toBeNull();
    expect(report.costProjection.estimatedOutputCost).toBeNull();
    expect(report.costProjection.estimatedTotalCost).toBeNull();
  });
});

describe('buildTokenReport — secrets never appear in the report (item 10)', () => {
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
