// Flexibility block (2026-10-28, owner: "yes" to building Blueprint's
// flexibility plan into every gym day). Blueprint schema 2 gives each
// mobility goal weekly minutes over 3-5 sessions (upper-body 10, lower-body
// 10, wrist & forearm 5, full-body 10). Like the weekly set ledger, the
// minutes count per calendar week (Mon-Sun):
//   done      completed sets of drills carrying the goal, each worth its
//             Blueprint time.seconds_per_set (x2 when per_side)
//   today     what is left, spread evenly over this week's remaining gym
//             days (each gets the block)
// Every Push / Pull / Upper / Legs session gets a deterministic block, outside
// the AI output (the model is told about it and leaves it to the app): for
// each goal still behind, furthest behind first, its least recently done
// drill not already picked, with enough sets for today's share. Dynamic
// drills go before the session (warm-up), holds and foam rolling after it
// (cool-down). The block stays between FLEXIBILITY_BLOCK_MIN_SECONDS and
// FLEXIBILITY_BLOCK_MAX_SECONDS, rest included. While the Legs injury pause
// is on, lower-body mobility is left out.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { SessionPurpose } from '../engine/config.js';
import { addDays } from '../engine/dateMath.js';
import { programmingWeekStart } from '../engine/workoutBuilder.js';
import { todayForUser } from '../lib/userTimezone.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import type { AIWorkoutExerciseProposal } from '../ai-programmer/contracts/programmerTypes.js';
import { weekGymDays } from '../ai-programmer/service/weekGeneration.js';
import { lastDoneDrills } from './athleticAddOn.js';
import { athleticFilterFor, athleticPaused, drillCatalogue, drillEntry, type AthleticDrillContext } from './athleticSession.js';

export const FLEXIBILITY_BLOCK_MIN_SECONDS = 5 * 60;
export const FLEXIBILITY_BLOCK_MAX_SECONDS = 12 * 60;
/** Gym days that get the block (the Athletic day has its own warm-up and cool-down). */
const BLOCK_PURPOSES: readonly SessionPurpose[] = ['push', 'pull', 'upper', 'legs'];
const LOWER_BODY_GOAL = 'lower-body-mobility';

export interface FlexibilityGoalWeek {
  goalId: string;
  name: string;
  weeklyMinutes: number;
  doneMinutes: number;
  remainingMinutes: number;
  /** Left out while the Legs injury pause is on. */
  paused: boolean;
}

export interface FlexibilityWeek {
  weekStart: string;
  goals: FlexibilityGoalWeek[];
  /** Gym days from today (or the week's start) to Sunday, not yet trained. */
  sessionsLeft: number;
}

export interface FlexibilityBlock {
  minutes: number;
  reason: string;
  /** Warm-up drills (before the session) and cool-down drills (after it). */
  warmup: AIWorkoutExerciseProposal[];
  cooldown: AIWorkoutExerciseProposal[];
}

const isFlexibilityGoal = (goalId: string) => BlueprintAdapter.listMobilityTargets().some((t) => t.goal_id === goalId);

/** Blueprint's working seconds for one set of a drill (both sides). */
export function drillSetSeconds(exerciseId: string): number {
  const time = BlueprintAdapter.getExercise(exerciseId)?.time;
  return time ? time.seconds_per_set * (time.per_side ? 2 : 1) : 0;
}

const restOf = (exerciseId: string) => BlueprintAdapter.getExercise(exerciseId)?.time?.rest_seconds[0] ?? 0;

/** This week's flexibility minutes, counting completed sessions dated
 * before `beforeDate` (pass the day after today to include today). */
export function flexibilityWeek(db: Database.Database, date: string, beforeDate: string = date): FlexibilityWeek {
  const weekStart = programmingWeekStart(date);
  const sessions = new WorkoutSessionsRepo(db);
  const doneSeconds = new Map<string, number>();
  const end = addDays(beforeDate, -1);
  if (end >= weekStart) {
    for (const s of sessions.listSessionsInRange(weekStart, end).filter((x) => x.status === 'completed')) {
      for (const p of sessions.getExercisePerformances(s.session_id)) {
        const goals = (BlueprintAdapter.getExercise(p.exercise_id)?.functional_goals ?? []).filter(isFlexibilityGoal);
        const seconds = p.sets.filter((x) => x.completed).length * drillSetSeconds(p.exercise_id);
        for (const g of goals) doneSeconds.set(g, (doneSeconds.get(g) ?? 0) + seconds);
      }
    }
  }
  const paused = athleticPaused(db);
  const goals = BlueprintAdapter.listMobilityTargets().map((t) => {
    const doneMinutes = Math.round(((doneSeconds.get(t.goal_id) ?? 0) / 60) * 10) / 10;
    return {
      goalId: t.goal_id,
      name: BlueprintAdapter.getFunctionalGoal(t.goal_id)?.name ?? t.goal_id,
      weeklyMinutes: t.weekly_minutes,
      doneMinutes,
      remainingMinutes: Math.max(0, Math.round((t.weekly_minutes - doneMinutes) * 10) / 10),
      paused: paused && t.goal_id === LOWER_BODY_GOAL,
    };
  });
  // Counted from today, so days planned ahead in one go (a week run) share
  // what is left instead of each asking for all of it.
  const today = todayForUser(db);
  const from = today < weekStart ? weekStart : today < date ? today : date;
  // A day before `date` that already has its completed session is used up.
  const trained = (day: string) => day < date && sessions.listSessionsByDate(day).some((x) => x.status === 'completed');
  // Every gym day counts: the calendar's purpose for a day is not always
  // what is trained there (with the Legs pause on, the Athletic slot is
  // trained as Push or Pull on request); a real Athletic day's own mobility
  // drills count toward the week too.
  const sessionsLeft = weekGymDays(db, weekStart).filter((d) => d.date >= from && !trained(d.date)).length;
  return { weekStart, goals, sessionsLeft };
}

