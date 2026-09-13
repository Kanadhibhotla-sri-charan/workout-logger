// Final Actionable vs Historical Session Resolution Fixes
// (docs/CLAUDE_TASK_FINAL_ACTIONABLE_VS_HISTORICAL_SESSION_FIXES.md): the
// ONE authoritative rule for "what is the state of a date's real gym
// `workout_sessions` rows" — replacing the prior phase's
// `resolveSelectedSession`, which returned a single flat `WorkoutSession`
// and therefore had to conflate two genuinely different concepts: a
// HISTORICAL session (completed, or in progress right now) and an
// ACTIONABLE one (a planned workout the user may still start/continue).
// That conflation is exactly what let a completed session be silently
// treated as if it were still "the" workout to open, and let multiple
// simultaneously-active planned AI sessions be silently resolved by
// recency instead of being surfaced as the data-integrity problem they
// are.
//
// This module is deliberately the ONLY place this decision is made.
// Every read path (`/week`, `/today`, the logger, completion) must go
// through `resolveSelectedSession` rather than re-deriving its own
// notion of "the" session for a date.

import type { WorkoutSession } from '../contracts/types.js';

/** A diagnostic describing an invalid or ambiguous session state for a
 * date — never silently resolved into a false "this is fine" answer.
 * Currently the only state that produces one is "more than one active
 * (`planned`) session exists in the same precedence tier" (spec §5) —
 * this can only happen from data that predates this phase's write-time
 * guards (`findActiveGymSessionConflict`, enforced on every session-
 * creation path), since those guards make it unreachable going forward,
 * but the resolver must still degrade safely if it encounters it. */
export interface SelectionConflict {
  code: string;
  message: string;
  sessionIds: string[];
}

/** The resolver's full answer for one date's real gym sessions — spec
 * §3's recommended shape, adopted directly (field names and all) since
 * no equivalent type already existed for this specific distinction.
 *
 * - `historicalSession`: a `completed` or `in_progress` session — a
 *   record of what already happened / is happening right now. NEVER
 *   also returned as `selectedPlannedWorkout`, however recent it is.
 * - `selectedPlannedWorkout`: the `planned` workout the user may start
 *   or continue — `null` whenever a `historicalSession` exists for the
 *   date (§2: a completed/in-progress session blocks any other session
 *   from being actionable, it does not merely outrank it for display)
 *   or when nothing planned exists at all.
 * - `selectionConflict`: non-null only when the underlying data is
 *   genuinely ambiguous (§5) — never populated merely because a
 *   historical session exists alongside an excluded planned one; that
 *   case is unambiguous (the historical session wins, per §2) and is
 *   expressed purely through `historicalSession`/`selectedPlannedWorkout`.
 * - `source`: which tier produced the result — `'conflict'` exactly
 *   when `selectionConflict` is non-null.
 */
export interface SelectedSessionResolution {
  historicalSession: WorkoutSession | null;
  selectedPlannedWorkout: WorkoutSession | null;
  selectionConflict: SelectionConflict | null;
  source: 'completed' | 'in_progress' | 'ai' | 'deterministic' | 'none' | 'conflict';
}

function mostRecent(sessions: readonly WorkoutSession[]): WorkoutSession {
  return sessions.reduce((latest, candidate) => {
    const byCreatedAt = candidate.created_at.localeCompare(latest.created_at);
    if (byCreatedAt !== 0) return byCreatedAt > 0 ? candidate : latest;
    return candidate.session_id.localeCompare(latest.session_id) > 0 ? candidate : latest;
  });
}

const MULTIPLE_ACTIVE_PLANNED_SESSIONS = 'MULTIPLE_ACTIVE_PLANNED_SESSIONS';

function buildConflict(sessions: readonly WorkoutSession[]): SelectionConflict {
  return {
    code: MULTIPLE_ACTIVE_PLANNED_SESSIONS,
    message: 'Multiple active planned Gym sessions exist for this date.',
    sessionIds: sessions.map((s) => s.session_id),
  };
}

/** Precedence, most authoritative first:
 *
 *   1. `completed` — a finished workout is the permanent historical
 *      record for the day; it is exposed as `historicalSession`, never
 *      as `selectedPlannedWorkout`. If more than one completed session
 *      exists (an edge case the required test matrix does not ask to be
 *      flagged as a conflict — only ACTIVE PLANNED duplicates are), the
 *      most recently created is shown; this is a display tie-break for
 *      an already-historical fact, not a live selection decision.
 *   2. `in_progress` — active execution in flight. Also `historicalSession`
 *      (spec §1: "in-progress... returned as current/historical state,
 *      not a new planned workout"), same completed-vs-in-progress
 *      caveat as above; this codebase's own pre-existing convention
 *      (`realSessionStatus` before this phase) already treated
 *      `completed` as outranking `in_progress` when, unusually, both
 *      exist for one date, so that ordering is kept here rather than
 *      inverted — no required test forces either order, so continuity
 *      with the rest of the codebase's existing convention was
 *      preferred.
 *   3. `planned`, `source_type` `'ai'`/`'manual'` — selected only when
 *      no historical session exists for the date (§2/§4.3). More than
 *      one such session existing simultaneously is a genuine
 *      `selectionConflict` (§5) — never silently resolved by recency;
 *      a deterministic recovery candidate (the most recent) is still
 *      returned as `selectedPlannedWorkout` so a read endpoint stays
 *      usable, but `source` is `'conflict'` and `selectionConflict` is
 *      populated so no caller can mistake it for an unconditionally
 *      valid answer.
 *   4. `planned`, `source_type` `'deterministic'` — the day's own
 *      generated plan, merely started; same conflict handling as (3)
 *      if more than one exists.
 *   5. Nothing at all — `historicalSession: null`,
 *      `selectedPlannedWorkout: null`, `selectionConflict: null`,
 *      `source: 'none'`. This is a normal, valid answer (there is
 *      simply no real session yet), never an error.
 *
 * `sessionsOnDate` may be in ANY order and may include non-gym sessions
 * (e.g. a same-day badminton session) — both are filtered/normalized
 * internally, so callers never need to pre-sort or pre-filter. */
