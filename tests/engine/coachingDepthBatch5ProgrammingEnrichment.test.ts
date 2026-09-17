// Coaching Depth Batch 5 spec §11 "Testing Requirements" — intensity
// techniques (§11.1), structural advisories (§11.2), profile factors
// (§11.3).

import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { ProfileFactorsRepo } from '../../src/repositories/profileFactorsRepo.js';
import { assignWeeklyIntensityTechniques, type DayTechniqueCandidates } from '../../src/engine/intensityTechniques.js';
import { evaluateStructuralAdvisories, type StructuralAdvisoryTargetInput } from '../../src/coaching/structuralAdvisories/structuralAdvisoryService.js';

// Real Blueprint exercise ids with real, verified demand profiles (see
// src/blueprint/snapshot/exercises.json):
const CABLE_FLY = 'cable-fly'; // isolation, fatigue=low, skill=low, stability=medium — eligible for drop-set
const LEG_EXTENSION = 'leg-extension'; // isolation, fatigue=low, skill=low, stability=low — eligible for drop-set (and, in principle, myo-reps/rest-pause; drop-set wins as the first catalog entry)
const BENCH = 'flat-barbell-bench-press'; // compound, fatigue=medium, skill=medium, stability=medium — eligible only for rest-pause
const BACK_SQUAT = 'back-squat'; // compound, fatigue=high, skill=high, stability=high — ineligible for every real technique in the catalog

function candidate(exerciseId: string, overrides: Partial<DayTechniqueCandidates['items'][number]> = {}) {
  return { exercise_id: exerciseId, target_type: 'physique_target' as const, has_progression_history: true, preference: 'neutral' as const, ...overrides };
}

describe('intensityTechniques — assignWeeklyIntensityTechniques', () => {
  it('applies a real, Blueprint-suitable technique to an eligible exercise with confirmed intermediate experience', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY)] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map([['2026-09-17::cable-fly', 3]]), { trainingExperience: 'intermediate', deloadActive: false });
    const key = '2026-09-17::cable-fly';
    expect(applied.get(key)?.technique_id).toBe('drop-set');
    expect(applied.get(key)?.applied_to_working_set_number).toBe(3);
    expect(evaluations.get(key)).toEqual({ considered: true, applied_technique_id: 'drop-set', suppressed_reason: null });
  });

  it('never applies a technique to an exercise with no suitable Blueprint entry (back-squat: compound, high fatigue/skill/stability)', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(BACK_SQUAT)] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(0);
    expect(evaluations.get('2026-09-17::back-squat')?.considered).toBe(true);
    expect(evaluations.get('2026-09-17::back-squat')?.suppressed_reason).toMatch(/no eligible intensity technique/i);
  });

  it('a compound exercise within Blueprint\'s real rest-pause suitability range is eligible for rest-pause specifically', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(BENCH)] }];
    const { applied } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'intermediate', deloadActive: false });
    expect(applied.get('2026-09-17::flat-barbell-bench-press')?.technique_id).toBe('rest-pause');
  });

  it('disables all intensity techniques by default during an active deload', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY)] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: true });
    expect(applied.size).toBe(0);
    expect(evaluations.get('2026-09-17::cable-fly')?.suppressed_reason).toMatch(/deload/i);
  });

  it('never applies a technique with no confirmed training experience — insufficient context, never a guessed default', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY)] }];
    const { applied } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: null, deloadActive: false });
    expect(applied.size).toBe(0);
  });

  it('a novice confirmed experience is still insufficient for a technique requiring intermediate', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY)] }];
    const { applied } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'novice', deloadActive: false });
    expect(applied.size).toBe(0);
  });

  it('never applies a technique to an exercise with no prior logged performance (progression-tracking protection)', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY, { has_progression_history: false })] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(0);
    expect(evaluations.get('2026-09-17::cable-fly')?.suppressed_reason).toMatch(/prior logged performance/i);
  });

  it('never applies a technique to an exercise the user has marked avoided', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY, { preference: 'avoided' })] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(0);
    expect(evaluations.get('2026-09-17::cable-fly')?.suppressed_reason).toMatch(/avoided/i);
  });

  it('a functional_goal target is never considered at all', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY, { target_type: 'functional_goal' })] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(0);
    expect(evaluations.get('2026-09-17::cable-fly')).toEqual({ considered: false, applied_technique_id: null, suppressed_reason: null });
  });

  it('enforces the per-session application cap (1) — a second eligible exercise the same day is suppressed for the limit, not ineligibility', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY), candidate(LEG_EXTENSION)] }];
    const { applied, evaluations } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(1);
    expect(applied.has('2026-09-17::cable-fly')).toBe(true);
    expect(evaluations.get('2026-09-17::leg-extension')?.suppressed_reason).toMatch(/session\/week already reached/i);
  });

  it('enforces the weekly application cap (2) across multiple days', () => {
    // Three real, independently-eligible exercises on three different
    // days, so the weekly cap (not per-exercise dedupe) is what's
    // actually being exercised here.
    const days: DayTechniqueCandidates[] = [
      { date: '2026-09-14', items: [candidate(CABLE_FLY)] },
      { date: '2026-09-16', items: [candidate(BENCH)] },
      { date: '2026-09-18', items: [candidate(LEG_EXTENSION)] },
    ];
    const { applied } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(2);
    expect(applied.has('2026-09-18::leg-extension')).toBe(false); // third real application this week is suppressed by the weekly cap
  });

  it('never re-applies to the same exercise twice in one week', () => {
    const days: DayTechniqueCandidates[] = [
      { date: '2026-09-14', items: [candidate(CABLE_FLY)] },
      { date: '2026-09-16', items: [candidate(CABLE_FLY)] },
    ];
    const { applied } = assignWeeklyIntensityTechniques(days, new Map(), { trainingExperience: 'advanced', deloadActive: false });
    expect(applied.size).toBe(1);
    expect(applied.has('2026-09-14::cable-fly')).toBe(true);
    expect(applied.has('2026-09-16::cable-fly')).toBe(false);
  });

  it('is deterministic — identical input always produces identical output', () => {
    const days: DayTechniqueCandidates[] = [{ date: '2026-09-17', items: [candidate(CABLE_FLY), candidate(BENCH)] }];
    const context = { trainingExperience: 'advanced' as const, deloadActive: false };
    const first = assignWeeklyIntensityTechniques(days, new Map(), context);
    const second = assignWeeklyIntensityTechniques(days, new Map(), context);
    expect([...first.applied.entries()]).toEqual([...second.applied.entries()]);
  });
});

