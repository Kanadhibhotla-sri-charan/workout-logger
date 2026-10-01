// Explicit week generation (2026-10-01). POST /api/ai-programmer/generate-week
// creates per-day PENDING proposals for the week's remaining gym days,
// using exactly the single-day machinery: buildProgrammerContext ->
// planSession -> the planned AI contract -> runProposalPipeline ->
// AIProposalRepo (via AIProgrammerService.generatePlannedDayProposal).
// What this module adds is only the week-level lifecycle around it:
//   - the allowed-week window (current week; next week from Saturday);
//   - a durable per-week run guard, acquired synchronously BEFORE any
//     provider await (WeekGenerationRunRepo.acquire);
//   - day order, the deterministic weekly purpose split
//     (assignSessionPurposes) and projected exposure from the week's
//     earlier days that already have a live proposal — including those
//     generated earlier in the same run (projectedExposure.ts);
//   - failure classes: provider failures stop the run and back off,
//     quality failures gate that day's exact context, SessionPlan
//     refusals never reach the provider.
// Reads (readWeekGenerationState) are pure: no writes, no provider.

import type Database from 'better-sqlite3';
import { WEEKDAYS, type Weekday } from '../../contracts/types.js';
import { addDays } from '../../engine/dateMath.js';
import { assignSessionPurposes } from '../../engine/sessionPurpose.js';
import { programmingWeekStart, weekdayOfDate } from '../../engine/workoutBuilder.js';
import { applyWeekOverrides } from '../../lib/dailyActivity.js';
import { resolveUserTimezone, todayForUser } from '../../lib/userTimezone.js';
import { AIProposalRepo, effectiveStatus } from '../../repositories/aiProposalRepo.js';
import { nowIso } from '../../repositories/ids.js';
import { NonGoalRotationRepo } from '../../repositories/nonGoalRotationRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeekGenerationRunRepo, type WeekRunDay, type WeekRunFailureClass, type WeekRunRecord } from '../../repositories/weekGenerationRunRepo.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { buildProgrammerContext } from '../context/programmerContextBuilder.js';
import type { ProjectedSession } from '../context/projectedExposure.js';
import {
  AIProgrammerError,
  AIProviderAuthenticationError,
  AIProviderInvalidResponseError,
  AIProviderRateLimitedError,
  AIProviderTimeoutError,
  AIProviderUnavailableError,
  AIWeekGenerationBackoffError,
  AIWeekGenerationDisabledError,
  AIWeekGenerationNotAllowedError,
  AIWeekGenerationNothingToDoError,
} from '../errors.js';
import { planSession } from '../planning/sessionPlanner.js';
import { aiWeekGenerationMode, isAiProgrammerEnabled, isPlannedGenerationEnabled } from '../provider/config.js';
import { boundDiagnosticIssues } from '../validation/diagnosticsBounds.js';
import type { AIProgrammerService } from './aiProgrammerService.js';
import { isGatedGenerationFailure } from './generationFailureMemory.js';
import type { SessionPurpose } from '../../engine/config.js';

/** A running run whose heartbeat is older than this is treated as abandoned (process crash mid-run). */
export const WEEK_RUN_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
/** While a provider call is in flight the heartbeat is refreshed this often, so a live
 * call — however long it takes — never looks stale; only a dead process stops refreshing. */
export const WEEK_RUN_HEARTBEAT_INTERVAL_MS = 30 * 1000;
/** Provider rejected the credentials (or the key's budget): back off before paying again. */
export const AUTH_BACKOFF_MS = 30 * 60 * 1000;
/** Transient provider failure: backoff by number of consecutive provider-failed runs for the week. */
export const TRANSIENT_BACKOFF_MS = [2, 10, 30, 60].map((m) => m * 60 * 1000);

// ---------------------------------------------------------------- window

/** Weeks paid generation may run for: the user's current programming week,
 * plus next week from Saturday onward. Never past weeks, never further ahead. */
export function allowedGenerationWeeks(db: Database.Database): string[] {
  const today = todayForUser(db);
  const current = programmingWeekStart(today);
  const weekday = weekdayOfDate(today);
  return weekday === 'saturday' || weekday === 'sunday' ? [current, addDays(current, 7)] : [current];
}

