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
import { buildFriendlyPlannedReasoning, buildFriendlyRejectedCandidateReasoning, buildFriendlySkipReasoning, humanizeSlug } from '../src/server/friendlyExplanation.js';
import { resolveGoalNameRef } from '../src/server/routes/programming.js';

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

describe('resolveGoalNameRef — Final Copy/Explanation Fixes §7: best available human-readable goal name', () => {
  it('uses the real Blueprint functionalGoal title when one exists, not a humanized slug', () => {
    // Verified directly against src/blueprint/snapshot/programming.json:
    // functionalGoals do carry a genuine clean title ("Rotator Cuff"),
    // unlike aesthetic outcomes, so it must be preferred here.
    expect(resolveGoalNameRef({ goal_type: 'functional', blueprint_ref: 'rotator-cuff' })).toBe('Rotator Cuff');
    expect(resolveGoalNameRef({ goal_type: 'functional', blueprint_ref: 'scapular-stability' })).toBe('Scapular Stability');
  });

  it('falls back to the raw blueprint_ref (humanized downstream) for an aesthetic outcome, which has no title field', () => {
    // aestheticOutcomes' only name-like field, display_name, is a
    // first-person problem statement ("Arms look thin from the side"),
    // not a goal title — spec §7 explicitly allows the slug-humanization
    // fallback when no better representation exists.
    expect(resolveGoalNameRef({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness' })).toBe('arm-side-thickness');
  });

  it('falls back to the raw blueprint_ref for a functional goal id Blueprint does not recognize', () => {
    expect(resolveGoalNameRef({ goal_type: 'functional', blueprint_ref: 'not-a-real-functional-goal' })).toBe('not-a-real-functional-goal');
  });

  it('end-to-end: a functional-goal-linked friendly_reasoning reads "your Rotator Cuff goal", never "your rotator cuff goal"', () => {
    const text = buildFriendlyPlannedReasoning(
      {
        target_name: 'Rotator Cuff',
        exercise_name: 'Band Pull-Apart',
        role: 'primary',
        classification: 'specialization',
        sets: 3,
        reps_min: 12,
        reps_max: 20,
        rir_min: 1,
        rir_max: 3,
        progression_decision: null,
        decision: { weekly_exposure: { primary_sets: 0 } },
      },
      resolveGoalNameRef({ goal_type: 'functional', blueprint_ref: 'rotator-cuff' })
    );
    expect(text).toContain('Added for your Rotator Cuff goal.');
    expect(text).not.toContain('rotator cuff goal'); // never the lowercase humanized-slug form when a real title exists
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

describe('buildFriendlySkipReasoning — One-Pass Dev Spec v2 §18/§19: switches exclusively on the structured reason_code, never on substrings of reason', () => {
  function baseSkip(overrides: Partial<Parameters<typeof buildFriendlySkipReasoning>[0]> = {}) {
    return {
      target_type: 'physique_target' as const,
      target_id: 'quads',
      target_name: 'Quads',
      reason_code: 'no_volume_recommended' as const,
      reason: 'some internal reason text',
      decision: {
        recovery: { priority_adjustment: 'none' },
        volume_decision: { action: 'maintain' },
        exposure_decision: { last_exposure_date: null, days_since_last_exposure: null, expected_exposure_interval_days: 4 },
        selection: null,
        last_trained: { date: null, days_since: null },
        recent_exercise_ids: [],
        weekly_exposure: { exposure_units: 0 },
      },
      ...overrides,
    };
  }

  it('a recovery skip reads as a recovery reason, using the real target name, with no fabricated date when none is known', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ reason_code: 'recovery' }));
    expect(text).toContain('Quads');
    expect(text).toContain('recovery time');
  });

  it('a recovery skip cites the REAL last-trained date when the engine actually knows it (spec §10)', () => {
    const text = buildFriendlySkipReasoning(
      baseSkip({ reason_code: 'recovery', decision: { ...baseSkip().decision, last_trained: { date: '2026-09-07', days_since: 1 } } })
    );
    expect(text).toContain('2026-09-07');
  });

  it('a target not due for this exposure reads as a scheduling/exposure reason, distinguishing valid-but-not-due from invalid, never framed as "not this week" (Post-v2 Corrective Fix §22)', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ reason_code: 'not_current_exposure' }));
    expect(text).toContain("isn't due for this exposure");
    expect(text).toContain('next appropriate target-training session');
    expect(text.toLowerCase()).not.toContain('this week');
  });

  it('a target not due for this exposure cites the REAL last exposure date when the engine knows it, never a fabricated one (Post-v2 Corrective Fix §22/§43)', () => {
    const text = buildFriendlySkipReasoning(
      baseSkip({
        reason_code: 'not_current_exposure',
        decision: { ...baseSkip().decision, exposure_decision: { last_exposure_date: '2026-09-05', days_since_last_exposure: 2, expected_exposure_interval_days: 4 } },
      })
    );
    expect(text).toContain('2026-09-05');
    expect(text).toContain("isn't due for this exposure");
  });

  it('an "adequately covered" skip names the REAL covering exercise(s), not a generic "compound work" placeholder (spec §10/§22)', () => {
    const text = buildFriendlySkipReasoning(
      baseSkip({ reason_code: 'adequately_covered', decision: { ...baseSkip().decision, recent_exercise_ids: ['back-squat', 'leg-extension'] } })
    );
    expect(text).toContain('Back Squat');
    expect(text).toContain('Leg Extension');
    assertNoJargon(text);
  });

  it('an "adequately covered" skip falls back to a plain sufficiency reason when no real covering exercise id resolves', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ reason_code: 'adequately_covered' }));
    expect(text).toContain('already getting enough real training this week');
    assertNoJargon(text);
  });

  it('a genuine Blueprint data gap (blueprint_data_integrity) is framed as a data issue, never as "not prescribable"/invalid (spec §9/§11/§18/§22/§23)', () => {
    const text = buildFriendlySkipReasoning(baseSkip({ reason_code: 'blueprint_data_integrity' }));
    expect(text).toContain('data gap');
    expect(text.toLowerCase()).not.toContain('not prescribable');
    expect(text.toLowerCase()).not.toContain('confidently prescribable');
    expect(text.toLowerCase()).not.toContain('invalid');
    assertNoJargon(text);
  });

  it('never contains internal implementation terminology', () => {
    const text = buildFriendlySkipReasoning(baseSkip());
    assertNoJargon(text);
  });
});

