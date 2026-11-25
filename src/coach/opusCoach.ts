// Opus coach (2026-11-22, owner decision; docs/logs/2026-11-22-113-opus-coach-app-side.md).
//
// A daily cloud routine running Claude Opus plans the day's session through
// /api/coach/*. It is the main path; the Qwen pipeline
// (src/ai-programmer/) stays as the owner's manual fallback and is left as it is.
//
// The owner's rules for this path:
// - Opus is the coach. The app does NOT check or repair its coaching: no
//   set counts, exercise caps, leg share, time or equipment checks.
// - The app refuses only two things (hard limits): an exercise that is not
//   in the exercise library (it could not be logged), and anything that
//   trains or loads an injury-paused body area.
// - Every session still waits for the owner's approval (the existing
//   pending -> approved -> committed lifecycle).

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { isDrillId } from '../blueprint/athletic.js';
import { ADD_ON_PARTS, isAddOnPart, type AddOnPart } from '../athletic/athleticAddOn.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../ai-programmer/contracts/programmerTypes.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from '../ai-programmer/contracts/programmerTypes.js';
import { endOfLocalDateIso } from '../ai-programmer/service/weekGeneration.js';
import { AIProposalRepo, effectiveStatus, type AIProposalRecord } from '../repositories/aiProposalRepo.js';
import { INJURY_AREAS, InjuryPausesRepo, targetIdsForArea } from '../repositories/injuryPausesRepo.js';
import { newId, nowIso } from '../repositories/ids.js';
import { WorkoutSessionsRepo } from '../repositories/workoutSessionsRepo.js';
import { isValidCalendarDate } from '../engine/dateMath.js';
import { weekdayOfDate } from '../engine/workoutBuilder.js';
import { resolveUserTimezone, todayForUser } from '../lib/userTimezone.js';

/** model_provider of every proposal this path saves; keeps them apart from Qwen's. */
export const OPUS_COACH_PROVIDER = 'opus-coach';
export const OPUS_COACH_DEFAULT_MODEL = 'claude-opus-5-5';

export const COACH_PURPOSES = ['push', 'pull', 'upper', 'athletic', 'legs', 'add_ons'] as const;
export type CoachPurpose = (typeof COACH_PURPOSES)[number];
/** The owner's request for a day (2026-11-22): 'full' = the session only,
 * 'add_ons' = the session plus the leg add-ons. No request = the weekly
 * plan and the coach decide. */
export const COACH_DAY_MODES = ['full', 'add_ons'] as const;
export type CoachDayMode = (typeof COACH_DAY_MODES)[number];

const BLOCKS = ['warmup', 'main', 'quality', 'strength', 'conditioning', 'cooldown', 'addon'] as const;

export interface CoachWeeklyRow {
  targetId: string;
  weeklyTarget: number;
  loggedSoFar: number;
  plannedToday: number;
  plannedRestOfWeek: number;
  reason?: string;
}

export interface CoachDecisionInput {
  subject: string;
  decision: string;
  reason: string;
  successCheck: string;
  checkOn: string;
}

export interface CoachDecisionUpdate {
  id: string;
  status: 'kept' | 'undone' | 'extended';
  outcome: string;
  checkOn?: string;
}

/** What the proposal JSON carries for a coach session (besides the shared fields). */
export interface CoachProposalExtras {
  purpose: CoachPurpose;
  coachNote: string[];
  weeklyTable: CoachWeeklyRow[];
}

export interface CoachProblem {
  index?: number;
  exerciseId?: string;
  problem: string;
}

// ------------------------------------------------------------------ hard limits

/** The two hard limits, read from CURRENT state. Used when saving and again
 * when committing (a pause set after saving still blocks the commit). */