function windowViolation(db: Database.Database, weekStart: string): string | null {
  if (programmingWeekStart(weekStart) !== weekStart) return 'weekStart must be the first day of a programming week';
  if (!allowedGenerationWeeks(db).includes(weekStart)) return 'only the current week (and next week from Saturday) can be generated';
  return null;
}

// ---------------------------------------------------------------- week days

export interface WeekGymDay {
  date: string;
  weekday: Weekday;
  purpose: SessionPurpose | null;
}

/** The week's gym days in order, with the deterministic weekly purpose split
 * (the same assignSessionPurposes input the deterministic planner builds). */
export function weekGymDays(db: Database.Database, weekStart: string): WeekGymDay[] {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) return [];
  const overrides = new WeekActivityOverridesRepo(db).get(profile.id, weekStart);
  const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
  const orderedGymDays = WEEKDAYS.filter((d) => effective.trainingDays.includes(d));
  const badmintonDays = effective.otherActivitySchedule.filter((a) => a.activity_type === 'badminton').map((a) => a.day);
  const { purposes } = assignSessionPurposes(orderedGymDays, badmintonDays);
  return orderedGymDays.map((weekday) => ({ date: addDays(weekStart, WEEKDAYS.indexOf(weekday)), weekday, purpose: purposes.get(weekday) ?? null }));
}

export type DayEligibility = { eligible: true } | { eligible: false; reason: 'past' | 'has_session' | 'has_proposal'; detail?: string };

/** Read-only: may this date still get a week-run proposal? (Re-checked
 * immediately before every paid call, not only when the run starts.) */
export function dayEligibility(db: Database.Database, date: string, today: string, now: string): DayEligibility {
  if (date < today) return { eligible: false, reason: 'past' };
  const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(date);
  if (sessions.length > 0) return { eligible: false, reason: 'has_session', detail: sessions[0]!.status };
  const latest = new AIProposalRepo(db).findLatestForTargetDate(date);
  if (latest) {
    const status = effectiveStatus(latest, now);
    if (status === 'pending' || status === 'approved') return { eligible: false, reason: 'has_proposal', detail: `${status}:${latest.id}` };
  }
  return { eligible: true };
}

/** Start of the next local day in `timeZone`, as a UTC ISO instant: a week-run
 * proposal stays usable through the whole of its target date. */
export function endOfLocalDateIso(date: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const offsetAt = (ms: number) => {
    const parts: Record<string, number> = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms))
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)])
    );
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - ms;
  };
  const nextMidnightAsUtc = Date.UTC(y, m - 1, d + 1);
  let instant = nextMidnightAsUtc - offsetAt(nextMidnightAsUtc);
  instant = nextMidnightAsUtc - offsetAt(instant); // settle across a DST change
  return new Date(instant).toISOString();
}

// ---------------------------------------------------------------- start a run

export type StartWeekGenerationResult =
  | { kind: 'started'; run: WeekRunRecord; done: Promise<WeekRunRecord> }
  | { kind: 'in_progress'; run: WeekRunRecord };

export interface StartWeekGenerationOptions {
  confirmRetry?: boolean;
}

/** Validates, acquires the guard (synchronously — no await before the run
 * row exists) and launches the run. The returned `done` resolves when the
 * run finishes; callers (the route) need not await it. */
