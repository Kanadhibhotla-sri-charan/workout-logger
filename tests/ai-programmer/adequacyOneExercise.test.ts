// Adequacy review (2026-10-09): a one-exercise "pull" session used to pass
// validateProposalAdequacy when that one exercise's Blueprint shared credit
// covered two identity targets of the same muscle group (hammer curl ->
// brachialis-arm-thickness + biceps). Identity coverage is now counted in
// distinct muscle groups, in the validator and the session planner alike. Real context builder,
// in-memory database, fixed clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { identityGroupOf, requiredIdentityGroups, validateProposalAdequacy } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import { creditedSetsByTarget, creditedTargetKeys } from '../../src/ai-programmer/validation/sharedCredit.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import type { AIProgrammerProvider, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { SESSION_PURPOSE_TARGETS, UNIVERSAL_PHYSIQUE_TARGETS } from '../../src/engine/config.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const TARGET = '2026-10-09';
let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T01:30:00Z'));
  db = openDb(':memory:');
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
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });
});

/** The real Oct 1-8 push/pull pattern at 2 sets per exercise (the same
 * fixture as exercisePool.test.ts). Biceps' maintained weekly volume is low,
 * so today's per-session biceps floor is 2 sets or less. */
function logEarlierWeek() {
  const push = ['cable-pushdown', 'cable-overhead-extension-leaning-forward', 'close-grip-bench-press', 'flat-barbell-bench-press', 'incline-barbell-press', 'cable-fly', 'dumbbell-lateral-raise', 'cable-crunch'];
  const pull = ['cross-body-hammer-curl', 'barbell-ez-bar-curl', 'lat-pulldown-wide-pronated', 'straight-arm-pulldown', 'face-pull', 'rear-delt-row', 'chest-supported-row', 'reverse-curl', 'wrist-curl'];
  const sessions = new WorkoutSessionsRepo(db);
  for (const [date, list] of [['2026-10-01', push], ['2026-10-02', pull], ['2026-10-05', push], ['2026-10-06', pull], ['2026-10-08', push]] as const) {
    const s = sessions.createSession({ date, session_type: 'gym', status: 'completed' });
    list.forEach((exercise_id, i) =>
      sessions.addExercisePerformance(s.session_id, { exercise_id, order: i + 1, role: 'primary', sets: [1, 2].map((n) => ({ set_number: n, weight: 20, reps: 10, completed: true })) })
    );
  }
}

