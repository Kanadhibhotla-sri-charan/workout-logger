// Exercise-variety replay (2026-10-09): rebuilds the October 5-9 sessions
// against a COPY of production data with the AI stubbed. Skipped unless
// REPLAY_DB points at a database copy; writes its findings to REPLAY_OUT.
//
//   REPLAY_DB=/path/copy.sqlite REPLAY_OUT=/path/out.json npx vitest run tests/replay
//
// Scenarios:
//   asLogged   — each day as of that morning (later sessions removed), both
//                pool modes, a plan-following stub;
//   sequential — wide mode as if live from Oct 5: history cut at Oct 5, each
//                later day sees the earlier stubbed days as projected sessions;
//   offList    — wide mode, the stub also returns one rested and one unlisted
//                exercise; records what conformance removed;
//   identity   — every stored proposal scored against the current identity
//                rule and the candidate "distinct muscle group" rule (report
//                only; no validator is changed).

import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import type { ProjectedSession } from '../../src/ai-programmer/context/projectedExposure.js';
import { planSession, type SessionPlan } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { buildPlannedAIContext } from '../../src/ai-programmer/planning/plannedContext.js';
import { AIProgrammerService } from '../../src/ai-programmer/service/aiProgrammerService.js';
import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../../src/ai-programmer/contracts/providerTypes.js';
import { creditedSetsByTarget, creditedTargetKeys } from '../../src/ai-programmer/validation/sharedCredit.js';
import { identityGroupOf, MEANINGFUL_COVERAGE_MIN_SETS } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import { SESSION_PURPOSE_TARGETS, UNIVERSAL_PHYSIQUE_TARGETS } from '../../src/engine/config.js';
import type { SessionPurpose } from '../../src/engine/sessionPurpose.js';

const DB = process.env.REPLAY_DB;
const DAYS: Array<[string, SessionPurpose]> = [
  ['2026-10-05', 'push'],
  ['2026-10-06', 'pull'],
  ['2026-10-08', 'push'],
  ['2026-10-09', 'pull'],
];
const report: Record<string, any> = { asLogged: {}, sequential: {}, offList: {}, identity: {} };

type StubExercise = { exerciseId: string; targetId: string; sets: number };

/** Follows the plan the way a careful coach would: in each exercise group,
 * every member target first gets one exercise; then each (required goal
 * first) gets further unused candidates — preferring candidates that also credit other members — until it reaches
 * its minimum sets, then the group's reserved count is filled; always at each
 * candidate's maxSets and authored reps/RIR. `extra` entries are appended. */
class PlanFollowingProvider implements AIProgrammerProvider {
  constructor(private readonly extra: () => any[] = () => []) {}
  async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    const ctx = request.context as any;
    const sp = ctx.sessionPlan;
    const seen = new Set<string>();
    const exercises: any[] = [];
    const credited = new Map<string, number>();
    const add = (t: any, c: any) => {
      seen.add(c.exerciseId);
      exercises.push({ exerciseId: c.exerciseId, role: 'primary', targetType: 'physique_target', targetId: t.targetId, sets: c.maxSets, repsMin: c.repsMin, repsMax: c.repsMax, rirMin: c.rirMin, rirMax: c.rirMax, rationale: ['stub'], source: 'blueprint' });
      for (const id of [t.targetId, ...c.alsoCredits]) credited.set(id, (credited.get(id) ?? 0) + c.maxSets);
    };
    for (const g of sp.exerciseGroups) {
      const members = sp.targets.filter((x: any) => g.targetIds.includes(x.targetId)).sort((a: any, b: any) => Number(b.role === 'required_goal') - Number(a.role === 'required_goal'));
      const shared = (c: any) => c.alsoCredits.filter((id: string) => g.targetIds.includes(id)).length;
      let taken = 0;
      const limit = g.reservedExercises + g.extraExercisesAllowed;
      // Every member gets one exercise before any member is filled further.
      for (const t of members) {
        if ((credited.get(t.targetId) ?? 0) > 0 || taken >= limit) continue;
        const c = [...t.candidates].sort((a: any, b: any) => shared(b) - shared(a)).find((x: any) => !seen.has(x.exerciseId));
        if (c) {
          add(t, c);
          taken++;
        }
      }
      for (const t of members) {
        for (const c of [...t.candidates].sort((a: any, b: any) => shared(b) - shared(a))) {
          if ((credited.get(t.targetId) ?? 0) >= t.minimumSets || taken >= limit) break;
          if (seen.has(c.exerciseId)) continue;
          add(t, c);
          taken++;
        }
      }
      for (const t of members) {
        for (const c of t.candidates) {
          if (taken >= g.reservedExercises) break;
          if (seen.has(c.exerciseId)) continue;
          add(t, c);
          taken++;
        }
      }
    }
    exercises.push(...this.extra());
    const body = {
      schemaVersion: 'ai-workout-session-proposal.v1', proposalId: 'stub', mode: 'generate_session', targetDate: ctx.targetDate, weekday: ctx.targetWeekday, sessionFocus: [sp.purpose],
      exercises, programmingRationale: ['stub'], goalAlignment: [], recoveryConsiderations: [], warnings: [],
    };
    return { provider: 'stub', model: 'stub', requestId: 'stub', rawText: JSON.stringify(body) };
  }
}

