// Athletic day (2026-10-18): leg training 'athletic' turns the Legs slot
// into an Athletic day of badminton drills and whole-body conditioning;
// leg muscles get no growth volume; drills only count for their athletic
// goals; the Legs injury pause makes the Athletic day a rest day.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';
import { ATHLETIC_GOAL_IDS, allDrills } from '../../src/blueprint/athletic.js';
import { modePrescriptionFor, resolvePrimaryRepRange } from '../../src/blueprint/programmingProfiles.js';
import { exercisesTrainingTarget } from '../../src/engine/exerciseSelector.js';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { assignSessionPurposes } from '../../src/engine/sessionPurpose.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { LegTrainingRepo } from '../../src/repositories/legTrainingRepo.js';
import { InjuryPausesRepo, targetIdsForArea } from '../../src/repositories/injuryPausesRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import { approveProposal, commitAIProposalToPlannedSession } from '../../src/ai-programmer/service/aiProposalLifecycle.js';
import { readWeekGenerationState, startWeekGeneration, weekGymDays } from '../../src/ai-programmer/service/weekGeneration.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { ATHLETIC_BLOCKS, BUILD_UP_SESSIONS, buildAthleticContext, checkAthleticOutput, type AthleticContext } from '../../src/athletic/athleticSession.js';
import { planAthleticAddOn } from '../../src/athletic/athleticAddOn.js';
import { addDays } from '../../src/engine/dateMath.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { athleticWork, strengthProgress } from '../../src/insights/insightsService.js';
import { buildCoachFacts, buildCoachInstruction } from '../../src/coaching/review/coachReviewService.js';

const MONDAY = '2026-10-19';
const THURSDAY = '2026-10-22';
let db: Database.Database;

/** Picks exercises per block at the low end of each range. `tweak` lets a test bend the answer. */
function athleticAnswer(context: AthleticContext, tweak: (exercises: any[]) => any[] = (x) => x) {
  const pick = (block: string, n: number) => context.drills.filter((d) => d.block === block).slice(0, n);
  const drills = [...pick('warmup', 2), ...pick('quality', 2), ...pick('conditioning', 1), ...pick('cooldown', 1)].map((d) => ({
    exerciseId: d.exerciseId, targetId: d.goals[0], sets: d.sets.min, amountMin: d.amount.min, amountMax: d.amount.max, restSeconds: d.restSeconds.min, rationale: d.mode,
  }));
  const lifts = ['bulgarian-split-squat-knee-dominant', 'romanian-deadlift'].map((id) => {
    const l = context.strengthLifts.find((x) => x.exerciseId === id)!;
    return { exerciseId: id, targetId: l.legTargets[0], sets: 3, repsMin: l.reps.min, repsMax: l.reps.max, rirMin: l.rir.min, rirMax: l.rir.max, restSeconds: 120, rationale: 'strength' };
  });
  // Lifts placed among the drills; the check orders them into the strength block.
  return { sessionFocus: ['footwork', 'strength'], exercises: tweak([...drills.slice(0, 4), ...lifts, ...drills.slice(4)]), warnings: [] };
}

/** A valid planned physique answer (same shape as tests/ai-programmer/weekGeneration.test.ts). */
function plannedOutput(ctx: any): any {
  const sp = ctx.sessionPlan;
  const used = new Set<string>();
  const exercises: any[] = [];
  for (const g of sp.exerciseGroups) {
    const credit = new Map<string, number>(g.targetIds.map((id: string) => [id, 0]));
    let count = 0;
    const add = (targetId: string, c: any) => {
      used.add(c.exerciseId);
      count++;
      for (const id of [targetId, ...c.alsoCredits]) if (credit.has(id)) credit.set(id, credit.get(id)! + c.maxSets);
      exercises.push({ exerciseId: c.exerciseId, role: 'primary', targetType: 'physique_target', targetId, sets: c.maxSets, repsMin: c.repsMin, repsMax: c.repsMax, rirMin: c.rirMin, rirMax: c.rirMax, rationale: ['fake'], source: 'blueprint' });
    };
    const candidatesOf = (id: string) =>
      [...sp.targets.find((t: any) => t.targetId === id).candidates]
        .filter((c: any) => !used.has(c.exerciseId))
        .sort((a: any, b: any) => b.alsoCredits.filter((x: string) => credit.has(x)).length - a.alsoCredits.filter((x: string) => credit.has(x)).length || b.maxSets - a.maxSets);
    for (const id of g.targetIds) {
      for (const c of candidatesOf(id)) {
        if (credit.get(id)! >= g.memberMinimumSets[id] || count >= g.reservedExercises) break;
        if (!used.has(c.exerciseId)) add(id, c);
      }
    }
    for (const id of g.targetIds) for (const c of candidatesOf(id)) if (count < g.reservedExercises) add(id, c);
  }
  return { schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'p', mode: 'generate_session', targetDate: ctx.targetDate, weekday: ctx.targetWeekday, sessionFocus: [sp.purpose], exercises, programmingRationale: ['fake'], goalAlignment: [], recoveryConsiderations: [], warnings: [] };
}

