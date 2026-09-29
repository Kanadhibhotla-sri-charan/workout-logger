// Plan conformance + the one post-provider pipeline (Phase 3,
// 2026-09-29), over REAL programmer contexts (real Blueprint data, real
// context builder, real goals) and REAL saved AI outputs — no provider
// calls. The downstream validators are the unchanged production ones.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../../src/ai-programmer/contracts/programmerTypes.js';
import { planSession, type SessionPlan, type TargetPlan } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { conformProposalToPlan } from '../../src/ai-programmer/planning/planConformance.js';
import { runProposalPipeline, type PipelineOutcome } from '../../src/ai-programmer/service/proposalPipeline.js';
import { validateProposalAdequacy } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import { creditedTargetKeys, keyOf } from '../../src/ai-programmer/validation/sharedCredit.js';
import { MAX_DIAGNOSTIC_ISSUES, MAX_DIAGNOSTIC_ISSUE_CHARS } from '../../src/ai-programmer/validation/diagnosticsBounds.js';
import { weekdayOfDate } from '../../src/engine/workoutBuilder.js';

const PURPOSES = ['pull', 'push', 'upper', 'legs'] as const;
type Purpose = (typeof PURPOSES)[number];
// arm-side-thickness (brachialis) and triceps-back-depth (triceps) are the
// user's real production goals; the goal-category guard forbids creating
// both together, so each gets its own database.
const SCENARIOS = ['arm-side-thickness', 'triceps-back-depth'] as const;
type Scenario = (typeof SCENARIOS)[number];

function futureTuesday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 61);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dbWithGoal(blueprintRef: string): Database.Database {
  const db = openDb(':memory:');
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
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: blueprintRef, priority: 1 });
  return db;
}

interface Case { scenario: Scenario; purpose: Purpose; db: Database.Database; context: AIProgrammerContext; plan: SessionPlan }
const cases: Case[] = [];
const targetDate = futureTuesday();

beforeAll(() => {
  for (const scenario of SCENARIOS) {
    const db = dbWithGoal(scenario);
    for (const purpose of PURPOSES) {
      const context = buildProgrammerContext(db, { targetDate, requestedSessionPurpose: purpose });
      cases.push({ scenario, purpose, db, context, plan: planSession(context, { nonGoalRotationCursor: 0 }) });
    }
  }
});

const get = (scenario: Scenario, purpose: Purpose) => cases.find((c) => c.scenario === scenario && c.purpose === purpose)!;
const isPlanned = (t: TargetPlan) => (t.status === 'required' || t.status === 'selected') && t.reservedExerciseSlots > 0;
const planned = (plan: SessionPlan) => plan.targets.filter(isPlanned);
const byId = (plan: SessionPlan, id: string) => plan.targets.find((t) => t.targetId === id)!;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** A real saved AI output, re-dated onto this test's target date (its only date-dependent fields). */
function fixture(path: string): any {
  const raw = JSON.parse(readFileSync(join(FIXTURES, path), 'utf8'));
  return { ...raw, targetDate, weekday: weekdayOfDate(targetDate) };
}

function entry(t: TargetPlan, exerciseId: string, context: AIProgrammerContext, sets?: number): AIWorkoutExerciseProposal {
  const v = context.targets.find((x) => x.targetType === t.targetType && x.targetId === t.targetId)!.validExercises.find((x) => x.exerciseId === exerciseId)!;
  const a = v.authoredPrescription!;
  return {
    exerciseId,
    role: 'primary',
    targetType: t.targetType,
    targetId: t.targetId,
    sets: sets ?? Math.min(a.sets, t.candidates.find((c) => c.exerciseId === exerciseId)?.ceiling ?? a.sets),
    repsMin: a.repsMin,
    repsMax: a.repsMax,
    rirMin: a.rirMin,
    rirMax: a.rirMax,
    rationale: ['test'],
    source: 'blueprint',
  } as AIWorkoutExerciseProposal;
}

function proposal(exercises: AIWorkoutExerciseProposal[]): AIWorkoutSessionProposal {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'p-test',
    mode: 'generate_session',
    targetDate,
    weekday: weekdayOfDate(targetDate),
    sessionFocus: ['test'],
    exercises,
    programmingRationale: ['test'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
  } as AIWorkoutSessionProposal;
}

/** Every planned target's candidates, each exercise used once (first target wins) — more than any session can hold. */
function everything(c: Case): AIWorkoutExerciseProposal[] {
  const used = new Set<string>();
  const out: AIWorkoutExerciseProposal[] = [];
  for (const t of planned(c.plan)) {
    for (const cand of t.candidates) {
      if (used.has(cand.exerciseId)) continue;
      used.add(cand.exerciseId);
      out.push(entry(t, cand.exerciseId, c.context));
    }
  }
  return out;
}

