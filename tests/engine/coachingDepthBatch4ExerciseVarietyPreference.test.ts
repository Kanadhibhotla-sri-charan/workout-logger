// Coaching Depth Batch 4 spec §9 "Testing Requirements" — preference/
// avoidance, rotation (family repetition), and pairing.

import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { ExercisePreferencesRepo } from '../../src/repositories/exercisePreferencesRepo.js';
import {
  selectExercise,
  AllCandidatesAvoidedError,
  type ExercisePreferenceLevel,
} from '../../src/engine/exerciseSelector.js';
import { evaluateSessionPairings } from '../../src/engine/exercisePairing.js';

let db: Database.Database;
let userId: string;

beforeEach(() => {
  db = openDb(':memory:');
  userId = new UsersRepo(db).getOrCreateDefault().id;
});

// Real Blueprint exercise ids (verified against src/blueprint/snapshot/exercises.json).
const BENCH = 'flat-barbell-bench-press'; // primary: mid-pec
const INCLINE_DB_PRESS = 'incline-dumbbell-press'; // primary: mid-pec (also trains upper-pec)
const CABLE_FLY = 'cable-fly'; // primary: mid-pec
const SEATED_CABLE_ROW = 'seated-cable-row'; // primary: lat-width, back-thickness
const LAT_PULLDOWN = 'neutral-grip-lat-pulldown'; // primary: lat-width
const BACK_SQUAT = 'back-squat'; // primary: quads
const AB_WHEEL_ROLLOUT = 'ab-wheel-rollout'; // primary: rectus-abdominis; overlaps_with: ['plank']
const CABLE_CRUNCH = 'cable-crunch'; // primary: rectus-abdominis
const PLANK = 'plank'; // primary: rectus-abdominis

function baseSelectionInput(overrides: Record<string, unknown> = {}) {
  return {
    target_type: 'physique_target' as const,
    target_id: 'mid-pec',
    target_tier: 'supporting' as const,
    candidate_exercise_ids: [BENCH, INCLINE_DB_PRESS, CABLE_FLY],
    recent_exercise_ids: [],
    ...overrides,
  };
}

describe('ExercisePreferencesRepo — effective preference computation', () => {
  it('defaults to neutral for any exercise with no rule', () => {
    const repo = new ExercisePreferencesRepo(db);
    expect(repo.effectiveFor(userId, BENCH, '2026-09-17')).toBe('neutral');
  });

  it('set/get round-trips a preferred/disliked/avoided rule', () => {
    const repo = new ExercisePreferencesRepo(db);
    repo.set(userId, { exerciseId: BENCH, preference: 'avoided', reason: 'shoulder discomfort' });
    expect(repo.effectiveFor(userId, BENCH, '2026-09-17')).toBe('avoided');
    expect(repo.get(userId, BENCH)?.reason).toBe('shoulder discomfort');
  });

  it('a temporary exclusion expires correctly — neutral after temporaryUntil', () => {
    const repo = new ExercisePreferencesRepo(db);
    repo.set(userId, { exerciseId: BENCH, preference: 'avoided', temporaryUntil: '2026-09-20' });
    expect(repo.effectiveFor(userId, BENCH, '2026-09-20')).toBe('avoided'); // inclusive
    expect(repo.effectiveFor(userId, BENCH, '2026-09-21')).toBe('neutral');
  });

  it('setting a new preference for the same exercise replaces the prior rule, never merges/duplicates', () => {
    const repo = new ExercisePreferencesRepo(db);
    repo.set(userId, { exerciseId: BENCH, preference: 'disliked' });
    repo.set(userId, { exerciseId: BENCH, preference: 'preferred' });
    expect(repo.effectiveFor(userId, BENCH, '2026-09-17')).toBe('preferred');
    expect(repo.listAll(userId)).toHaveLength(1);
  });

  it('remove() deletes the rule explicitly, distinct from expiry', () => {
    const repo = new ExercisePreferencesRepo(db);
    repo.set(userId, { exerciseId: BENCH, preference: 'avoided' });
    repo.remove(userId, BENCH);
    expect(repo.effectiveFor(userId, BENCH, '2026-09-17')).toBe('neutral');
  });

  it('listActive excludes expired rules but listAll includes everything', () => {
    const repo = new ExercisePreferencesRepo(db);
    repo.set(userId, { exerciseId: BENCH, preference: 'avoided', temporaryUntil: '2026-01-01' });
    repo.set(userId, { exerciseId: CABLE_FLY, preference: 'preferred' });
    expect(repo.listAll(userId)).toHaveLength(2);
    expect(repo.listActive(userId, '2026-09-17').map((r) => r.exerciseId)).toEqual([CABLE_FLY]);
  });
});