export function startWeekGeneration(
  db: Database.Database,
  service: AIProgrammerService,
  weekStart: string,
  options: StartWeekGenerationOptions = {}
): StartWeekGenerationResult {
  if (aiWeekGenerationMode() !== 'explicit') throw new AIWeekGenerationDisabledError();
  if (!isAiProgrammerEnabled() || !isPlannedGenerationEnabled()) throw new AIWeekGenerationDisabledError();
  const violation = windowViolation(db, weekStart);
  if (violation) throw new AIWeekGenerationNotAllowedError(weekStart, allowedGenerationWeeks(db), violation);

  const today = todayForUser(db);
  const now = nowIso();
  const gymDays = weekGymDays(db, weekStart);
  const ineligible: Array<{ date: string; reason: string }> = [];
  const days: WeekRunDay[] = [];
  for (const day of gymDays) {
    const e = dayEligibility(db, day.date, today, now);
    if (e.eligible) days.push({ date: day.date, purpose: day.purpose, outcome: 'planned' });
    else ineligible.push({ date: day.date, reason: e.reason });
  }

  const repo = new WeekGenerationRunRepo(db);
  const staleBefore = new Date(Date.now() - WEEK_RUN_HEARTBEAT_TIMEOUT_MS).toISOString();
  // The guard is checked before "nothing to do" so a concurrent request for a week whose days were
  // just claimed by a running run reports that run instead of "nothing to do".
  const running = repo.running(weekStart);
  if (running && running.heartbeatAt >= staleBefore) return { kind: 'in_progress', run: running };
  if (days.length === 0) throw new AIWeekGenerationNothingToDoError(weekStart, ineligible);

  const acquired = repo.acquire(weekStart, days, now, staleBefore);
  if (acquired.kind === 'in_progress') return { kind: 'in_progress', run: acquired.run };
  if (acquired.kind === 'backoff') throw new AIWeekGenerationBackoffError(weekStart, acquired.retryAfter, acquired.run.failureClass);

  const run = acquired.run;
  const done = executeRun(db, service, run, options).catch((err) => {
    // A bug, never a provider/quality outcome (those are handled per day): close the run so the guard is released.
    console.error('[ai-programmer] week generation run crashed', JSON.stringify({ runId: run.id, weekStart, error: err instanceof Error ? err.name : 'unknown' }));
    const current = repo.getById(run.id);
    repo.finish(run.id, 'failed', current?.days ?? run.days, null, null);
    return repo.getById(run.id)!;
  });
  return { kind: 'started', run, done };
}

// ---------------------------------------------------------------- projection

/** Planned-but-not-yet-trained work on the week's days before `date`: each
 * earlier day's live proposal (pending/approved, or committed with its
 * session not yet started). Read from the database, so it covers days
 * generated earlier in this run AND by earlier runs or single-day
 * generation — a re-attempted day is planned against the same projection
 * (and therefore the same contextHash) as its first attempt. Days already
 * trained are real history and are not projected. */
export function projectedSessionsBefore(db: Database.Database, weekStart: string, date: string): ProjectedSession[] {
  const proposals = new AIProposalRepo(db);
  const sessions = new WorkoutSessionsRepo(db);
  const now = nowIso();
  const out: ProjectedSession[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    if (day >= date) break;
    if (sessions.listSessionsByDate(day).some((s) => s.status === 'completed' || s.status === 'in_progress')) continue;
    const latest = proposals.findLatestForTargetDate(day);
    if (!latest) continue;
    const status = effectiveStatus(latest, now);
    if (status !== 'pending' && status !== 'approved' && status !== 'committed') continue;
    out.push({ date: day, exercises: latest.proposal.exercises.map((e) => ({ exerciseId: e.exerciseId, sets: e.sets })) });
  }
  return out;
}

// ---------------------------------------------------------------- the run

const isProviderAuthFailure = (err: unknown) => err instanceof AIProviderAuthenticationError;
const isProviderTransientFailure = (err: unknown) =>
  err instanceof AIProviderUnavailableError ||
  err instanceof AIProviderTimeoutError ||
  err instanceof AIProviderRateLimitedError ||
  err instanceof AIProviderInvalidResponseError;

function backoffAfter(repo: WeekGenerationRunRepo, weekStart: string, failureClass: WeekRunFailureClass): string {
  if (failureClass === 'provider_auth') return new Date(Date.now() + AUTH_BACKOFF_MS).toISOString();
  const recent = repo.recentFinished(weekStart, TRANSIENT_BACKOFF_MS.length);
  let consecutive = 0;
  for (const r of recent) {
    if (r.failureClass !== 'provider_transient') break;
    consecutive++;
  }
  return new Date(Date.now() + TRANSIENT_BACKOFF_MS[Math.min(consecutive, TRANSIENT_BACKOFF_MS.length - 1)]!).toISOString();
}

