// Blueprint Picker/Daily Activity spec §7/§10/§16: proves the planner
// behavior the spec requires (a badminton-only day gets no automatic gym
// session; the given 4-gym/2-badminton example never becomes 6 gym
// sessions) and the history-safety guarantee (changing a day's activity
// never touches an already-logged WorkoutSession). Both properties
// already hold today — src/engine/workoutBuilder.ts's gym-day eligibility
// was always independent of other_activity_schedule, and
// setDailyActivity only ever writes to training_profiles/
// training_profile_activities, never workout_sessions — this test exists
// to keep it that way as a real regression guard, not because either
// module was changed for this feature.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { UsersRepo } from '../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../src/repositories/workoutSessionsRepo.js';
import { assembleWeeklyPlanInput, buildWeeklyProgrammingPlan } from '../src/engine/workoutBuilder.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const MON = '2026-08-31';

let db: Database.Database;
let userId: string;

beforeEach(() => {
  db = openDb(':memory:');
  userId = new UsersRepo(db).getOrCreateDefault().id;
});

describe('Planner behavior: badminton is never silently double-counted as a gym day (spec §7)', () => {
  it('the exact spec example — Mon/Tue/Thu/Fri gym, Wed rest, Sat/Sun badminton — produces exactly 4 gym sessions, not 6', () => {
    new TrainingProfileRepo(db).upsert(userId, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [
        { day: 'saturday', activity_type: 'badminton', notes: null },
        { day: 'sunday', activity_type: 'badminton', notes: null },
      ],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const input = assembleWeeklyPlanInput(db, MON, 60);
    const plan = buildWeeklyProgrammingPlan(input);

    expect(plan.sessions).toHaveLength(4);
    const gymWeekdays = plan.sessions.map((s) => s.date).sort();
    expect(gymWeekdays).toEqual(['2026-08-31', '2026-09-01', '2026-09-03', '2026-09-04']); // Mon, Tue, Thu, Fri
  });

  it('a "both" day (gym + badminton) still gets exactly one real gym session, not two', () => {
    new TrainingProfileRepo(db).upsert(userId, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [{ day: 'monday', activity_type: 'badminton', notes: null }],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const input = assembleWeeklyPlanInput(db, MON, 60);
    const plan = buildWeeklyProgrammingPlan(input);
    expect(plan.sessions.filter((s) => s.date === MON)).toHaveLength(1);
  });

  it('an unselected (rest) day never receives a gym session', () => {
    new TrainingProfileRepo(db).upsert(userId, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['tuesday'], // monday deliberately excluded
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [],
    });
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'chest-front-width', priority: 1 });

    const input = assembleWeeklyPlanInput(db, MON, 60);
    const plan = buildWeeklyProgrammingPlan(input);
    expect(plan.sessions.some((s) => s.date === MON)).toBe(false);
  });
});

describe('History safety: changing a day\'s activity never touches logged WorkoutSessions (spec §10/§16)', () => {
  it('a completed session on the changed day is byte-for-byte unchanged after the activity change', () => {
    const trainingProfileRepo = new TrainingProfileRepo(db);
    trainingProfileRepo.upsert(userId, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [],
    });

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const logged = sessionsRepo.createSession({
      date: MON,
      session_type: 'gym',
      status: 'completed',
      duration_minutes: 55,
      notes: 'felt strong today',
    });

    // Change Monday from gym to badminton — a real, disruptive-looking
    // activity change on the exact day this session was logged for.
    trainingProfileRepo.setDailyActivity(userId, 'monday', 'badminton');

    const reloaded = sessionsRepo.listSessionsByDate(MON).find((s) => s.session_id === logged.session_id);
    expect(reloaded).toEqual(logged);
  });

  it('changing a future day\'s activity leaves an unrelated already-logged session on another day untouched', () => {
    const trainingProfileRepo = new TrainingProfileRepo(db);
    trainingProfileRepo.upsert(userId, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: FULL_EQUIPMENT,
      other_activity_schedule: [],
    });

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const mondaySession = sessionsRepo.createSession({ date: MON, session_type: 'gym', status: 'completed', duration_minutes: 50 });

    trainingProfileRepo.setDailyActivity(userId, 'friday', 'unselected'); // an unrelated future day changes to rest

    const reloadedMonday = sessionsRepo.listSessionsByDate(MON).find((s) => s.session_id === mondaySession.session_id);
    expect(reloadedMonday).toEqual(mondaySession);
  });
});
