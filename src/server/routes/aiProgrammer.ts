// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §12: the first
// AI-programmer endpoint (proposal generation). Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md)
// adds retrieval, explicit approval, and explicit commit on top of it —
// generation still never persists anything into
// workout_sessions/program_sessions itself; only the new commit route
// does, via commitAIProposalToPlannedSession().

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { isValidCalendarDate } from '../../engine/dateMath.js';
import { AIProgrammerError, AIProgrammerDisabledError } from '../../ai-programmer/errors.js';
import type { AIProposalRecord } from '../../repositories/aiProposalRepo.js';
import { createDefaultAIProgrammerService } from '../../ai-programmer/service/aiProgrammerService.js';
import {
  approveProposal,
  commitAIProposalToPlannedSession,
  getLatestProposalForDate,
  getProposal,
} from '../../ai-programmer/service/aiProposalLifecycle.js';
import { isAiProgrammerEnabled } from '../../ai-programmer/provider/config.js';

export const aiProgrammerRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
}

/** The safe, client-facing shape of a persisted proposal — proposal
 * content plus lifecycle/audit metadata only. Never the raw provider
 * response, never an API key/authorization header, never a raw SQL
 * error or stack trace (spec §6/§14). */
function serializeProposal(record: AIProposalRecord) {
  return {
    proposalId: record.id,
    status: record.status,
    targetDate: record.targetDate,
    weekday: record.weekday,
    proposal: record.proposal,
    contextHash: record.contextHash,
    provider: record.modelProvider,
    model: record.modelName,
    requestId: record.requestId,
    committedSessionId: record.committedSessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    approvedAt: record.approvedAt,
    committedAt: record.committedAt,
    rejectedAt: record.rejectedAt,
    expiresAt: record.expiresAt,
  };
}

/** Phase 2 §17: proposal retrieval/approval/commit must not expose
 * unsafe functionality when the feature is disabled — same
 * `AI_PROGRAMMER_ENABLED` gate `POST /generate-session` already uses,
 * checked first, before touching the database. */
function requireEnabled(): void {
  if (!isAiProgrammerEnabled()) {
    throw new AIProgrammerDisabledError();
  }
}

aiProgrammerRouter.post('/generate-session', async (req, res, next) => {
  const { targetDate, timezone } = req.body ?? {};
  if (typeof targetDate !== 'string' || targetDate.trim() === '') {
    return res.status(400).json({ ok: false, error: 'targetDate (string, YYYY-MM-DD) is required' });
  }
  if (!isValidCalendarDate(targetDate)) {
    return res.status(400).json({ ok: false, error: `targetDate "${targetDate}" is not a real calendar date in YYYY-MM-DD format` });
  }
  // Correction pass §5 (Option A): the user's stored TrainingProfile
  // timezone is the single authoritative timezone for every date-
  // sensitive operation in this request (current date, weekday,
  // editability, context). A request-level override would otherwise
  // leave the context's displayed `timezone` field inconsistent with
  // the timezone actually used to compute `currentDate`/editability —
  // rejected clearly rather than silently ignored.
  if (timezone !== undefined) {
    return res
      .status(400)
      .json({ ok: false, error: 'timezone is not accepted in the request — the user\'s TrainingProfile.timezone is always authoritative' });
  }

  // Express 4 does not automatically forward a rejected promise from an
  // async handler to the error middleware — every path below must
  // resolve via res.json/res.status or explicitly call next(err).
  try {
    const service = createDefaultAIProgrammerService(db(req));
    const result = await service.generateSession({ targetDate });
    // Phase 2 §5: the response now also carries the persisted proposal's
    // id/status — proposal.proposalId (echoed in `proposal`) and
    // `proposalId` here are always the exact same string (see
    // AIProgrammerService.generateSession / AIProposalRepo.create).
    res.json({
      ok: true,
      proposal: result.proposal,
      proposalId: result.proposalId,
      status: result.status,
      contextHash: result.contextHash,
      provider: result.provider,
      model: result.model,
      requestId: result.requestId,
    });
  } catch (err) {
    if (err instanceof AIProgrammerError) {
      return res.status(err.statusCode).json({ ok: false, error: err.code, message: err.publicMessage, details: err.details });
    }
    next(err);
  }
});