export function coachHardLimitProblems(db: Database.Database, exercises: ReadonlyArray<{ exerciseId: string }>): CoachProblem[] {
  const pauses = new InjuryPausesRepo(db).list();
  const pausedRegions = new Set<string>(pauses.flatMap((p) => [...INJURY_AREAS[p.area].regions]));
  const pausedTargets = new Set<string>(pauses.flatMap((p) => targetIdsForArea(p.area)));
  const problems: CoachProblem[] = [];
  exercises.forEach((e, index) => {
    const ex = BlueprintAdapter.getExercise(e.exerciseId);
    if (!ex) {
      problems.push({ index, exerciseId: e.exerciseId, problem: 'not in the exercise library' });
      return;
    }
    const regions = ex.body_regions ?? [];
    const targets = [...(ex.primary_targets ?? []), ...(ex.secondary_targets ?? []), ...(ex.physique_targets ?? [])];
    const hitRegion = regions.find((r) => pausedRegions.has(r));
    const hitTarget = targets.find((t) => pausedTargets.has(t));
    if (hitRegion || hitTarget) {
      const area = pauses.find((p) => (hitRegion && (INJURY_AREAS[p.area].regions as readonly string[]).includes(hitRegion)) || (hitTarget && targetIdsForArea(p.area).includes(hitTarget)));
      problems.push({ index, exerciseId: e.exerciseId, problem: `trains or loads an injury-paused area (${area?.area ?? hitRegion ?? hitTarget})` });
    }
  });
  return problems;
}

// ------------------------------------------------------------------ input shape

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isText = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const textList = (v: unknown, maxItems = 30): string[] | null => (Array.isArray(v) && v.length <= maxItems && v.every((x) => isText(x)) ? (v as string[]) : null);

export interface ParsedCoachProposal {
  targetDate: string;
  purpose: CoachPurpose;
  model: string;
  runId: string;
  exercises: AIWorkoutExerciseProposal[];
  coachNote: string[];
  weeklyTable: CoachWeeklyRow[];
  decisions: CoachDecisionInput[];
  decisionUpdates: CoachDecisionUpdate[];
  sessionFocus: string[];
}

function targetFor(exerciseId: string, requested: unknown): { targetType: AIWorkoutExerciseProposal['targetType']; targetId: string } | null {
  if (typeof requested === 'string') {
    if (BlueprintAdapter.getTarget(requested)) return { targetType: 'physique_target', targetId: requested };
    if (BlueprintAdapter.getFunctionalGoal(requested)) return { targetType: 'functional_goal', targetId: requested };
  }
  const ex = BlueprintAdapter.getExercise(exerciseId);
  const own = [...(ex?.physique_targets ?? []), ...(ex?.primary_targets ?? [])].find((t) => BlueprintAdapter.getTarget(t));
  if (own) return { targetType: 'physique_target', targetId: own };
  const goal = (ex?.functional_goals ?? []).find((g) => BlueprintAdapter.getFunctionalGoal(g));
  return goal ? { targetType: 'functional_goal', targetId: goal } : null;
}

/** Checks the request's FORMAT only (types and sane number ranges), so it
 * can be stored and logged. Coaching choices are never judged here. */
