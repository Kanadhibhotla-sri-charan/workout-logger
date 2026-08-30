// Proves the module boundary is exactly where docs/TRAINING_ENGINE_DESIGN.md
// says it should be: every engine module whose real logic depends on an
// unapproved design decision throws NotApprovedError, loudly and
// specifically, rather than silently returning an invented answer or a
// generic "not implemented." This is the executable form of acceptance
// criterion "the full automatic optimizer is not implemented until the
// design decisions are approved."

import { describe, expect, it } from 'vitest';
import { NotApprovedError } from '../../src/engine/errors.js';
import { allocateVolume } from '../../src/engine/volumeEngine.js';
import { allocateFrequency } from '../../src/engine/frequencyEngine.js';
import { applyRecoveryConstraint } from '../../src/engine/recoveryEngine.js';
import { selectExercise } from '../../src/engine/exerciseSelector.js';
import { buildWorkout } from '../../src/engine/workoutBuilder.js';
import { explainExerciseSelection } from '../../src/engine/explanationEngine.js';

describe('unapproved engine modules — throw, never silently invent an answer', () => {
  it('volumeEngine.allocateVolume throws NotApprovedError("hypertrophy-volume-model")', () => {
    expect(() =>
      allocateVolume({
        target_type: 'physique_target',
        target_id: 'triceps',
        blueprint_volume_guidance: undefined,
        current_exposure: {
          target_type: 'physique_target',
          target_id: 'triceps',
          period_start: '2026-08-31',
          period_end: '2026-09-06',
          exercise_ids: [],
          total_sets: 0,
          exposure_units: 0,
        },
        goal_priority: 1,
      })
    ).toThrow(NotApprovedError);
    try {
      allocateVolume({} as any);
    } catch (err) {
      expect((err as NotApprovedError).decision).toBe('hypertrophy-volume-model');
    }
  });

  it('frequencyEngine.allocateFrequency throws NotApprovedError("frequency-allocation-model")', () => {
    expect(() =>
      allocateFrequency({
        target_type: 'physique_target',
        target_id: 'triceps',
        desired_weekly_exposure_units: 12,
        available_training_days: ['monday', 'wednesday', 'friday', 'saturday'],
      })
    ).toThrow(NotApprovedError);
    try {
      allocateFrequency({} as any);
    } catch (err) {
      expect((err as NotApprovedError).decision).toBe('frequency-allocation-model');
    }
  });

  it('recoveryEngine.applyRecoveryConstraint throws NotApprovedError("recovery-methodology")', () => {
    try {
      applyRecoveryConstraint({} as any);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotApprovedError);
      expect((err as NotApprovedError).decision).toBe('recovery-methodology');
    }
  });

  it('exerciseSelector.selectExercise throws NotApprovedError("exercise-selection-ranking")', () => {
    try {
      selectExercise({} as any);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotApprovedError);
      expect((err as NotApprovedError).decision).toBe('exercise-selection-ranking');
    }
  });

  it('workoutBuilder.buildWorkout throws NotApprovedError referencing its unresolved dependencies', () => {
    try {
      buildWorkout({} as any);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotApprovedError);
      expect((err as NotApprovedError).decision).toBe('volume-frequency-recovery-and-exercise-selection');
    }
  });

  it('explanationEngine.explainExerciseSelection throws — nothing real to explain yet', () => {
    expect(() => explainExerciseSelection()).toThrow(NotApprovedError);
  });
});
