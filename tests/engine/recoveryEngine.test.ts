import { describe, expect, it } from 'vitest';
import { applyRecoveryConstraint, type RecoveryConstraintInput } from '../../src/engine/recoveryEngine.js';
import { RECOVERY_THRESHOLDS } from '../../src/engine/config.js';

const BASE: RecoveryConstraintInput = {
  target_type: 'physique_target',
  target_id: 'triceps',
  weekly_exposure_units: 8,
  rolling_exposure_units: 16,
  rolling_window_days: 14,
  days_since_target_last_trained: 3,
  recent_badminton: null,
  other_activity_today: [],
};

describe('recoveryEngine — spec §12 (inspect first, never auto-reduce) + §15 (badminton feeds recovery)', () => {
  it('returns none when nothing unusual is present', () => {
    const result = applyRecoveryConstraint(BASE);
    expect(result.priority_adjustment).toBe('none');
  });

  it('returns avoid when the target was already trained today, regardless of other signals', () => {
    const result = applyRecoveryConstraint({ ...BASE, days_since_target_last_trained: 0 });
    expect(result.priority_adjustment).toBe('avoid');
    expect(result.reasoning).toContain('already trained earlier today');
  });

  it('returns reduce when this week is a real spike vs the rolling baseline (RECOVERY_THRESHOLDS.recentHighExposureMultiplier)', () => {
    // Rolling average weekly rate = 16 / (14/7) = 8. Multiplier is 1.5, so
    // anything above 12 this week is a spike.
    const result = applyRecoveryConstraint({ ...BASE, weekly_exposure_units: 20, rolling_exposure_units: 16 });
    expect(result.priority_adjustment).toBe('reduce');
    expect(result.reasoning).toContain(String(RECOVERY_THRESHOLDS.recentHighExposureMultiplier));
  });

  it('does not flag a spike when there is no rolling baseline yet (avoids a false positive on cold start)', () => {
    const result = applyRecoveryConstraint({ ...BASE, weekly_exposure_units: 20, rolling_exposure_units: 0 });
    expect(result.priority_adjustment).toBe('none');
  });

  it('returns reduce for a recent high-intensity badminton session', () => {
    const result = applyRecoveryConstraint({
      ...BASE,
      recent_badminton: { intensity: 'high', post_session_fatigue: null },
      other_activity_today: ['badminton'],
    });
    expect(result.priority_adjustment).toBe('reduce');
    expect(result.reasoning).toContain('high intensity');
  });

  it('returns reduce for a recent low-intensity badminton session with high logged fatigue', () => {
    const result = applyRecoveryConstraint({
      ...BASE,
      recent_badminton: { intensity: 'low', post_session_fatigue: 5 },
    });
    expect(result.priority_adjustment).toBe('reduce');
    expect(result.reasoning).toContain('fatigue 5/5');
  });

  it('does not reduce for a light, low-fatigue badminton session', () => {
    const result = applyRecoveryConstraint({
      ...BASE,
      recent_badminton: { intensity: 'low', post_session_fatigue: 2 },
    });
    expect(result.priority_adjustment).toBe('none');
  });

  it('never converts badminton demand into an exposure-unit or set-count figure — the result carries no such field', () => {
    const result = applyRecoveryConstraint({
      ...BASE,
      recent_badminton: { intensity: 'high', post_session_fatigue: 5 },
    });
    expect(result).not.toHaveProperty('exposure_units');
    expect(result).not.toHaveProperty('effective_sets');
  });

  it('remediation §9: badminton_triggered is true when heavy badminton alone causes the reduce', () => {
    const result = applyRecoveryConstraint({
      ...BASE,
      recent_badminton: { intensity: 'high', post_session_fatigue: null },
    });
    expect(result.priority_adjustment).toBe('reduce');
    expect(result.badminton_triggered).toBe(true);
  });

  it('remediation §9: badminton_triggered is false when a pure exposure spike (no badminton) causes the reduce', () => {
    const result = applyRecoveryConstraint({ ...BASE, weekly_exposure_units: 20, rolling_exposure_units: 16 });
    expect(result.priority_adjustment).toBe('reduce');
    expect(result.badminton_triggered).toBe(false);
  });

  it('badminton_triggered is false for none/avoid outcomes', () => {
    expect(applyRecoveryConstraint(BASE).badminton_triggered).toBe(false);
    expect(applyRecoveryConstraint({ ...BASE, days_since_target_last_trained: 0 }).badminton_triggered).toBe(false);
  });

  it('cites every triggered signal in reasoning when both a spike and heavy badminton co-occur', () => {
    const result = applyRecoveryConstraint({
      ...BASE,
      weekly_exposure_units: 20,
      rolling_exposure_units: 16,
      recent_badminton: { intensity: 'high', post_session_fatigue: null },
    });
    expect(result.priority_adjustment).toBe('reduce');
    expect(result.reasoning).toContain('spike');
    expect(result.reasoning).toContain('badminton');
  });
});
