// Final Selected Session Resolution and AI/Deterministic Precedence Fixes
// (docs/CLAUDE_TASK_FINAL_SELECTED_SESSION_RESOLUTION_AND_AI_PRECEDENCE_FIXES.md)
// §1/§2: the ONE authoritative rule for "which real gym `workout_sessions`
// row, if any, is the selected workout for a date" — replacing the
// previous `findRealGymSession()` helper, which picked whichever row
// `WorkoutSessionsRepo.listSessionsByDate` happened to return first
// (`ORDER BY start_time ASC`). That was never a valid precedence rule:
// row order is an incidental storage detail, not a decision about which
// workout is authoritative when a deterministic session, an AI session,
// and/or a manual session can all exist for the same date at once.
//
// This module is deliberately the ONLY place this decision is made.
// Every read path (`/week`, `/today`, the logger, completion) must go
// through `resolveSelectedSession` rather than re-deriving its own
// notion of "the" session for a date (spec §6/§12 invariant 7).

import type { WorkoutSession } from '../contracts/types.js';

/** Precedence (spec §2), most authoritative first:
 *
 *   1. `completed` — a finished workout is the permanent historical
 *      record for the day. A later `planned` session appearing for the
 *      same date (e.g. a same-day makeup session someone starts logging)
 *      never displaces it — see §11.A "Completed session plus planned
 *      replacement."
 *   2. `in_progress` — active execution in flight takes precedence over
 *      any other `planned` candidate for the same date (§11.A
 *      "In-progress session plus planned replacement").
 *   3. `planned`, `source_type` `'ai'` or `'manual'` — an explicit
 *      AI/manual replacement supersedes the day's own deterministic
 *      prescription (Final AI-Deterministic Precedence Fixes §1).
 *   4. `planned`, `source_type` `'deterministic'` — the day's own
 *      generated plan, merely started.
 *
 * Within a tier, the most recently created session wins (`created_at`
 * DESC, `session_id` as an explicit deterministic tie-break for the rare
 * case of two sessions created in the same millisecond) — this is an
 * explicit, documented rule, never "whichever array position the caller
 * happened to pass in first." `sessionsOnDate` may be in ANY order and
 * may include non-gym sessions (e.g. a same-day badminton session) —
 * both are filtered/normalized internally, so callers never need to
 * pre-sort or pre-filter before calling this.
 */
export function resolveSelectedSession(sessionsOnDate: readonly WorkoutSession[]): WorkoutSession | undefined {
  const gymSessions = sessionsOnDate.filter((s) => s.session_type === 'gym');

  const mostRecentMatching = (predicate: (s: WorkoutSession) => boolean): WorkoutSession | undefined => {
    const matches = gymSessions.filter(predicate);
    if (matches.length === 0) return undefined;
    return matches.reduce((latest, candidate) => {
      const byCreatedAt = candidate.created_at.localeCompare(latest.created_at);
      if (byCreatedAt !== 0) return byCreatedAt > 0 ? candidate : latest;
      return candidate.session_id.localeCompare(latest.session_id) > 0 ? candidate : latest;
    });
  };

  return (
    mostRecentMatching((s) => s.status === 'completed') ??
    mostRecentMatching((s) => s.status === 'in_progress') ??
    mostRecentMatching((s) => s.status === 'planned' && s.source_type !== 'deterministic') ??
    mostRecentMatching((s) => s.status === 'planned' && s.source_type === 'deterministic')
  );
}

/** Final Selected Session Resolution Fixes §3/§10: the single, shared
 * "is there already an active real gym session for this date" check —
 * used by every write path that could otherwise create a second,
 * competing selected workout (`POST /api/workouts`,
 * `aiProposalLifecycle.ts`'s commit). "Active" means `planned` or
 * `in_progress`: a `completed` session never blocks a new one (a same-day
 * makeup session, or the AI committing again after the original was
 * finished, are both legitimate — see `resolveSelectedSession`'s own
 * completed-always-wins rule, which keeps the completed one authoritative
 * even if a second real session later exists uncontested).
 *
 * This does not by itself make "two real gym sessions for one date"
 * impossible at the database level (see the implementation report's
 * discussion of why a blanket schema-level UNIQUE constraint was
 * rejected) — it makes it impossible through any SUPPORTED write path,
 * which is what spec §12 invariant 6 ("AI commits cannot create an
 * orphan competing workout") requires. */
export function findActiveGymSessionConflict(sessionsOnDate: readonly WorkoutSession[]): WorkoutSession | undefined {
  return sessionsOnDate.find((s) => s.session_type === 'gym' && (s.status === 'planned' || s.status === 'in_progress'));
}