export function parseCoachProposal(body: unknown): { ok: true; value: ParsedCoachProposal } | { ok: false; problems: CoachProblem[] } {
  const problems: CoachProblem[] = [];
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.targetDate !== 'string' || !isValidCalendarDate(b.targetDate)) problems.push({ problem: 'targetDate must be a real date, YYYY-MM-DD' });
  if (!(COACH_PURPOSES as readonly unknown[]).includes(b.purpose)) problems.push({ problem: `purpose must be one of ${COACH_PURPOSES.join('|')}` });
  const coachNote = textList(b.coachNote, 12);
  if (!coachNote || coachNote.length === 0) problems.push({ problem: 'coachNote must be 1-12 non-empty lines' });
  if (!Array.isArray(b.exercises) || b.exercises.length === 0 || b.exercises.length > 30) problems.push({ problem: 'exercises must be a list of 1-30 exercises' });

  const exercises: AIWorkoutExerciseProposal[] = [];
  (Array.isArray(b.exercises) ? b.exercises : []).forEach((raw, index) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const bad = (problem: string) => problems.push({ index, exerciseId: typeof e.exerciseId === 'string' ? e.exerciseId : undefined, problem });
    if (!isText(e.exerciseId, 200)) return bad('exerciseId is required');
    if (!isInt(e.sets, 1, 12)) bad('sets must be a whole number 1-12');
    const repUnit = e.repUnit === undefined ? 'reps' : e.repUnit;
    if (repUnit !== 'reps' && repUnit !== 'seconds') bad('repUnit must be reps or seconds');
    const repMax = repUnit === 'seconds' ? 600 : 100;
    if (!isInt(e.repsMin, 1, repMax) || !isInt(e.repsMax, 1, repMax) || (e.repsMin as number) > (e.repsMax as number)) bad(`repsMin/repsMax must be whole numbers 1-${repMax}, min <= max`);
    const rirOk = (v: unknown) => v === null || v === undefined || isNum(v, 0, 6);
    if (!rirOk(e.rirMin) || !rirOk(e.rirMax)) bad('rirMin/rirMax must be 0-6 or null');
    if (e.restSeconds !== undefined && !isInt(e.restSeconds, 0, 900)) bad('restSeconds must be 0-900');
    if (e.block !== undefined && !(BLOCKS as readonly unknown[]).includes(e.block)) bad(`block must be one of ${BLOCKS.join('|')}`);
    if (e.targetLoadKg !== undefined && e.targetLoadKg !== null && !isNum(e.targetLoadKg, -200, 500)) bad('targetLoadKg must be a number (negative = assistance)');
    if (e.cue !== undefined && !isText(e.cue, 300)) bad('cue must be a short text');
    const rationale = e.rationale === undefined ? [] : textList(e.rationale, 6);
    if (rationale === null) bad('rationale must be a list of short texts');
    const target = targetFor(e.exerciseId as string, e.targetId);
    const lines = [
      ...(typeof e.targetLoadKg === 'number' ? [`Target load: ${e.targetLoadKg} kg`] : []),
      ...(typeof e.cue === 'string' ? [`Cue: ${e.cue}`] : []),
      ...(rationale ?? []),
    ];
    exercises.push({
      exerciseId: e.exerciseId as string,
      role: isDrillId(e.exerciseId as string) ? 'conditioning' : 'primary',
      targetType: (target?.targetType ?? null) as AIWorkoutExerciseProposal['targetType'],
      targetId: (target?.targetId ?? null) as unknown as string,
      sets: e.sets as number,
      repsMin: e.repsMin as number,
      repsMax: e.repsMax as number,
      rirMin: (e.rirMin ?? null) as number | null,
      rirMax: (e.rirMax ?? null) as number | null,
      ...(e.restSeconds !== undefined ? { restSeconds: e.restSeconds as number } : {}),
      rationale: lines,
      source: 'blueprint',
      ...(repUnit === 'seconds' ? { repUnit: 'seconds' as const } : {}),
      ...(e.block !== undefined ? { block: e.block as AIWorkoutExerciseProposal['block'] } : {}),
    });
  });

  const weeklyTable: CoachWeeklyRow[] = [];
  if (b.weeklyTable !== undefined && !Array.isArray(b.weeklyTable)) problems.push({ problem: 'weeklyTable must be a list' });
  (Array.isArray(b.weeklyTable) ? b.weeklyTable : []).forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const nums = ['weeklyTarget', 'loggedSoFar', 'plannedToday', 'plannedRestOfWeek'] as const;
    if (!isText(r.targetId, 200) || !nums.every((k) => isNum(r[k], 0, 200)) || (r.reason !== undefined && !isText(r.reason, 600))) {
      problems.push({ problem: `weeklyTable[${i}] needs targetId and the four numbers (0-200), reason optional` });
      return;
    }
    weeklyTable.push({
      targetId: r.targetId as string,
      weeklyTarget: r.weeklyTarget as number,
      loggedSoFar: r.loggedSoFar as number,
      plannedToday: r.plannedToday as number,
      plannedRestOfWeek: r.plannedRestOfWeek as number,
      ...(r.reason !== undefined ? { reason: r.reason as string } : {}),
    });
  });

  const decisions: CoachDecisionInput[] = [];
  (Array.isArray(b.decisions) ? b.decisions : []).forEach((raw, i) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    if (!isText(d.subject, 200) || !isText(d.decision, 600) || !isText(d.reason, 600) || !isText(d.successCheck, 600) || typeof d.checkOn !== 'string' || !isValidCalendarDate(d.checkOn)) {
      problems.push({ problem: `decisions[${i}] needs subject, decision, reason, successCheck and checkOn (YYYY-MM-DD)` });
      return;
    }
    decisions.push({ subject: d.subject, decision: d.decision, reason: d.reason, successCheck: d.successCheck, checkOn: d.checkOn });
  });
  const decisionUpdates: CoachDecisionUpdate[] = [];
  (Array.isArray(b.decisionUpdates) ? b.decisionUpdates : []).forEach((raw, i) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    if (!isText(d.id, 200) || !['kept', 'undone', 'extended'].includes(d.status as string) || !isText(d.outcome, 600) || (d.checkOn !== undefined && (typeof d.checkOn !== 'string' || !isValidCalendarDate(d.checkOn)))) {
      problems.push({ problem: `decisionUpdates[${i}] needs id, status (kept|undone|extended), outcome, optional checkOn` });
      return;
    }
    decisionUpdates.push({ id: d.id, status: d.status as CoachDecisionUpdate['status'], outcome: d.outcome, ...(typeof d.checkOn === 'string' ? { checkOn: d.checkOn } : {}) });
  });

  const focus = textList(b.sessionFocus, 6);
  if (problems.length > 0) return { ok: false, problems };
  const purpose = b.purpose as CoachPurpose;
  const label = purpose === 'add_ons' ? 'Add-ons' : purpose[0]!.toUpperCase() + purpose.slice(1);
  return {
    ok: true,
    value: {
      targetDate: b.targetDate as string,
      purpose,
      model: isText(b.model, 100) ? b.model : OPUS_COACH_DEFAULT_MODEL,
      runId: isText(b.runId, 200) ? b.runId : newId('coachrun'),
      exercises,
      coachNote: coachNote!,
      weeklyTable,
      decisions,
      decisionUpdates,
      // sessionFocus[0] is the purpose label: weeklyLedger reads it to know
      // which day type a committed session was.
      sessionFocus: [label, ...(focus ?? []).filter((f) => f !== label)],
    },
  };
}

