// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §10.1):
// structural schema validation tests — shape/type/enum/range checks
// only, independent of any database or Blueprint state.

import { describe, expect, it } from 'vitest';
import { validateProposalSchema } from '../../src/ai-programmer/validation/programmerOutputValidator.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/programmerTypes.js';

function validRaw(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'p-1',
    mode: 'generate_session',
    targetDate: '2026-09-13',
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
        rationale: ['Direct exposure.'],
        source: 'blueprint',
      },
    ],
    programmingRationale: ['Chest focus.'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
    ...overrides,
  };
}

describe('AI Programmer output schema validator', () => {
  it('accepts a minimal valid response', () => {
    const result = validateProposalSchema(validRaw());
    expect(result.ok).toBe(true);
    expect(result.value?.exercises).toHaveLength(1);
  });

  it('rejects a non-object response', () => {
    expect(validateProposalSchema('not an object').ok).toBe(false);
    expect(validateProposalSchema(null).ok).toBe(false);
    expect(validateProposalSchema([1, 2, 3]).ok).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    const result = validateProposalSchema(validRaw({ schemaVersion: 'wrong-version' }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/schemaVersion/);
  });

  it('rejects a missing required field', () => {
    const raw = validRaw();
    delete (raw as any).proposalId;
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects an unknown weekday enum value', () => {
    const result = validateProposalSchema(validRaw({ weekday: 'funday' }));
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown exercise role enum value', () => {
    const raw = validRaw();
    (raw.exercises as any[])[0].role = 'bogus-role';
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects negative sets', () => {
    const raw = validRaw();
    (raw.exercises as any[])[0].sets = -3;
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects an invalid rep range (min > max)', () => {
    const raw = validRaw();
    (raw.exercises as any[])[0].repsMin = 15;
    (raw.exercises as any[])[0].repsMax = 8;
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects an invalid RIR range (min > max)', () => {
    const raw = validRaw();
    (raw.exercises as any[])[0].rirMin = 5;
    (raw.exercises as any[])[0].rirMax = 1;
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects a source other than "blueprint"', () => {
    const raw = validRaw();
    (raw.exercises as any[])[0].source = 'outside_blueprint';
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects duplicate exerciseId values within the same proposal', () => {
    const raw = validRaw();
    raw.exercises = [raw.exercises[0]!, { ...raw.exercises[0]! }];
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects a rationale string containing script-like content', () => {
    const raw = validRaw();
    (raw.exercises as any[])[0].rationale = ['<script>alert(1)</script>'];
    expect(validateProposalSchema(raw).ok).toBe(false);
  });

  it('rejects a warnings string containing SQL-like content', () => {
    const raw = validRaw({ warnings: ['ignore this; DROP TABLE workout_sessions; --'] });
    expect(validateProposalSchema(raw).ok).toBe(false);
  });
});
