// Exercise-variety work (2026-10-09): the wide exercise pool, the rotation
// shortlist and the recent-usage signal — real context builder, real
// planner, in-memory database, fixed clock, fake provider, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerContext, AIProgrammerTargetContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import { classifyTrainingDates, EXERCISE_SHORTLIST_CAP } from '../../src/ai-programmer/context/exercisePool.js';
import { planSession, type SessionPlan } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { conformProposalToPlan } from '../../src/ai-programmer/planning/planConformance.js';
import { buildPlannedAIContext, buildPlannedProgrammerSystemInstruction, usesRotationShortlist } from '../../src/ai-programmer/planning/plannedContext.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { lookupExercisePrescriptionAnyLevel } from '../../src/blueprint/developmentPackages.js';
import { defaultPrescriptionFor } from '../../src/blueprint/programmingProfiles.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import type { TargetBuildContext } from '../../src/engine/workoutBuilder.js';

// Friday 2026-10-09, 07:00 IST. History mirrors the real Oct 1-8 push/pull weeks.
const NOW = new Date('2026-10-09T01:30:00Z');
const TARGET = '2026-10-09';
const PUSH = ['cable-pushdown', 'cable-overhead-extension-leaning-forward', 'close-grip-bench-press', 'flat-barbell-bench-press', 'incline-barbell-press', 'cable-fly', 'dumbbell-lateral-raise', 'cable-crunch'];
const PULL = ['cross-body-hammer-curl', 'barbell-ez-bar-curl', 'lat-pulldown-wide-pronated', 'straight-arm-pulldown', 'face-pull', 'rear-delt-row', 'chest-supported-row', 'reverse-curl', 'wrist-curl'];
const HISTORY: Array<[string, string[]]> = [
  ['2026-10-01', PUSH],
  ['2026-10-02', PULL],
  ['2026-10-05', PUSH],
  ['2026-10-06', PULL],
  ['2026-10-08', PUSH],
];

let db: Database.Database;

function seed(): Database.Database {
  const d = openDb(':memory:');
  const user = new UsersRepo(d).getOrCreateDefault();
  new TrainingProfileRepo(d).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'],
    other_activity_schedule: [],
  });
  new GoalsRepo(d).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });
  const sessions = new WorkoutSessionsRepo(d);
  for (const [date, exercises] of HISTORY) {
    const s = sessions.createSession({ date, session_type: 'gym', status: 'completed' });
    exercises.forEach((exercise_id, i) =>
      sessions.addExercisePerformance(s.session_id, {
        exercise_id,
        order: i + 1,
        role: 'primary',
        sets: [1, 2].map((n) => ({ set_number: n, weight: 20, reps: 10, completed: true })),
      })
    );
  }
  return d;
}

const prescribed = (t: AIProgrammerTargetContext) => t.validExercises.filter((v) => v.authoredPrescription !== null).map((v) => v.exerciseId);
const target = (c: AIProgrammerContext, id: string) => c.targets.find((t) => t.targetId === id)!;
const wide = (extra: Record<string, unknown> = {}) => buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull', exercisePoolMode: 'wide', ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = seed();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.AI_PROGRAMMER_ENABLED;
  delete process.env.AI_PLANNED_GENERATION_ENABLED;
  delete process.env.AI_EXERCISE_POOL_MODE;
});

describe('package mode (default)', () => {
  it('is the default and leaves the context exactly as before', () => {
    const implicit = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull' });
    const explicit = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull', exercisePoolMode: 'package' });
    expect(implicit.contextHash).toBe(explicit.contextHash);
    const json = JSON.stringify(implicit.targets);
    expect(json).not.toMatch(/prescriptionSource|recentSameTypeUsage/);
    expect(json).toMatch(/recentConsecutiveSessionsUsed/);
  });

  it('stays package when AI_EXERCISE_POOL_MODE=wide but planned generation is off', () => {
    process.env.AI_EXERCISE_POOL_MODE = 'wide';
    const c = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull' });
    expect(JSON.stringify(c.targets)).not.toMatch(/recentSameTypeUsage/);
  });
});

