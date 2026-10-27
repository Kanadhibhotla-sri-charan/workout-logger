// Weekly ledger drives the session (AI_WEEKLY_LEDGER_MODE=on, 2026-10-27):
// the ledger rewrites the brief, and the planner allocates "must" targets
// before "can wait" ones.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { applyWeeklyLedger, MUST_ADEQUACY_TOLERANCE } from '../../src/ai-programmer/planning/ledgerBrief.js';
import { buildWeeklyLedger } from '../../src/ai-programmer/planning/weeklyLedger.js';
import { planSession } from '../../src/ai-programmer/planning/sessionPlanner.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

function setup() {
  const db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata', week_start_day: 'monday', training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60, minimum_session_duration_minutes: 30, maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'dumbbell', 'cable', 'machine', 'bench'], other_activity_schedule: [],
  });
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });
  return db;
}

const TARGET = '2099-03-05'; // a Thursday, far from "today"

describe('applyWeeklyLedger', () => {
  it('sets must minimums, drops done muscles from the expected list, and keeps the context hash honest', () => {
    const db = setup();
    // Monday of the target week: 6 credited front-delt sets from pressing, so front delts are done.
    const s = new WorkoutSessionsRepo(db).createSession({ date: '2099-03-02', session_type: 'gym', status: 'completed' });
    new WorkoutSessionsRepo(db).addExercisePerformance(s.session_id, { exercise_id: 'incline-barbell-press', order: 0, role: 'primary', sets: Array.from({ length: 12 }, (_, i) => ({ set_number: i + 1, completed: true })) });
    const context = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'push' });
    const ledger = buildWeeklyLedger(db, context);
    const applied = applyWeeklyLedger(context, ledger);
    const triceps = applied.programmingBrief.muscles.find((m) => m.targetId === 'triceps')!;
    const tricepsEntry = ledger.entries.find((e) => e.targetId === 'triceps')!;
    expect(triceps).toMatchObject({ weeklyStatus: 'must', isGoalOriented: true, adequacyTolerance: MUST_ADEQUACY_TOLERANCE });
    expect(triceps.recommendedSessionSets.min).toBe(Math.ceil(tricepsEntry.mustSetsToday));
    expect(applied.programmingBrief.muscles.find((m) => m.targetId === 'front-delt')!.weeklyStatus).toBe('done');
    expect(applied.programmingBrief.session.expectedCoverageTargetIds).not.toContain('front-delt');
    expect(applied.contextHash).not.toBe(context.contextHash);
    expect(applyWeeklyLedger(context, ledger).contextHash).toBe(applied.contextHash);
  });

  it('plans every must target before any can-wait one', () => {
    const db = setup();
    const context = buildProgrammerContext(db, { targetDate: TARGET, requestedSessionPurpose: 'push' });
    const applied = applyWeeklyLedger(context, buildWeeklyLedger(db, context));
    const plan = planSession(applied);
    const statusOf = (id: string) => applied.programmingBrief.muscles.find((m) => m.targetId === id)?.weeklyStatus;
    const ranked = plan.targets.filter((t) => t.rank !== null).sort((a, b) => a.rank! - b.rank!);
    const lastMust = Math.max(...ranked.map((t, i) => (statusOf(t.targetId) === 'must' ? i : -1)));
    const firstCanWait = ranked.findIndex((t) => statusOf(t.targetId) === 'can_wait');
    if (firstCanWait >= 0) expect(lastMust).toBeLessThan(firstCanWait);
    expect(plan.refusals).toEqual([]);
  });
});