// ------------------------------------------------------------------ save

export class CoachSaveRefused extends Error {
  constructor(public problems: CoachProblem[]) {
    super(problems.map((p) => p.problem).join('; '));
  }
}

/** Saves a coach session as a PENDING proposal (owner approves in the app).
 * Refuses only on the hard limits and on a date that can no longer take a
 * session. A pending/approved coach proposal for the same date is replaced. */
export function saveCoachProposal(db: Database.Database, input: ParsedCoachProposal): AIProposalRecord {
  const today = todayForUser(db);
  if (input.targetDate < today) throw new CoachSaveRefused([{ problem: `targetDate ${input.targetDate} is in the past (today is ${today})` }]);
  const locked = new WorkoutSessionsRepo(db).listSessionsByDate(input.targetDate).filter((s) => s.session_type !== 'badminton' && (s.status === 'completed' || s.status === 'in_progress'));
  if (locked.length > 0) throw new CoachSaveRefused([{ problem: `${input.targetDate} already has a ${locked[0]!.status} gym session` }]);
  const hard = coachHardLimitProblems(db, input.exercises);
  if (hard.length > 0) throw new CoachSaveRefused(hard);

  const repo = new AIProposalRepo(db);
  const proposalId = randomUUID();
  const proposal: AIWorkoutSessionProposal = {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId,
    mode: 'generate_session',
    targetDate: input.targetDate,
    weekday: weekdayOfDate(input.targetDate),
    sessionFocus: input.sessionFocus,
    sessionKind: 'coach',
    exercises: input.exercises,
    programmingRationale: input.coachNote,
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
    coach: { purpose: input.purpose, coachNote: input.coachNote, weeklyTable: input.weeklyTable },
  };
  const tx = db.transaction(() => {
    const previous = repo.findLatestForTargetDate(input.targetDate, 'coach');
    if (previous) {
      const status = effectiveStatus(previous, nowIso());
      if (status === 'pending' || status === 'approved') {
        repo.reject(previous.id, 'Replaced by a newer coach run');
      }
    }
    const record = repo.create({
      proposal,
      contextHash: 'opus-coach',
      blueprintCommit: BlueprintAdapter.getManifest().sourceCommit,
      modelProvider: OPUS_COACH_PROVIDER,
      modelName: input.model,
      requestId: input.runId,
      expiresAt: endOfLocalDateIso(input.targetDate, resolveUserTimezone(db)),
    });
    const now = nowIso();
    const insert = db.prepare(
      `INSERT INTO coach_decisions (id, decided_on, subject, decision, reason, success_check, check_on, status, outcome, proposal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)`
    );
    for (const d of input.decisions) insert.run(newId('coachdec'), input.targetDate, d.subject, d.decision, d.reason, d.successCheck, d.checkOn, record.id, now, now);
    const update = db.prepare('UPDATE coach_decisions SET status = ?, outcome = ?, check_on = COALESCE(?, check_on), updated_at = ? WHERE id = ?');
    for (const u of input.decisionUpdates) update.run(u.status, u.outcome, u.checkOn ?? null, now, u.id);
    recordCoachRun(db, input.targetDate, 'saved', null, record.id);
    return record;
  });
  return tx();
}

