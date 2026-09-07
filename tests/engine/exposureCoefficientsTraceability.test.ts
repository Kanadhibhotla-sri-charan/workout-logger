// Programming Redesign (Step 12) §16.C: explicit traceability that the
// primary/secondary exposure coefficients (1.00/0.33) are unchanged by
// this redesign, and that the field is never labeled "effective sets"
// anywhere in the public contract. The underlying behavior was already
// proven by tests/engine/exposureEngine.test.ts (from a prior phase,
// unmodified here) — this file is the direct, named regression check
// this phase's own required test list asks for.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPOSURE_COEFFICIENTS } from '../../src/engine/config.js';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';

describe('Exposure coefficients (spec section 16.C)', () => {
  it('primary = 1.00, secondary = 0.33 — exact, unchanged values', () => {
    expect(EXPOSURE_COEFFICIENTS.primary).toBe(1.0);
    expect(EXPOSURE_COEFFICIENTS.secondary).toBe(0.33);
  });

  it('a real calculation applies the coefficients exactly, never a rounded/approximated substitute', () => {
    const { contributions } = calculateExerciseExposure('flat-barbell-bench-press', [
      { completed: true },
      { completed: true },
      { completed: true },
    ]);
    const primary = contributions.find((c) => c.role === 'primary')!;
    const secondary = contributions.find((c) => c.role === 'secondary')!;
    expect(primary.exposure_units).toBeCloseTo(3 * EXPOSURE_COEFFICIENTS.primary, 6);
    expect(secondary.exposure_units).toBeCloseTo(3 * EXPOSURE_COEFFICIENTS.secondary, 6);
  });

  it('secondary exposure is never mislabeled as "effective sets" — no such field/property exists, only exposure_units (a comment may still explain the distinction in prose)', () => {
    const source = readFileSync(new URL('../../src/engine/exposureEngine.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/effective_sets?\s*:/);
    expect(source).toContain('exposure_units');
  });

  it('secondary exposure is a real, distinct field from direct/primary sets — never merged or substituted 1:1', () => {
    const { contributions } = calculateExerciseExposure('flat-barbell-bench-press', [{ completed: true }, { completed: true }]);
    const primaryTargetIds = contributions.filter((c) => c.role === 'primary').map((c) => c.target_id);
    const secondaryTargetIds = contributions.filter((c) => c.role === 'secondary').map((c) => c.target_id);
    // Disjoint sets of targets — a target is never counted as both its
    // own direct primary work AND a secondary contribution from the
    // same exercise (this exercise's own §7 "no double-role" rule).
    expect(primaryTargetIds.some((id) => secondaryTargetIds.includes(id))).toBe(false);
    expect(secondaryTargetIds.length).toBeGreaterThan(0);
  });
});
