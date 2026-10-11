// Deload double-cut fix (2026-10-11): during a deload the recommended
// sets already carry the deload's reduction, so the adequacy floor (and
// the planner's minimumSets) is the recommendation itself, not 50% of it.
// Also: ending a reactive deload early. Real context builder, planner,
// validator and routes; in-memory database; fixed clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { createInitialProgramState, updateReactiveState } from '../../src/coaching/programState/programStateService.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { buildPlannedProgrammerSystemInstruction } from '../../src/ai-programmer/planning/plannedContext.js';
import { adequacyToleranceFor, deloadAdequacyTolerance, validateProposalAdequacy } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';

let db: Database.Database;
let userId: string;
const TARGET = '2026-10-12';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T03:00:00Z'));
  db = openDb(':memory:');
  userId = new UsersRepo(db).getOrCreateDefault().id;
  new TrainingProfileRepo(db).upsert(userId, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar'],
    other_activity_schedule: [],
  });
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
});

afterEach(() => vi.useRealTimers());

const startReactiveDeload = () => {
  if (!db.prepare('SELECT 1 FROM coaching_program_state WHERE program_id = ?').get(userId)) createInitialProgramState(db, { programId: userId, blockStartDate: '2026-10-05', blockLengthWeeks: 4 });
  updateReactiveState(db, userId, TARGET, 'monday', { reactiveTriggerStatus: 'triggered', reactiveTriggeredAt: '2026-10-11', reactiveDeloadStartDate: '2026-10-11', reactiveDeloadEndDate: '2026-10-17', cooldownUntil: '2026-10-31', lastEvaluatedAt: TARGET });
};
const context = () => buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'push', exercisePoolMode: 'wide' });

describe('deload volume floor', () => {
  it('outside a deload every target keeps the 50% floor', () => {
    const c = context();
    expect(c.programmingBrief.deloadActive).toBeUndefined();
    for (const m of c.programmingBrief.muscles) expect(adequacyToleranceFor(m)).toBe(0.5);
  });

  it('the deload tolerance cuts once and never asks for more than a normal week', () => {
    expect(deloadAdequacyTolerance(4, 8)).toBe(1); // halved recommendation: floor = the recommendation (4), = normal floor
    expect(deloadAdequacyTolerance(12, 12)).toBe(0.5); // capped, unchanged by the deload: normal floor (6)
    expect(deloadAdequacyTolerance(5, 8)).toBe(0.8); // floor 4 = normal floor
    expect(deloadAdequacyTolerance(0, 4)).toBe(0.5);
  });

  it('in a deload each planned target floor is min(deload recommendation, normal floor), and the plan still fits', () => {
    const normal = context();
    startReactiveDeload();
    const c = context();
    expect(c.programmingBrief.deloadActive).toBe(true);
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    expect(plan.refusals).toEqual([]);
    let raised = 0;
    for (const t of plan.targets.filter((x) => x.status === 'required' || x.status === 'selected')) {
      const g = c.programmingBrief.muscles.find((m) => m.targetId === t.targetId)!;
      const n = normal.programmingBrief.muscles.find((m) => m.targetId === t.targetId)!;
      expect(t.adequacyThreshold, t.targetId).toBeCloseTo(Math.min(g.recommendedSessionSets.min, n.recommendedSessionSets.min * 0.5), 5);
      if (t.adequacyThreshold > g.recommendedSessionSets.min * 0.5) raised++;
    }
    expect(raised).toBeGreaterThan(0); // the double cut is gone for at least one target
  });

  it('in a deload the validator rejects a halved target cut below its recommendation', () => {
    startReactiveDeload();
    const c = context();
    const g = c.programmingBrief.muscles.find((m) => m.eligibleForThisSession && m.adequacyTolerance === 1 && m.recommendedSessionSets.min >= 2 && c.programmingBrief.session.expectedCoverageTargetIds.includes(m.targetId))!;
    const exerciseId = c.targets.find((t) => t.targetId === g.targetId)!.validExercises.find((v) => v.authoredPrescription)!.exerciseId;
    const sets = g.recommendedSessionSets.min - 1;
    const proposal = {
      schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'p', mode: 'generate_session', targetDate: TARGET, weekday: 'monday', sessionFocus: ['push'],
      exercises: [{ exerciseId, role: 'primary', targetType: 'physique_target', targetId: g.targetId, sets, repsMin: 8, repsMax: 12, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' }],
      programmingRationale: [], goalAlignment: [], recoveryConsiderations: [], warnings: [],
    } as any;
    expect(validateProposalAdequacy(proposal, c).errors.join(' ')).toContain(`${g.targetId}: ${sets} sets is clearly inadequate volume — below 100%`);
  });

  it('tells the model the deload is already in the numbers', () => {
    expect(buildPlannedProgrammerSystemInstruction()).toMatch(/During a deload, aim for recommendedSets/);
  });
});

describe('ending a reactive deload early', () => {
  it('ends it, records a manual event, and 409s when none is active', async () => {
    startReactiveDeload();
    const app = createApp(db);
    expect((await request(app).get('/api/programming/periodization').expect(200)).body.periodizationState).toBe('REACTIVE_DELOAD');
    await request(app).post('/api/programming/periodization/end-reactive-deload').expect(200, { ended: true });
    const after = (await request(app).get('/api/programming/periodization').expect(200)).body;
    expect(after.periodizationState).toBe('ACTIVE');
    expect(after.reactiveEvidence).toBeNull();
    const events = db.prepare("SELECT trigger_type, new_state FROM coaching_periodization_events WHERE trigger_type = 'manual'").all();
    expect(events).toEqual([{ trigger_type: 'manual', new_state: 'ACTIVE' }]);
    await request(app).post('/api/programming/periodization/end-reactive-deload').expect(409);
  });
});