/** The required post-conformance invariants. */
function expectConformant(c: Case, before: AIWorkoutSessionProposal, after: AIWorkoutSessionProposal, removedTargetIds: string[]) {
  const planByKey = new Map(c.plan.targets.map((t) => [t.key, t]));
  for (const e of after.exercises) {
    const t = planByKey.get(keyOf(e.targetType, e.targetId));
    if (!t) continue; // unknown targets are left for domain validation
    expect(isPlanned(t), `${e.targetId} remains only if planned`).toBe(true);
    expect(creditedTargetKeys(e, c.context.targets), `${e.exerciseId} credits its label ${e.targetId}`).toContain(t.key);
  }
  for (const t of c.plan.targets.filter((t) => t.status === 'required')) {
    if (before.exercises.some((e) => e.targetId === t.targetId)) expect(after.exercises.some((e) => e.targetId === t.targetId), `goal ${t.targetId} kept`).toBe(true);
  }
  for (const id of removedTargetIds) expect(after.exercises.some((e) => e.targetId === id), `${id} removed whole`).toBe(false);
  const beforeIds = new Set(before.exercises.map((e) => `${e.targetId}|${e.exerciseId}`));
  for (const e of after.exercises) expect(beforeIds.has(`${e.targetId}|${e.exerciseId}`), 'nothing invented').toBe(true);
  for (const e of after.exercises) {
    const original = before.exercises.find((x) => x.targetId === e.targetId && x.exerciseId === e.exerciseId)!;
    expect(e.sets, 'no volume added').toBeLessThanOrEqual(original.sets);
  }
}

describe('plan conformance — rules', () => {
  it('rule 1: an infeasible target (Pull upper-traps) is removed whole, with a note', () => {
    const c = get('arm-side-thickness', 'pull');
    const traps = byId(c.plan, 'upper-traps');
    expect(traps.status).toBe('infeasible');
    const brachialis = byId(c.plan, 'brachialis-arm-thickness');
    const input = proposal([entry(brachialis, brachialis.candidates[0]!.exerciseId, c.context), entry(traps, 'barbell-dumbbell-shrug', c.context, 4)]);
    const out = conformProposalToPlan(input, c.plan, c.context);
    expect(out.proposal.exercises.map((e) => e.targetId)).toEqual(['brachialis-arm-thickness']);
    expect(out.removedTargetIds).toEqual(['upper-traps']);
    expect(out.notes.join('\n')).toMatch(/removed upper-traps .*infeasible/);
    expect(out.proposal.warnings).toEqual(out.notes);
  });

  it('rule 1: a deferred target is removed whole — never swapped in for a planned one', () => {
    for (const c of cases) {
      const deferred = c.plan.targets.find((t) => t.status === 'deferred' && t.candidates.length > 0);
      if (!deferred) continue;
      const input = proposal(deferred.candidates.slice(0, 2).map((x) => entry(deferred, x.exerciseId, c.context)));
      const out = conformProposalToPlan(input, c.plan, c.context);
      expect(out.proposal.exercises, `${c.purpose}:${deferred.targetId}`).toHaveLength(0);
      expect(out.removedTargetIds).toEqual([deferred.targetId]);
    }
  });

  // Blueprint credits the seated raise to soleus only and the standing raise to gastrocnemius only.
  const WRONG_CALF_RAISE: Record<string, string> = { soleus: 'standing-calf-raise', gastrocnemius: 'seated-calf-raise' };
  const plannedCalf = (c: Case) => planned(c.plan).find((t) => t.targetId in WRONG_CALF_RAISE)!;

  it('rule 2: an entry whose exercise does not credit its label is removed (Legs: the other calf\'s raise under the planned calf)', () => {
    const c = get('arm-side-thickness', 'legs');
    const calf = plannedCalf(c);
    const wrong = WRONG_CALF_RAISE[calf.targetId]!;
    const e = { ...entry(calf, calf.candidates[0]!.exerciseId, c.context), exerciseId: wrong };
    expect(creditedTargetKeys(e, c.context.targets)).not.toContain(calf.key);
    const out = conformProposalToPlan(proposal([e]), c.plan, c.context);
    expect(out.proposal.exercises).toHaveLength(0);
    expect(out.notes[0]).toContain(`removed ${wrong} from ${calf.targetId} — it does not earn credit for ${calf.targetId}`);
  });

  it('rule 3: over capacity drops whole OPTIONAL targets lowest plan priority first; required goals always stay', () => {
    let exercised = 0;
    for (const c of cases) {
      const input = proposal(everything(c));
      const out = conformProposalToPlan(input, c.plan, c.context);
      expectConformant(c, input, out.proposal, out.removedTargetIds);
      const dropped = out.removedTargetIds.map((id) => byId(c.plan, id));
      for (const t of dropped) expect(t.status, `${c.purpose}: ${t.targetId} dropped`).toBe('selected');
      const keptRanks = planned(c.plan).filter((t) => t.status === 'selected' && out.proposal.exercises.some((e) => e.targetId === t.targetId)).map((t) => t.rank!);
      for (const t of dropped) for (const r of keptRanks) expect(t.rank!, `${c.purpose}: dropped ${t.targetId} ranks below every kept optional`).toBeGreaterThan(r);
      if (dropped.length > 0) exercised++;
    }
    expect(exercised).toBeGreaterThan(0);
  });

  it('a target unknown to the plan is left untouched, so domain validation still rejects it', () => {
    const c = get('arm-side-thickness', 'pull');
    const brachialis = byId(c.plan, 'brachialis-arm-thickness');
    const invented = { ...entry(brachialis, brachialis.candidates[0]!.exerciseId, c.context), targetId: 'invented-target' };
    const out = conformProposalToPlan(proposal([invented]), c.plan, c.context);
    expect(out.proposal.exercises).toEqual([invented]);
  });

  it('a conformant proposal is returned unchanged (same object, no notes)', () => {
    const c = get('arm-side-thickness', 'pull');
    const input = proposal(planned(c.plan).slice(0, 2).map((t) => entry(t, t.candidates[0]!.exerciseId, c.context)));
    const out = conformProposalToPlan(input, c.plan, c.context);
    expect(out.proposal).toBe(input);
    expect(out.notes).toEqual([]);
  });

  it('is deterministic, never mutates its input, and its notes are bounded', () => {
    for (const c of cases) {
      const deferredAndInfeasible = c.plan.targets.filter((t) => !isPlanned(t) && t.candidates.length > 0);
      const input = proposal([...everything(c), ...deferredAndInfeasible.flatMap((t) => t.candidates.slice(0, 1).map((x) => entry(t, x.exerciseId, c.context)))]);
      const snapshot = JSON.stringify(input);
      const a = conformProposalToPlan(input, c.plan, c.context);
      const b = conformProposalToPlan(JSON.parse(snapshot), c.plan, c.context);
      expect(JSON.stringify(input)).toBe(snapshot);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.notes.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUES);
      for (const n of a.notes) expect(n.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ISSUE_CHARS);
      expectConformant(c, input, a.proposal, a.removedTargetIds);
    }
  });
});

