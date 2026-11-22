// Opus coach (2026-11-22): the raw data the coach reads each morning
// (GET /api/coach/context). Facts only, no pre-digested plan: the coach
// decides. Food data is not here; the routine reads it from the food
// tracker itself.

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { addDays } from '../engine/dateMath.js';
import { programmingWeekStart, weekdayOfDate } from '../engine/workoutBuilder.js';
import { volumeOverview } from '../ai-programmer/planning/weeklyLedger.js';
import { weekGymDays } from '../ai-programmer/service/weekGeneration.js';
import { INJURY_AREAS, InjuryPausesRepo, targetIdsForArea } from '../repositories/injuryPausesRepo.js';
import { resolveUserTimezone, todayForUser } from '../lib/userTimezone.js';
import { getDayRequest, listDecisions, OPUS_COACH_PROVIDER } from './opusCoach.js';

export const COACH_CONTEXT_VERSION = 'opus-coach-context.v1';
export const COACH_HISTORY_DAYS = 42;

const parseJson = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const targetName = (id: string) => BlueprintAdapter.getTarget(id)?.name ?? BlueprintAdapter.listVolumeGroups().find((g) => g.id === id)?.name ?? BlueprintAdapter.getFunctionalGoal(id)?.name ?? id;

export function buildCoachContext(db: Database.Database, targetDate: string): Record<string, unknown> {
  const today = todayForUser(db);
  const weekStart = programmingWeekStart(targetDate);
  const from = addDays(targetDate, -COACH_HISTORY_DAYS);

  const profile = db.prepare('SELECT * FROM training_profiles LIMIT 1').get() as Record<string, unknown> | undefined;
  const activities = db.prepare('SELECT day, activity_type AS activity, notes FROM training_profile_activities ORDER BY day').all();
  const experience = db.prepare("SELECT value FROM user_profile_factors WHERE factor_name = 'training_experience'").get() as { value: string } | undefined;

  const goals = (db.prepare('SELECT id, goal_type, blueprint_ref, priority, notes FROM goals WHERE active = 1 ORDER BY priority, created_at').all() as Array<Record<string, unknown>>).map((g) => {
    const outcome = typeof g.blueprint_ref === 'string' ? BlueprintAdapter.getAestheticGoal(g.blueprint_ref) : undefined;
    return {
      goalId: g.id,
      type: g.goal_type,
      blueprintRef: g.blueprint_ref,
      name: outcome?.display_name ?? BlueprintAdapter.getFunctionalGoal(String(g.blueprint_ref))?.name ?? g.blueprint_ref,
      priority: g.priority,
      notes: g.notes,
      primaryTargets: outcome?.primary_targets ?? [],
      volumeLevels: outcome?.volume_levels ?? [],
    };
  });

  const overview = volumeOverview(db, targetDate);
  const weeklyTargets = overview.entries.map((e) => ({
    targetId: e.targetId,
    name: targetName(e.targetId),
    isGoal: e.isGoal,
    shareOf: e.shareOf,
    weeklyTarget: e.number,
    loggedSoFar: e.done,
    remaining: e.remaining,
    laterGymSessionsThisWeek: e.laterSessions,
  }));

  const sessions = (db.prepare('SELECT * FROM workout_sessions WHERE date >= ? AND date <= ? ORDER BY date, start_time').all(from, addDays(targetDate, 6)) as Array<Record<string, unknown>>).map((s) => {
    const exercises = (db.prepare('SELECT * FROM workout_exercises WHERE workout_session_id = ? ORDER BY order_index').all(s.session_id) as Array<Record<string, unknown>>).map((e) => ({
      exerciseId: e.exercise_id,
      name: BlueprintAdapter.getExercise(String(e.exercise_id))?.name ?? e.exercise_id,
      targetId: e.target_id,
      planned: { sets: e.target_sets, repsMin: e.target_reps_min, repsMax: e.target_reps_max, rirMin: e.target_rir_min, rirMax: e.target_rir_max },
      equipment: e.equipment,
      attachment: e.attachment,
      repUnit: e.rep_unit ?? 'reps',
      sets: (db.prepare('SELECT set_number, weight, reps, completed, rir, technique, notes FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number').all(e.id) as Array<Record<string, unknown>>).map((t) => ({
        set: t.set_number,
        kg: t.weight,
        reps: t.reps,
        rir: t.rir,
        done: t.completed === 1,
        ...(t.technique ? { technique: t.technique } : {}),
        ...(t.notes ? { notes: t.notes } : {}),
      })),
    }));
    const badminton = db.prepare('SELECT intensity, format, games_count, session_quality, post_session_fatigue, notes FROM badminton_session_details WHERE workout_session_id = ?').get(s.session_id);
    return {
      sessionId: s.session_id,
      date: s.date,
      weekday: weekdayOfDate(String(s.date)),
      type: s.session_type,
      status: s.status,
      source: s.source_type,
      durationMinutes: s.duration_minutes,
      notes: s.notes,
      ...(badminton ? { badminton } : {}),
      exercises,
    };
  });

  const proposals = (db.prepare('SELECT id, status, target_date, model_provider, proposal_json, rejection_reason, created_at FROM ai_program_proposals WHERE target_date >= ? AND target_date <= ? ORDER BY target_date, created_at').all(addDays(targetDate, -10), addDays(targetDate, 6)) as Array<Record<string, unknown>>).map((p) => {
    const json = parseJson(String(p.proposal_json)) as { sessionFocus?: string[]; exercises?: Array<Record<string, unknown>>; coach?: unknown } | null;
    return {
      proposalId: p.id,
      date: p.target_date,
      status: p.status,
      source: p.model_provider === OPUS_COACH_PROVIDER ? 'coach' : 'qwen',
      createdAt: p.created_at,
      focus: json?.sessionFocus ?? [],
      exercises: (json?.exercises ?? []).map((e) => ({ exerciseId: e.exerciseId, sets: e.sets, repsMin: e.repsMin, repsMax: e.repsMax, rirMin: e.rirMin, rirMax: e.rirMax })),
      ...(p.rejection_reason ? { discardReason: p.rejection_reason } : {}),
      ...(json?.coach ? { coach: json.coach } : {}),
    };
  });

  const pauses = new InjuryPausesRepo(db).list().map((p) => ({ area: p.area, since: p.since, note: p.note, regions: INJURY_AREAS[p.area].regions, targetIds: targetIdsForArea(p.area) }));

  const library = BlueprintAdapter.getExercises().map((e) => ({
    id: e.id,
    name: e.name,
    primaryTargets: e.primary_targets,
    secondaryTargets: e.secondary_targets ?? [],
    bodyRegions: e.body_regions,
    equipment: e.equipment,
    type: e.exercise_type,
    laterality: e.laterality,
    fatigueCost: e.fatigue_cost,
    ...(e.training_mode ? { trainingMode: e.training_mode } : {}),
    ...(e.functional_goals ? { functionalGoals: e.functional_goals } : {}),
  }));

  return {
    version: COACH_CONTEXT_VERSION,
    today,
    targetDate,
    weekday: weekdayOfDate(targetDate),
    timezone: resolveUserTimezone(db),
    dayRequest: getDayRequest(db, targetDate),
    profile: profile
      ? {
          trainingDays: parseJson(profile.training_days as string),
          split: profile.preferred_split,
          sessionMinutes: { default: profile.default_session_duration_minutes, min: profile.minimum_session_duration_minutes, max: profile.maximum_session_duration_minutes },
          legTraining: profile.leg_training,
          equipment: parseJson(profile.available_equipment as string),
          otherActivities: activities,
          trainingExperience: experience?.value ?? null,
        }
      : null,
    thisWeek: { weekStart, gymDays: weekGymDays(db, weekStart) },
    goals,
    weeklyTargets,
    injuryPauses: pauses,
    exercisePreferences: db.prepare('SELECT exercise_id AS exerciseId, preference, temporary_until AS until, reason FROM exercise_preferences WHERE temporary_until IS NULL OR temporary_until >= ?').all(targetDate),
    sessions,
    proposals,
    dayNotes: db.prepare('SELECT date, note FROM day_notes WHERE date >= ? AND date <= ? ORDER BY date').all(from, targetDate),
    measurements: db.prepare('SELECT date, metric_name AS metric, value, unit, notes FROM measurements WHERE date >= ? ORDER BY date').all(addDays(targetDate, -90)),
    decisions: listDecisions(db, addDays(targetDate, -60)),
    recentRuns: db.prepare('SELECT target_date AS date, outcome, reason, created_at AS at FROM coach_runs WHERE target_date >= ? ORDER BY created_at DESC LIMIT 20').all(addDays(targetDate, -14)),
    targets: BlueprintAdapter.getTargets().map((t) => ({ id: t.id, name: t.name, region: t.parent_region })),
    library,
  };
}