describe('structuralAdvisoryService — evaluateStructuralAdvisories', () => {
  function target(overrides: Partial<StructuralAdvisoryTargetInput>): StructuralAdvisoryTargetInput {
    return { target_type: 'physique_target', target_id: 'mid-pec', is_specialization: false, rolling_exposure_units: 0, rolling_window_days: 28, ...overrides };
  }

  it('produces no advisory when there is insufficient accumulated evidence (a fresh program)', () => {
    const targets = [target({ target_id: 'mid-pec', rolling_exposure_units: 0.5 }), target({ target_id: 'back-thickness', rolling_exposure_units: 0.2 })];
    expect(evaluateStructuralAdvisories(targets, '2026-09-17')).toEqual([]);
  });

  it('flags a real, sustained push/pull imbalance as REVIEW when the lower side is under 30% of the higher side', () => {
    const targets = [target({ target_id: 'mid-pec', rolling_exposure_units: 20 }), target({ target_id: 'back-thickness', rolling_exposure_units: 5 })];
    const advisories = evaluateStructuralAdvisories(targets, '2026-09-17');
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ category: 'push_pull_imbalance', severity: 'REVIEW', affects_prescription: false });
  });

  it('flags a moderate push/pull imbalance as WATCH (30-40% share)', () => {
    const targets = [target({ target_id: 'mid-pec', rolling_exposure_units: 20 }), target({ target_id: 'back-thickness', rolling_exposure_units: 7 })];
    const advisories = evaluateStructuralAdvisories(targets, '2026-09-17');
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.severity).toBe('WATCH');
  });

  it('produces no push/pull advisory when volume is reasonably balanced', () => {
    const targets = [target({ target_id: 'mid-pec', rolling_exposure_units: 10 }), target({ target_id: 'back-thickness', rolling_exposure_units: 9 })];
    expect(evaluateStructuralAdvisories(targets, '2026-09-17')).toEqual([]);
  });

  it('flags a persistent coverage gap for an active goal target with zero rolling exposure over the full window', () => {
    const targets = [target({ target_id: 'calves', is_specialization: true, rolling_exposure_units: 0, rolling_window_days: 28 })];
    const advisories = evaluateStructuralAdvisories(targets, '2026-09-17');
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ category: 'persistent_target_coverage_gap', severity: 'WATCH', affected_targets: ['calves'], affects_prescription: false });
  });

  it('never flags a coverage gap for a non-goal (non-specialization) target', () => {
    const targets = [target({ target_id: 'calves', is_specialization: false, rolling_exposure_units: 0, rolling_window_days: 28 })];
    expect(evaluateStructuralAdvisories(targets, '2026-09-17')).toEqual([]);
  });

  it('is deterministic and pure — never mutates its input', () => {
    const targets = [target({ target_id: 'mid-pec', rolling_exposure_units: 20 }), target({ target_id: 'back-thickness', rolling_exposure_units: 5 })];
    const snapshot = JSON.stringify(targets);
    evaluateStructuralAdvisories(targets, '2026-09-17');
    expect(JSON.stringify(targets)).toBe(snapshot);
    expect(evaluateStructuralAdvisories(targets, '2026-09-17')).toEqual(evaluateStructuralAdvisories(targets, '2026-09-17'));
  });
});

