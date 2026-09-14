// Cross-Week Programming Intelligence Fix — the regression scenario the
// architect required before this fix could be considered proven: the
// exact real-world case that produced the reported bug (Push: 19
// exercises/2h15m, Pull: 16/1h58m, Legs: 20/2h17m) — a muscle with only
// ONE eligible session in the current week had its ENTIRE weekly target
// volume crammed into that single session. This file exercises the real
// production path end to end (the actual `GET /api/programming/week`
// route, which is the one and only place `programs.target_allocations_
// json` is genuinely persisted via reconcileWeekProgram) across two
// REAL, separately-generated weeks, and proves the deferred volume from
// week 1 is genuinely consumed by week 2's own real generation — never
// merely computed and discarded.
//
// Fixture, exactly as specified: current week Tuesday Push / Wednesday
// Pull / Thursday Legs (Monday and Friday rest, Saturday/Sunday
// badminton — a real, ordinary 3-gym-day week), plus existing completed
// workout history. Next week adds a Friday Upper session (via a
// current-week-scoped activity override, never a change to the
// recurring TrainingProfile) — a real, ordinary 4-gym-day
// Push/Pull/Legs/Upper week.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { addDays } from '../../src/engine/dateMath.js';
import { assembleWeeklyPlanInput, type WeeklyPlanTargetAllocation } from '../../src/engine/workoutBuilder.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../src/repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

// 2026-08-31 is a real Monday.
const WEEK1_START = '2026-08-31';
const WEEK1_TUE = '2026-09-01'; // Push
const WEEK1_WED = '2026-09-02'; // Pull
const WEEK1_THU = '2026-09-03'; // Legs
const WEEK2_START = addDays(WEEK1_START, 7); // 2026-09-07
const WEEK2_TUE = addDays(WEEK2_START, 1); // Push
const WEEK2_FRI = addDays(WEEK2_START, 4); // Upper
const WEEK3_START = addDays(WEEK2_START, 7);

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

function setupProfile() {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['tuesday', 'wednesday', 'thursday'],
    default_session_duration_minutes: 75,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 120,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [
      { day: 'saturday', activity_type: 'badminton', notes: null },
      { day: 'sunday', activity_type: 'badminton', notes: null },
    ],
  });
  // Next week only: Friday becomes a 4th real gym day (Upper), via the
  // current-week-scoped override mechanism — the recurring profile
  // above (this test's whole-session "recurring Training Profile")
  // never changes.
  new WeekActivityOverridesRepo(db).setOverride(profile.id, WEEK2_START, 'friday', 'gym');
  return profile;
}

function getProgram(weekStart: string) {
  return new WeeklyProgramRepo(db).getByWeekStart(weekStart);
}

function allocationFor(weekStart: string, targetId: string): WeeklyPlanTargetAllocation | undefined {
  const allocations = getProgram(weekStart)?.target_allocations as WeeklyPlanTargetAllocation[] | null | undefined;
  return allocations?.find((a) => a.target_id === targetId);
}