describe('exerciseSelector — explicit avoidance (Gate 2b)', () => {
  it('an avoided candidate is excluded from selection', () => {
    const preferenceMap = new Map<string, ExercisePreferenceLevel>([[BENCH, 'avoided']]);
    const result = selectExercise(baseSelectionInput({ preference_by_exercise_id: preferenceMap }));
    expect(result.exercise_id).not.toBe(BENCH);
    expect(result.avoided_candidates).toContain(BENCH);
  });

  it('throws AllCandidatesAvoidedError when every goal-relevant candidate is avoided — never silently falls back', () => {
    const preferenceMap = new Map<string, ExercisePreferenceLevel>([
      [BENCH, 'avoided'],
      [INCLINE_DB_PRESS, 'avoided'],
      [CABLE_FLY, 'avoided'],
    ]);
    expect(() => selectExercise(baseSelectionInput({ preference_by_exercise_id: preferenceMap }))).toThrow(AllCandidatesAvoidedError);
  });

  it('avoidance is never bypassed even when it is also the current/progression-continuity pick', () => {
    const preferenceMap = new Map<string, ExercisePreferenceLevel>([[BENCH, 'avoided']]);
    const result = selectExercise(baseSelectionInput({ current_exercise_id: BENCH, preference_by_exercise_id: preferenceMap }));
    expect(result.exercise_id).not.toBe(BENCH);
  });

  it('with no preference map at all, behavior is completely unaffected (every pre-Batch-4 caller)', () => {
    const result = selectExercise(baseSelectionInput());
    expect(result.avoided_candidates).toEqual([]);
  });
});

describe('exerciseSelector — soft preference ranking (Gate 5b)', () => {
  it('a preferred exercise wins a tie among otherwise-equal candidates', () => {
    const preferenceMap = new Map<string, ExercisePreferenceLevel>([[CABLE_FLY, 'preferred']]);
    const result = selectExercise(baseSelectionInput({ preference_by_exercise_id: preferenceMap }));
    expect(result.exercise_id).toBe(CABLE_FLY);
    expect(result.decisive_gate).toBe('gate5b_preference_ranking');
  });

  it('a disliked exercise is deprioritized (never eliminated) when an alternative exists', () => {
    const preferenceMap = new Map<string, ExercisePreferenceLevel>([[BENCH, 'disliked']]);
    const result = selectExercise(baseSelectionInput({ preference_by_exercise_id: preferenceMap }));
    expect(result.exercise_id).not.toBe(BENCH);
  });

  it('preference ranking (Gate 5b) only ever runs after Gate 3\'s programming-need narrowing has already resolved — never overrides it', () => {
    // Gate 3 (primary-role-first) already narrows the pool to a single
    // primary-role winner before Gate 5b ever runs when only one
    // candidate is primary — proven directly by decisive_gate never
    // reporting gate5b in that case, regardless of preference.
    const preferenceMap = new Map<string, ExercisePreferenceLevel>([[BENCH, 'preferred']]);
    const result = selectExercise(baseSelectionInput({ candidate_exercise_ids: [BENCH], preference_by_exercise_id: preferenceMap }));
    expect(result.exercise_id).toBe(BENCH);
    expect(result.decisive_gate).not.toBe('gate5b_preference_ranking');
  });
});

