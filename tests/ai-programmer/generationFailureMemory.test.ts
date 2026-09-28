// Same-context retry gate: unit tests for the in-process failure memory
// itself (which failures are remembered, bounding, eviction, isolation).
// The end-to-end gate behavior through the real route is covered in
// aiProgrammerRoute.test.ts.

import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import {
  AIOutputAdequacyInvalidError,
  AIOutputDomainInvalidError,
  AIOutputSchemaInvalidError,
  AIProviderOutputTruncatedError,
  AIProviderRateLimitedError,
  AIProviderTimeoutError,
  AIProviderUnavailableError,
  AIProviderAuthenticationError,
  AIProposalAlreadyPendingError,
} from '../../src/ai-programmer/errors.js';
import {
  MAX_REMEMBERED_FAILURES_PER_DATABASE,
  clearGenerationFailure,
  findGenerationFailure,
  isGatedGenerationFailure,
  recordGenerationFailure,
} from '../../src/ai-programmer/service/generationFailureMemory.js';
import { MAX_DIAGNOSTIC_ISSUES } from '../../src/ai-programmer/validation/diagnosticsBounds.js';

/** Narrows a real error instance the same way the service does before recording it. */
function gated(err: unknown) {
  if (!isGatedGenerationFailure(err)) throw new Error('fixture is not a gated failure');
  return err;
}

describe('generationFailureMemory', () => {
  it('treats exactly the four AI-output quality failures as gated', () => {
    expect(isGatedGenerationFailure(new AIProviderOutputTruncatedError({ mode: 'generate_session' }))).toBe(true);
    expect(isGatedGenerationFailure(new AIOutputSchemaInvalidError(['x']))).toBe(true);
    expect(isGatedGenerationFailure(new AIOutputDomainInvalidError(['x']))).toBe(true);
    expect(isGatedGenerationFailure(new AIOutputAdequacyInvalidError(['x']))).toBe(true);
  });

  it('never treats provider/transient or application errors as gated', () => {
    expect(isGatedGenerationFailure(new AIProviderTimeoutError(1000))).toBe(false);
    expect(isGatedGenerationFailure(new AIProviderRateLimitedError(5))).toBe(false);
    expect(isGatedGenerationFailure(new AIProviderUnavailableError())).toBe(false);
    expect(isGatedGenerationFailure(new AIProviderAuthenticationError())).toBe(false);
    expect(isGatedGenerationFailure(new AIProposalAlreadyPendingError('2026-10-01', 'p-1'))).toBe(false);
    expect(isGatedGenerationFailure(new Error('plain'))).toBe(false);
  });

  it('records, finds and clears a marker by targetDate + contextHash only', () => {
    const db = openDb(':memory:');
    recordGenerationFailure(db, '2026-10-01', 'hash-a', gated(new AIOutputAdequacyInvalidError(['upper-traps: 2 sets is clearly inadequate volume'])));

    const found = findGenerationFailure(db, '2026-10-01', 'hash-a');
    expect(found?.code).toBe('AI_OUTPUT_ADEQUACY_INVALID');
    expect(found?.issues).toEqual(['upper-traps: 2 sets is clearly inadequate volume']);
    expect(typeof found?.failedAt).toBe('string');
    expect(findGenerationFailure(db, '2026-10-01', 'hash-b')).toBeUndefined();
    expect(findGenerationFailure(db, '2026-10-02', 'hash-a')).toBeUndefined();

    clearGenerationFailure(db, '2026-10-01', 'hash-a');
    expect(findGenerationFailure(db, '2026-10-01', 'hash-a')).toBeUndefined();
  });

  it('stores only bounded issues', () => {
    const db = openDb(':memory:');
    const manyLongIssues = Array.from({ length: MAX_DIAGNOSTIC_ISSUES + 10 }, (_, i) => `issue ${i} ${'x'.repeat(2000)}`);
    recordGenerationFailure(db, '2026-10-01', 'hash-a', gated(new AIOutputSchemaInvalidError(manyLongIssues)));

    const issues = findGenerationFailure(db, '2026-10-01', 'hash-a')!.issues;
    expect(issues.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUES + 1); // + omission marker
    expect(issues.every((i) => i.length <= 500)).toBe(true);
  });

  it('falls back to the safe public message when the error carries no issue list (truncation)', () => {
    const db = openDb(':memory:');
    const err = new AIProviderOutputTruncatedError({ mode: 'generate_session', finishReason: 'length' });
    recordGenerationFailure(db, '2026-10-01', 'hash-a', gated(err));
    expect(findGenerationFailure(db, '2026-10-01', 'hash-a')!.issues).toEqual([err.publicMessage]);
  });

  it('is bounded: the oldest marker is evicted once the per-database cap is exceeded', () => {
    const db = openDb(':memory:');
    for (let i = 0; i <= MAX_REMEMBERED_FAILURES_PER_DATABASE; i++) {
      recordGenerationFailure(db, '2026-10-01', `hash-${i}`, gated(new AIOutputSchemaInvalidError(['x'])));
    }
    expect(findGenerationFailure(db, '2026-10-01', 'hash-0')).toBeUndefined();
    expect(findGenerationFailure(db, '2026-10-01', `hash-${MAX_REMEMBERED_FAILURES_PER_DATABASE}`)).toBeDefined();
  });

  it('is isolated per database connection — never shared across databases', () => {
    const dbA = openDb(':memory:');
    const dbB = openDb(':memory:');
    recordGenerationFailure(dbA, '2026-10-01', 'hash-a', gated(new AIOutputSchemaInvalidError(['x'])));
    expect(findGenerationFailure(dbA, '2026-10-01', 'hash-a')).toBeDefined();
    expect(findGenerationFailure(dbB, '2026-10-01', 'hash-a')).toBeUndefined();
  });
});