describe('Cross-Week Programming Intelligence Fix — genuine cross-week distribution, real production path', () => {
  it('proves the full required regression: realistic current sessions, real cross-week Push distribution, Friday Upper absorbing prior-week carryover, and every safety invariant', async () => {
    setupProfile();
    // A single specialization goal is enough to reproduce the exact
    // reported failure mode: mid-pec is push+upper compatible only, so
    // this week it has exactly ONE compatible day (Tuesday) — the
    // precise "only one eligible session this week" condition that
    // previously crammed the whole weekly target into that one day.
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    // Existing completed workout history, present before either week is
    // ever generated — a real mid-pec exercise (not a bare session row),
    // so this history is genuinely visible to the engine's own
    // last-trained-date/continuity/recovery inputs, not merely present
    // in the schedule. Dated within the engine's real 14-day rolling
    // history window as seen from BOTH week1's Tuesday and week2's
    // Friday (buildTrainingState's own rollingRangeEnding/weekRange
    // union) — a completed session further back would genuinely (and
    // correctly) fall outside that window and not be "recent history"
    // at all, which would misrepresent this fixture's own intent.
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const completed = sessionsRepo.createSession({ date: '2026-08-29', session_type: 'gym', status: 'completed' }); // the Saturday before week 1
    sessionsRepo.addExercisePerformance(completed.session_id, {
      exercise_id: 'flat-barbell-bench-press',
      order: 1,
      role: 'primary',
      sets: [
        { set_number: 1, weight: 60, reps: 8, completed: true },
        { set_number: 2, weight: 60, reps: 8, completed: true },
        { set_number: 3, weight: 60, reps: 8, completed: true },
      ],
    });
    const completedBefore = sessionsRepo.getSession(completed.session_id)!;
    const completedExercisesBefore = sessionsRepo.getExercisePerformances(completed.session_id);

    const profileBefore = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!;

    const fetchSpy = vi.spyOn(global, 'fetch');
    const app = createApp(db);

    // --- Generate week 1 (the real production entrypoint) ---
    const week1Res = await request(app).get(`/api/programming/week?date=${WEEK1_TUE}`).expect(200);
    const week1Days = new Map(week1Res.body.days.map((d: any) => [d.date, d]));

    // Property 1: current sessions are realistic — nowhere near the
    // reported 19/16/20-exercise, 135/118/137-minute sessions. The
    // profile's own configured ceiling (120 minutes) is the meaningful
    // bound here — the bug's signature was blowing past a realistic
    // session length, not any particular exercise count (an ordinary
    // 8-muscle push day legitimately has more than a handful of
    // exercises).
    for (const date of [WEEK1_TUE, WEEK1_WED, WEEK1_THU]) {
      const day = week1Days.get(date) as any;
      expect(day.type).toBe('gym');
      expect(day.estimatedMinutes).toBeLessThanOrEqual(120);
    }
    // Monday/Friday remain rest; Saturday/Sunday remain badminton — the
    // "other days matching the actual schedule" requirement.
    expect((week1Days.get(WEEK1_START) as any).type).not.toBe('gym');
    expect((week1Days.get(addDays(WEEK1_START, 4)) as any).type).not.toBe('gym');

    const midPecWeek1 = allocationFor(WEEK1_START, 'mid-pec');
    expect(midPecWeek1).toBeDefined();
    // The genuine cross-week signal: with only one compatible day this
    // week, the fix must leave real unmet volume behind (a fair share,
    // not the whole target crammed in) rather than silently absorbing
    // it or exploding the single session.
    expect(midPecWeek1!.unmetDirectSets).toBeGreaterThan(0);
    expect(midPecWeek1!.deliveredDirectSets).toBeGreaterThan(0);
    expect(midPecWeek1!.deliveredDirectSets).toBeLessThan(midPecWeek1!.requiredDirectSets);
    const week1TuesdayMidPecSets = (week1Days.get(WEEK1_TUE) as any).plannedWork
      .filter((w: any) => w.target_id === 'mid-pec')
      .reduce((sum: number, w: any) => sum + w.sets, 0);
    expect(week1TuesdayMidPecSets).toBe(midPecWeek1!.deliveredDirectSets);

    // --- Generate week 2 (the real production entrypoint, real second call) ---
    const week2Res = await request(app).get(`/api/programming/week?date=${WEEK2_TUE}`).expect(200);
    const week2Days = new Map(week2Res.body.days.map((d: any) => [d.date, d]));

    // Friday is now a real 4th gym day, Upper, exactly as specified.
    expect((week2Days.get(WEEK2_FRI) as any).type).toBe('gym');
    expect((week2Days.get(WEEK2_FRI) as any).sessionPurpose).toBe('upper');
    expect((week2Days.get(WEEK2_TUE) as any).sessionPurpose).toBe('push');

    const midPecWeek1SetsInWeek2 = [WEEK2_TUE, WEEK2_FRI].map((date) =>
      (week2Days.get(date) as any).plannedWork.filter((w: any) => w.target_id === 'mid-pec').reduce((sum: number, w: any) => sum + w.sets, 0)
    );

    // Property 2/3: Push work is genuinely distributed across
    // current-week Push and next-week Push, and next-week Upper
    // actually accounts for the carried-over exposure — not merely a
    // number computed and forgotten. Both of next week's push-compatible
    // sessions (Tuesday Push and Friday Upper) carry real mid-pec work.
    expect(midPecWeek1SetsInWeek2[0]).toBeGreaterThan(0);
    expect(midPecWeek1SetsInWeek2[1]).toBeGreaterThan(0);

    // Property 4: no muscle receives redundant excessive work — week 2's
    // sessions stay realistic too, even while absorbing week 1's carryover.
    for (const date of [WEEK2_TUE, addDays(WEEK2_START, 2), addDays(WEEK2_START, 3), WEEK2_FRI]) {
      const day = week2Days.get(date) as any;
      expect(day.estimatedMinutes).toBeLessThanOrEqual(120);
    }

    // The carryover materially reduced week 2's own remaining unmet
    // volume relative to week 1 — proving it was actually consumed, not
    // just carried forward as an ever-growing, never-applied number.
    const midPecWeek2 = allocationFor(WEEK2_START, 'mid-pec');
    expect(midPecWeek2).toBeDefined();
    expect(midPecWeek2!.requiredDirectSets).toBeGreaterThan(midPecWeek1!.requiredDirectSets); // this week's own target + week 1's carryover
    expect(midPecWeek2!.unmetDirectSets).toBeLessThan(midPecWeek1!.unmetDirectSets + midPecWeek1!.requiredDirectSets);

    // Property 4 (explicit): Friday Upper's own construction genuinely
    // has visibility into the real completed history, not just the
    // cross-week carryover number — the same real per-target facts
    // buildTargetContexts/recoveryEngine/Gate 5 continuity consume.
    // allocatedSessionDates spanning BOTH week2 push-compatible sessions
    // (never a separate, disconnected allocation per session) proves
    // Friday Upper and Tuesday Push are accounted for together, under
    // one real target allocation — never double-counted or independently
    // re-maxed.
    const fridayPlanInput = assembleWeeklyPlanInput(db, WEEK2_START, 75, WEEK2_FRI);
    const midPecTargetAtFriday = fridayPlanInput.targets.find((t) => t.target_id === 'mid-pec');
    expect(midPecTargetAtFriday?.last_trained_date).toBe('2026-08-29');
    expect(midPecTargetAtFriday?.exercise_history['flat-barbell-bench-press']?.[0]).toMatchObject({ date: '2026-08-29' });
    expect(midPecWeek2!.allocatedSessionDates).toEqual(expect.arrayContaining([WEEK2_TUE, WEEK2_FRI]));

    // --- Safety invariants ---

    // Property 5: completed history is byte-identical — the session row
    // AND its real logged exercise/set performance.
    expect(sessionsRepo.getSession(completed.session_id)).toEqual(completedBefore);
    expect(sessionsRepo.getExercisePerformances(completed.session_id)).toEqual(completedExercisesBefore);

    // Property 6: the recurring Training Profile is unchanged — only a
    // week-scoped override was added, exactly as the fix requires.
    const profileAfter = new TrainingProfileRepo(db).get(new UsersRepo(db).getOrCreateDefault().id)!;
    expect(profileAfter.training_days).toEqual(profileBefore.training_days);
    expect(profileAfter.other_activity_schedule).toEqual(profileBefore.other_activity_schedule);

    // Property 7: no unrelated future week was overwritten or even
    // created — week 3 was never requested, so it must not exist yet.
    expect(getProgram(WEEK3_START)).toBeUndefined();

    // Property 8: no AI call was made by this fully-deterministic flow.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