describe('buildFriendlyRejectedCandidateReasoning — One-Pass Dev Spec v2 §18/§22/§31.13: valid-but-not-selected-today explanations', () => {
  it('a candidate rejected for a better-fit variation (any non-redundancy gate) is explained as "better variation selected," remaining valid for a future session', () => {
    const text = buildFriendlyRejectedCandidateReasoning({
      rejected_exercise_name: 'Close-Grip Bench Press',
      selected_exercise_name: 'Cable Pushdown',
      decisive_gate: 'gate5_progression_continuity',
    });
    expect(text).toContain('Close-Grip Bench Press');
    expect(text).toContain('Cable Pushdown');
    expect(text).toContain('better fit');
    expect(text.toLowerCase()).toContain('remains available');
    expect(text.toLowerCase()).not.toContain('no valid prescription');
    expect(text.toLowerCase()).not.toContain('not prescribable');
  });

  it('a candidate rejected because it is already covering a different target today (Gate 3) is explained as redundant today, not invalid', () => {
    const text = buildFriendlyRejectedCandidateReasoning({
      rejected_exercise_name: 'Incline Dumbbell Press',
      selected_exercise_name: 'Cable Fly',
      decisive_gate: 'gate3_programming_need',
    });
    expect(text).toContain('Incline Dumbbell Press');
    expect(text).toContain('already doing work for a different target');
    expect(text.toLowerCase()).toContain('remains available');
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
