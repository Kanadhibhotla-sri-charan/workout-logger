# 113 · Opus coach: app side (endpoints, day request, discard reason, coach view)

Date: 2026-11-22 · Status: built, not deployed

## Request
Owner, 2026-11-22 (design agreed in a question round, see memory
"opus-coach-routine-design"): a daily cloud routine running Claude Opus
plans the day's session; the Qwen pipeline stays, unchanged, as the
fallback the owner starts by hand. Opus is the coach: no coded coaching
check. Only two hard limits: the exercise library and the injury pause.
The owner approves every session.

## Changes
New: src/coach/opusCoach.ts, src/coach/coachContext.ts,
src/server/routes/coach.ts
- Routine side, `Authorization: Bearer <COACH_API_TOKEN>` (off with 503
  until a token of 32+ characters is set):
  - GET /api/coach/context?date= : raw data (profile, goals, weekly
    targets and what is logged, 6 weeks of sessions with sets, the last
    10 days of proposals from both paths with discard reasons, notes,
    measurements, injury pauses, preferences, the decision log, recent
    runs, the 182-exercise library). About 160k characters on prod data.
  - POST /api/coach/proposals : saves a PENDING proposal
    (model_provider 'opus-coach', sessionKind 'coach', expires at the
    end of the target date). Checks format and the two hard limits only;
    422 names each problem. A newer run replaces the date's pending coach
    proposal. Stores coach note, weekly table and decision-log entries.
  - POST /api/coach/runs : "no_run_needed" or "failed" with a reason.
- App side: GET /api/coach/day, PUT /api/coach/day-request
  (full | add_ons | null), GET /api/coach/decisions, POST /api/coach/rerun
  (calls COACH_RERUN_URL with COACH_RERUN_TOKEN; 501 and button hidden
  until set).
- Tables: coach_day_requests, coach_runs, coach_decisions; column
  ai_program_proposals.rejection_reason.

Kept apart from Qwen
- AIProposalRepo.findLatestForTargetDate(date, source='qwen'): every
  existing caller sees only Qwen proposals, so a pending coach proposal
  never blocks Qwen's Generate and the shadow week can hold both.
- Commit of a coach proposal: hard limits re-checked on current state
  (a pause set after saving blocks it); the Qwen schema, Blueprint-commit
  and domain checks are skipped; session note "Coach-planned session".
- athleticPlan counts a committed coach Athletic day.

UI (public/program.html)
- Day view: "Coach plan for <day>": the day request select, last run
  (failed / nothing planned), the proposal with Coach note on top, cards
  showing target load and cue, a weekly table (Target / Done / Today /
  Later, bold when more than 2 sets off, with the reason), Approve, Add
  to my program, Discard with an optional reason, Re-run coach.
- Qwen's discard accepts the same optional reason (API).

## Not done yet
- Qwen reading the day request (waits on what "add-ons only" means for
  Qwen).
- The routine itself, its trigger URL, and the coaching brief (in
  review with the owner).
- Target load and cue are shown on the proposal, not in the logger after
  commit.

## Tests
tests/coach/opusCoach.test.ts (11): token, context, save with no
coaching checks, library refusal, injury refusal, replace on re-run,
Qwen lookup unaffected, approve + commit, commit refused after a new
pause, discard reason reaches the context, failed run shown.
Full suite: 2375 passed, 13 failed (the known date-rot tests), 10 skipped.
