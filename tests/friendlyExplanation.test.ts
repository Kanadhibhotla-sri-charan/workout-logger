// Workout Programmer UI Fix §4-§10/§11.D: human-readable programming
// explanations. Unit tests exercise buildFriendlyPlannedReasoning/
// buildFriendlySkipReasoning directly (real logic, not string
// reimplementation); the route-level test at the bottom proves the
// real HTTP response actually carries the friendly fields end-to-end
// and that the internal jargon vocabulary the spec names is genuinely
// absent from them.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { createApp } from '../src/server/app.js';
import { GoalsRepo } from '../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../src/repositories/usersRepo.js';
import { buildFriendlyPlannedReasoning, buildFriendlySkipReasoning, humanizeSlug } from '../src/server/friendlyExplanation.js';

const JARGON_TERMS = [
  'physique_target',
  'decisive gate',
  'gate1',
  'gate2',
  'gate3',
  'gate4',
  'gate5',
  'gate6',
  'Surgical Fix',
  'package prescription',
  "this target's own real weekly plan",
  'session-by-session',
  'not divided evenly',
  'spec §',
  'remediation §',
];

function assertNoJargon(text: string) {
  for (const term of JARGON_TERMS) {
    expect(text.toLowerCase()).not.toContain(term.toLowerCase());
  }
}

describe('humanizeSlug', () => {
  it('turns a kebab-case Blueprint id into plain words', () => {
    expect(humanizeSlug('chest-front-width')).toBe('chest front width');
    expect(humanizeSlug('arm-side-thickness')).toBe('arm side thickness');
  });
});

describe('buildFriendlyPlannedReasoning', () => {
  function baseWork(overrides: Partial<Parameters<typeof buildFriendlyPlannedReasoning>[0]> = {}) {
    return {
      target_name: 'Brachialis',
      exercise_name: 'Hammer Curl',
      role: 'primary',
      classification: 'specialization' as const,
      sets: 2,
      reps_min: 10,
      reps_max: 20,
      rir_min: 1,
      rir_max: 3,
      progression_decision: null,
      decision: { weekly_exposure: { primary_sets: 2 } },
      ...overrides,
    };
  }

  it('a goal-linked primary exercise names the real goal and the muscle it trains (spec example)', () => {
    const text = buildFriendlyPlannedReasoning(baseWork(), 'arm-side-thickness');
    expect(text).toContain('Added for your arm side thickness goal.');
    expect(text).toContain('primarily trains the Brachialis');
    assertNoJargon(text);
  });

  it('reports real weekly progress: sets already done this week, and how many this session adds', () => {
    const text = buildFriendlyPlannedReasoning(baseWork({ decision: { weekly_exposure: { primary_sets: 4 } }, sets: 2 }), 'arm-side-thickness');
    expect(text).toContain('You had 4 sets for this target so far this week');
    expect(text).toContain('adds another 2 sets');
  });

  it('reports "not trained yet this week" when nothing was done before this placement', () => {
    const text = buildFriendlyPlannedReasoning(baseWork({ decision: { weekly_exposure: { primary_sets: 0 } } }), 'arm-side-thickness');
    expect(text).toContain("haven't trained this target yet this week");
  });

  it('a secondary-role exercise is described as supporting/indirect work (spec example)', () => {
    const text = buildFriendlyPlannedReasoning(baseWork({ role: 'secondary', target_name: 'Triceps', exercise_name: 'Close-Grip Bench Press' }), 'arm-side-thickness');
    expect(text).toContain('Supports your arm side thickness goal.');
    expect(text).toContain('Close-Grip Bench Press trains the Triceps as a secondary muscle');
    expect(text).toContain('without requiring another dedicated exercise');
  });

  it('a non-goal (normal-development) target is framed as overall physique development (spec example)', () => {
    const text = buildFriendlyPlannedReasoning(baseWork({ classification: 'normal_development', target_name: 'Quads', exercise_name: 'Back Squat' }), null);
    expect(text).toContain('Added for overall physique development.');
    expect(text).toContain('not currently an active goal but still needs regular development');
  });

  it('reps/RIR stay actionable, phrased naturally rather than citing the Blueprint package', () => {
    const text = buildFriendlyPlannedReasoning(baseWork({ reps_min: 10, reps_max: 20, rir_min: 1, rir_max: 3 }), 'arm-side-thickness');
    expect(text).toContain('Use 10–20 reps');
    expect(text).toContain('1–3 rep(s) in reserve');
    expect(text.toLowerCase()).not.toContain("per blueprint's development package");
  });

  it('first-time vs continued-progression language, translated to plain English (spec examples)', () => {
    const firstTime = buildFriendlyPlannedReasoning(baseWork({ progression_decision: null }), 'arm-side-thickness');
    expect(firstTime).toContain('First time using this variation in your logged history');

    const continuing = buildFriendlyPlannedReasoning(baseWork({ progression_decision: { recommendation: 'maintain' } }), 'arm-side-thickness');
    expect(continuing).toContain('Based on your previous performance, this continues your progression');
  });

  it('never contains internal implementation terminology', () => {
    for (const overrides of [{}, { role: 'secondary' }, { classification: 'normal_development' as const }, { classification: 'maintenance' as const }]) {
      const text = buildFriendlyPlannedReasoning(baseWork(overrides), 'arm-side-thickness');
      assertNoJargon(text);
      expect(text).not.toMatch(/\bphysique_target\b/);
      expect(text).not.toMatch(/"[a-z-]+-[a-z-]+"/); // no quoted raw slug-style ids
    }
  });
});

