import { describe, expect, it } from 'vitest';
import { NoFeasibleExerciseError, selectExercise } from '../../src/engine/exerciseSelector.js';
import { explainExerciseSelection } from '../../src/engine/explanationEngine.js';

// triceps is a primary target for cable-pushdown, and only a secondary
// (mapped-from-free-text) target for cable-chest-press (whose own
// primary role is mid-pec) — see docs/SECONDARY_TARGET_MAPPING.md.
const TRICEPS_PRIMARY = 'cable-pushdown';
const TRICEPS_SECONDARY_ONLY = 'cable-chest-press';

describe('exerciseSelector — spec §5', () => {
  it('prefers a primary-role candidate over a secondary-only one for the same target (Blueprint muscle-role data)', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
    expect(result.reasoning).toContain('primary');
  });

  it('mildly penalizes a recently-used candidate but does not exclude it outright', () => {
    // Only one candidate at all — must still be selected even though recent.
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY],
      recent_exercise_ids: [TRICEPS_PRIMARY],
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
  });

  it('prefers a non-recent primary candidate over a recent primary candidate, all else equal', () => {
    const otherTricepsPrimary = 'close-grip-bench-press';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, otherTricepsPrimary],
      recent_exercise_ids: [TRICEPS_PRIMARY],
    });
    expect(result.exercise_id).toBe(otherTricepsPrimary);
  });

  it('§5: keeps the current exercise when it is tied for best, rather than replacing it for no reason', () => {
    const otherTricepsPrimary = 'close-grip-bench-press';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, otherTricepsPrimary],
      recent_exercise_ids: [],
      current_exercise_id: otherTricepsPrimary,
    });
    expect(result.exercise_id).toBe(otherTricepsPrimary);
    expect(result.reasoning).toContain('kept');
  });

  it('§5: replaces the current exercise when a demonstrably better (primary-role) candidate exists', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY],
      recent_exercise_ids: [],
      current_exercise_id: TRICEPS_SECONDARY_ONLY,
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
    expect(result.reasoning).toContain('replaces');
  });

  it('is deterministic: identical inputs always produce the identical output', () => {
    const input = {
      target_type: 'physique_target' as const,
      target_id: 'triceps',
      target_tier: 'primary' as const,
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY, 'close-grip-bench-press'],
      recent_exercise_ids: [TRICEPS_PRIMARY],
    };
    const a = selectExercise(input);
    const b = selectExercise(input);
    expect(a).toEqual(b);
  });

  it('throws NoFeasibleExerciseError when given no candidates at all', () => {
    expect(() =>
      selectExercise({
        target_type: 'physique_target',
        target_id: 'triceps',
        target_tier: 'primary',
        candidate_exercise_ids: [],
        recent_exercise_ids: [],
      })
    ).toThrow(NoFeasibleExerciseError);
  });

  it('reasoning is a real, non-opaque explanation (spec §20) and matches explainExerciseSelection', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.length).toBeGreaterThan(20);
    expect(explainExerciseSelection(result)).toBe(result.reasoning);
  });
});

describe('exerciseSelector — Strict Remediation Spec §3: gate hierarchy, no arbitrary scoring', () => {
  it('never assigns a numeric score — the result carries no such field', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(result).not.toHaveProperty('score');
  });

  it('Gate 2 throws for a genuinely irrelevant candidate list', () => {
    expect(() =>
      selectExercise({
        target_type: 'physique_target',
        target_id: 'quads', // leg target
        target_tier: 'primary',
        candidate_exercise_ids: [TRICEPS_PRIMARY], // an arm exercise, trains neither role for quads
        recent_exercise_ids: [],
      })
    ).toThrow(NoFeasibleExerciseError);
  });

  it('Gate 3 avoids an exercise already claimed for a different target earlier in the session, when an equal alternative exists', () => {
    const other = 'close-grip-bench-press';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, other],
      recent_exercise_ids: [],
      exercises_already_planned_today: [TRICEPS_PRIMARY],
    });
    expect(result.exercise_id).toBe(other);
    expect(result.decisive_gate).toBe('gate3_programming_need');
  });

  it('Gate 4 avoids a recently-used-but-not-current candidate in favor of a fresh one', () => {
    const fresh = 'dip-triceps-biased';
    const recentButNotCurrent = 'machine-triceps-extension';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [recentButNotCurrent, fresh],
      recent_exercise_ids: [recentButNotCurrent],
      current_exercise_id: null,
    });
    expect(result.exercise_id).toBe(fresh);
    expect(result.decisive_gate).toBe('gate4_historical_context');
  });

  it('Gate 4 never penalizes the current exercise even if it is also the most recently used one', () => {
    const fresh = 'dip-triceps-biased';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, fresh],
      recent_exercise_ids: [TRICEPS_PRIMARY],
      current_exercise_id: TRICEPS_PRIMARY,
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
    expect(result.decisive_gate).toBe('gate5_progression_continuity');
  });

  it('Gate 5 prefers the current exercise for progression continuity when the programming need is otherwise tied', () => {
    const other = 'close-grip-bench-press';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_PRIMARY, other],
      recent_exercise_ids: [],
      current_exercise_id: TRICEPS_PRIMARY,
    });
    expect(result.exercise_id).toBe(TRICEPS_PRIMARY);
    expect(result.decisive_gate).toBe('gate5_progression_continuity');
  });

  it('Gate 6 is a stable alphabetical tie-break when nothing else distinguishes the candidates', () => {
    const a = 'close-grip-bench-press';
    const b = 'cable-pushdown';
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [a, b],
      recent_exercise_ids: [],
    });
    expect(result.exercise_id).toBe([a, b].sort((x, y) => x.localeCompare(y))[0]);
    expect(result.decisive_gate).toBe('gate6_tie_break');
  });

  it('remediation §9: prefer_lower_fatigue_cost overrides alphabetical order within Gate 6 (never a new gate, still narrow())', () => {
    // dip-triceps-biased (fatigue_cost medium) sorts alphabetically
    // before overhead-triceps-extension (fatigue_cost low) — so without
    // the badminton-driven preference, alphabetical Gate 6 would pick
    // the higher-fatigue one. With the preference on, the lower-
    // fatigue_cost candidate must win instead.
    const higherFatigue = 'dip-triceps-biased';
    const lowerFatigue = 'overhead-triceps-extension';

    const withoutPreference = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [higherFatigue, lowerFatigue],
      recent_exercise_ids: [],
    });
    expect(withoutPreference.exercise_id).toBe(higherFatigue);

    const withPreference = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [higherFatigue, lowerFatigue],
      recent_exercise_ids: [],
      prefer_lower_fatigue_cost: true,
    });
    expect(withPreference.exercise_id).toBe(lowerFatigue);
    expect(withPreference.decisive_gate).toBe('gate6_tie_break');
    expect(withPreference.reasoning).toContain('fatigue_cost');
  });

  it('rejected_candidates lists every candidate that did not win, for explainability', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(result.rejected_candidates).toEqual([TRICEPS_SECONDARY_ONLY]);
  });

  it('reasoning names the decisive gate explicitly', () => {
    const result = selectExercise({
      target_type: 'physique_target',
      target_id: 'triceps',
      target_tier: 'primary',
      candidate_exercise_ids: [TRICEPS_SECONDARY_ONLY, TRICEPS_PRIMARY],
      recent_exercise_ids: [],
    });
    expect(result.reasoning).toContain(result.decisive_gate);
  });
});