const session = (exercises: Array<[string, string, number]>) =>
  ({
    schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'p', mode: 'generate_session', targetDate: TARGET, weekday: 'friday', sessionFocus: ['pull'],
    exercises: exercises.map(([targetId, exerciseId, sets]) => ({ exerciseId, role: 'primary', targetType: 'physique_target', targetId, sets, repsMin: 10, repsMax: 16, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' })),
    programmingRationale: [], goalAlignment: [], recoveryConsiderations: [], warnings: [],
  }) as any;

describe.each(['package', 'wide'] as const)('adequacy, one-exercise pull sessions (%s pool)', (mode) => {
  const context = () => buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull', exercisePoolMode: mode });

  it('hammer curl alone earns credit for two identity targets of one muscle group', () => {
    const c = context();
    const keys = creditedTargetKeys({ exerciseId: 'hammer-curl', targetType: 'physique_target', targetId: 'brachialis-arm-thickness' }, c.targets);
    expect(keys.sort()).toEqual(['physique_target:biceps', 'physique_target:brachialis-arm-thickness']);
  });

  it('rejects a one-exercise session whose single exercise covers only one identity target', () => {
    const result = validateProposalAdequacy(session([['brachialis-arm-thickness', 'cross-body-hammer-curl', 2]]), context());
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/session identity "pull" expects meaningful coverage of at least 2/);
  });

  it('rejects a session that omits the active goal', () => {
    const result = validateProposalAdequacy(session([['lat-width', 'lat-pulldown-wide-pronated', 3], ['back-thickness', 'chest-supported-row', 3]]), context());
    expect(result.errors.join(' ')).toMatch(/brachialis-arm-thickness: an active-goal target eligible for this session received no direct work/);
  });

  it('rejects a single hammer curl when the biceps volume floor is not met (fresh week)', () => {
    const result = validateProposalAdequacy(session([['brachialis-arm-thickness', 'hammer-curl', 2]]), context());
    expect(result.errors.join(' ')).toMatch(/biceps: 2 sets is clearly inadequate volume/);
  });

  // The counterexample (fixed 2026-10-09): late in a light week, a single
  // hammer curl cleared every volume floor and was counted as covering two
  // pull targets. Identity coverage is now counted in muscle groups, so
  // brachialis + biceps from one curl is one group.
  it('rejects a one-exercise pull session made of a single hammer curl (late in the week)', () => {
    logEarlierWeek();
    const c = context();
    expect(c.programmingBrief.muscles.find((m) => m.targetId === 'biceps')!.recommendedSessionSets.min).toBeLessThanOrEqual(4);
    const result = validateProposalAdequacy(session([['brachialis-arm-thickness', 'hammer-curl', 2]]), c);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/at least 2 muscle groups .*-> groups \[biceps\]/);
  });

  it('still credits the hammer curl to both targets for volume (shared credit unchanged)', () => {
    logEarlierWeek();
    const c = context();
    const totals = creditedSetsByTarget(session([['brachialis-arm-thickness', 'hammer-curl', 2]]).exercises, c.targets);
    expect(totals.get('physique_target:biceps')).toBe(2);
    expect(totals.get('physique_target:brachialis-arm-thickness')).toBe(2);
  });

  it('accepts the same hammer curl once a second muscle group is covered', () => {
    logEarlierWeek();
    const result = validateProposalAdequacy(session([['brachialis-arm-thickness', 'hammer-curl', 2], ['lat-width', 'lat-pulldown-wide-pronated', 3]]), context());
    expect(result.errors.join(' ')).not.toMatch(/session identity/);
  });

  it('plans identity coverage across two muscle groups, never brachialis + biceps alone', () => {
    logEarlierWeek();
    const plan = planSession(context(), { nonGoalRotationCursor: 0 });
    const groups = plan.identityMinimum.coveringTargetIds.map(identityGroupOf);
    expect(plan.identityMinimum.satisfied).toBe(true);
    expect(new Set(groups).size).toBe(groups.length);
    expect(groups.length).toBe(2);
  });
});

describe('identity groups', () => {
  it('maps targets to their Blueprint muscle group', () => {
    expect(identityGroupOf('biceps')).toBe(identityGroupOf('brachialis-arm-thickness'));
    expect(identityGroupOf('upper-pec')).toBe('chest');
    expect(identityGroupOf('lat-width')).not.toBe(identityGroupOf('rear-delt'));
  });

  it('requires two groups for every session purpose', () => {
    for (const purpose of ['push', 'pull', 'legs', 'upper'] as const) {
      expect(requiredIdentityGroups([...SESSION_PURPOSE_TARGETS[purpose], ...UNIVERSAL_PHYSIQUE_TARGETS]), purpose).toBe(2);
    }
  });
});

describe('generation end to end: a one-hammer-curl answer (fake provider)', () => {
  class OneCurl implements AIProgrammerProvider {
    async generate(): Promise<AIProgrammerProviderResponse> {
      const body = { ...session([['brachialis-arm-thickness', 'hammer-curl', 2]]), proposalId: 'p' };
      return { provider: 'fake', model: 'fake-model', requestId: 'req-x', rawText: JSON.stringify(body) };
    }
  }
  afterEach(() => {
    delete process.env.AI_PROGRAMMER_ENABLED;
    delete process.env.AI_PLANNED_GENERATION_ENABLED;
    delete process.env.AI_EXERCISE_POOL_MODE;
  });

  it.each(['package', 'wide'])('is rejected by adequacy validation (%s pool)', async (mode) => {
    logEarlierWeek();
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
    process.env.AI_EXERCISE_POOL_MODE = mode;
    const err = await new AIProgrammerService(db, new OneCurl()).generateSession({ targetDate: TARGET, requestedSessionPurpose: 'pull' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/programming-adequacy validation: session identity "pull" expects meaningful coverage of at least 2 muscle groups/);
  });
});