/** Keeps the run's lease alive while `work` (a provider call) is in flight. */
async function withHeartbeat<T>(repo: WeekGenerationRunRepo, runId: string, days: WeekRunDay[], work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => repo.update(runId, days), WEEK_RUN_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function executeRun(db: Database.Database, service: AIProgrammerService, run: WeekRunRecord, options: StartWeekGenerationOptions): Promise<WeekRunRecord> {
  const repo = new WeekGenerationRunRepo(db);
  const days = run.days.map((d) => ({ ...d }));
  const timeZone = resolveUserTimezone(db);
  const userId = new UsersRepo(db).getOrCreateDefault().id;
  let providerFailure: WeekRunFailureClass | null = null;

  for (const day of days) {
    if (providerFailure) {
      day.outcome = 'not_attempted';
      continue;
    }
    repo.update(run.id, days); // heartbeat between days

    // Re-check immediately before the paid call: the day may have been generated, committed or locked meanwhile.
    const eligibility = dayEligibility(db, day.date, todayForUser(db), nowIso());
    if (!eligibility.eligible) {
      day.outcome = 'skipped';
      day.code = eligibility.reason;
      continue;
    }

    try {
      const projected = projectedSessionsBefore(db, run.weekStart, day.date);
      const context = buildProgrammerContext(db, {
        targetDate: day.date,
        requestedSessionPurpose: (day.purpose as SessionPurpose | null) ?? undefined,
        projectedSessions: projected,
      });
      day.contextHash = context.contextHash;

      const previous = repo.dayFailure(day.date, context.contextHash);
      if (previous && !options.confirmRetry) {
        day.outcome = 'gated';
        day.code = previous.code;
        continue;
      }

      const plan = planSession(context, { nonGoalRotationCursor: new NonGoalRotationRepo(db).cursorFor(userId, context.reportingBoundary.weekStart) });
      console.log('[ai-programmer] week run session plan', JSON.stringify({ runId: run.id, date: day.date, purpose: plan.purpose, refusals: plan.refusals.map((r) => r.code), projectedDays: projected.length }));
      if (plan.refusals.length > 0) {
        day.outcome = 'refused';
        day.code = plan.refusals.map((r) => r.code).join(',');
        continue; // never paid for
      }

      const result = await withHeartbeat(repo, run.id, days, () =>
        service.generatePlannedDayProposal(context, plan, { weekRunId: run.id, expiresAt: endOfLocalDateIso(day.date, timeZone) })
      );
      if (previous) repo.clearDayFailure(day.date, context.contextHash);
      day.outcome = 'proposal_pending';
      day.proposalId = result.proposalId;
    } catch (err) {
      if (isGatedGenerationFailure(err)) {
        day.outcome = 'failed_quality';
        day.code = err.code;
        const issues = (err.details as { issues?: unknown } | undefined)?.issues;
        const list = Array.isArray(issues) ? issues.filter((i): i is string => typeof i === 'string') : [err.publicMessage];
        if (day.contextHash) repo.recordDayFailure(day.date, day.contextHash, err.code, boundDiagnosticIssues(list), run.id);
      } else if (isProviderAuthFailure(err) || isProviderTransientFailure(err)) {
        providerFailure = isProviderAuthFailure(err) ? 'provider_auth' : 'provider_transient';
        day.outcome = 'failed_provider';
        day.code = (err as AIProgrammerError).code;
      } else if (err instanceof AIProgrammerError) {
        day.outcome = 'skipped'; // e.g. the date became not editable between re-check and context build
        day.code = err.code;
      } else {
        throw err;
      }
    }
  }

  const succeeded = days.filter((d) => d.outcome === 'proposal_pending').length;
  const status = succeeded === days.length ? 'completed' : succeeded > 0 ? 'partially_completed' : 'failed';
  repo.finish(run.id, status, days, providerFailure, providerFailure ? backoffAfter(repo, run.weekStart, providerFailure) : null);
  console.log('[ai-programmer] week generation run finished', JSON.stringify({ runId: run.id, weekStart: run.weekStart, status, failureClass: providerFailure, days: days.map((d) => `${d.date}:${d.outcome}`) }));
  return repo.getById(run.id)!;
}

// ---------------------------------------------------------------- read state (pure)

export type WeekDayGenerationStatus =
  | 'past'
  | 'locked'
  | 'committed'
  | 'proposal_pending'
  | 'approved'
  | 'generating'
  | 'refused'
  | 'failed_quality'
  | 'gated'
  | 'failed_provider'
  | 'not_generated';

export interface WeekGenerationState {
  mode: 'explicit';
  status: 'generating' | 'saved' | 'generated' | 'partially_generated' | 'failed' | 'not_generated';
  canGenerate: boolean;
  reason?: 'outside_window' | 'in_progress' | 'provider_unavailable' | 'nothing_to_generate' | 'disabled';
  retryAfter?: string;
  runId?: string;
  perDay: Array<{ date: string; weekday: Weekday; purpose: SessionPurpose | null; status: WeekDayGenerationStatus; proposalId?: string; code?: string }>;
}

/** Pure read for GET /week and /today in explicit mode: never writes (not
 * even the lazy proposal-expiry transition) and never calls the provider. */
export function readWeekGenerationState(db: Database.Database, weekStart: string, programSaved: boolean): WeekGenerationState {
  const today = todayForUser(db);
  const now = nowIso();
  const repo = new WeekGenerationRunRepo(db);
  const proposals = new AIProposalRepo(db);
  const sessions = new WorkoutSessionsRepo(db);
  const staleBefore = new Date(Date.now() - WEEK_RUN_HEARTBEAT_TIMEOUT_MS).toISOString();
  const runningRaw = repo.running(weekStart);
  const running = runningRaw && runningRaw.heartbeatAt >= staleBefore ? runningRaw : undefined;
  const lastRun = running ?? repo.latestFinished(weekStart);

  const perDay = weekGymDays(db, weekStart).map((day) => {
    const base = { date: day.date, weekday: day.weekday, purpose: day.purpose };
    const daySessions = sessions.listSessionsByDate(day.date);
    if (daySessions.some((s) => s.status === 'completed' || s.status === 'in_progress')) return { ...base, status: 'locked' as const };
    if (daySessions.length > 0) return { ...base, status: 'committed' as const };
    const latest = proposals.findLatestForTargetDate(day.date);
    const latestStatus = latest ? effectiveStatus(latest, now) : undefined;
    if (latest && latestStatus === 'pending') return { ...base, status: 'proposal_pending' as const, proposalId: latest.id };
    if (latest && latestStatus === 'approved') return { ...base, status: 'approved' as const, proposalId: latest.id };
    if (day.date < today) return { ...base, status: 'past' as const };
    const runDay = lastRun?.days.find((d) => d.date === day.date);
    if (running && runDay?.outcome === 'planned') return { ...base, status: 'generating' as const };
    if (runDay && ['refused', 'failed_quality', 'gated', 'failed_provider'].includes(runDay.outcome)) {
      return { ...base, status: runDay.outcome as WeekDayGenerationStatus, ...(runDay.code ? { code: runDay.code } : {}) };
    }
    return { ...base, status: 'not_generated' as const };
  });

  const eligibleRemaining = perDay.filter((d) => ['not_generated', 'refused', 'failed_quality', 'gated', 'failed_provider'].includes(d.status)).length;
  const proposed = perDay.filter((d) => ['proposal_pending', 'approved', 'committed', 'locked'].includes(d.status)).length;
  const backoff = !running && lastRun?.nextAllowedAt && lastRun.nextAllowedAt > now ? lastRun.nextAllowedAt : undefined;
  const enabled = aiWeekGenerationMode() === 'explicit' && isAiProgrammerEnabled() && isPlannedGenerationEnabled();
  const inWindow = allowedGenerationWeeks(db).includes(weekStart);

  const reason: WeekGenerationState['reason'] = !enabled
    ? 'disabled'
    : !inWindow
      ? 'outside_window'
      : running
        ? 'in_progress'
        : backoff
          ? 'provider_unavailable'
          : eligibleRemaining === 0
            ? 'nothing_to_generate'
            : undefined;

  const status: WeekGenerationState['status'] = running
    ? 'generating'
    : programSaved
      ? 'saved'
      : proposed > 0
        ? eligibleRemaining > 0
          ? 'partially_generated'
          : 'generated'
        : lastRun?.status === 'failed'
          ? 'failed'
          : 'not_generated';

  return {
    mode: 'explicit',
    status,
    canGenerate: reason === undefined,
    ...(reason ? { reason } : {}),
    ...(backoff ? { retryAfter: backoff } : {}),
    ...(running ? { runId: running.id } : {}),
    perDay,
  };
}

/** For generate-session: the active run (if any) that is about to generate `targetDate`. */
export function activeRunClaimingDate(db: Database.Database, targetDate: string): WeekRunRecord | undefined {
  const run = new WeekGenerationRunRepo(db).running(programmingWeekStart(targetDate));
  const staleBefore = new Date(Date.now() - WEEK_RUN_HEARTBEAT_TIMEOUT_MS).toISOString();
  if (!run || run.heartbeatAt < staleBefore) return undefined;
  return run.days.some((d) => d.date === targetDate && d.outcome === 'planned') ? run : undefined;
}
