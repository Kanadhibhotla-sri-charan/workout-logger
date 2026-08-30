import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { OutsideBlueprintExercisesRepo } from '../src/repositories/outsideBlueprintExercisesRepo.js';
import { UnknownBlueprintExerciseError, WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import { resolveExercise, isKnownExercise } from '../src/engine/exerciseUniverse.js';

let db: Database.Database;
let outsideRepo: OutsideBlueprintExercisesRepo;

beforeEach(() => {
  db = openDb(':memory:');
  outsideRepo = new OutsideBlueprintExercisesRepo(db);
});

describe('OutsideBlueprintExercisesRepo — spec §4.2 approval gate', () => {
  it('a newly proposed exercise starts unapproved', () => {
    const proposed = outsideRepo.propose({
      name: 'Landmine Press',
      justification_category: 'blueprint_inadequate',
      justification_text: 'Blueprint has no single-arm landmine pressing variation',
    });

    expect(proposed.approved).toBe(false);
    expect(proposed.approved_at).toBeNull();
  });

  it('is not resolvable as a known exercise until approved', () => {
    const proposed = outsideRepo.propose({
      name: 'Landmine Press',
      justification_category: 'blueprint_inadequate',
      justification_text: 'Blueprint has no single-arm landmine pressing variation',
    });

    expect(isKnownExercise(db, proposed.id)).toBe(false);
    expect(resolveExercise(db, proposed.id)).toBeNull();
  });

  it('becomes resolvable only after an explicit approve() call', () => {
    const proposed = outsideRepo.propose({
      name: 'Landmine Press',
      justification_category: 'blueprint_inadequate',
      justification_text: 'Blueprint has no single-arm landmine pressing variation',
    });

    const approved = outsideRepo.approve(proposed.id);

    expect(approved?.approved).toBe(true);
    expect(approved?.approved_at).not.toBeNull();
    expect(resolveExercise(db, proposed.id)).toEqual({
      source: 'outside_blueprint',
      exercise_id: proposed.id,
      name: 'Landmine Press',
    });
  });

  it('approve() on an unknown id returns undefined and leaves nothing resolvable', () => {
    expect(outsideRepo.approve('no-such-id')).toBeUndefined();
  });

  it('a workout session cannot log an unapproved outside-Blueprint exercise', () => {
    const proposed = outsideRepo.propose({
      name: 'Landmine Press',
      justification_category: 'contextual_constraint',
      justification_text: 'Only a landmine attachment is available at this location',
    });

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'gym' });

    expect(() =>
      sessionsRepo.addExercisePerformance(session.session_id, {
        exercise_id: proposed.id,
        order: 1,
        role: 'primary',
        sets: [{ set_number: 1, weight: 40, reps: 8, completed: true }],
      })
    ).toThrow(UnknownBlueprintExerciseError);
  });

  it('a workout session can log an approved outside-Blueprint exercise', () => {
    const proposed = outsideRepo.propose({
      name: 'Landmine Press',
      justification_category: 'meaningful_advantage',
      justification_text: 'Reduces shoulder impingement pain reported across the last 3 sessions',
    });
    outsideRepo.approve(proposed.id);

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: '2026-08-30', session_type: 'gym' });

    const performance = sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: proposed.id,
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, weight: 40, reps: 8, completed: true }],
    });

    expect(performance.exercise_id).toBe(proposed.id);
  });

  it('list() returns all proposals regardless of approval state', () => {
    const a = outsideRepo.propose({
      name: 'Landmine Press',
      justification_category: 'blueprint_inadequate',
      justification_text: 'x',
    });
    const b = outsideRepo.propose({
      name: 'Sled Push',
      justification_category: 'contextual_constraint',
      justification_text: 'y',
    });
    outsideRepo.approve(a.id);

    const all = outsideRepo.list();
    expect(all.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });
});
