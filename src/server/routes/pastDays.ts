// Past-day activity (2026-11-09, owner: "yes build the past-day edit
// option"). PUT /week/days/:day/activity only reaches the current week
// (on Monday 9 Nov, "sunday" meant 15 Nov, so Sunday 8 Nov needed a data
// fix, change log 103). These routes cover every day from last week's
// Monday through yesterday, by date.
//
// A past day's activity is a record of what happened, so the change
// writes only that day's week override. It never runs the planner and
// never touches sessions, plans or other days. What a day can become
// depends on what was logged there:
//   completed workout          Gym, or Both (gym + badminton)
//   nothing logged             Rest, or Badminton
//   planned or in progress     nothing: finish, log or delete it first

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { WEEKDAYS, type DailyActivity, type TrainingProfile, type Weekday } from '../../contracts/types.js';
import { addDays, isValidCalendarDate } from '../../engine/dateMath.js';
import { programmingWeekStart } from '../../engine/workoutBuilder.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';

export const pastDaysRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

export interface PastDay {
  date: string;
  weekday: Weekday;
  activity: DailyActivity;
  /** The day's workout, if any: completed, planned or in_progress. */
  workout: 'completed' | 'planned' | 'in_progress' | null;
  /** Activities this day can be changed to (its current one included). */
  allowed: DailyActivity[];
  /** Why `allowed` is empty, when it is. */
  blockedReason: string | null;
}

/** From last week's Monday through yesterday. */
export function pastDayWindow(today: string): { first: string; last: string } {
  return { first: addDays(programmingWeekStart(today), -7), last: addDays(today, -1) };
}

function weekdayOf(date: string, weekStart: string): Weekday {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / 86_400_000);
  return WEEKDAYS[days]!;
}

export function readPastDay(database: Database.Database, profile: TrainingProfile, date: string): PastDay {
  const weekStart = programmingWeekStart(date);
  const weekday = weekdayOf(date, weekStart);
  const overrides = new WeekActivityOverridesRepo(database).get(profile.id, weekStart);
  const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
  const activity = deriveDailyActivity(weekday, effective.trainingDays, effective.otherActivitySchedule);
  const sessions = new WorkoutSessionsRepo(database).listSessionsByDate(date);
  const workout = sessions.some((s) => s.status === 'in_progress')
    ? 'in_progress'
    : sessions.some((s) => s.status === 'completed')
      ? 'completed'
      : sessions.some((s) => s.status === 'planned')
        ? 'planned'
        : null;
  const allowed: DailyActivity[] = workout === 'completed' ? ['gym', 'both'] : workout === null ? ['unselected', 'badminton'] : [];
  const blockedReason =
    workout === 'in_progress'
      ? 'A workout on this day is still in progress. Finish it first.'
      : workout === 'planned'
        ? 'This day still has a planned workout. Log it or delete it first.'
        : null;
  return { date, weekday, activity, workout, allowed, blockedReason };
}

function profileOf(database: Database.Database): TrainingProfile | undefined {
  return new TrainingProfileRepo(database).get(new UsersRepo(database).getOrCreateDefault().id) ?? undefined;
}

// GET /api/programming/past-days: every day in the window, newest first.
pastDaysRouter.get('/past-days', (req, res) => {
  const database = db(req);
  const profile = profileOf(database);
  if (!profile) return res.status(404).json({ error: 'No training profile exists for this user yet — create one first (PUT /api/training-profile)' });
  const { first, last } = pastDayWindow(todayForUser(database));
  const days: PastDay[] = [];
  for (let d = last; d >= first; d = addDays(d, -1)) days.push(readPastDay(database, profile, d));
  res.json({ first, last, days });
});

// PUT /api/programming/past-days/:date/activity { activity }
pastDaysRouter.put('/past-days/:date/activity', (req, res) => {
  const database = db(req);
  const date = req.params.date;
  if (!isValidCalendarDate(date)) return res.status(400).json({ error: 'date must be a real calendar date in YYYY-MM-DD format' });
  const activity = req.body?.activity as DailyActivity;
  const profile = profileOf(database);
  if (!profile) return res.status(404).json({ error: 'No training profile exists for this user yet — create one first (PUT /api/training-profile)' });
  const { first, last } = pastDayWindow(todayForUser(database));
  if (date < first || date > last) {
    return res.status(400).json({ error: `Only days from ${first} to ${last} can be changed here. Today and later days are changed from the week view.` });
  }
  const day = readPastDay(database, profile, date);
  if (day.blockedReason) return res.status(409).json({ error: day.blockedReason });
  if (!day.allowed.includes(activity)) {
    const reason = day.workout === 'completed' ? 'a workout is logged on this day' : 'no workout is logged on this day';
    return res.status(400).json({ error: `activity must be one of ${day.allowed.join('|')} (${reason})` });
  }
  new WeekActivityOverridesRepo(database).setOverride(profile.id, programmingWeekStart(date), day.weekday, activity);
  res.json(readPastDay(database, profile, date));
});