const summarize = (o: PipelineOutcome) => (o.ok ? 'valid' : `${o.stage}: ${o.errors.join(' | ')}`);

describe('Phase 3 fixture replay — real saved AI outputs, current pipeline vs pipeline with plan conformance', () => {
  for (const name of ['pull-old-contract-rejected-adequacy-1.json', 'pull-old-contract-rejected-adequacy-2.json']) {
    it(`${name}: rejected by the current pipeline; valid with plan conformance via the unchanged validators`, () => {
      const c = get('arm-side-thickness', 'pull');
      const raw = fixture(`generation-2026-09-29/${name}`);
      const oldOutcome = runProposalPipeline(structuredClone(raw), c.context, c.db, null);
      expect(oldOutcome.ok).toBe(false);
      expect(!oldOutcome.ok && oldOutcome.stage).toBe('adequacy');
      expect(summarize(oldOutcome)).toMatch(/lat-width/);

      const outcome = runProposalPipeline(structuredClone(raw), c.context, c.db, c.plan);
      expect(summarize(outcome)).toBe('valid');
      if (!outcome.ok) return;
      const final = outcome.proposal.exercises;
      // upper-traps removed (infeasible), abs removed (deferred)
      expect(final.some((e) => e.targetId === 'upper-traps')).toBe(false);
      expect(outcome.trace.conformanceNotes.join('\n')).toMatch(/rectus-abdominis/);
      // lat/back reserved capacity used by completion
      expect(outcome.trace.completionNotes.join('\n')).toMatch(/lat-width/);
      for (const id of ['lat-width', 'back-thickness']) {
        const sets = final.filter((e) => creditedTargetKeys(e, c.context.targets).includes(`physique_target:${id}`)).reduce((s, e) => s + e.sets, 0);
        expect(sets, id).toBeGreaterThanOrEqual(byId(c.plan, id).plannedMinimumSets);
      }
      // brachialis valid, no duplicate curl
      expect(final.find((e) => e.targetId === 'brachialis-arm-thickness')?.exerciseId).toBe('hammer-curl');
      expect(new Set(final.map((e) => e.exerciseId)).size).toBe(final.length);
      // passes the unchanged validator independently
      expect(validateProposalAdequacy(outcome.proposal, c.context).ok).toBe(true);
    });
  }

  for (const name of ['pull-2026-09-29/rejected-duplicate-1.json', 'pull-2026-09-29/rejected-duplicate-2.json', 'pull-2026-09-29/rejected-duplicate-3.json', 'generation-2026-09-29/pull-planned-rejected-duplicate.json']) {
    it(`${name}: duplicate exerciseId is still a schema rejection in both pipelines (never weakened)`, () => {
      const c = get('arm-side-thickness', 'pull');
      const raw = fixture(name);
      const oldOutcome = runProposalPipeline(structuredClone(raw), c.context, c.db, null);
      const outcome = runProposalPipeline(structuredClone(raw), c.context, c.db, c.plan);
      expect(!oldOutcome.ok && oldOutcome.stage).toBe('schema');
      expect(summarize(outcome)).toBe(summarize(oldOutcome));
      expect(summarize(outcome)).toMatch(/duplicate exerciseId/);
    });
  }

  it('Legs duplicate calf (same raise under gastrocnemius and soleus): still a schema rejection in both pipelines', () => {
    const c = get('arm-side-thickness', 'legs');
    const raw = fixture('generation-2026-09-29/legs-old-contract.json');
    raw.exercises.find((e: any) => e.targetId === 'soleus').exerciseId = raw.exercises.find((e: any) => e.targetId === 'gastrocnemius').exerciseId;
    for (const plan of [null, c.plan]) expect(summarize(runProposalPipeline(structuredClone(raw), c.context, c.db, plan))).toMatch(/^schema: .*duplicate exerciseId/);
  });

  it('Legs calf credit: a raise that does not credit its calf label is removed; completion refills only from the plan', () => {
    const c = get('arm-side-thickness', 'legs');
    const raw = fixture('generation-2026-09-29/legs-old-contract.json');
    const calf = planned(c.plan).find((t) => t.targetId === 'soleus' || t.targetId === 'gastrocnemius')!;
    const wrong = calf.targetId === 'soleus' ? 'standing-calf-raise' : 'seated-calf-raise';
    raw.exercises = raw.exercises.filter((e: any) => e.targetId !== 'soleus' && e.targetId !== 'gastrocnemius');
    raw.exercises.push({ ...raw.exercises[0], targetId: calf.targetId, exerciseId: wrong, sets: 3 });
    const outcome = runProposalPipeline(structuredClone(raw), c.context, c.db, c.plan);
    expect(outcome.trace.conformanceNotes.join('\n')).toContain(`removed ${wrong} from ${calf.targetId}`);
    if (outcome.ok) {
      for (const e of outcome.proposal.exercises) expect(creditedTargetKeys(e, c.context.targets)).toContain(keyOf(e.targetType, e.targetId));
    }
  });

  it('Push (real old-contract output + infeasible front-delt): front-delt removed, triceps goals kept, valid', () => {
    const c = get('triceps-back-depth', 'push');
    expect(byId(c.plan, 'front-delt').status).toBe('infeasible');
    const raw = fixture('generation-2026-09-29/push-old-contract.json');
    raw.exercises.push({ ...raw.exercises[0], exerciseId: 'overhead-press', targetId: 'front-delt', sets: 4 });
    const outcome = runProposalPipeline(structuredClone(raw), c.context, c.db, c.plan);
    expect(outcome.trace.removedTargetIds).toContain('front-delt');
    expect(summarize(outcome)).toBe('valid');
    if (outcome.ok) for (const id of ['triceps', 'triceps-long-head']) expect(outcome.proposal.exercises.some((e) => e.targetId === id), id).toBe(true);
  });

  it('Upper (real old-contract output, 16 exercises): deferred regions and forearms removed before they can consume goal capacity', () => {
    const c = get('triceps-back-depth', 'upper');
    const raw = fixture('generation-2026-09-29/upper-old-contract.json');
    // Forearms/abs listed first, goals last: order must not decide what survives.
    raw.exercises.sort((a: any, b: any) => Number(/triceps|brachialis/.test(a.targetId)) - Number(/triceps|brachialis/.test(b.targetId)));
    const outcome = runProposalPipeline(structuredClone(raw), c.context, c.db, c.plan);
    const final = outcome.ok ? outcome.proposal.exercises : [];
    expect(summarize(outcome)).toBe('valid');
    for (const t of c.plan.targets.filter((t) => t.status === 'required')) expect(final.some((e) => e.targetId === t.targetId), t.targetId).toBe(true);
    for (const e of final) expect(isPlanned(c.plan.targets.find((t) => t.key === keyOf(e.targetType, e.targetId))!), e.targetId).toBe(true);
  });
});