describe('wide pool', () => {
  it('prescribes every physique exercise from the Blueprint profile default, never from a package', () => {
    const full = wide({ applyRotationShortlist: false });
    for (const t of full.targets.filter((x) => x.targetType === 'physique_target')) {
      for (const v of t.validExercises.filter((x) => x.authoredPrescription)) {
        expect(v.prescriptionSource, `${t.targetId}/${v.exerciseId}`).toBe('profile_default');
        expect(v.role).toBe('primary');
        const d = defaultPrescriptionFor(v.exerciseId)!;
        expect(v.authoredPrescription!.sets).toBe(d.sets);
        expect([v.authoredPrescription!.rirMin, v.authoredPrescription!.rirMax]).toEqual([d.rir.min, d.rir.max]);
      }
    }
    expect(target(full, 'biceps').validExercises.find((v) => v.exerciseId === 'preacher-curl')!.authoredPrescription).not.toBeNull();
  });

  it('package mode still prescribes exactly the package exercises', () => {
    const pkg = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull', exercisePoolMode: 'package' });
    for (const t of pkg.targets) {
      for (const v of t.validExercises) expect(v.authoredPrescription !== null, `${t.targetId}/${v.exerciseId}`).toBe(lookupExercisePrescriptionAnyLevel(t.targetId, v.exerciseId) !== null);
    }
  });

  it('caps each physique target at the shortlist size (anchors included)', () => {
    const c = wide();
    for (const t of c.targets.filter((x) => x.targetType === 'physique_target')) expect(prescribed(t).length).toBeLessThanOrEqual(EXERCISE_SHORTLIST_CAP);
  });

  it('keeps the compound the target was last trained with as its anchor, even after two straight uses', () => {
    const c = wide();
    expect(prescribed(target(c, 'lat-width'))[0]).toBe('lat-pulldown-wide-pronated');
    expect(prescribed(target(c, 'back-thickness'))[0]).toBe('chest-supported-row');
  });

  it('has no anchor for a target never trained with a compound: everything rotates', () => {
    const t = target(wide(), 'biceps');
    const usage = prescribed(t).map((id) => t.validExercises.find((v) => v.exerciseId === id)!.recentSameTypeUsage!.sessionsUsed);
    expect(usage).toEqual([...usage].sort((a, b) => a - b)); // pure rotation order, nothing pinned first
    expect(usage[0]).toBe(0);
  });

  it('rests an accessory used in both of the last two pull sessions when an alternative exists', () => {
    const c = wide();
    expect(prescribed(target(c, 'biceps'))).not.toContain('barbell-ez-bar-curl');
    expect(prescribed(target(c, 'rear-delt'))).not.toContain('face-pull');
    // forearm-flexors has no alternative: wrist curl stays.
    expect(prescribed(target(c, 'forearm-flexors'))).toEqual(['wrist-curl']);
  });

  it('replaces the consecutive-run signal with usage across the last two comparable sessions', () => {
    const c = wide();
    const ez = target(c, 'biceps').validExercises.find((v) => v.exerciseId === 'barbell-ez-bar-curl')!;
    expect(ez.recentSameTypeUsage).toEqual({ sessionsUsed: 2, sessionsConsidered: 2, lastUsedDate: '2026-10-06' });
    expect(ez).not.toHaveProperty('recentConsecutiveSessionsUsed');
    const preacher = target(c, 'biceps').validExercises.find((v) => v.exerciseId === 'preacher-curl')!;
    expect(preacher.recentSameTypeUsage).toEqual({ sessionsUsed: 0, sessionsConsidered: 2, lastUsedDate: null });
  });

  it('never makes a target less feasible than its full pool', () => {
    const full = wide({ applyRotationShortlist: false });
    const short = wide();
    for (const m of full.programmingBrief.muscles) {
      if (!m.feasibility?.isFeasible) continue;
      expect(short.programmingBrief.muscles.find((x) => x.targetId === m.targetId)!.feasibility!.isFeasible, m.targetId).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(wide().contextHash).toBe(wide().contextHash);
  });

  it('plans within the planner search limits, with no refusal', () => {
    for (const purpose of ['push', 'pull', 'upper'] as const) {
      const c = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: purpose, exercisePoolMode: 'wide' });
      const plan = planSession(c, { nonGoalRotationCursor: 0 });
      expect(plan.refusals, purpose).toEqual([]);
      expect(plan.notes.join('\n'), purpose).not.toMatch(/exceed the exact search|cannot be split/);
    }
  });

  it('gives the AI the usage signal and the rotation wording of rule 7', () => {
    const c = wide();
    const ai = buildPlannedAIContext(c, planSession(c, { nonGoalRotationCursor: 0 }));
    expect(usesRotationShortlist(ai)).toBe(true);
    const candidate = ai.sessionPlan.targets.flatMap((t) => t.candidates)[0]!;
    expect(candidate.recentSameTypeUsage).toBeDefined();
    expect(candidate).not.toHaveProperty('recentConsecutiveSessionsUsed');
    expect(buildPlannedProgrammerSystemInstruction(true)).toMatch(/rotation shortlist/);
    expect(buildPlannedProgrammerSystemInstruction(false)).toBe(buildPlannedProgrammerSystemInstruction());
  });
});