/** The flexibility block for a gym session on `date`, or null (not a gym
 * purpose, or every goal already met this week). */
export function planFlexibilityBlock(db: Database.Database, date: string, purpose: SessionPurpose | null): FlexibilityBlock | null {
  if (purpose === null || !BLOCK_PURPOSES.includes(purpose)) return null;
  const week = flexibilityWeek(db, date);
  // Today counts even when the calendar does not list it as a gym day.
  const sessionsLeft = Math.max(1, week.sessionsLeft);
  const behind = week.goals
    .filter((g) => !g.paused && g.remainingMinutes > 0)
    .map((g) => ({ ...g, todaySeconds: (g.remainingMinutes * 60) / sessionsLeft }))
    .sort((a, b) => b.remainingMinutes - a.remainingMinutes || a.goalId.localeCompare(b.goalId));
  if (behind.length === 0) return null;

  const catalogue = drillCatalogue(lastDoneDrills(db, date), athleticFilterFor(db, date), isFlexibilityGoal);
  const covered = new Map<string, number>();
  const picks: Array<{ drill: AthleticDrillContext; sets: number }> = [];
  for (const goal of behind) {
    const need = goal.todaySeconds - (covered.get(goal.goalId) ?? 0);
    if (need <= 0) continue;
    const drill = catalogue
      .filter((d) => d.goals.includes(goal.goalId) && drillSetSeconds(d.exerciseId) > 0 && !picks.some((p) => p.drill.exerciseId === d.exerciseId))
      .sort((a, b) => (a.lastDone ?? '').localeCompare(b.lastDone ?? '') || a.exerciseId.localeCompare(b.exerciseId))[0];
    if (!drill) continue;
    const perSet = drillSetSeconds(drill.exerciseId);
    const sets = Math.min(drill.sets.max, Math.max(drill.sets.min, Math.ceil(need / perSet)));
    picks.push({ drill, sets });
    for (const g of drill.goals) covered.set(g, (covered.get(g) ?? 0) + sets * perSet);
  }
  if (picks.length === 0) return null;

  // Fit the time box: take sets off the longest item while over it (never below 1).
  const secondsOf = (p: { drill: AthleticDrillContext; sets: number }) => p.sets * (drillSetSeconds(p.drill.exerciseId) + restOf(p.drill.exerciseId));
  const total = () => picks.reduce((sum, p) => sum + secondsOf(p), 0);
  while (total() > FLEXIBILITY_BLOCK_MAX_SECONDS) {
    const longest = [...picks].filter((p) => p.sets > 1).sort((a, b) => secondsOf(b) - secondsOf(a))[0];
    if (!longest) break;
    longest.sets -= 1;
  }
  // Short of the minimum: add sets to the furthest-behind picks within their ranges.
  for (let grown = true; grown && total() < FLEXIBILITY_BLOCK_MIN_SECONDS; ) {
    grown = false;
    for (const p of picks) {
      if (total() >= FLEXIBILITY_BLOCK_MIN_SECONDS) break;
      if (p.sets < p.drill.sets.max) {
        p.sets += 1;
        grown = true;
      }
    }
  }

  const repairs: string[] = [];
  const exercises = picks.map(({ drill, sets }) => {
    const targetId = behind.find((g) => drill.goals.includes(g.goalId))?.goalId ?? drill.goals[0];
    const entry = drillEntry(
      drill,
      { targetId, sets, amountMin: drill.amount.min, amountMax: drill.amount.min + Math.floor((drill.amount.max - drill.amount.min) / 2), restSeconds: drill.restSeconds.min, rationale: 'flexibility block' },
      repairs
    );
    // The time box may take a drill below its usual minimum sets (never below 1).
    return { ...entry, sets };
  });
  const names = behind.filter((g) => picks.some((p) => p.drill.goals.includes(g.goalId))).map((g) => `${g.name} ${g.remainingMinutes} of ${g.weeklyMinutes} min left`);
  return {
    minutes: Math.max(1, Math.round(total() / 60)),
    reason: `This week: ${names.join('; ')}.`,
    warmup: exercises.filter((e) => e.block === 'warmup'),
    cooldown: exercises.filter((e) => e.block !== 'warmup'),
  };
}
