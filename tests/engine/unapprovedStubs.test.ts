// Proves the module boundary is exactly where docs/TRAINING_ENGINE_DESIGN.md
// says it should be: every engine module whose real logic depends on an
// unapproved design decision throws NotApprovedError, loudly and
// specifically, rather than silently returning an invented answer or a
// generic "not implemented." This is the executable form of acceptance
// criterion "the full automatic optimizer is not implemented until the
// design decisions are approved."

import { describe, expect, it } from 'vitest';
import { NotApprovedError } from '../../src/engine/errors.js';
import { buildWorkout } from '../../src/engine/workoutBuilder.js';

describe('unapproved engine modules — throw, never silently invent an answer', () => {
  it('workoutBuilder.buildWorkout throws NotApprovedError referencing its unresolved dependencies', () => {
    try {
      buildWorkout({} as any);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotApprovedError);
      expect((err as NotApprovedError).decision).toBe('resource-allocation-and-time-fitting');
    }
  });
});