/** Discovery/Rehydration spec §2/§3/§4: "is there an existing relevant
 * AI proposal for this target date?" — used by the frontend on every
 * day-modal open, BEFORE deciding which action (Generate/Approve/
 * Commit/Open planned workout) to show, so proposal state survives a
 * closed-and-reopened modal instead of living only in local JS state.
 *
 * Registered BEFORE `/proposals/:proposalId` below so the literal path
 * segment `latest` is never captured as a `:proposalId` value by that
 * route instead (Express matches routes in registration order).
 *
 * Returns `{ok: true, found: false}` — never a 404 — when no proposal
 * has ever been generated for this date; that is the normal, expected
 * case for a day the user hasn't asked the AI Programmer about yet, not
 * an error. Response safety, ordering, and effective-status/expiry
 * semantics are identical to `GET /proposals/:proposalId` (same
 * `serializeProposal`, same lazy expiry via `getLatestProposalForDate`) —
 * this route only adds "how a proposal for this date is found",
 * everything else is deliberately unchanged. */
aiProgrammerRouter.get('/proposals/latest', (req, res, next) => {
  try {
    requireEnabled();
    const { targetDate } = req.query;
    if (typeof targetDate !== 'string' || targetDate.trim() === '') {
      return res.status(400).json({ ok: false, error: 'targetDate (string, YYYY-MM-DD) query parameter is required' });
    }
    if (!isValidCalendarDate(targetDate)) {
      return res.status(400).json({ ok: false, error: `targetDate "${targetDate}" is not a real calendar date in YYYY-MM-DD format` });
    }
    const record = getLatestProposalForDate(db(req), targetDate);
    if (!record) {
      return res.json({ ok: true, found: false });
    }
    res.json({ ok: true, found: true, ...serializeProposal(record) });
  } catch (err) {
    if (err instanceof AIProgrammerError) {
      return res.status(err.statusCode).json({ ok: false, error: err.code, message: err.publicMessage, details: err.details });
    }
    next(err);
  }
});

aiProgrammerRouter.get('/proposals/:proposalId', (req, res, next) => {
  try {
    requireEnabled();
    const record = getProposal(db(req), req.params.proposalId);
    res.json({ ok: true, ...serializeProposal(record) });
  } catch (err) {
    if (err instanceof AIProgrammerError) {
      return res.status(err.statusCode).json({ ok: false, error: err.code, message: err.publicMessage, details: err.details });
    }
    next(err);
  }
});

/** Explicit approval only (spec §7) — never commits, never mutates the
 * proposal's own content. */
aiProgrammerRouter.post('/proposals/:proposalId/approve', (req, res, next) => {
  try {
    requireEnabled();
    const record = approveProposal(db(req), req.params.proposalId);
    res.json({ ok: true, ...serializeProposal(record) });
  } catch (err) {
    if (err instanceof AIProgrammerError) {
      return res.status(err.statusCode).json({ ok: false, error: err.code, message: err.publicMessage, details: err.details });
    }
    next(err);
  }
});

const AI_COMMIT_INTENTS = ['fill_existing_gym_day', 'replace_day_activity'] as const;

/** The only route that persists an AI proposal into the real
 * workout/session model (spec §8/§10), via
 * commitAIProposalToPlannedSession() — never called from
 * `generate-session` or `approve` automatically (spec §17: "no
 * automatic fallback from failed AI generation to automatic commit").
 *
 * Activity Scheduling and AI Alignment Fixes (Fix 1, Option A): `intent`
 * is now a REQUIRED body field (`'fill_existing_gym_day' |
 * 'replace_day_activity'`) — the prior release accepted an omitted
 * intent and silently preserved pre-existing behavior (create the
 * planned session, never touch the weekly activity representation),
 * which could leave a real planned Gym session committed on a day the
 * weekly activity still calls Rest/Badminton. That fallback is removed
 * entirely: a missing or invalid intent is a `400` here, before
 * `commitAIProposalToPlannedSession` runs at all — no session is
 * created, no override is written, and the proposal is not marked
 * committed. */
aiProgrammerRouter.post('/proposals/:proposalId/commit', (req, res, next) => {
  try {
    requireEnabled();
    const { intent } = req.body ?? {};
    if (!AI_COMMIT_INTENTS.includes(intent)) {
      return res.status(400).json({ ok: false, error: `intent is required and must be one of ${AI_COMMIT_INTENTS.join('|')}` });
    }
    const { proposal } = commitAIProposalToPlannedSession(db(req), req.params.proposalId, { intent });
    res.json({ ok: true, ...serializeProposal(proposal) });
  } catch (err) {
    if (err instanceof AIProgrammerError) {
      return res.status(err.statusCode).json({ ok: false, error: err.code, message: err.publicMessage, details: err.details });
    }
    next(err);
  }
});