export function resolveSelectedSession(sessionsOnDate: readonly WorkoutSession[]): SelectedSessionResolution {
  const gymSessions = sessionsOnDate.filter((s) => s.session_type === 'gym');

  const completed = gymSessions.filter((s) => s.status === 'completed');
  if (completed.length > 0) {
    return { historicalSession: mostRecent(completed), selectedPlannedWorkout: null, selectionConflict: null, source: 'completed' };
  }

  const inProgress = gymSessions.filter((s) => s.status === 'in_progress');
  if (inProgress.length > 0) {
    return { historicalSession: mostRecent(inProgress), selectedPlannedWorkout: null, selectionConflict: null, source: 'in_progress' };
  }

  const plannedAi = gymSessions.filter((s) => s.status === 'planned' && s.source_type !== 'deterministic');
  if (plannedAi.length > 0) {
    const conflict = plannedAi.length > 1 ? buildConflict(plannedAi) : null;
    return { historicalSession: null, selectedPlannedWorkout: mostRecent(plannedAi), selectionConflict: conflict, source: conflict ? 'conflict' : 'ai' };
  }

  const plannedDeterministic = gymSessions.filter((s) => s.status === 'planned' && s.source_type === 'deterministic');
  if (plannedDeterministic.length > 0) {
    const conflict = plannedDeterministic.length > 1 ? buildConflict(plannedDeterministic) : null;
    return {
      historicalSession: null,
      selectedPlannedWorkout: mostRecent(plannedDeterministic),
      selectionConflict: conflict,
      source: conflict ? 'conflict' : 'deterministic',
    };
  }

  return { historicalSession: null, selectedPlannedWorkout: null, selectionConflict: null, source: 'none' };
}

/** Final Selected Session Resolution Fixes §3/§10, extended by the
 * Actionable vs Historical fix's §2/§7: the single, shared "would
 * creating/committing another active real gym session for this date be
 * unsafe" check — used by every write path that could otherwise create
 * a second, competing selected workout (`POST /api/workouts`,
 * `aiProposalLifecycle.ts`'s commit, and any future move/reuse/regenerate
 * path that creates a real gym session). "Active" means `planned` or
 * `in_progress`, OR `completed` (the Actionable vs Historical fix's own
 * §2: a completed session ALSO now blocks a new one — no silent same-day
 * makeup session through this codebase's existing write paths; that is
 * explicitly deferred to a future, separate feature per that spec's own
 * scope note).
 *
 * This does not by itself make "two real gym sessions for one date"
 * impossible at the database level (see the implementation reports'
 * discussion of why a blanket schema-level UNIQUE constraint was
 * rejected — it would conflict with the resolver's own required ability
 * to read and diagnose exactly this state when it already exists in
 * historical data) — it makes it impossible through any SUPPORTED write
 * path. */
export function findActiveGymSessionConflict(sessionsOnDate: readonly WorkoutSession[]): WorkoutSession | undefined {
  return sessionsOnDate.find((s) => s.session_type === 'gym' && (s.status === 'planned' || s.status === 'in_progress' || s.status === 'completed'));
}

/** Spec's "Logging and Diagnostics" section: one shared, structured log
 * call for every invalid/blocked/conflicting session state this module
 * or its callers detect — never sensitive data (no tokens, no request
 * bodies), just enough to investigate: date, session type, the stable
 * conflict/rejection code, the session id(s) involved, and which
 * operation hit it. `userId` is included only where a caller already
 * has it cheaply on hand (this app is single-user, so there is exactly
 * one real value it will ever take); omitting it elsewhere is not a
 * regression — it is not the primary diagnostic key for a single-user
 * dataset. */
export function logSessionConflict(context: {
  operation: string;
  date: string;
  sessionType: string;
  code: string;
  conflictingSessionIds: readonly string[];
  userId?: string;
}): void {
  console.warn('[selectedSessionResolver] session conflict detected', {
    operation: context.operation,
    date: context.date,
    sessionType: context.sessionType,
    code: context.code,
    conflictingSessionIds: [...context.conflictingSessionIds],
    ...(context.userId ? { userId: context.userId } : {}),
  });
}