describe('Phase 3 safety — the unchanged validators still reject', () => {
  const pull = () => get('arm-side-thickness', 'pull');
  const valid = () => fixture('generation-2026-09-29/pull-planned-valid.json');

  it('baseline: the real planned Pull output is valid', () => {
    const c = pull();
    expect(summarize(runProposalPipeline(valid(), c.context, c.db, c.plan))).toBe('valid');
  });

  it('a required goal omitted by the AI is rejected — completion never adds it', () => {
    const c = pull();
    const raw = valid();
    raw.exercises = raw.exercises.filter((e: any) => e.targetId !== 'brachialis-arm-thickness');
    const outcome = runProposalPipeline(raw, c.context, c.db, c.plan);
    expect(!outcome.ok && outcome.stage).toBe('adequacy');
    expect(summarize(outcome)).toMatch(/brachialis-arm-thickness/);
    expect(outcome.trace.completionNotes.join('\n')).not.toMatch(/added [a-z-]+ for brachialis/);
  });

  it('schema-invalid output is rejected at schema', () => {
    const c = pull();
    const raw = valid();
    delete raw.exercises;
    expect(summarize(runProposalPipeline(raw, c.context, c.db, c.plan))).toMatch(/^schema:/);
  });

  it('a wrong output schema version (hard structural violation) is rejected at schema', () => {
    const c = pull();
    expect(summarize(runProposalPipeline({ ...valid(), schemaVersion: 'ai-workout-session-proposal.v2' }, c.context, c.db, c.plan))).toMatch(/^schema:/);
  });

  it('an unknown exercise is rejected at domain', () => {
    const c = pull();
    const raw = valid();
    raw.exercises[1].exerciseId = 'invented-row';
    expect(summarize(runProposalPipeline(raw, c.context, c.db, c.plan))).toMatch(/^domain: .*not a known Blueprint exercise/);
  });

  it('an unknown target is rejected at domain', () => {
    const c = pull();
    const raw = valid();
    raw.exercises[1].targetId = 'invented-target';
    expect(summarize(runProposalPipeline(raw, c.context, c.db, c.plan))).toMatch(/^domain: .*invented-target/);
  });

  it('a safety ceiling breach (rest above the application ceiling) is rejected at domain', () => {
    const c = pull();
    const raw = valid();
    raw.exercises[1].restSeconds = 100_000;
    expect(summarize(runProposalPipeline(raw, c.context, c.db, c.plan))).toMatch(/^domain: .*safety ceiling/);
  });

  it('a proposal still inadequate after completion is rejected (real planned Legs output: 2-set hamstrings)', () => {
    const c = get('arm-side-thickness', 'legs');
    // In production soleus was the planned calf; here gastrocnemius is — relabel so all five leg slots stay used,
    // exactly as in production, leaving completion no room to add a second hamstring exercise.
    const raw = fixture('generation-2026-09-29/legs-planned-rejected-adequacy.json');
    const calf = planned(c.plan).find((t) => t.targetId === 'soleus' || t.targetId === 'gastrocnemius')!;
    Object.assign(raw.exercises.find((e: any) => e.targetId === 'soleus'), { targetId: calf.targetId, exerciseId: calf.candidates[0]!.exerciseId });
    const outcome = runProposalPipeline(raw, c.context, c.db, c.plan);
    expect(outcome.trace.conformanceNotes).toEqual([]);
    expect(!outcome.ok && outcome.stage).toBe('adequacy');
    expect(summarize(outcome)).toMatch(/hamstrings/);
  });
});

describe('the one pipeline — no fork', () => {
  it('without a plan, conformance never runs and every other stage is the same code path', () => {
    const c = get('arm-side-thickness', 'pull');
    const raw = fixture('generation-2026-09-29/pull-planned-valid.json');
    const a = runProposalPipeline(structuredClone(raw), c.context, c.db, null);
    const b = runProposalPipeline(structuredClone(raw), c.context, c.db, c.plan);
    expect(a.trace.conformanceNotes).toEqual([]);
    // A plan-conformant proposal is treated identically either way.
    expect(b.trace.conformanceNotes).toEqual([]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