describe('ProfileFactorsRepo', () => {
  let db: Database.Database;
  let userId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    userId = new UsersRepo(db).getOrCreateDefault().id;
  });

  it('returns null (genuine absence) for a factor with no rule at all', () => {
    const repo = new ProfileFactorsRepo(db);
    expect(repo.effectiveValue(userId, 'training_experience', '2026-09-17')).toBeNull();
  });

  it('returns null for a stored but NOT user-confirmed factor', () => {
    const repo = new ProfileFactorsRepo(db);
    repo.set(userId, { factorName: 'training_experience', value: 'advanced', userConfirmed: false });
    expect(repo.effectiveValue(userId, 'training_experience', '2026-09-17')).toBeNull();
  });

  it('returns the real value once explicitly user-confirmed', () => {
    const repo = new ProfileFactorsRepo(db);
    repo.set(userId, { factorName: 'training_experience', value: 'advanced', userConfirmed: true });
    expect(repo.effectiveValue(userId, 'training_experience', '2026-09-17')).toBe('advanced');
  });

  it('treats an expired factor as absent even if it was user-confirmed', () => {
    const repo = new ProfileFactorsRepo(db);
    repo.set(userId, { factorName: 'training_experience', value: 'advanced', userConfirmed: true, expiresAt: '2026-01-01' });
    expect(repo.effectiveValue(userId, 'training_experience', '2026-09-17')).toBeNull();
  });

  it('set() replaces the prior record rather than merging/duplicating', () => {
    const repo = new ProfileFactorsRepo(db);
    repo.set(userId, { factorName: 'training_experience', value: 'novice', userConfirmed: true });
    repo.set(userId, { factorName: 'training_experience', value: 'advanced', userConfirmed: true });
    expect(repo.listAll(userId)).toHaveLength(1);
    expect(repo.effectiveValue(userId, 'training_experience', '2026-09-17')).toBe('advanced');
  });

  it('remove() deletes the record explicitly', () => {
    const repo = new ProfileFactorsRepo(db);
    repo.set(userId, { factorName: 'training_experience', value: 'advanced', userConfirmed: true });
    repo.remove(userId, 'training_experience');
    expect(repo.effectiveValue(userId, 'training_experience', '2026-09-17')).toBeNull();
  });

  it('listActive excludes expired records but listAll includes everything', () => {
    const repo = new ProfileFactorsRepo(db);
    repo.set(userId, { factorName: 'training_experience', value: 'advanced', userConfirmed: true, expiresAt: '2026-01-01' });
    repo.set(userId, { factorName: 'other_factor', value: 'x', userConfirmed: true });
    expect(repo.listAll(userId)).toHaveLength(2);
    expect(repo.listActive(userId, '2026-09-17').map((r) => r.factorName)).toEqual(['other_factor']);
  });
});
