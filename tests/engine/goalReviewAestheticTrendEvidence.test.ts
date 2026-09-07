// Final Step 12 Fix Pass §P0-1: aesthetic assessment evidence must be a
// REAL trend — comparing an appropriate earlier assessment against the
// latest one — never a single 1-5 rating classified in isolation. See
// classifyAestheticTrendForReview in src/engine/goalPhaseEngine.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { GoalPhaseRepo } from '../../src/repositories/goalPhaseRepo.js';
import { AestheticAssessmentsRepo } from '../../src/repositories/aestheticAssessmentsRepo.js';
import { gatherReviewEvidence } from '../../src/engine/goalPhaseEngine.js';

let db: Database.Database;

function setup() {
  const goal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });
  const phase = new GoalPhaseRepo(db).create({ goal_id: goal.id, start_date: '2026-08-01', review_date: '2026-09-12', package_level: 'complete' });
  return { goal, phase };
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('Test A — 2 -> 3 is improving', () => {
  it('an earlier rating of 2 followed by a later rating of 3 in-phase is a real improving trend', () => {
    const { goal, phase } = setup();
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-08-05', rating: 2 });
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-09-01', rating: 3 });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-12');
    expect(evidence.aesthetic_trend).toBe('improving');
  });
});

describe('Test B — 5 -> 4 is declining', () => {
  it('an earlier rating of 5 followed by a later rating of 4 in-phase is a real declining trend', () => {
    const { goal, phase } = setup();
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-08-05', rating: 5 });
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-09-01', rating: 4 });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-12');
    expect(evidence.aesthetic_trend).toBe('declining');
  });
});

describe('Test C — 3 -> 3 is stagnant', () => {
  it('two equal in-phase ratings is a real stagnant trend, never classified as improving/declining from the rating value alone', () => {
    const { goal, phase } = setup();
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-08-05', rating: 3 });
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-09-01', rating: 3 });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-12');
    expect(evidence.aesthetic_trend).toBe('stagnant');
  });
});

describe('Test D — a single assessment is insufficient data', () => {
  it('one assessment overall — even a high rating of 5 — is never itself classified as a trend', () => {
    const { goal, phase } = setup();
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-09-01', rating: 5 });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-12');
    expect(evidence.aesthetic_trend).toBe('insufficient_data');
  });
});

describe('Test E — an assessment recorded for a different, unrelated goal is excluded', () => {
  it("another goal's own assessment history never contributes to this goal's trend", () => {
    const { goal, phase } = setup();
    const otherGoal = new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 2 });

    // This goal has only ONE real assessment of its own — insufficient
    // on its own — while the OTHER goal has a real, comparable
    // improving pair that must never leak into this goal's evidence.
    new AestheticAssessmentsRepo(db).record({ goal_id: goal.id, date: '2026-09-01', rating: 3 });
    new AestheticAssessmentsRepo(db).record({ goal_id: otherGoal.id, date: '2026-08-05', rating: 2 });
    new AestheticAssessmentsRepo(db).record({ goal_id: otherGoal.id, date: '2026-09-01', rating: 5 });

    const evidence = gatherReviewEvidence(db, goal, phase, '2026-09-12');
    expect(evidence.aesthetic_trend).toBe('insufficient_data');
  });
});