describe('buildFriendlySkipReasoning', () => {
  function baseSkip(overrides: Partial<Parameters<typeof buildFriendlySkipReasoning>[0]> = {}) {
    return {
      target_type: 'physique_target' as const,
      target_id: 'quads',
      target_name: 'Quads',
      reason: 'some internal reason text',
      decision: {
        recovery: { priority_adjustment: 'none' },
        volume_decision: { action: 'maintain' },
        weekly_allocation: { eligible_days_this_week: ['monday'] },
        selection: null,
      },
      ...overrides,
    };
  }

  it('a recovery-flagged skip reads as a recovery reason, using the real target name', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ decision: { ...baseSkip().decision, recovery: { priority_adjustment: 'avoid' } } }));
    expect(text).toContain('Quads');
    expect(text).toContain('recovery time');
  });

  it('a genuinely unscheduled target reads as a scheduling reason', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ decision: { ...baseSkip().decision, weekly_allocation: { eligible_days_this_week: [] } } }));
    expect(text).toContain("isn't scheduled on any of your training days");
  });

  it('an "already adequately exposed" skip reads as a positive sufficiency reason, not a gap', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ reason: 'Already adequately exposed via compound work (14.0 real+planned exposure_units this week...) (spec §7/§8).' }));
    expect(text).toContain('already getting enough real training this week');
    assertNoJargon(text);
  });

  it('never contains internal implementation terminology', () => {
    const text = buildFriendlySkipReasoning(baseSkip());
    assertNoJargon(text);
  });
});

describe('GET /api/programming/week — friendly fields reach the real HTTP response', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(':memory:');
    app = createApp(db);
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'],
      other_activity_schedule: [],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
  });

  it('every planned exercise carries a real, human-readable friendly_reasoning free of internal jargon, alongside the untouched internal reasoning', async () => {
    const week = await request(app).get('/api/programming/week').expect(200);
    const plannedWork = week.body.days.flatMap((d: any) => d.plannedWork ?? []);
    expect(plannedWork.length).toBeGreaterThan(0);
    for (const item of plannedWork) {
      expect(typeof item.friendly_reasoning).toBe('string');
      expect(item.friendly_reasoning.length).toBeGreaterThan(10);
      assertNoJargon(item.friendly_reasoning);
      // The internal machine-readable reasoning/decision are NOT deleted.
      expect(typeof item.reasoning).toBe('string');
      expect(item.decision).toBeDefined();
    }
    // At least the goal-linked chest target should read naturally.
    const goalLinked = plannedWork.find((w: any) => w.goal_id);
    expect(goalLinked).toBeDefined();
    expect(goalLinked.friendly_reasoning).toMatch(/Added for your|Supports your/);
  });

  it('skipped targets (if any this week) carry a friendly_reason free of internal jargon', async () => {
    const week = await request(app).get('/api/programming/week').expect(200);
    const skipped = week.body.days.flatMap((d: any) => d.skipped ?? []);
    for (const s of skipped) {
      expect(typeof s.friendly_reason).toBe('string');
      assertNoJargon(s.friendly_reason);
      expect(typeof s.reason).toBe('string'); // internal reason preserved
    }
  });
});