const BLOCK_ORDER = ['warmup', 'warmup', 'quality', 'quality', 'strength', 'strength', 'conditioning', 'cooldown'];

/** Completed Athletic days in the past, so the build-up phase is over. */
function pastAthleticDays(n: number) {
  const repo = new WorkoutSessionsRepo(db);
  for (let i = 1; i <= n; i++) {
    const s = repo.createSession({ date: addDays(MONDAY, -7 * i + 3), session_type: 'gym', status: 'completed' });
    repo.addExercisePerformance(s.session_id, { exercise_id: 'jump-rope', order: 0, role: 'conditioning', sets: [{ set_number: 1, weight: null, reps: 30, completed: true }] });
  }
}

class FakeProvider implements AIProgrammerProvider {
  requests: AIProgrammerProviderRequest[] = [];
  constructor(private tweak?: (exercises: any[]) => any[]) {}
  async generate(req: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    this.requests.push(req);
    const ctx = req.context as any;
    const body = ctx.schemaVersion === 'athletic-session-context.v3' ? athleticAnswer(ctx, this.tweak) : ctx.sessionPlan ? plannedOutput(ctx) : { nonsense: true };
    return { provider: 'fake', model: 'fake-model', requestId: req.requestId, rawText: JSON.stringify(body) };
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${MONDAY}T03:00:00Z`));
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
    other_activity_schedule: [{ day: 'saturday', activity_type: 'badminton', notes: null }, { day: 'sunday', activity_type: 'badminton', notes: null }],
  });
  new LegTrainingRepo(db).set('athletic');
  process.env.AI_PROGRAMMER_ENABLED = 'true';
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ['AI_PROGRAMMER_ENABLED', 'AI_PLANNED_GENERATION_ENABLED', 'AI_WEEK_GENERATION_MODE']) delete process.env[k];
});

describe('Blueprint drills', () => {
  it('a drill gets its own mode prescription; normal lifts keep their hypertrophy ranges', () => {
    expect(allDrills()).toHaveLength(20);
    expect(resolvePrimaryRepRange(BlueprintAdapter.getExercise('flat-barbell-bench-press')!)).toEqual([6, 12]);
    expect(modePrescriptionFor('flat-barbell-bench-press')).toBeNull();
    expect(modePrescriptionFor('lateral-shuffle')).toMatchObject({ mode: 'agility', unit: 'seconds', amount: [5, 15], sets: [4, 8], restSeconds: [30, 90] });
    expect(modePrescriptionFor('pogo-hops')).toMatchObject({ mode: 'power', unit: 'reps' });
  });

  it('drills answer only their athletic goals and credit nothing else', () => {
    const drillIds = new Set(allDrills().map((d) => d.id));
    for (const t of BlueprintAdapter.getTargets()) {
      expect(exercisesTrainingTarget('physique_target', t.id).filter((id) => drillIds.has(id)), t.id).toEqual([]);
    }
    expect(exercisesTrainingTarget('functional_goal', 'full-body-conditioning')).toEqual(expect.arrayContaining(['burpee', 'rowing-machine-intervals']));
    const credited = calculateExerciseExposure('rowing-machine-intervals', [{ completed: true }]).contributions;
    expect(credited.every((c) => c.target_type === 'functional_goal' && (ATHLETIC_GOAL_IDS as readonly string[]).includes(c.target_id))).toBe(true);
  });
});

describe('leg training setting and the weekly rotation', () => {
  it('athletic replaces legs in the rotation; never on Monday', () => {
    const days = ['monday', 'tuesday', 'thursday', 'friday'] as const;
    expect(Object.fromEntries(assignSessionPurposes(days, ['saturday', 'sunday'], 'athletic').purposes)).toEqual({ monday: 'push', tuesday: 'pull', thursday: 'athletic', friday: 'upper' });
    expect(Object.fromEntries(assignSessionPurposes(days, [], 'hypertrophy').purposes).thursday).toBe('legs');
    expect(assignSessionPurposes(['monday', 'wednesday', 'friday'], [], 'athletic').purposes.get('monday')).not.toBe('athletic');
    expect(weekGymDays(db, MONDAY).map((d) => d.purpose)).toEqual(['push', 'pull', 'athletic', 'upper']);
  });

  it('GET/PUT /api/programming/leg-training', async () => {
    const app = createApp(db);
    expect((await request(app).get('/api/programming/leg-training').expect(200)).body).toEqual({ mode: 'athletic' });
    expect((await request(app).put('/api/programming/leg-training').send({ mode: 'hypertrophy' }).expect(200)).body).toEqual({ mode: 'hypertrophy' });
    await request(app).put('/api/programming/leg-training').send({ mode: 'cardio' }).expect(400);
  });

  it('leg muscles get no growth volume in athletic mode', () => {
    const legs = new Set(targetIdsForArea('legs'));
    const brief = buildProgrammerContext(db, { targetDate: '2026-10-23', requestedSessionPurpose: 'upper' }).programmingBrief;
    // Leg targets are left out of the plan input entirely (never eligible anywhere).
    expect(brief.muscles.filter((m) => legs.has(m.targetId) && m.eligibleForThisSession)).toEqual([]);
    expect(brief.session.expectedCoverageTargetIds.some((id) => legs.has(id))).toBe(false);
    new LegTrainingRepo(db).set('hypertrophy');
    const legsBrief = buildProgrammerContext(db, { targetDate: THURSDAY, requestedSessionPurpose: 'legs' }).programmingBrief;
    expect(legsBrief.muscles.some((m) => legs.has(m.targetId) && m.eligibleForThisSession)).toBe(true);
  });
});

describe('generating an Athletic day', () => {
  it("the rotation's Athletic day: drills with mode numbers and no RIR, plus leg strength lifts with reps and RIR, in block order", async () => {
    pastAthleticDays(BUILD_UP_SESSIONS);
    const provider = new FakeProvider();
    const result = await new AIProgrammerService(db, provider).generateSession({ targetDate: THURSDAY });
    expect(provider.requests[0]!.systemInstruction).toMatch(/strength and conditioning coach.*not badminton skill or footwork/);
    const p = result.proposal;
    expect(p.sessionKind).toBe('athletic');
    expect(p.exercises.map((e) => e.block)).toEqual(BLOCK_ORDER);
    for (const e of p.exercises.filter((x) => x.block !== 'strength')) {
      const rx = modePrescriptionFor(e.exerciseId)!;
      expect(e).toMatchObject({ targetType: 'functional_goal', rirMin: null, rirMax: null, repUnit: rx.unit });
      expect(BlueprintAdapter.getExercise(e.exerciseId)!.functional_goals).toContain(e.targetId);
    }
    expect(p.exercises.filter((x) => x.block === 'strength')).toEqual([
      expect.objectContaining({ exerciseId: 'bulgarian-split-squat-knee-dominant', targetType: 'physique_target', sets: 3, rirMin: 1, rirMax: 3, repUnit: 'reps' }),
      expect.objectContaining({ exerciseId: 'romanian-deadlift', targetType: 'physique_target', sets: 3, repUnit: 'reps' }),
    ]);
  });

  it('every leg-relevant lift is eligible for the strength block; drills and upper-body lifts are not', () => {
    const context = buildAthleticContext(db, THURSDAY);
    const ids = context.strengthLifts.map((l) => l.exerciseId);
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(ids).toEqual(expect.arrayContaining(['back-squat', 'romanian-deadlift', 'step-up', 'single-leg-calf-raise', 'copenhagen-plank', 'nordic-hamstring-curl', 'tibialis-raise', 'leg-extension']));
    expect(ids).not.toContain('flat-barbell-bench-press');
    expect(ids.some((id) => allDrills().some((d) => d.id === id))).toBe(false);
  });

  it('build-up phase (first Athletic days): low end of every range, lifts at RIR 2+', () => {
    const context = buildAthleticContext(db, THURSDAY);
    expect(context.session.buildUp).toBe(true);
    const heavy = athleticAnswer(context, (xs) => xs.map((x) => ({ ...x, sets: 9, amountMax: 999, ...(x.rirMin !== undefined ? { rirMin: 0, rirMax: 0 } : {}) })));
    const check = checkAthleticOutput(heavy, context);
    if (!check.ok) throw new Error(check.errors.join('; '));
    for (const e of check.proposal.exercises) {
      if (e.block === 'strength') {
        expect(e.sets).toBe(3);
        expect(e.rirMin).toBeGreaterThanOrEqual(2);
      } else {
        const rx = modePrescriptionFor(e.exerciseId)!;
        expect(e.sets).toBe(rx.sets[0]);
        expect(e.repsMax).toBeLessThanOrEqual(rx.amount[0] + Math.ceil((rx.amount[1] - rx.amount[0]) / 2));
      }
    }
    pastAthleticDays(BUILD_UP_SESSIONS);
    expect(buildAthleticContext(db, THURSDAY).session.buildUp).toBe(false);
  });

  it('can be requested for any date', async () => {
    const result = await new AIProgrammerService(db, new FakeProvider()).generateSession({ targetDate: '2026-10-20', requestedSessionPurpose: 'athletic' });
    expect(result.proposal.sessionKind).toBe('athletic');
  });

  it('numbers outside a range are clamped and the order is fixed; a bad answer fails', async () => {
    pastAthleticDays(BUILD_UP_SESSIONS);
    const reversed = new FakeProvider((xs) => [...xs].reverse().map((x) => ({ ...x, sets: 50, amountMax: 999, restSeconds: 1 })));
    const p = (await new AIProgrammerService(db, reversed).generateSession({ targetDate: THURSDAY })).proposal;
    expect(p.exercises.map((e) => e.block)).toEqual(BLOCK_ORDER);
    for (const e of p.exercises.filter((x) => x.block !== 'strength')) {
      const rx = modePrescriptionFor(e.exerciseId)!;
      expect(e.sets).toBe(rx.sets[1]);
      expect(e.repsMax).toBe(rx.acceptableAmount[1]);
      expect(e.restSeconds).toBe(rx.restSeconds[0]);
    }
    expect(p.exercises.filter((x) => x.block === 'strength').map((e) => [e.sets, e.restSeconds])).toEqual([[4, 60], [4, 60]]);
    expect(p.warnings.join(' ')).toMatch(/reordered/);

    const context = buildAthleticContext(db, '2026-10-23');
    const noConditioning = athleticAnswer(context, (xs) => xs.filter((x) => context.drills.find((d) => d.exerciseId === x.exerciseId)?.block !== 'conditioning'));
    expect(checkAthleticOutput(noConditioning, context)).toMatchObject({ ok: false, stage: 'domain' });
    const benchSnuckIn = athleticAnswer(context, (xs) => [...xs, { ...xs[4], exerciseId: 'flat-barbell-bench-press' }]);
    expect(checkAthleticOutput(benchSnuckIn, context)).toMatchObject({ ok: false, errors: [expect.stringMatching(/not an athletic drill or leg strength lift/)] });
    const noStrength = athleticAnswer(context, (xs) => xs.filter((x) => x.rirMin === undefined));
    expect(checkAthleticOutput(noStrength, context)).toMatchObject({ ok: false, errors: [expect.stringMatching(/strength: 0/)] });
  });

  it('while the Legs injury pause is on, the Athletic day is a rest day', async () => {
    new InjuryPausesRepo(db).pause('legs', '2026-10-10', 'knee rehab');
    const provider = new FakeProvider();
    await expect(new AIProgrammerService(db, provider).generateSession({ targetDate: THURSDAY })).rejects.toMatchObject({ code: 'AI_ATHLETIC_PAUSED', statusCode: 409 });
    expect(provider.requests).toHaveLength(0);

    process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
    process.env.AI_WEEK_GENERATION_MODE = 'explicit';
    const state = readWeekGenerationState(db, MONDAY, false);
    expect(state.perDay.find((d) => d.date === THURSDAY)).toMatchObject({ purpose: 'athletic', status: 'injury_pause' });
  });

  it('a week run generates the Athletic day with the Athletic contract', async () => {
    process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
    process.env.AI_WEEK_GENERATION_MODE = 'explicit';
    const provider = new FakeProvider();
    const started = startWeekGeneration(db, new AIProgrammerService(db, provider), MONDAY);
    if (started.kind !== 'started') throw new Error('run did not start');
    const run = await started.done;
    expect(run.days.find((d) => d.date === THURSDAY)).toMatchObject({ outcome: 'proposal_pending' });
  });

  it('commit writes the drills with their units and no RIR; refused once the Legs pause is on', async () => {
    const service = new AIProgrammerService(db, new FakeProvider());
    const { proposalId, proposal } = await service.generateSession({ targetDate: THURSDAY });
    approveProposal(db, proposalId);
    const { sessionId } = commitAIProposalToPlannedSession(db, proposalId, { intent: 'fill_existing_gym_day' });
    const perfs = new WorkoutSessionsRepo(db).getExercisePerformances(sessionId);
    expect(perfs.map((p) => p.exercise_id)).toEqual(proposal.exercises.map((e) => e.exerciseId));
    for (const p of perfs) {
      const rx = modePrescriptionFor(p.exercise_id);
      if (rx) {
        expect(p.rep_unit).toBe(rx.unit);
        expect([p.target_rir_min, p.target_rir_max]).toEqual([null, null]);
      } else {
        expect(p.rep_unit).toBe('reps');
        expect(p.target_rir_min).toBeGreaterThanOrEqual(1);
      }
    }

    const second = await service.generateSession({ targetDate: '2026-10-23', requestedSessionPurpose: 'athletic' });
    approveProposal(db, second.proposalId);
    new InjuryPausesRepo(db).pause('legs', MONDAY, null);
    expect(() => commitAIProposalToPlannedSession(db, second.proposalId, { intent: 'fill_existing_gym_day' })).toThrow(expect.objectContaining({ code: 'AI_ATHLETIC_PAUSED' }));
  });
});

describe("the owner's gym and aims (2026-10-18)", () => {
  const ids = (c: AthleticContext) => c.drills.map((d) => d.exerciseId);

  it('drills needing equipment the user lacks are left out; drop landings use a bench, box jumps do not', () => {
    const c = buildAthleticContext(db, THURSDAY); // profile: bench, no jump rope / plyo box / rowing machine
    expect(ids(c)).not.toEqual(expect.arrayContaining(['jump-rope']));
    expect(ids(c)).not.toContain('rowing-machine-intervals');
    expect(ids(c)).not.toContain('box-jump');
    expect(c.drills.find((d) => d.exerciseId === 'drop-landing')).toMatchObject({ setupNote: expect.stringMatching(/bench.*never jump onto it/) });
    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    new TrainingProfileRepo(db).upsert(user.id, { ...profile, available_equipment: [...profile.available_equipment, 'jump rope'] });
    expect(ids(buildAthleticContext(db, THURSDAY))).toContain('jump-rope');
  });

  it('avoided drills (shadowing) never appear, on the Athletic day or in add-ons', async () => {
    const app = createApp(db);
    for (const id of ['shadow-badminton-intervals', 'four-corner-shadow-footwork']) {
      await request(app).put(`/api/programming/preferences/${id}`).send({ preference: 'avoided', reason: 'no court; never learned shadowing' }).expect(200);
    }
    expect(ids(buildAthleticContext(db, THURSDAY))).not.toEqual(expect.arrayContaining(['shadow-badminton-intervals']));
    expect(ids(buildAthleticContext(db, THURSDAY))).not.toContain('four-corner-shadow-footwork');
    for (const date of [MONDAY, '2026-10-20', '2026-10-23']) {
      expect(planAthleticAddOn(db, date, 'push')!.exercises.map((e) => e.exerciseId)).not.toContain('shadow-badminton-intervals');
    }
  });

  it('durability first: the context states the aims and orders the goals; the active add-on is ankle/landing work', () => {
    const c = buildAthleticContext(db, THURSDAY);
    expect(c.athlete).toMatch(/injury-free.*flexible.*fatigue resistance/);
    expect(c.goals.map((g) => g.goalId).slice(0, 2)).toEqual(['ankle-resilience', 'landing-control']);
    const tue = planAthleticAddOn(db, '2026-10-20', 'pull')!;
    expect(tue.kind).toBe('active');
    expect(BlueprintAdapter.getExercise(tue.exercises[0]!.exerciseId)!.functional_goals).toEqual(expect.arrayContaining([expect.stringMatching(/ankle-resilience|landing-control/)]));
  });
});

describe('athletic add-on on Push / Pull / Upper days', () => {
  it('mobility next to a hard day (badminton, the Athletic day), short active work otherwise', () => {
    // Mon: badminton on Sunday -> mobility. Tue: Mon and Wed are easy -> active. Fri: Thu is the Athletic day -> mobility.
    const mon = planAthleticAddOn(db, MONDAY, 'push')!;
    const tue = planAthleticAddOn(db, '2026-10-20', 'pull')!;
    const fri = planAthleticAddOn(db, '2026-10-23', 'upper')!;
    expect([mon.kind, tue.kind, fri.kind]).toEqual(['mobility', 'active', 'mobility']);
    expect(mon.reason).toMatch(/badminton yesterday/);
    expect(fri.reason).toMatch(/Athletic day yesterday.*badminton tomorrow/);
    expect(mon.exercises.map((e) => modePrescriptionFor(e.exerciseId)!.mode)).toEqual(['mobility-dynamic', 'mobility-hold']);
    expect(tue.exercises.map((e) => modePrescriptionFor(e.exerciseId)!.mode)).toEqual([expect.stringMatching(/agility|power/), 'conditioning']);
    for (const a of [mon, tue, fri]) {
      expect(a.minutes).toBeGreaterThanOrEqual(1);
      expect(a.minutes).toBeLessThanOrEqual(10);
      expect(a.exercises.every((e) => e.block === 'addon' && e.rirMin === null)).toBe(true);
    }
  });

  it('never two active days in a row', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    const profile = new TrainingProfileRepo(db).get(user.id)!;
    new TrainingProfileRepo(db).upsert(user.id, { ...profile, training_days: ['tuesday', 'wednesday', 'friday'] as any, other_activity_schedule: [] });
    const repo = new WorkoutSessionsRepo(db);
    const tue = planAthleticAddOn(db, '2026-10-20', 'push')!;
    expect(tue.kind).toBe('active');
    const s = repo.createSession({ date: '2026-10-20', session_type: 'gym', status: 'planned' });
    tue.exercises.forEach((e, i) => repo.addExercisePerformance(s.session_id, { exercise_id: e.exerciseId, order: i, role: 'accessory', sets: [] }));
    expect(planAthleticAddOn(db, '2026-10-21', 'pull')!).toMatchObject({ kind: 'mobility', reason: expect.stringMatching(/drills yesterday/) });
  });

  it('none on the Athletic day, with leg training on Size, or during the Legs pause', () => {
    expect(planAthleticAddOn(db, THURSDAY, 'athletic')).toBeNull();
    new InjuryPausesRepo(db).pause('legs', MONDAY, null);
    expect(planAthleticAddOn(db, '2026-10-20', 'pull')).toBeNull();
    new InjuryPausesRepo(db).resume('legs');
    new LegTrainingRepo(db).set('hypertrophy');
    expect(planAthleticAddOn(db, '2026-10-20', 'pull')).toBeNull();
  });

  it('a Push proposal carries the add-on and commit writes it after the session', async () => {
    process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
    const service = new AIProgrammerService(db, new FakeProvider());
    const { proposalId, proposal } = await service.generateSession({ targetDate: '2026-10-20', requestedSessionPurpose: 'push' });
    expect(proposal.athleticAddOn).toMatchObject({ kind: 'active' });
    approveProposal(db, proposalId);
    const { sessionId } = commitAIProposalToPlannedSession(db, proposalId, { intent: 'fill_existing_gym_day' });
    const perfs = new WorkoutSessionsRepo(db).getExercisePerformances(sessionId);
    const addOnIds = proposal.athleticAddOn!.exercises.map((e) => e.exerciseId);
    expect(perfs.slice(-addOnIds.length).map((p) => p.exercise_id)).toEqual(addOnIds);
    expect(perfs.slice(0, -addOnIds.length).map((p) => p.exercise_id)).toEqual(proposal.exercises.map((e) => e.exerciseId));
    expect(perfs.slice(-addOnIds.length).map((p) => p.rep_unit)).toEqual(addOnIds.map((id) => modePrescriptionFor(id)!.unit));
  });
});

describe('logging and Insights', () => {
  function logDrill(date: string, exerciseId: string, counts: number[]) {
    const repo = new WorkoutSessionsRepo(db);
    const s = repo.listSessionsByDate(date)[0] ?? repo.createSession({ date, session_type: 'gym', status: 'completed' });
    return repo.addExercisePerformance(s.session_id, { exercise_id: exerciseId, order: 0, role: 'primary', sets: counts.map((reps, i) => ({ set_number: i + 1, weight: null, reps, completed: true })) });
  }

  it('a drill logged by hand starts in its Blueprint unit', () => {
    expect(logDrill('2026-10-12', 'deep-squat-hold', [30]).rep_unit).toBe('seconds');
    expect(logDrill('2026-10-12', 'pogo-hops', [6]).rep_unit).toBe('reps');
  });

  it('drills stay out of strength progress and show under athletic work', () => {
    logDrill('2026-10-05', 'lateral-shuffle', [10, 10, 10]);
    logDrill('2026-10-12', 'lateral-shuffle', [12, 12, 15]);
    expect(strengthProgress(db, '2026-10-19').some((x) => x.exerciseId === 'lateral-shuffle')).toBe(false);
    const work = athleticWork(db, '2026-10-19', 3);
    expect(work.weeks.map((w) => w.sessions)).toEqual([1, 1, 0]);
    expect(work.drills).toEqual([expect.objectContaining({ exerciseId: 'lateral-shuffle', sessions: 2, lastDate: '2026-10-12', best: '15 s', last: '12 s, 12 s, 15 s' })]);
  });

  it('the coach review knows legs are trained athletically', () => {
    logDrill('2026-10-12', 'burpee', [30, 30]);
    const facts = buildCoachFacts(db, '2026-10-19', () => ({ required: new Map<string, number>(), goalLabel: new Map<string, string | null>() }));
    expect(facts.legTraining).toBe('athletic');
    expect(facts.athletic.drills[0]).toMatchObject({ drill: 'Burpee', sessions: 1 });
    expect(buildCoachInstruction()).toMatch(/legTraining is "athletic"/);
  });

  it('the exercise list carries drill prescriptions; the logger shows them and hides RIR', async () => {
    const list = (await request(createApp(db)).get('/api/blueprint/exercises').expect(200)).body;
    expect(list.find((e: any) => e.id === 'couch-stretch')).toMatchObject({ training_mode: 'mobility-hold', drill: { unit: 'seconds' } });
    expect(list.find((e: any) => e.id === 'flat-barbell-bench-press').drill).toBeUndefined();
    const html = readFileSync(new URL('../../public/logger.html', import.meta.url), 'utf8');
    expect(html).toMatch(/noRir: !!drill/);
    expect(html).toMatch(/if \(state\.noRir\) row\.append\(weight, reps, done, remove\)/);
    expect(ATHLETIC_BLOCKS).toEqual(['warmup', 'quality', 'strength', 'conditioning', 'cooldown']);
  });

  it('pages load with app.js (no clashing top-level names)', () => {
    const read = (f: string) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
    for (const page of ['program.html', 'logger.html', 'coaching-insights.html']) {
      const inline = read(page).match(/<script>([\s\S]*?)<\/script>/)![1]!;
      expect(() => new Function(`${read('app.js')}\n${inline}`), page).not.toThrow();
    }
  });
});