// ------------------------------------------------------------------ runs, day requests

export function recordCoachRun(db: Database.Database, targetDate: string, outcome: 'saved' | 'no_run_needed' | 'failed', reason: string | null, proposalId: string | null = null): void {
  db.prepare('INSERT INTO coach_runs (id, target_date, outcome, reason, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('coachrun'), targetDate, outcome, reason, proposalId, nowIso());
}

export interface CoachRunRow {
  targetDate: string;
  outcome: 'saved' | 'no_run_needed' | 'failed';
  reason: string | null;
  proposalId: string | null;
  createdAt: string;
}

export function latestCoachRun(db: Database.Database, targetDate: string): CoachRunRow | null {
  const row = db
    .prepare('SELECT target_date AS targetDate, outcome, reason, proposal_id AS proposalId, created_at AS createdAt FROM coach_runs WHERE target_date = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(targetDate) as CoachRunRow | undefined;
  return row ?? null;
}

export function getDayRequest(db: Database.Database, date: string): CoachDayMode | null {
  const row = db.prepare('SELECT mode FROM coach_day_requests WHERE date = ?').get(date) as { mode: CoachDayMode } | undefined;
  return row?.mode ?? null;
}

/** The leg add-on parts the owner picked for the day (2026-11-25), in
 * ADD_ON_PARTS order. Null unless the day is 'add_ons'; an add-ons day saved
 * without a pick means all four parts. */
export function getDayAddOnParts(db: Database.Database, date: string): AddOnPart[] | null {
  const row = db.prepare('SELECT mode, parts_json FROM coach_day_requests WHERE date = ?').get(date) as { mode: CoachDayMode; parts_json: string | null } | undefined;
  if (row?.mode !== 'add_ons') return null;
  let picked: unknown = null;
  try {
    picked = row.parts_json === null ? null : JSON.parse(row.parts_json);
  } catch {
    picked = null;
  }
  if (!Array.isArray(picked)) return [...ADD_ON_PARTS];
  const list = picked as unknown[];
  const parts = ADD_ON_PARTS.filter((p) => list.includes(p));
  return parts.length ? parts : [...ADD_ON_PARTS];
}

/** null clears the request (the weekly plan decides). `parts` is kept only
 * for 'add_ons'; omitted = all four parts. */
export function setDayRequest(db: Database.Database, date: string, mode: CoachDayMode | null, parts?: readonly AddOnPart[]): void {
  if (mode === null) {
    db.prepare('DELETE FROM coach_day_requests WHERE date = ?').run(date);
    return;
  }
  const partsJson = mode === 'add_ons' && parts !== undefined ? JSON.stringify(ADD_ON_PARTS.filter((p) => parts.includes(p))) : null;
  db.prepare('INSERT INTO coach_day_requests (date, mode, parts_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (date) DO UPDATE SET mode = excluded.mode, parts_json = excluded.parts_json, updated_at = excluded.updated_at').run(date, mode, partsJson, nowIso());
}

export const isAddOnPartList = (v: unknown): v is AddOnPart[] => Array.isArray(v) && v.every(isAddOnPart);

export function listDecisions(db: Database.Database, sinceDate: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT id, decided_on AS decidedOn, subject, decision, reason, success_check AS successCheck, check_on AS checkOn, status, outcome, proposal_id AS proposalId
         FROM coach_decisions WHERE status = 'open' OR decided_on >= ? ORDER BY decided_on DESC, created_at DESC`
    )
    .all(sinceDate) as Array<Record<string, unknown>>;
}
