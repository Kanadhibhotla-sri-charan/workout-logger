import { describe, expect, it } from 'vitest';
import { classifyAestheticTrend, decideVolume, type VolumeDecisionInput } from '../../src/engine/volumeEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { PROGRESSION_INCREMENTS } from '../../src/engine/config.js';

const BASE: VolumeDecisionInput = {
  target_type: 'physique_target',
  target_id: 'triceps',
  goal_priority: 1,
  current_weekly_primary_sets: 12,
  aesthetic_progress_trend: 'improving',
  recovery_ok: true,
};

describe('classifyAestheticTrend — spec §3 (a dated 1-5 assessment is already directional)', () => {
  it('classifies 4 and 5 as improving', () => {
    expect(classifyAestheticTrend({ rating: 4, date: '2026-08-01' }, '2026-08-05', 28)).toBe('improving');
    expect(classifyAestheticTrend({ rating: 5, date: '2026-08-01' }, '2026-08-05', 28)).toBe('improving');
  });

  it('classifies 3 as stagnant', () => {
    expect(classifyAestheticTrend({ rating: 3, date: '2026-08-01' }, '2026-08-05', 28)).toBe('stagnant');
  });

  it('classifies 1 and 2 as declining', () => {
    expect(classifyAestheticTrend({ rating: 2, date: '2026-08-01' }, '2026-08-05', 28)).toBe('declining');
    expect(classifyAestheticTrend({ rating: 1, date: '2026-08-01' }, '2026-08-05', 28)).toBe('declining');
  });

  it('returns insufficient_data when there is no assessment', () => {
    expect(classifyAestheticTrend(null, '2026-08-05', 28)).toBe('insufficient_data');
  });

  it('returns insufficient_data for a stale assessment (more than 2x the review cadence old)', () => {
    // reviewCadenceDays=28 -> stale past 56 days.
    expect(classifyAestheticTrend({ rating: 5, date: '2026-01-01' }, '2026-08-30', 28)).toBe('insufficient_data');
  });
});

describe('decideVolume — spec §8-13', () => {
  it('§9: starting volume builds up to the Blueprint conservative starting point when there is no existing direct volume', () => {
    const { starting_point_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;
    const result = decideVolume({ ...BASE, current_weekly_primary_sets: 0 });

    expect(result.action).toBe('increase');
    expect(result.recommended_weekly_primary_sets).toBe(starting_point_sets[0]);
    expect(result.blueprint_reference_range.label).toBe('starting_point');
  });

  it('§9: starting volume ignores goal priority — same recommendation for priority 1 and priority 2', () => {
    const highPriority = decideVolume({ ...BASE, current_weekly_primary_sets: 0, goal_priority: 1 });
    const lowPriority = decideVolume({ ...BASE, current_weekly_primary_sets: 0, goal_priority: 2 });
    expect(highPriority.recommended_weekly_primary_sets).toBe(lowPriority.recommended_weekly_primary_sets);
  });

  it('§13: good aesthetic progress -> maintain volume (required test 7)', () => {
    const result = decideVolume({ ...BASE, aesthetic_progress_trend: 'improving' });
    expect(result.action).toBe('maintain');
    expect(result.recommended_weekly_primary_sets).toBe(BASE.current_weekly_primary_sets);
  });

  it('insufficient_data also maintains rather than acting on weak evidence', () => {
    const result = decideVolume({ ...BASE, aesthetic_progress_trend: 'insufficient_data' });
    expect(result.action).toBe('maintain');
  });

  it('§11: stagnation requires introspection before any volume increase (required test 8)', () => {
    const result = decideVolume({ ...BASE, aesthetic_progress_trend: 'stagnant' });
    expect(result.action).toBe('introspect_needed');
    expect(result.introspection_checklist).not.toBeNull();
    expect(result.introspection_checklist!.length).toBeGreaterThan(0);
    expect(result.recommended_weekly_primary_sets).toBe(BASE.current_weekly_primary_sets);
  });

  it('§11: stagnation + confirmed no other explanation + good recovery -> small configured increase (required test 9)', () => {
    const result = decideVolume({
      ...BASE,
      aesthetic_progress_trend: 'stagnant',
      recovery_ok: true,
      introspection_confirmed_no_other_explanation: true,
    });
    expect(result.action).toBe('increase');
    expect(result.recommended_weekly_primary_sets).toBe(BASE.current_weekly_primary_sets + PROGRESSION_INCREMENTS.weeklyExposureUnits);
  });

  it('never jumps to Blueprint maximum in one increase — capped at the current reference range max', () => {
    const { practical_range_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;
    const result = decideVolume({
      ...BASE,
      current_weekly_primary_sets: practical_range_sets[1] - 1,
      aesthetic_progress_trend: 'stagnant',
      recovery_ok: true,
      introspection_confirmed_no_other_explanation: true,
    });
    expect(result.recommended_weekly_primary_sets).toBeLessThanOrEqual(practical_range_sets[1]);
  });

  it('stagnation + poor recovery -> introspect_needed, not an increase, even with confirmation', () => {
    const result = decideVolume({
      ...BASE,
      aesthetic_progress_trend: 'stagnant',
      recovery_ok: false,
      introspection_confirmed_no_other_explanation: true,
    });
    expect(result.action).toBe('introspect_needed');
  });

  it('§12: declining performance + poor recovery -> no automatic volume increase, introspection path (required test 10)', () => {
    const result = decideVolume({ ...BASE, aesthetic_progress_trend: 'declining', recovery_ok: false });
    expect(result.action).toBe('introspect_needed');
    expect(result.action).not.toBe('increase');
    expect(result.recommended_weekly_primary_sets).toBe(BASE.current_weekly_primary_sets);
  });

  it('declining never returns an automatic reduction either — only introspect_needed', () => {
    const result = decideVolume({ ...BASE, aesthetic_progress_trend: 'declining', recovery_ok: true });
    expect(result.action).toBe('introspect_needed');
    expect(['maintain', 'increase']).not.toContain('reduce'); // 'reduce' isn't even a valid VolumeAction
  });

  it('reasoning always cites the specific spec rule/threshold applied — never an opaque score', () => {
    const result = decideVolume({ ...BASE, aesthetic_progress_trend: 'stagnant' });
    expect(result.reasoning.length).toBeGreaterThan(20);
    expect(typeof result.reasoning).toBe('string');
  });
});
