// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §12: the first
// AI-programmer endpoint. Returns a validated proposal only — it never
// persists a program or touches workout_sessions/program_sessions. A
// future `POST /commit-session-proposal` (explicit validation +
// transaction + persistence) is deliberately out of scope for this
// milestone (spec §12: "for this task, implementing only the first
// endpoint is acceptable and preferred").

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { isValidCalendarDate } from '../../engine/dateMath.js';
import { AIProgrammerError } from '../../ai-programmer/errors.js';
import { createDefaultAIProgrammerService } from '../../ai-programmer/service/aiProgrammerService.js';

export const aiProgrammerRouter = Router();

function db(req: import('express').Request): Database.Database {
  return req.app.locals.db;
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
    res.json({
      ok: true,
      proposal: result.proposal,
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
