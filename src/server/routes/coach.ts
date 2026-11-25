// Opus coach API (2026-11-22, src/coach/opusCoach.ts).
//
// Routine side (needs `Authorization: Bearer <COACH_API_TOKEN>`):
//   GET  /api/coach/context?date=YYYY-MM-DD   raw data for the day
//   POST /api/coach/proposals                 save a session (pending)
//   POST /api/coach/runs                      record "no run needed" / "failed"
// App side (same access as the rest of the app):
//   GET  /api/coach/day?date=                 request, last run, latest coach proposal
//   PUT  /api/coach/day-request               {date, mode: 'full'|'add_ons'|null, parts?: AddOnPart[] (add_ons only)}
//   GET  /api/coach/decisions                 the coach's decision log
//   POST /api/coach/rerun                     {date} start the routine now

import { Router, type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import { isValidCalendarDate, addDays } from '../../engine/dateMath.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { getLatestProposalForDate } from '../../ai-programmer/service/aiProposalLifecycle.js';
import { buildCoachContext } from '../../coach/coachContext.js';
import {
  COACH_DAY_MODES,
  CoachSaveRefused,
  getDayAddOnParts,
  getDayRequest,
  isAddOnPartList,
  latestCoachRun,
  listDecisions,
  parseCoachProposal,
  recordCoachRun,
  saveCoachProposal,
  setDayRequest,
  type CoachDayMode,
} from '../../coach/opusCoach.js';
import { serializeProposal } from './aiProgrammer.js';

export const coachRouter = Router();

function db(req: Request): Database.Database {
  return req.app.locals.db as Database.Database;
}

/** Constant-time bearer check against COACH_API_TOKEN; the routine side is
 * off (503) when no token is configured. */
function requireCoachToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.COACH_API_TOKEN ?? '';
  if (expected.length < 32) return res.status(503).json({ ok: false, error: 'coach API is not configured' });
  const header = req.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const dateParam = (v: unknown): string | null => (typeof v === 'string' && isValidCalendarDate(v) ? v : null);

// ------------------------------------------------------------ routine side

coachRouter.get('/context', requireCoachToken, (req, res, next) => {
  try {
    const date = dateParam(req.query.date) ?? todayForUser(db(req));
    res.json({ ok: true, context: buildCoachContext(db(req), date) });
  } catch (err) {
    next(err);
  }
});

coachRouter.post('/proposals', requireCoachToken, (req, res, next) => {
  try {
    const parsed = parseCoachProposal(req.body);
    if (!parsed.ok) return res.status(422).json({ ok: false, error: 'invalid_format', problems: parsed.problems });
    const record = saveCoachProposal(db(req), parsed.value);
    res.status(201).json({ ok: true, proposalId: record.id, status: record.status, expiresAt: record.expiresAt });
  } catch (err) {
    if (err instanceof CoachSaveRefused) return res.status(422).json({ ok: false, error: 'refused', problems: err.problems });
    next(err);
  }
});

coachRouter.post('/runs', requireCoachToken, (req, res, next) => {
  try {
    const { targetDate, outcome, reason } = req.body ?? {};
    if (!dateParam(targetDate)) return res.status(400).json({ ok: false, error: 'targetDate (YYYY-MM-DD) is required' });
    if (outcome !== 'no_run_needed' && outcome !== 'failed') return res.status(400).json({ ok: false, error: 'outcome must be no_run_needed or failed' });
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 1000) return res.status(400).json({ ok: false, error: 'reason (text, at most 1000 characters) is required' });
    recordCoachRun(db(req), targetDate, outcome, reason.trim());
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ app side

coachRouter.get('/day', (req, res, next) => {
  try {
    const date = dateParam(req.query.date);
    if (!date) return res.status(400).json({ ok: false, error: 'date (YYYY-MM-DD) is required' });
    const record = getLatestProposalForDate(db(req), date, 'coach');
    res.json({
      ok: true,
      date,
      request: getDayRequest(db(req), date),
      parts: getDayAddOnParts(db(req), date),
      run: latestCoachRun(db(req), date),
      proposal: record ? serializeProposal(record) : null,
      rerunAvailable: rerunConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

coachRouter.put('/day-request', (req, res, next) => {
  try {
    const { date, mode, parts } = req.body ?? {};
    if (!dateParam(date)) return res.status(400).json({ ok: false, error: 'date (YYYY-MM-DD) is required' });
    if (mode !== null && !(COACH_DAY_MODES as readonly unknown[]).includes(mode)) return res.status(400).json({ ok: false, error: `mode must be ${COACH_DAY_MODES.join('|')} or null` });
    // The add-on parts the owner picked (2026-11-25): add_ons only, at least one.
    if (parts !== undefined) {
      if (mode !== 'add_ons') return res.status(400).json({ ok: false, error: 'parts is only accepted with mode add_ons' });
      if (!isAddOnPartList(parts) || parts.length === 0) return res.status(400).json({ ok: false, error: 'parts must be a non-empty array of resilience|conditioning|mobility|flexibility (pick "Session only" for none)' });
    }
    if (date < todayForUser(db(req))) return res.status(400).json({ ok: false, error: 'date is in the past' });
    setDayRequest(db(req), date, mode as CoachDayMode | null, parts);
    res.json({ ok: true, date, request: getDayRequest(db(req), date), parts: getDayAddOnParts(db(req), date) });
  } catch (err) {
    next(err);
  }
});

coachRouter.get('/decisions', (req, res, next) => {
  try {
    res.json({ ok: true, decisions: listDecisions(db(req), addDays(todayForUser(db(req)), -90)) });
  } catch (err) {
    next(err);
  }
});

/** Re-run starts the routine through its trigger URL (COACH_RERUN_URL +
 * COACH_RERUN_TOKEN). Not configured: 501, and the app hides the button. */
function rerunConfigured(): boolean {
  return Boolean(process.env.COACH_RERUN_URL && process.env.COACH_RERUN_TOKEN);
}

coachRouter.post('/rerun', async (req, res, next) => {
  try {
    const date = dateParam(req.body?.date);
    if (!date) return res.status(400).json({ ok: false, error: 'date (YYYY-MM-DD) is required' });
    if (!rerunConfigured()) return res.status(501).json({ ok: false, error: 'rerun is not set up' });
    const response = await fetch(process.env.COACH_RERUN_URL!, {
      method: 'POST',
      // Claude Code routine API trigger (POST .../routines/{trig_id}/fire):
      // anthropic-version is required; the beta header marks the experimental endpoint.
      headers: {
        authorization: `Bearer ${process.env.COACH_RERUN_TOKEN}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      },
      body: JSON.stringify({ text: `Re-run the coach for ${date}. This is a Re-run pressed by the lifter.` }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`coach rerun trigger answered ${response.status}`);
      return res.status(502).json({ ok: false, error: 'the coach routine could not be started' });
    }
    res.status(202).json({ ok: true, date });
  } catch (err) {
    next(err);
  }
});
