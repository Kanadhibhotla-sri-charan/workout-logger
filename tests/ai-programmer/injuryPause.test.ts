// Injury pause (2026-10-11): a paused body area's physique targets are
// ineligible for every session; the planner plans none of them and no
// exercise that also credits one; the validator does not demand them.
// Real routes, context builder and planner; in-memory database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { InjuryPausesRepo, targetIdsForArea } from '../../src/repositories/injuryPausesRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { buildPlannedAIContext, buildPlannedProgrammerSystemInstruction } from '../../src/ai-programmer/planning/plannedContext.js';
import { creditedTargetKeys } from '../../src/ai-programmer/validation/sharedCredit.js';
import { validateProposalAdequacy } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';

let db: Database.Database;
const TARGET = '2026-10-12';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T03:00:00Z'));
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
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

describe('areas', () => {
  it('legs covers every lower-body target and nothing else', () => {
    expect(targetIdsForArea('legs').sort()).toEqual(['adductors', 'gastrocnemius', 'gluteus-maximus', 'gluteus-medius-minimus', 'hamstrings', 'quads', 'soleus']);
    expect(targetIdsForArea('arms')).toEqual(expect.arrayContaining(['biceps', 'triceps', 'forearm-flexors']));
  });
});

describe('routes', () => {
  it('lists areas, pauses one with today as its start, and resumes it', async () => {
    const app = createApp(db);
    const before = (await request(app).get('/api/programming/injuries').expect(200)).body.areas;
    expect(before.map((a: any) => a.id)).toEqual(['chest', 'shoulders', 'back', 'arms', 'core', 'legs', 'neck']);
    expect(before.every((a: any) => !a.paused)).toBe(true);

    const paused = (await request(app).put('/api/programming/injuries/legs').send({ paused: true }).expect(200)).body;
    expect(paused).toEqual({ id: 'legs', label: 'Legs', paused: true, since: '2026-10-11', note: null });

    await request(app).put('/api/programming/injuries/legs').send({ paused: false }).expect(200);
    expect(new InjuryPausesRepo(db).list()).toEqual([]);
  });

  it('rejects an unknown area and a missing flag', async () => {
    const app = createApp(db);
    await request(app).put('/api/programming/injuries/knees').send({ paused: true }).expect(400);
    await request(app).put('/api/programming/injuries/legs').send({}).expect(400);
  });
});

describe.each(['package', 'wide'] as const)('planning with a paused area (%s pool)', (mode) => {
  const context = (purpose: 'push' | 'pull' | 'legs' | 'upper') => buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: purpose, exercisePoolMode: mode });

  it('a paused area is ineligible and out of the expected coverage; nothing else changes', () => {
    const free = context('upper');
    new InjuryPausesRepo(db).pause('shoulders', '2026-10-10', 'left shoulder twinge');
    const c = context('upper');
    const shoulders = targetIdsForArea('shoulders');
    for (const m of c.programmingBrief.muscles) {
      const before = free.programmingBrief.muscles.find((x) => x.targetId === m.targetId)!;
      if (shoulders.includes(m.targetId)) {
        expect(m.eligibleForThisSession).toBe(false);
        expect(m.pausedForInjury).toBe(true);
      } else {
        expect(m.eligibleForThisSession).toBe(before.eligibleForThisSession);
        expect(m).not.toHaveProperty('pausedForInjury');
      }
    }
    expect(c.programmingBrief.session.expectedCoverageTargetIds.filter((id) => shoulders.includes(id))).toEqual([]);
    expect(c.injuryPauses).toEqual([{ area: 'shoulders', since: '2026-10-10', note: 'left shoulder twinge', targetIds: shoulders }]);
  });

  it('the plan trains no paused target and offers no exercise that credits one', () => {
    new InjuryPausesRepo(db).pause('shoulders', '2026-10-10', null);
    const c = context('push');
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    const shoulders = new Set(targetIdsForArea('shoulders'));
    const planned = plan.targets.filter((t) => t.status === 'required' || t.status === 'selected');
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.filter((t) => shoulders.has(t.targetId))).toEqual([]);
    for (const t of plan.targets.filter((x) => shoulders.has(x.targetId))) expect(t.reason).toBe('body area paused for injury');
    for (const t of planned) {
      for (const cand of t.candidates) {
        const credited = creditedTargetKeys({ exerciseId: cand.exerciseId, targetType: 'physique_target', targetId: t.targetId }, c.targets);
        expect(credited.some((k) => shoulders.has(k.slice(k.indexOf(':') + 1))), `${t.targetId}/${cand.exerciseId}`).toBe(false);
      }
    }
    expect(plan.identityMinimum.satisfied).toBe(true);
  });

  it('a legs session with legs paused has nothing to train', () => {
    new InjuryPausesRepo(db).pause('legs', '2026-10-10', null);
    const c = context('legs');
    const legs = new Set(targetIdsForArea('legs'));
    expect(c.programmingBrief.muscles.filter((m) => legs.has(m.targetId)).every((m) => !m.eligibleForThisSession)).toBe(true);
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    expect(plan.targets.filter((t) => (t.status === 'required' || t.status === 'selected') && legs.has(t.targetId))).toEqual([]);
  });

  it('a paused goal target is not demanded by the validator', () => {
    new InjuryPausesRepo(db).pause('arms', '2026-10-10', null);
    const c = context('push');
    const proposal = {
      schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'p', mode: 'generate_session', targetDate: TARGET, weekday: 'monday', sessionFocus: ['push'],
      exercises: [
        { exerciseId: 'flat-barbell-bench-press', role: 'primary', targetType: 'physique_target', targetId: 'mid-pec', sets: 3, repsMin: 6, repsMax: 10, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' },
        { exerciseId: 'dumbbell-lateral-raise', role: 'primary', targetType: 'physique_target', targetId: 'side-delt', sets: 3, repsMin: 10, repsMax: 20, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' },
      ],
      programmingRationale: [], goalAlignment: [], recoveryConsiderations: [], warnings: [],
    } as any;
    expect(validateProposalAdequacy(proposal, c).errors.join(' ')).not.toMatch(/triceps.*active-goal/);
  });

  it('the model is told about the pause', () => {
    new InjuryPausesRepo(db).pause('legs', '2026-10-10', 'knee');
    const c = context('push');
    expect(buildPlannedAIContext(c, planSession(c, { nonGoalRotationCursor: 0 })).injuryPauses[0]).toMatchObject({ area: 'legs', note: 'knee' });
    expect(buildPlannedProgrammerSystemInstruction()).toMatch(/context\.injuryPauses lists body areas/);
  });
});