function dbAsOf(date: string): Database.Database {
  const path = join(mkdtempSync(join(tmpdir(), 'wl-replay-')), 'db.sqlite');
  copyFileSync(DB!, path);
  const db = openDb(path);
  db.prepare('DELETE FROM workout_sessions WHERE date >= ?').run(date);
  return db;
}

function at(date: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${date}T00:30:00Z`)); // 06:00 IST
}

function flags(mode: 'package' | 'wide') {
  process.env.AI_PROGRAMMER_ENABLED = 'true';
  process.env.AI_PLANNED_GENERATION_ENABLED = 'true';
  process.env.AI_EXERCISE_POOL_MODE = mode;
}

const isPlanned = (t: SessionPlan['targets'][number]) => (t.status === 'required' || t.status === 'selected') && t.reservedExerciseSlots > 0;

function describePlan(context: AIProgrammerContext, plan: SessionPlan) {
  const valid = (targetId: string, exerciseId: string) => context.targets.find((t) => t.targetId === targetId)!.validExercises.find((v) => v.exerciseId === exerciseId)!;
  return {
    refusals: plan.refusals,
    searchNotes: plan.notes.filter((n) => /exceed the exact search|cannot be split/.test(n)),
    identityMinimum: { ...plan.identityMinimum, coveringGroups: plan.identityMinimum.coveringTargetIds.map(identityGroupOf) },
    largestGroupOptions: Math.max(...plan.capacityGroups.map((g) => plan.targets.filter((t) => g.targetIds.includes(t.targetId)).reduce((s, t) => s + t.candidates.length, 0))),
    statuses: Object.fromEntries(plan.targets.filter((t) => t.status !== 'ineligible' && t.status !== 'outside_identity').map((t) => [t.targetId, t.status])),
    candidates: Object.fromEntries(
      plan.targets.filter(isPlanned).map((t) => [
        t.targetId,
        t.candidates.map((c) => {
          const v = valid(t.targetId, c.exerciseId);
          const u = v.recentSameTypeUsage;
          return `${c.exerciseId}:${c.ceiling}${v.prescriptionSource === 'profile_default' ? ' [new]' : ''}${u ? ` used ${u.sessionsUsed}/${u.sessionsConsidered}` : ''}`;
        }),
      ])
    ),
  };
}

async function generate(db: Database.Database, date: string, purpose: SessionPurpose, provider: AIProgrammerProvider) {
  return new AIProgrammerService(db, provider)
    .generateSession({ targetDate: date, requestedSessionPurpose: purpose })
    .then((r) => ({ ok: true as const, exercises: r.proposal.exercises.map((e) => ({ exerciseId: e.exerciseId, targetId: e.targetId, sets: e.sets })), warnings: r.proposal.warnings }))
    .catch((e: Error) => ({ ok: false as const, error: e.message }));
}

/** Identity coverage under the current rule (covered expected targets) and the candidate rule (their distinct Blueprint muscle groups). */
function identityScore(exercises: readonly StubExercise[], purpose: string, context: AIProgrammerContext) {
  const expected = [...(SESSION_PURPOSE_TARGETS[purpose as SessionPurpose] ?? []), ...UNIVERSAL_PHYSIQUE_TARGETS];
  const totals = creditedSetsByTarget(exercises.map((e) => ({ ...e, targetType: 'physique_target' })), context.targets);
  const covered = expected.filter((id) => (totals.get(`physique_target:${id}`) ?? 0) >= MEANINGFUL_COVERAGE_MIN_SETS);
  const groups = [...new Set(covered.map(identityGroupOf))];
  return { covered, groups, passesCurrent: covered.length >= 2, passesGroupRule: groups.length >= 2 };
}

describe.skipIf(!DB)('exercise-pool replay, Oct 5-9 (production copy, AI stubbed)', () => {
  afterAll(() => {
    vi.useRealTimers();
    if (process.env.REPLAY_OUT) writeFileSync(process.env.REPLAY_OUT, JSON.stringify(report, null, 2));
  });

  for (const [date, purpose] of DAYS) {
    it(`as logged: ${date} ${purpose}`, async () => {
      at(date);
      const day: Record<string, unknown> = {};
      for (const mode of ['package', 'wide'] as const) {
        const db = dbAsOf(date);
        const started = performance.now();
        const context = buildProgrammerContext(db, { targetDate: date, requestedSessionPurpose: purpose, exercisePoolMode: mode });
        const plan = planSession(context, { nonGoalRotationCursor: 0 });
        const planMs = Math.round(performance.now() - started);
        flags(mode);
        const stubbed = await generate(db, date, purpose, new PlanFollowingProvider());
        day[mode] = {
          planMs,
          plannedContextChars: JSON.stringify(buildPlannedAIContext(context, plan)).length,
          ...describePlan(context, plan),
          stubbed,
          identity: stubbed.ok ? identityScore(stubbed.exercises, purpose, context) : null,
        };
        db.close();
        expect(plan.refusals).toEqual([]);
      }
      report.asLogged[`${date} ${purpose}`] = day;
    });
  }

  it('sequential (wide, as if live from Oct 5)', async () => {
    const projected: ProjectedSession[] = [];
    for (const [date, purpose] of DAYS) {
      at(date);
      const db = dbAsOf(DAYS[0]![0]);
      const context = buildProgrammerContext(db, { targetDate: date, requestedSessionPurpose: purpose, exercisePoolMode: 'wide', projectedSessions: [...projected] });
      const plan = planSession(context, { nonGoalRotationCursor: 0 });
      // The stub reads the same plan the service builds; the service is given
      // the projections through a context-preserving wrapper below.
      flags('wide');
      const service = new AIProgrammerService(db, new PlanFollowingProvider());
      const stubbed = await (service as any)
        .generatePlannedDayProposal(context, plan, null)
        .then((r: any) => ({ ok: true as const, exercises: r.proposal.exercises.map((e: any) => ({ exerciseId: e.exerciseId, targetId: e.targetId, sets: e.sets })), warnings: r.proposal.warnings }))
        .catch((e: Error) => ({ ok: false as const, error: e.message }));
      report.sequential[`${date} ${purpose}`] = { ...describePlan(context, plan), stubbed, identity: stubbed.ok ? identityScore(stubbed.exercises, purpose, context) : null };
      if (stubbed.ok) projected.push({ date, exercises: stubbed.exercises.map((e: StubExercise) => ({ exerciseId: e.exerciseId, sets: e.sets })) });
      db.close();
      expect(plan.refusals).toEqual([]);
    }
  });

  for (const [date, purpose] of DAYS) {
    it(`off-list AI output is removed: ${date} ${purpose}`, async () => {
      at(date);
      const db = dbAsOf(date);
      const context = buildProgrammerContext(db, { targetDate: date, requestedSessionPurpose: purpose, exercisePoolMode: 'wide' });
      const plan = planSession(context, { nonGoalRotationCursor: 0 });
      const planned = plan.targets.filter(isPlanned);
      // A rested exercise (prescribed in the full pool, left off by rotation) and one never prescribed at all.
      const full = buildProgrammerContext(db, { targetDate: date, requestedSessionPurpose: purpose, exercisePoolMode: 'wide', applyRotationShortlist: false });
      // Never an exercise listed for ANY planned target (the stub may already use it), and always one that
      // earns credit for the target it is labelled with — so only the candidate-list rule can remove it.
      const listedAnywhere = new Set(planned.flatMap((t) => t.candidates.map((c) => c.exerciseId)));
      const pick = (want: 'rested' | 'unlisted') => {
        for (const t of planned) {
          const pool = full.targets.find((x) => x.targetId === t.targetId)!.validExercises;
          const hit = pool.find(
            (v) =>
              !listedAnywhere.has(v.exerciseId) &&
              creditedTargetKeys({ exerciseId: v.exerciseId, targetType: 'physique_target', targetId: t.targetId }, context.targets).includes(`physique_target:${t.targetId}`) &&
              (want === 'rested' ? v.authoredPrescription !== null : v.authoredPrescription === null)
          );
          if (hit) return { exerciseId: hit.exerciseId, targetId: t.targetId, kind: want };
        }
        return null;
      };
      const injected = [pick('rested'), pick('unlisted')].filter((x): x is NonNullable<ReturnType<typeof pick>> => x !== null);
      flags('wide');
      const provider = new PlanFollowingProvider(() =>
        injected.map((x) => ({ exerciseId: x.exerciseId, role: 'primary', targetType: 'physique_target', targetId: x.targetId, sets: 2, repsMin: 10, repsMax: 16, rirMin: 1, rirMax: 3, rationale: ['stub'], source: 'blueprint' }))
      );
      const stubbed = await generate(db, date, purpose, provider);
      const survived = stubbed.ok ? injected.filter((x) => stubbed.exercises.some((e) => e.exerciseId === x.exerciseId)) : [];
      report.offList[`${date} ${purpose}`] = {
        injected,
        survived,
        ok: stubbed.ok,
        error: stubbed.ok ? undefined : stubbed.error,
        conformanceNotes: stubbed.ok ? stubbed.warnings.filter((w) => w.includes('not one of')) : [],
      };
      db.close();
      expect(survived).toEqual([]);
    });
  }

  it('identity rule impact on stored proposals', () => {
    at('2026-10-09');
    const db = dbAsOf('2026-10-09');
    const context = buildProgrammerContext(db, { targetDate: '2026-10-09', requestedSessionPurpose: 'pull', exercisePoolMode: 'package' });
    const rows = db.prepare('SELECT id, target_date, status, proposal_json FROM ai_program_proposals ORDER BY target_date').all() as Array<{ id: string; target_date: string; status: string; proposal_json: string }>;
    const scored = rows.flatMap((r) => {
      const p = JSON.parse(r.proposal_json);
      const purpose = String(p.sessionFocus?.[0] ?? '').toLowerCase();
      if (!(purpose in SESSION_PURPOSE_TARGETS)) return [];
      return [{ date: r.target_date, status: r.status, purpose, ...identityScore(p.exercises, purpose, context) }];
    });
    const stubs = Object.entries(report.asLogged).flatMap(([day, v]: [string, any]) =>
      (['package', 'wide'] as const).filter((m) => v[m]?.identity).map((m) => ({ day, mode: m, ...v[m].identity }))
    );
    report.identity = {
      storedProposalsScored: scored.length,
      storedPassCurrent: scored.filter((s) => s.passesCurrent).length,
      storedPassGroupRule: scored.filter((s) => s.passesGroupRule).length,
      storedWouldNewlyFail: scored.filter((s) => s.passesCurrent && !s.passesGroupRule),
      stubsWouldNewlyFail: stubs.filter((s) => s.passesCurrent && !s.passesGroupRule),
    };
    db.close();
  });
});