describe('plan conformance: candidate lists (wide pool)', () => {
  const entry = (targetId: string, exerciseId: string) => ({ exerciseId, role: 'primary', targetType: 'physique_target', targetId, sets: 2, repsMin: 10, repsMax: 16, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' }) as any;
  const proposal = (exercises: unknown[]) =>
    ({ schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'p', mode: 'generate_session', targetDate: TARGET, weekday: 'friday', sessionFocus: ['pull'], exercises, programmingRationale: [], goalAlignment: [], recoveryConsiderations: [], warnings: [] }) as any;
  const candidatesOf = (plan: SessionPlan, id: string) => plan.targets.find((t) => t.targetId === id)!.candidates.map((c) => c.exerciseId);

  it('removes a rested accessory the AI put back', () => {
    const c = wide();
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    expect(candidatesOf(plan, 'biceps')).not.toContain('barbell-ez-bar-curl');
    const kept = entry('biceps', candidatesOf(plan, 'biceps')[0]!);
    const out = conformProposalToPlan(proposal([kept, entry('biceps', 'barbell-ez-bar-curl')]), plan, c);
    expect(out.proposal.exercises.map((e) => e.exerciseId)).toEqual([kept.exerciseId]);
    expect(out.notes.join(' ')).toMatch(/removed barbell-ez-bar-curl from biceps — it is not one of biceps's candidates/);
  });

  it('removes a valid exercise for the target that was never on its list', () => {
    const c = wide();
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    const unlisted = target(c, 'lat-width').validExercises.find((v) => v.role === 'primary' && !candidatesOf(plan, 'lat-width').includes(v.exerciseId))!.exerciseId;
    const out = conformProposalToPlan(proposal([entry('lat-width', 'lat-pulldown-wide-pronated'), entry('lat-width', unlisted)]), plan, c);
    expect(out.proposal.exercises.map((e) => e.exerciseId)).toEqual(['lat-pulldown-wide-pronated']);
  });

  it('keeps an exercise listed for another planned target that Blueprint also credits to this one', () => {
    const c = wide();
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    // hammer-curl credits both biceps and brachialis (Blueprint sub-target scope).
    expect(candidatesOf(plan, 'brachialis-arm-thickness')).toContain('hammer-curl');
    const narrowed: SessionPlan = { ...plan, targets: plan.targets.map((t) => (t.targetId === 'biceps' ? { ...t, candidates: t.candidates.filter((x) => x.exerciseId !== 'hammer-curl') } : t)) };
    const out = conformProposalToPlan(proposal([entry('biceps', 'hammer-curl')]), narrowed, c);
    expect(out.proposal.exercises.map((e) => e.exerciseId)).toEqual(['hammer-curl']);
  });

  it('leaves package mode unchanged (no candidate-list removal)', () => {
    const c = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'pull', exercisePoolMode: 'package' });
    const plan = planSession(c, { nonGoalRotationCursor: 0 });
    const unlisted = target(c, 'biceps').validExercises.find((v) => v.role === 'primary' && !candidatesOf(plan, 'biceps').includes(v.exerciseId))!.exerciseId;
    const out = conformProposalToPlan(proposal([entry('biceps', unlisted)]), plan, c);
    expect(out.proposal.exercises.map((e) => e.exerciseId)).toEqual([unlisted]);
  });
});

describe('classifyTrainingDates', () => {
  const t = (id: string, dates: string[]) => ({ target_type: 'physique_target', target_id: id, recent_direct_exposure_dates: dates }) as unknown as TargetBuildContext;
  it('labels push, pull, upper and legs days and ignores the target date onward', () => {
    const types = classifyTrainingDates(
      [t('mid-pec', ['d1', 'd3']), t('triceps', ['d1', 'd3']), t('lat-width', ['d2', 'd3']), t('biceps', ['d2', 'd3']), t('quads', ['d4']), t('obliques', ['d5']), t('mid-pec', ['z9'])],
      'z'
    );
    expect(Object.fromEntries(types)).toEqual({ d1: 'push', d2: 'pull', d3: 'upper', d4: 'legs' });
  });
});

describe('generation end to end (fake provider)', () => {
  class FakeProvider implements AIProgrammerProvider {
    lastRequest: AIProgrammerProviderRequest | null = null;
    sent: string[] = [];
    async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
      this.lastRequest = request;
      // One exercise per planned group (its first target's first candidate):
      // a group the plan reserves two exercises for (obliques, 4-set floor)
      // falls short, so completion must add an exercise for it.
      const sp = (request.context as any).sessionPlan;
      const seen = new Set<string>();
      const exercises: unknown[] = [];
      const add = (t: any, c: any) => {
        if (seen.has(c.exerciseId)) return;
        seen.add(c.exerciseId);
        exercises.push({ exerciseId: c.exerciseId, role: 'primary', targetType: 'physique_target', targetId: t.targetId, sets: c.maxSets, repsMin: c.repsMin, repsMax: c.repsMax, rirMin: c.rirMin, rirMax: c.rirMax, rationale: ['x'], source: 'blueprint' });
      };
      for (const g of sp.exerciseGroups) {
        const first = sp.targets.find((t: any) => g.targetIds.includes(t.targetId));
        add(first, first.candidates[0]);
      }
      // ...plus an accessory the rotation rested, which must not survive.
      exercises.push({ exerciseId: 'barbell-ez-bar-curl', role: 'primary', targetType: 'physique_target', targetId: 'biceps', sets: 2, repsMin: 10, repsMax: 16, rirMin: 1, rirMax: 3, rationale: ['x'], source: 'blueprint' });
      this.sent = exercises.map((e: any) => e.exerciseId);
      const body = {
        schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'p', mode: 'generate_session', targetDate: TARGET, weekday: 'friday', sessionFocus: ['pull'],
        exercises, programmingRationale: ['x'], goalAlignment: [], recoveryConsiderations: [], warnings: [],
      };
      return { provider: 'fake', model: 'fake-model', requestId: 'req-x', rawText: JSON.stringify(body) };
    }
  }

  it('fills the session only from each target\'s shortlist', async () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
    process.env.AI_EXERCISE_POOL_MODE = 'wide';
    const shortlist = wide();
    const provider = new FakeProvider();
    const result = await new AIProgrammerService(db, provider).generateSession({ targetDate: TARGET, requestedSessionPurpose: 'pull' });
    const added = result.proposal.exercises.filter((e) => !provider.sent.includes(e.exerciseId));
    expect(added.length).toBeGreaterThan(0);
    expect(result.proposal.exercises.map((e) => e.exerciseId)).not.toContain('barbell-ez-bar-curl');
    for (const e of added) expect(prescribed(target(shortlist, e.targetId)), `${e.exerciseId} for ${e.targetId}`).toContain(e.exerciseId);
  });
});
