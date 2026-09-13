// AI Programmer Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md):
// retrieval, explicit approval, and the ONLY function allowed to commit
// an AI proposal into the real workout/session data model. Never calls
// the LLM/provider — everything here operates on an already-generated,
// already-persisted proposal (spec §10.5: "never call the LLM/provider").

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { AIProposalRepo, type AIProposalRecord } from '../../repositories/aiProposalRepo.js';
import { nowIso } from '../../repositories/ids.js';
import { UnknownExerciseError, WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { TrainingProfileRepo } from '../../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../repositories/usersRepo.js';
import { WeekActivityOverridesRepo } from '../../repositories/weekActivityOverridesRepo.js';
import { WeeklyProgramRepo } from '../../repositories/weeklyProgramRepo.js';
import { applyWeekOverrides, deriveDailyActivity } from '../../lib/dailyActivity.js';
import { WEEKDAYS } from '../../contracts/types.js';
import { programmingWeekStart, weekdayOfDate } from '../../engine/workoutBuilder.js';
import { buildProgrammerContext } from '../context/programmerContextBuilder.js';
import {
  AICommitIntentMismatchError,
  AIProposalCommitFailedError,
  AIProposalConflictError,
  AIProposalExpiredError,
  AIProposalInvalidStateError,
  AIProposalNotFoundError,
  AIProposalStaleError,
  AIProposalValidationFailedError,
} from '../errors.js';
import { validateProposalDomain } from '../validation/programmerDomainValidator.js';
import { validateProposalSchema } from '../validation/programmerOutputValidator.js';

/** AI Activity Alignment / Non-Regenerative Schedule Fixes (Part 3),
 * now REQUIRED on every commit (Activity Scheduling and AI Alignment
 * Fixes, Fix 1, Option A): which of the two supported commit intents
 * applies — filling an already-Gym day, or explicitly replacing a
 * Rest/Badminton day's activity with Gym. There is no longer an
 * "omitted" case that preserves old behavior; the route validates
 * presence before this function is ever called (see aiProgrammer.ts's
 * commit route). */
export type AICommitIntent = 'fill_existing_gym_day' | 'replace_day_activity';

/** The SAME effective-activity computation `src/server/routes/
 * programming.ts`'s `effectiveWeekActivity` already uses for display —
 * recurring TrainingProfile + this week's own WeekActivityOverridesRepo
 * overrides, never a second inference mechanism. Returns 'unselected'
 * (Rest) if no training profile exists at all, which is the only sane
 * default (a proposal can't have been generated without one — see
 * buildProgrammerContext — so this branch is effectively unreachable in
 * practice, but never throws). */
function effectiveActivityForDate(db: Database.Database, targetDate: string): { activity: string; profileId: string | null } {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  if (!profile) return { activity: 'unselected', profileId: null };
  const weekStart = programmingWeekStart(targetDate);
  const weekday = weekdayOfDate(targetDate);
  const overrides = new WeekActivityOverridesRepo(db).get(profile.id, weekStart);
  const effective = applyWeekOverrides(profile.training_days, profile.other_activity_schedule, overrides);
  return { activity: deriveDailyActivity(weekday, effective.trainingDays, effective.otherActivitySchedule), profileId: profile.id };
}

/** If `record` is still `pending`/`approved` but past its `expires_at`,
 * persists the lazy pending/approved -> expired transition right now
 * (never on a background timer — see AIProposalRepo.markExpired's own
 * doc comment) and returns the updated record; otherwise returns
 * `record` unchanged. Shared by every read path (retrieval by id,
 * discovery by target date, approve, commit) so they all observe a
 * consistent, truthful status. */
function expireIfNeeded(repo: AIProposalRepo, record: AIProposalRecord): AIProposalRecord {
  if ((record.status === 'pending' || record.status === 'approved') && record.expiresAt < nowIso()) {
    return repo.markExpired(record.id) ?? record;
  }
  return record;
}

/** Loads a proposal and, if it is still `pending`/`approved` but past
 * its `expires_at`, persists the lazy pending/approved -> expired
 * transition right now before returning it, so every caller (retrieval,
 * approve, commit) observes a consistent, truthful status. */
function loadCurrent(db: Database.Database, proposalId: string): AIProposalRecord {
  const repo = new AIProposalRepo(db);
  const record = repo.getById(proposalId);
  if (!record) throw new AIProposalNotFoundError(proposalId);
  return expireIfNeeded(repo, record);
}

export function getProposal(db: Database.Database, proposalId: string): AIProposalRecord {
  return loadCurrent(db, proposalId);
}

/** Discovery/Rehydration spec §2/§3: "is there an existing relevant AI
 * proposal for this target date?" — returns the single most recently
 * created proposal for `targetDate` (see
 * AIProposalRepo.findLatestForTargetDate for the exact ordering
 * contract), with the same lazy pending/approved -> expired transition
 * `getProposal`/approve/commit already apply, so a proposal that has
 * quietly passed its `expiresAt` is never reported as still active.
 * Returns `undefined` when no proposal has ever been generated for this
 * date — never throws AIProposalNotFoundError, since "no proposal yet"
 * is the normal, expected case here (unlike `getProposal`, which is
 * always given an id the caller already believes exists). */
export function getLatestProposalForDate(db: Database.Database, targetDate: string): AIProposalRecord | undefined {
  const repo = new AIProposalRepo(db);
  const record = repo.findLatestForTargetDate(targetDate);
  if (!record) return undefined;
  return expireIfNeeded(repo, record);
}

/** Explicit approval only — never commits, never mutates the proposal's
 * own JSON content (spec §7). Approving an already-`approved` proposal
 * is idempotent (returns the existing record unchanged rather than
 * erroring); every other non-`pending` state is a documented conflict. */
export function approveProposal(db: Database.Database, proposalId: string): AIProposalRecord {
  const record = loadCurrent(db, proposalId);
  if (record.status === 'approved') return record;
  if (record.status === 'expired') throw new AIProposalExpiredError(proposalId, record.expiresAt);
  if (record.status !== 'pending') throw new AIProposalInvalidStateError(proposalId, record.status, 'approved');

  const approved = new AIProposalRepo(db).approve(proposalId);
  if (!approved) {
    // Lost a race with another request that changed this proposal's
    // status between loadCurrent() above and this conditional UPDATE —
    // re-read and report whatever state it actually landed in.
    const current = new AIProposalRepo(db).getById(proposalId);
    throw new AIProposalInvalidStateError(proposalId, current?.status ?? record.status, 'approved');
  }
  return approved;
}

export interface CommitAIProposalResult {
  sessionId: string;
  proposal: AIProposalRecord;
}

/** Cleanup pass §1: `failure_reason` is a PERSISTED, retrievable field
 * (surfaced via `GET /proposals/:id`) — it must never contain a raw
 * `err.message`/stack trace, which can carry SQL text, table/column
 * names, or other internal detail. This maps any commit-transaction
 * failure to one of a small, fixed set of safe, stable categories. The
 * raw error is still logged server-side (see the catch block below) for
 * real debugging — just never persisted or returned to a client. */
function classifyCommitFailure(err: unknown): string {
  if (err instanceof UnknownExerciseError) return 'exercise_resolution_failed';
  return 'commit_transaction_failed';
}

/** The only function in this codebase allowed to translate an AI
 * proposal into a real, persisted planned workout session (spec §10).
 * Accepts only an already-validated, already-approved proposal by id;
 * revalidates everything about CURRENT state before writing anything
 * (spec §8: "do not rely only on validation performed during
 * generation"); never calls the provider.
 *
 * Concurrency (spec §9's "race protection... not only an in-memory
 * boolean"): the actual proposal -> committed transition is a
 * conditional `UPDATE ... WHERE status IN (...)` (AIProposalRepo.
 * markCommitted), so two racing commit calls can never both succeed even
 * in principle. In THIS application (a single Node process, a
 * synchronous better-sqlite3 connection, and no `await` anywhere between
 * this function's preconditions and its transaction), two "simultaneous"
 * HTTP commit requests are additionally serialized in practice by
 * Node's single-threaded event loop — the whole commit transaction below
 * runs to completion before the second request's handler code executes
 * at all. The conditional UPDATE is what makes that a real guarantee
 * rather than an assumption that happens to hold today.
 *
 * AI Activity Alignment / Non-Regenerative Schedule Fixes (Part 3),
 * hardened by Activity Scheduling and AI Alignment Fixes (Fix 1/2):
 * `options.intent` (now REQUIRED — see AICommitIntent's own doc
 * comment) tells commit whether the target date is ALREADY effectively
 * Gym/Both (`'fill_existing_gym_day'` — commit only fills in the
 * workout, the weekly activity representation is untouched) or is being
 * explicitly turned into Gym (`'replace_day_activity'` — commit ALSO
 * writes a `WeekActivityOverridesRepo` override for that date). Both the
 * override write (when applicable) and session creation happen in the
 * SAME `db.transaction()` below as marking the proposal committed, so a
 * commit failure never leaves an inconsistent override or an orphaned
 * session behind (Fix 2's transaction requirement — there is no
 * "best-effort independent writes" path here at all: either every one
 * of override/session/committed-status changes, or none of it does).
 * `intent` is validated against the CURRENT effective activity, not the
 * proposal's own generation-time context, so a stale client assumption
 * is caught even if the day's activity changed after the proposal was
 * generated. This function never invokes the deterministic
 * planner/reconciliation (Fix 2's "do not invoke full program
 * generation merely because the user selected replacement") — the
 * override write alone is sufficient for `/week`'s own
 * override-applied activity computation to show Gym for this date. */
export function commitAIProposalToPlannedSession(
  db: Database.Database,
  proposalId: string,
  options: { intent: AICommitIntent }
): CommitAIProposalResult {
  const repo = new AIProposalRepo(db);
  const record = loadCurrent(db, proposalId);

  // Idempotency (spec §9): repeated commit of an already-committed
  // proposal returns the SAME committed_session_id — never a duplicate
  // session, never an error.
  if (record.status === 'committed') {
    if (!record.committedSessionId) throw new AIProposalCommitFailedError(proposalId);
    return { sessionId: record.committedSessionId, proposal: record };
  }
  if (record.status === 'expired') throw new AIProposalExpiredError(proposalId, record.expiresAt);
  if (record.status !== 'approved') throw new AIProposalInvalidStateError(proposalId, record.status, 'committed');

  // "Proposal JSON parses successfully" / "passes structural validation"
  // (spec §8) — re-checked here rather than assumed from generation
  // time. AIProposalRepo.getById already throws MalformedProposalJsonError
  // (a plain Error, not an AIProgrammerError) if proposal_json itself
  // isn't valid JSON; that surfaces via loadCurrent() above and is left
  // to propagate to the route's generic 500 handler, since a row this
  // codebase itself wrote should never actually be malformed JSON.
  const structural = validateProposalSchema(record.proposal);
  if (!structural.ok || !structural.value) {
    throw new AIProposalValidationFailedError(proposalId, structural.errors);
  }
  const proposal = structural.value;

  // Blueprint/context staleness (spec §13). NOTE on `record.contextHash`
  // (`AIProposalRecord.contextHash`, from the generation-time
  // `AIProgrammerContext.contextHash`): it is deliberately AUDIT
  // METADATA ONLY here, never compared against a freshly-computed hash
  // as an equality gate. `hashContext()` (programmerContextDiagnostics.ts)
  // hashes the FULL context, which includes point-in-time-volatile
  // fields — `currentDate`, and every target's live
  // weeklyExposureUnits/rollingExposureUnits/recovery/exerciseHistory —
  // so an exact-match check would fail almost any proposal more than a
  // few minutes old regardless of whether anything that actually matters
  // for commit-safety changed, making the 24h approval window pointless.
  // The two checks below are the REAL, deliberately-scoped enforcement:
  // (1) `blueprint_commit` equality, an exact, cheap, semantically
  // meaningful fingerprint (the same one `programs.blueprint_commit`
  // already uses elsewhere in this codebase); and (2) a full domain
  // revalidation against a FRESHLY REBUILT context below, which
  // precisely re-checks every fact that could invalidate this specific
  // proposal — an authored prescription that changed, an exercise no
  // longer valid for its target, a target date/weekday mismatch (which
  // also transitively catches a TrainingProfile.timezone change that
  // shifts what "today" is) — without the false positives an opaque
  // hash comparison would produce. `contextHash` remains stored/returned
  // purely so a specific historical proposal's exact generation-time
  // context can be identified for debugging, never as a validity check.
  const currentBlueprintCommit = BlueprintAdapter.getManifest().sourceCommit;
  if (currentBlueprintCommit !== record.blueprintCommit) {
    throw new AIProposalStaleError(proposalId, [
      `Blueprint changed since this proposal was generated (was "${record.blueprintCommit}", now "${currentBlueprintCommit}")`,
    ]);
  }

  // Rebuild the FULL context fresh against current DB state — this
  // reuses buildProgrammerContext's own existing checks for "target date
  // still valid" and "no completed/in-progress session already there"
  // (it throws AITargetNotEditableError, itself an AIProgrammerError
  // with its own 409 status, if either fails) rather than duplicating
  // that logic here.
  const context = buildProgrammerContext(db, { targetDate: proposal.targetDate });

  // Full domain revalidation against the FRESH context — this is what
  // catches a changed authored prescription, an exercise that is no
  // longer valid for its target, or a target date/weekday mismatch,
  // exactly the same way generation-time validation did, just re-run
  // against now-current state instead of generation-time state. This
  // also catches an exerciseId that resolves only via the SEPARATE
  // outside-Blueprint-exercise catalogue (approved or not) — this
  // milestone's proposals accept `source: 'blueprint'` only, and
  // `BlueprintAdapter.isKnownExercise()` (called inside
  // validateProposalDomain) never treats an outside-Blueprint exercise
  // as known, regardless of its own approval state.
  const domain = validateProposalDomain(proposal, context, db);
  if (!domain.ok || !domain.value) {
    throw new AIProposalStaleError(proposalId, domain.errors);
  }

  // Planned-session conflict (spec §11's recommended default: reject).
  // Completed/in-progress conflicts are already covered by
  // buildProgrammerContext's own lock check above; a merely-`planned`
  // session is not, since that path only treats completed/in_progress
  // as locking — so it is checked explicitly here.
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const plannedConflict = sessionsRepo.listSessionsByDate(proposal.targetDate).find((s) => s.status === 'planned');
  if (plannedConflict) {
    throw new AIProposalConflictError(proposalId, proposal.targetDate, plannedConflict.session_id, plannedConflict.status);
  }

  // Part 3 / Fix 1-2: validate the requested intent against the day's
  // CURRENT effective activity before writing anything.
  // 'fill_existing_gym_day' asserts the day is already Gym/Both — a
  // mismatch means the caller's assumption about the day is wrong/stale,
  // so this rejects rather than silently treating it as a replace.
  // 'replace_day_activity' IS the explicit confirmation that this
  // request should replace the day's current (Rest/Badminton/already-
  // Gym) activity with Gym (Fix 2 step 4, "confirm that replacement is
  // explicitly requested") — it has no precondition on the day's current
  // activity; its own alignment write is applied inside the transaction
  // below.
  const { activity: currentActivity, profileId } = effectiveActivityForDate(db, proposal.targetDate);
  const isCurrentlyGym = currentActivity === 'gym' || currentActivity === 'both';
  if (options.intent === 'fill_existing_gym_day' && !isCurrentlyGym) {
    throw new AICommitIntentMismatchError(proposalId, proposal.targetDate, options.intent, currentActivity);
  }

  // Final AI-Deterministic Precedence and Scheduling Fixes §1: if a
  // deterministic prescription already exists for this exact date (this
  // week's own `program_sessions` row at the date's day_index — the
  // "fill_existing_gym_day" scenario is exactly this case), the AI
  // session about to be created SUPERSEDES it for display purposes
  // (Option 1, "AI replacement/supersession" — the deterministic row is
  // never deleted, only display precedence changes; see
  // programming.ts's renderWeekDays for the shared read-side rule).
  // Read here (outside the write transaction — this is a pure lookup)
  // so both the override write and the session's own supersession
  // pointer are decided from the exact same pre-commit snapshot of
  // state.
  const targetWeekStart = programmingWeekStart(proposal.targetDate);
  const targetDayIndex = WEEKDAYS.indexOf(weekdayOfDate(proposal.targetDate));
  const supersededProgramSession = new WeeklyProgramRepo(db).getByWeekStart(targetWeekStart)?.sessions.find((s) => s.day_index === targetDayIndex);

  let sessionId: string;
  try {
    const tx = db.transaction(() => {
      if (options.intent === 'replace_day_activity' && profileId) {
        // Part 3's "Rest or Badminton day" alignment: the weekly
        // activity representation is updated to Gym in the SAME
        // transaction as session creation, so the two can never observe
        // a partial state — either both happen or neither does.
        new WeekActivityOverridesRepo(db).setOverride(profileId, programmingWeekStart(proposal.targetDate), weekdayOfDate(proposal.targetDate), 'gym');
      }
      const session = sessionsRepo.createSession({
        date: proposal.targetDate,
        session_type: 'gym',
        status: 'planned',
        source_type: 'ai',
        supersedes_program_session_id: supersededProgramSession?.id ?? null,
        // Cleanup pass §3: `record.id` (the loaded, persisted
        // ai_program_proposals row id) is the authoritative identity —
        // `proposal.proposalId` is the same value today (AIProposalRepo.
        // create() guarantees that by construction), but this note
        // should reference the persisted record, not the in-memory
        // proposal object, in case that ever changes.
        notes: `AI-proposed session (proposal ${record.id})`,
      });
      // Correction: the proposal's prescription (repsMin/repsMax/
      // rirMin/rirMax/restSeconds/sets count) is planned data — it goes
      // into workout_exercises' own target_* prescription columns, NOT
      // into workout_sets' PERFORMED weight/reps/rir/rpe/rest_seconds
      // fields, which stay null until the user actually performs the
      // set (see ExercisePerformance's doc comment in contracts/types.ts).
      // Each set row's ONLY prescribed fact is which set number it is —
      // that's why there are exactly `exercise.sets` set rows.
      proposal.exercises.forEach((exercise, index) => {
        sessionsRepo.addExercisePerformance(session.session_id, {
          exercise_id: exercise.exerciseId,
          order: index,
          role: exercise.role,
          target_sets: exercise.sets,
          target_reps_min: exercise.repsMin,
          target_reps_max: exercise.repsMax,
          target_rir_min: exercise.rirMin,
          target_rir_max: exercise.rirMax,
          target_rest_seconds: exercise.restSeconds ?? null,
          sets: Array.from({ length: exercise.sets }, (_, setIndex) => ({
            set_number: setIndex + 1,
            weight: null,
            reps: null,
            completed: false,
            rir: null,
            rpe: null,
            rest_seconds: null,
            technique: null,
            tempo: null,
            notes: null,
          })),
        });
      });
      const committed = repo.markCommitted(proposalId, session.session_id);
      if (!committed) {
        // Cleanup pass §2: markCommitted()'s WHERE clause now checks
        // BOTH status AND expiry atomically, so a zero-row result here
        // means either the status changed (a race with another commit
        // attempt) or the proposal crossed its expiry boundary between
        // the pre-checks above and this exact call — re-read to report
        // whichever actually happened. Throwing here rolls back the
        // whole transaction (db.transaction wraps this in BEGIN/COMMIT/
        // ROLLBACK), so the just-created session is never left orphaned.
        const current = repo.getById(proposalId);
        if (current && current.status !== 'expired' && current.expiresAt < nowIso()) {
          throw new AIProposalExpiredError(proposalId, current.expiresAt);
        }
        throw new AIProposalInvalidStateError(proposalId, current?.status ?? record.status, 'committed');
      }
      return session.session_id;
    });
    sessionId = tx();
  } catch (err) {
    if (err instanceof AIProposalInvalidStateError || err instanceof AIProposalExpiredError) throw err;
    // Atomicity (spec §9): the transaction above rolled back entirely on
    // any thrown error — no partial session/exercise/set rows, and the
    // proposal was never marked committed. The raw error (which may
    // contain SQL text, table/column names, or other internal detail)
    // is logged to the server's own controlled log for real debugging,
    // but only a safe, fixed-category string — never `err.message` or a
    // stack trace — is persisted into `failure_reason` (cleanup pass
    // §1), since that field is retrievable via `GET /proposals/:id`.
    console.error(`AI proposal commit failed for proposal ${proposalId}:`, err);
    repo.recordFailure(proposalId, classifyCommitFailure(err));
    throw new AIProposalCommitFailedError(proposalId);
  }

  const finalRecord = repo.getById(proposalId);
  if (!finalRecord) throw new AIProposalCommitFailedError(proposalId);
  return { sessionId, proposal: finalRecord };
}
