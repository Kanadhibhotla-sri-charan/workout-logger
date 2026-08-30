import { describe, expect, it } from 'vitest';
import { allocateFrequency } from '../../src/engine/frequencyEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('frequencyEngine — spec §16', () => {
  it('uses Blueprint own typical_starting_range_per_week, clamped to available days', () => {
    const { typical_starting_range_per_week } = BlueprintAdapter.getGlobalPrinciples().frequency;
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 16,
      available_training_days: ['tuesday', 'thursday', 'friday'],
    });

    expect(result.sessions_per_week).toBeLessThanOrEqual(typical_starting_range_per_week[1]);
    expect(result.sessions_per_week).toBeGreaterThan(0);
    expect(result.assigned_days.length).toBe(result.sessions_per_week);
  });

  it('never assigns more sessions than available training days', () => {
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 20,
      available_training_days: ['monday'],
    });
    expect(result.sessions_per_week).toBeLessThanOrEqual(1);
  });

  it('never assigns a day outside available_training_days', () => {
    const available = ['tuesday', 'thursday'] as const;
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 12,
      available_training_days: available,
    });
    for (const day of result.assigned_days) {
      expect(available).toContain(day);
    }
  });

  it('returns zero sessions and an empty day list when desired exposure is zero', () => {
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 0,
      available_training_days: ['monday', 'wednesday', 'friday'],
    });
    expect(result.sessions_per_week).toBe(0);
    expect(result.assigned_days).toEqual([]);
  });

  it('returns zero sessions when no training days are available at all', () => {
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 12,
      available_training_days: [],
    });
    expect(result.sessions_per_week).toBe(0);
  });

  it('§16 required test 12: never assigns a lower-body target to Monday when an alternative day is available', () => {
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'quads',
      desired_weekly_exposure_units: 12,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
    });
    expect(result.assigned_days).not.toContain('monday');
  });

  it('does not apply the Monday rule to an upper-body target', () => {
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 4,
      available_training_days: ['monday'],
    });
    expect(result.assigned_days).toEqual(['monday']);
  });

  it('does not apply the Monday rule to a functional_goal target (it only ever concerns physique targets)', () => {
    const functionalGoal = BlueprintAdapter.getFunctionalGoals()[0]!;
    const result = allocateFrequency({
      target_type: 'functional_goal',
      target_id: functionalGoal.id,
      desired_weekly_exposure_units: 4,
      available_training_days: ['monday'],
    });
    expect(result.assigned_days).toEqual(['monday']);
  });

  it('spreads sessions across the week rather than clustering them adjacently when more days are available than needed', () => {
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 12,
      available_training_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    });
    // 2 sessions across 6 available days should not both land in the first two days.
    if (result.sessions_per_week === 2) {
      expect(result.assigned_days).not.toEqual(['monday', 'tuesday']);
    }
  });

  it('reasoning cites the Blueprint frequency range actually used', () => {
    const { typical_starting_range_per_week } = BlueprintAdapter.getGlobalPrinciples().frequency;
    const result = allocateFrequency({
      target_type: 'physique_target',
      target_id: 'upper-pec',
      desired_weekly_exposure_units: 12,
      available_training_days: ['tuesday', 'thursday', 'friday'],
    });
    expect(result.reasoning).toContain(String(typical_starting_range_per_week[0]));
    expect(result.reasoning).toContain(String(typical_starting_range_per_week[1]));
  });
});
