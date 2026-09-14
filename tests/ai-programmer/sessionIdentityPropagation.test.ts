// Repair: the AI context previously never told the model which session
// identity (Push/Pull/Legs/Upper) a gym day actually was — only a
// generic "gym" activity flag. This tests that
// buildProgrammerContext().programmingBrief.session.purpose correctly
// reads the ALREADY-PERSISTED WeeklyProgramRepo session name (the same
// value weekProgramReconciliation.ts writes verbatim from
// sessionPurpose.ts) rather than recomputing it — see
// programmerContextBuilder.ts's own doc comment on this design choice.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { addDays } from '../../src/engine/dateMath.js';
import { programmingWeekStart } from '../../src/engine/workoutBuilder.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

function futureMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 70);
  // Walk forward to the next Monday so this fixture stays stable and
  // real (matches this app's own Monday-anchored week convention)
  // without ever going stale like a fixed calendar-date constant would.
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
});

describe('session identity propagation into AIProgrammerContext.programmingBrief', () => {
  it('reads the already-persisted program_sessions name as this session\'s purpose', () => {
    const monday = futureMonday();
    const tuesday = addDays(monday, 1);
    const weekStart = programmingWeekStart(monday);
    const weekEnd = addDays(weekStart, 6);

    const program = new WeeklyProgramRepo(db).create(weekStart, weekEnd);
    new WeeklyProgramRepo(db).upsertSession(program.id, 0, 'push', 'gym', {});
    new WeeklyProgramRepo(db).upsertSession(program.id, 1, 'pull', 'gym', {});

    const contextMonday = buildProgrammerContext(db, { targetDate: monday });
    const contextTuesday = buildProgrammerContext(db, { targetDate: tuesday });

    expect(contextMonday.programmingBrief.session.purpose).toBe('push');
    expect(contextTuesday.programmingBrief.session.purpose).toBe('pull');
    expect(contextMonday.programmingBrief.session.expectedCoverageTargetIds).toEqual(
      expect.arrayContaining(['upper-pec', 'front-delt', 'side-delt', 'triceps', 'triceps-long-head'])
    );
    expect(contextTuesday.programmingBrief.session.expectedCoverageTargetIds).not.toContain('upper-pec'); // a Push target, not Pull
  });

  it('is null when no program row exists yet for this week', () => {
    const monday = futureMonday();
    const context = buildProgrammerContext(db, { targetDate: monday });
    expect(context.programmingBrief.session.purpose).toBeNull();
    expect(context.programmingBrief.session.expectedCoverageTargetIds).toEqual([]);
  });

  it('is null on a day with no persisted session row even when the week program exists (e.g. Rest/Badminton)', () => {
    const monday = futureMonday();
    const saturday = addDays(monday, 5); // recurring badminton day in this fixture's profile — never a gym day
    const weekStart = programmingWeekStart(monday);
    const weekEnd = addDays(weekStart, 6);
    const program = new WeeklyProgramRepo(db).create(weekStart, weekEnd);
    new WeeklyProgramRepo(db).upsertSession(program.id, 0, 'push', 'gym', {});

    const context = buildProgrammerContext(db, { targetDate: saturday });
    expect(context.programmingBrief.session.purpose).toBeNull();
  });
});
