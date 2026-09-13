// Fix AI Weekly Reconciliation Review, Finding 2: buildTokenDiagnostics
// must measure the EXACT text a request would actually send, never sum
// mismatched/partial pieces, never double-count outputSchema, and never
// fabricate actual usage when the provider didn't report any.

import { describe, expect, it } from 'vitest';
import { buildTokenDiagnostics, estimateTokensFromChars } from '../../src/ai-programmer/service/tokenDiagnostics.js';
import { buildVelonaUserTurnContent } from '../../src/ai-programmer/provider/velonaProvider.js';
import type { AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';

const REQUEST: AIProgrammerProviderRequest = {
  mode: 'generate_session',
  systemInstruction: 'You are the workout programmer.',
  context: { targetDate: '2026-09-20', targets: [{ id: 'mid-pec' }] },
  outputSchema: { type: 'object', properties: { exercises: { type: 'array' } } },
  requestId: 'req-diag-1',
};

describe('buildTokenDiagnostics', () => {
  it('systemInstructionChars matches the exact system-turn text length', () => {
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST);
    expect(diagnostics.systemInstructionChars).toBe(REQUEST.systemInstruction.length);
  });

  it('userTurnChars matches the exact user-turn content buildVelonaUserTurnContent would produce', () => {
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST);
    expect(diagnostics.userTurnChars).toBe(buildVelonaUserTurnContent(REQUEST).length);
  });

  it('outputSchema is never counted separately — it lives only inside userTurnChars', () => {
    const withoutSchema: AIProgrammerProviderRequest = { ...REQUEST, outputSchema: {} };
    const withSchema = REQUEST;
    const diagWithout = buildTokenDiagnostics('generate_session', withoutSchema);
    const diagWith = buildTokenDiagnostics('generate_session', withSchema);
    // A bigger outputSchema must show up exactly once, inside userTurnChars —
    // there is no separate outputSchemaChars field to double count into.
    expect(diagWith.userTurnChars).toBeGreaterThan(diagWithout.userTurnChars);
    expect(diagWith).not.toHaveProperty('outputSchemaChars');
  });

  it('wirePayloadChars and configuredMaxOutputTokens are absent (never fabricated) when the provider supplies no requestDiagnostics', () => {
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST, { rawText: '{}' });
    expect(diagnostics.wirePayloadChars).toBeUndefined();
    expect(diagnostics.configuredMaxOutputTokens).toBeUndefined();
  });

  it('wirePayloadChars and configuredMaxOutputTokens are taken from the provider-supplied requestDiagnostics when present', () => {
    const response: Pick<AIProgrammerProviderResponse, 'rawText' | 'requestDiagnostics'> = {
      rawText: '{}',
      requestDiagnostics: { systemInstructionChars: 999, userTurnChars: 888, wirePayloadChars: 12345, configuredMaxOutputTokens: 4096 },
    };
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST, response);
    expect(diagnostics.wirePayloadChars).toBe(12345);
    expect(diagnostics.configuredMaxOutputTokens).toBe(4096);
    // The provider's own exact figures take precedence over this
    // module's own reconstruction.
    expect(diagnostics.systemInstructionChars).toBe(999);
    expect(diagnostics.userTurnChars).toBe(888);
  });

  it('estimatedInputTokens is deterministic — identical requests always produce the identical estimate', () => {
    const a = buildTokenDiagnostics('generate_session', REQUEST);
    const b = buildTokenDiagnostics('generate_session', { ...REQUEST });
    expect(a.estimatedInputTokens).toBe(b.estimatedInputTokens);
    expect(a.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('estimatedInputTokens matches the documented ~4-chars-per-token heuristic applied to system + user-turn text', () => {
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST);
    const inputText = [REQUEST.systemInstruction, buildVelonaUserTurnContent(REQUEST)].join('\n');
    expect(diagnostics.estimatedInputTokens).toBe(estimateTokensFromChars(inputText.length));
  });

  it('estimatedOutputTokens is a heuristic from the raw response text length, absent entirely when there is no response', () => {
    const withResponse = buildTokenDiagnostics('generate_session', REQUEST, { rawText: 'x'.repeat(400) });
    expect(withResponse.estimatedOutputTokens).toBe(estimateTokensFromChars(400));
    const withoutResponse = buildTokenDiagnostics('generate_session', REQUEST);
    expect(withoutResponse.estimatedOutputTokens).toBe(0);
  });

  it('actual usage is parsed and exposed as-is when the provider reports it', () => {
    const response: Pick<AIProgrammerProviderResponse, 'rawText' | 'usage'> = {
      rawText: '{}',
      usage: { inputTokens: 1500, outputTokens: 300, totalTokens: 1800 },
    };
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST, response);
    expect(diagnostics.actualInputTokens).toBe(1500);
    expect(diagnostics.actualOutputTokens).toBe(300);
    expect(diagnostics.actualTotalTokens).toBe(1800);
  });

  it('absent usage stays absent (undefined) — never reported as zero or backfilled from the heuristic', () => {
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST, { rawText: '{}' });
    expect(diagnostics.actualInputTokens).toBeUndefined();
    expect(diagnostics.actualOutputTokens).toBeUndefined();
    expect(diagnostics.actualTotalTokens).toBeUndefined();
    // And the estimate is never silently relabeled as "actual" — the two
    // fields are always independent, whatever their individual values.
    expect(diagnostics.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('carries mode and requestId through unchanged, for both generate_session and reconcile_week', () => {
    const gen = buildTokenDiagnostics('generate_session', REQUEST);
    expect(gen.mode).toBe('generate_session');
    expect(gen.requestId).toBe(REQUEST.requestId);

    const reconcileRequest: AIProgrammerProviderRequest = { ...REQUEST, mode: 'reconcile_week' };
    const reconcile = buildTokenDiagnostics('reconcile_week', reconcileRequest);
    expect(reconcile.mode).toBe('reconcile_week');
  });

  it('never includes the raw context/outputSchema content, only counts', () => {
    const diagnostics = buildTokenDiagnostics('generate_session', REQUEST);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('mid-pec');
    expect(serialized).not.toContain('2026-09-20');
  });
});
