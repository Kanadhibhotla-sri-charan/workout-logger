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
import { ATHLETIC_BLOCKS, buildAthleticContext, checkAthleticOutput, type AthleticContext } from '../../src/athletic/athleticSession.js';
import { athleticWork, strengthProgress } from '../../src/insights/insightsService.js';
import { buildCoachFacts, buildCoachInstruction } from '../../src/coaching/review/coachReviewService.js';

const MONDAY = '2026-10-19';
const THURSDAY = '2026-10-22';
let db: Database.Database;

/** Picks drills per block at the low end of each range. `tweak` lets a test bend the answer. */
function athleticAnswer(context: AthleticContext, tweak: (exercises: any[]) => any[] = (x) => x) {
  const pick = (block: string, n: number) => context.drills.filter((d) => d.block === block).slice(0, n);
  const chosen = [...pick('warmup', 2), ...pick('quality', 2), ...pick('conditioning', 1), ...pick('cooldown', 1)];
  return {
    sessionFocus: ['footwork', 'conditioning'],
    exercises: tweak(chosen.map((d) => ({ exerciseId: d.exerciseId, targetId: d.goals[0], sets: d.sets.min, amountMin: d.amount.min, amountMax: d.amount.max, restSeconds: d.restSeconds.min, rationale: d.mode }))),
    warnings: [],
  };
}

class FakeProvider implements AIProgrammerProvider {
  requests: AIProgrammerProviderRequest[] = [];
  constructor(private tweak?: (exercises: any[]) => any[]) {}
  async generate(req: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    this.requests.push(req);
    const ctx = req.context as any;
    const body = ctx.schemaVersion === 'athletic-session-context.v1' ? athleticAnswer(ctx, this.tweak) : { nonsense: true };
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
  it("the rotation's Athletic day gets a drills-only proposal in block order, with mode numbers and no RIR", async () => {
    const provider = new FakeProvider();
    const result = await new AIProgrammerService(db, provider).generateSession({ targetDate: THURSDAY });
    expect(provider.requests[0]!.systemInstruction).toMatch(/athletic coach/);
    const p = result.proposal;
    expect(p.sessionKind).toBe('athletic');
    expect(p.exercises.map((e) => e.block)).toEqual(['warmup', 'warmup', 'quality', 'quality', 'conditioning', 'cooldown']);
    for (const e of p.exercises) {
      const rx = modePrescriptionFor(e.exerciseId)!;
      expect(e).toMatchObject({ targetType: 'functional_goal', rirMin: null, rirMax: null, repUnit: rx.unit });
      expect(BlueprintAdapter.getExercise(e.exerciseId)!.functional_goals).toContain(e.targetId);
    }
  });

  it('can be requested for any date', async () => {
    const result = await new AIProgrammerService(db, new FakeProvider()).generateSession({ targetDate: '2026-10-20', requestedSessionPurpose: 'athletic' });
    expect(result.proposal.sessionKind).toBe('athletic');
  });

  it('numbers outside a drill range are clamped and the order is fixed; a bad answer fails', async () => {
    const reversed = new FakeProvider((xs) => [...xs].reverse().map((x) => ({ ...x, sets: 50, amountMax: 999, restSeconds: 1 })));
    const p = (await new AIProgrammerService(db, reversed).generateSession({ targetDate: THURSDAY })).proposal;
    expect(p.exercises.map((e) => e.block)).toEqual(['warmup', 'warmup', 'quality', 'quality', 'conditioning', 'cooldown']);
    for (const e of p.exercises) {
      const rx = modePrescriptionFor(e.exerciseId)!;
      expect(e.sets).toBe(rx.sets[1]);
      expect(e.repsMax).toBe(rx.acceptableAmount[1]);
      expect(e.restSeconds).toBe(rx.restSeconds[0]);
    }
    expect(p.warnings.join(' ')).toMatch(/reordered/);

    const context = buildAthleticContext(db, '2026-10-23');
    const noConditioning = athleticAnswer(context, (xs) => xs.filter((x) => context.drills.find((d) => d.exerciseId === x.exerciseId)!.block !== 'conditioning'));
    expect(checkAthleticOutput(noConditioning, context)).toMatchObject({ ok: false, stage: 'domain' });
    const benchSnuckIn = athleticAnswer(context, (xs) => [...xs, { ...xs[0], exerciseId: 'flat-barbell-bench-press' }]);
    expect(checkAthleticOutput(benchSnuckIn, context)).toMatchObject({ ok: false, errors: [expect.stringMatching(/not an athletic drill/)] });
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
      expect(p.rep_unit).toBe(modePrescriptionFor(p.exercise_id)!.unit);
      expect([p.target_rir_min, p.target_rir_max]).toEqual([null, null]);
    }

    const second = await service.generateSession({ targetDate: '2026-10-23', requestedSessionPurpose: 'athletic' });
    approveProposal(db, second.proposalId);
    new InjuryPausesRepo(db).pause('legs', MONDAY, null);
    expect(() => commitAIProposalToPlannedSession(db, second.proposalId, { intent: 'fill_existing_gym_day' })).toThrow(expect.objectContaining({ code: 'AI_ATHLETIC_PAUSED' }));
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
    expect(ATHLETIC_BLOCKS).toEqual(['warmup', 'quality', 'conditioning', 'cooldown']);
  });

  it('pages load with app.js (no clashing top-level names)', () => {
    const read = (f: string) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
    for (const page of ['program.html', 'logger.html', 'coaching-insights.html']) {
      const inline = read(page).match(/<script>([\s\S]*?)<\/script>/)![1]!;
      expect(() => new Function(`${read('app.js')}\n${inline}`), page).not.toThrow();
    }
  });
});
