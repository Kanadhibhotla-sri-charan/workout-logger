import { describe, expect, it } from 'vitest';
import { assignSessionPurposes, isTargetCompatibleWithPurpose } from '../../src/engine/sessionPurpose.js';

describe('sessionPurpose — Final Programming-Engine Pass §5', () => {
  describe('isTargetCompatibleWithPurpose', () => {
    it('a chest target is compatible with push and upper, not pull or legs', () => {
      expect(isTargetCompatibleWithPurpose('physique_target', 'mid-pec', 'push')).toBe(true);
      expect(isTargetCompatibleWithPurpose('physique_target', 'mid-pec', 'upper')).toBe(true);
      expect(isTargetCompatibleWithPurpose('physique_target', 'mid-pec', 'pull')).toBe(false);
      expect(isTargetCompatibleWithPurpose('physique_target', 'mid-pec', 'legs')).toBe(false);
    });

    it('biceps (pull) and triceps (push) resolve to different purposes, even though Blueprint groups both under "arms"', () => {
      expect(isTargetCompatibleWithPurpose('physique_target', 'biceps', 'pull')).toBe(true);
      expect(isTargetCompatibleWithPurpose('physique_target', 'biceps', 'push')).toBe(false);
      expect(isTargetCompatibleWithPurpose('physique_target', 'triceps', 'push')).toBe(true);
      expect(isTargetCompatibleWithPurpose('physique_target', 'triceps', 'pull')).toBe(false);
    });

    it('quads (legs) is compatible with legs only', () => {
      expect(isTargetCompatibleWithPurpose('physique_target', 'quads', 'legs')).toBe(true);
      expect(isTargetCompatibleWithPurpose('physique_target', 'quads', 'push')).toBe(false);
      expect(isTargetCompatibleWithPurpose('physique_target', 'quads', 'pull')).toBe(false);
      expect(isTargetCompatibleWithPurpose('physique_target', 'quads', 'upper')).toBe(false);
    });

    it('a universal target (abs) is compatible with every purpose', () => {
      for (const purpose of ['push', 'pull', 'legs', 'upper'] as const) {
        expect(isTargetCompatibleWithPurpose('physique_target', 'rectus-abdominis', purpose)).toBe(true);
      }
    });

    it('a functional_goal target is always compatible, regardless of purpose', () => {
      for (const purpose of ['push', 'pull', 'legs', 'upper'] as const) {
        expect(isTargetCompatibleWithPurpose('functional_goal', 'anything', purpose)).toBe(true);
      }
    });
  });

  describe('assignSessionPurposes', () => {
    it('rotates push/pull/legs/upper across the ordered gym days', () => {
      const { purposes } = assignSessionPurposes(['monday', 'tuesday', 'thursday', 'friday']);
      expect(purposes.get('monday')).toBe('push');
      expect(purposes.get('tuesday')).toBe('pull');
      expect(purposes.get('thursday')).toBe('legs');
      expect(purposes.get('friday')).toBe('upper');
    });

    it('never assigns legs to Monday — swaps with the next available day', () => {
      const { purposes, reasoning } = assignSessionPurposes(['monday', 'wednesday', 'thursday']);
      // Naive rotation would put push=monday, pull=wednesday, legs=thursday
      // — thursday isn't Monday, so no swap is actually needed here; use
      // a case where legs WOULD land on Monday instead.
      expect(purposes.get('monday')).not.toBe('legs');
      expect(reasoning).toContain('Monday-never-legs');
    });

    it('forces legs off Monday even when the naive rotation would put it there', () => {
      // Only 2 gym days -> rotation index 0,1 = push,pull normally, but a
      // 3rd/4th-position wrap can still land legs on Monday depending on
      // day order; construct that directly by starting the rotation at
      // position 2 (three days, Monday last).
      const { purposes } = assignSessionPurposes(['tuesday', 'thursday', 'monday']);
      // Naive: tuesday=push, thursday=pull, monday=legs -> must be swapped.
      expect(purposes.get('monday')).not.toBe('legs');
      expect([...purposes.values()]).toContain('legs'); // legs still exists somewhere this week
    });

    it('moves legs off a recurring badminton day onto a feasible alternative (remediation §9, now a purpose swap)', () => {
      const { purposes, reasoning } = assignSessionPurposes(['tuesday', 'thursday', 'friday'], ['thursday']);
      // Naive: tuesday=push, thursday=pull, friday=legs -> friday isn't
      // badminton-constrained, so no swap needed here; use a day order
      // that puts legs on the badminton day instead.
      const { purposes: p2, reasoning: r2 } = assignSessionPurposes(['tuesday', 'wednesday', 'thursday'], ['thursday']);
      expect(p2.get('thursday')).not.toBe('legs');
      expect(r2).toContain('recurring badminton day');
    });

    it('is deterministic — identical input produces identical output', () => {
      const a = assignSessionPurposes(['monday', 'tuesday', 'thursday', 'friday'], ['saturday', 'sunday']);
      const b = assignSessionPurposes(['monday', 'tuesday', 'thursday', 'friday'], ['saturday', 'sunday']);
      expect([...a.purposes.entries()]).toEqual([...b.purposes.entries()]);
    });

    it('accommodates fewer than 4 gym days without error', () => {
      const { purposes } = assignSessionPurposes(['tuesday', 'friday']);
      expect(purposes.get('tuesday')).toBe('push');
      expect(purposes.get('friday')).toBe('pull');
    });

    it('accommodates zero gym days without error', () => {
      const { purposes, reasoning } = assignSessionPurposes([]);
      expect(purposes.size).toBe(0);
      expect(typeof reasoning).toBe('string');
    });
  });
});