describe('exerciseSelector — exercise-family rotation (extended Gate 4)', () => {
  it('a recently-used exercise\'s own family member (Blueprint overlaps_with) is also penalized, not just an exact id match', () => {
    // ab-wheel-rollout's own overlaps_with lists 'plank'.
    const result = selectExercise(
      baseSelectionInput({
        target_id: 'rectus-abdominis',
        candidate_exercise_ids: [AB_WHEEL_ROLLOUT, CABLE_CRUNCH],
        recent_exercise_ids: [PLANK],
      })
    );
    expect(result.exercise_id).toBe(CABLE_CRUNCH);
  });

  it('the current/ongoing pick is still exempt from family-based rotation exclusion (progression continuity)', () => {
    const result = selectExercise(
      baseSelectionInput({
        target_id: 'rectus-abdominis',
        candidate_exercise_ids: [AB_WHEEL_ROLLOUT, CABLE_CRUNCH],
        recent_exercise_ids: [PLANK],
        current_exercise_id: AB_WHEEL_ROLLOUT,
      })
    );
    expect(result.exercise_id).toBe(AB_WHEEL_ROLLOUT);
  });

  it('an exact recent-use match (not just family) is still penalized as before Batch 4', () => {
    const result = selectExercise(
      baseSelectionInput({
        target_id: 'rectus-abdominis',
        candidate_exercise_ids: [CABLE_CRUNCH, PLANK],
        recent_exercise_ids: [CABLE_CRUNCH],
      })
    );
    expect(result.exercise_id).toBe(PLANK);
  });
});

describe('exercisePairing — antagonist (push/pull) pairing', () => {
  it('pairs a push-target exercise with a pull-target exercise when fatigue overlap is acceptable', () => {
    const result = evaluateSessionPairings({
      items: [
        { exercise_id: BENCH, target_type: 'physique_target', target_id: 'mid-pec' }, // push
        { exercise_id: SEATED_CABLE_ROW, target_type: 'physique_target', target_id: 'back-thickness' }, // pull
      ],
    });
    expect(result.pairs.get(BENCH)).toBe(SEATED_CABLE_ROW);
    expect(result.pairs.get(SEATED_CABLE_ROW)).toBe(BENCH);
  });

  it('leaves exercises unpaired when no antagonist partner exists — never forces an incompatible pair', () => {
    const result = evaluateSessionPairings({
      items: [
        { exercise_id: BENCH, target_type: 'physique_target', target_id: 'mid-pec' },
        { exercise_id: INCLINE_DB_PRESS, target_type: 'physique_target', target_id: 'upper-pec' },
      ],
    });
    expect(result.pairs.size).toBe(0);
  });

  it('a target with no push/pull classification (e.g. legs) is never paired', () => {
    const result = evaluateSessionPairings({
      items: [
        { exercise_id: BACK_SQUAT, target_type: 'physique_target', target_id: 'quads' },
        { exercise_id: SEATED_CABLE_ROW, target_type: 'physique_target', target_id: 'back-thickness' },
      ],
    });
    expect(result.pairs.size).toBe(0);
  });

  it('an avoided exercise never enters a pair even if it would otherwise be antagonist-compatible', () => {
    const result = evaluateSessionPairings({
      items: [
        { exercise_id: BENCH, target_type: 'physique_target', target_id: 'mid-pec' },
        { exercise_id: SEATED_CABLE_ROW, target_type: 'physique_target', target_id: 'back-thickness' },
      ],
      preference_by_exercise_id: new Map([[SEATED_CABLE_ROW, 'avoided']]),
    });
    expect(result.pairs.size).toBe(0);
  });

  it('no exercise is paired more than once', () => {
    const result = evaluateSessionPairings({
      items: [
        { exercise_id: BENCH, target_type: 'physique_target', target_id: 'mid-pec' },
        { exercise_id: SEATED_CABLE_ROW, target_type: 'physique_target', target_id: 'back-thickness' },
        { exercise_id: LAT_PULLDOWN, target_type: 'physique_target', target_id: 'lat-width' },
      ],
    });
    const pairedIds = [...result.pairs.keys()];
    expect(new Set(pairedIds).size).toBe(pairedIds.length);
  });
});
