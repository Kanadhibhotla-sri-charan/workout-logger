# 2026-09-14 — Cross-Week Planning Horizon + AI Timeout/Context Fixes

Commit (this entry's own). Full detail in
`docs/CROSS_WEEK_PROGRAMMING_INTELLIGENCE_FIX_REPORT.md`.

## Why

Production generated absurd single sessions (Push: 19 exercises/2h15m,
Pull: 16/1h58m, Legs: 20/2h17m) because a target with only one
compatible gym day in the current week had its entire weekly volume
crammed into that one session — the deterministic engine had no concept
of any week beyond the one being built. Both AI Programmer UI actions
("Regenerate"/"Reorganize") also failed with a generic error, traced to
nginx's default 60s `proxy_read_timeout` racing the app's own identical
60000ms Velona timeout.

## What changed

- `src/engine/workoutBuilder.ts`: a genuine, bounded (exactly one week
  each direction) cross-week planning horizon — real persisted carryover
  from the prior week folded into this week's own volume target, and
  this week's own per-exposure division extended into next week's real
  compatible days when this week's own fall short. No time-based
  candidate elimination reintroduced (`WORKOUT_PROGRAMMER_CONSOLIDATED
  _FIX_SPEC.md` §7 stays intact).
- `tests/engine/crossWeekPlanningHorizon.test.ts` (new): end-to-end
  regression through the real `GET /api/programming/week` route across
  two real weeks — proven discriminating by reverting the engine change
  (fails at 135.1 minutes, matching the reported bug; passes at 104.3
  with the fix).
- `ops/nginx/workout-logger.conf`: `proxy_read_timeout 150s;` added
  (still needs applying to the live production nginx config separately —
  not part of this app's git-based deploy).
- `public/app.js`'s `aiApi()`: distinguishes a network failure, a
  non-JSON body on a 502/503/504 gateway status (the nginx-race
  signature — new user-facing message), and any other non-JSON body
  (kept the existing generic message) — see updated/new tests in
  `tests/frontend/aiProposalUI.test.ts`.
- `src/ai-programmer/provider/velonaProvider.ts` /
  `src/ai-programmer/service/tokenReport.ts`: a targeted
  `reconcile_week`-only floor (6144) on top of the shared
  `VELONA_MAX_TOKENS` config, justified by the real 7-day output
  schema against this same task's own empirically-observed 16-exercise
  session; `generate_session` is unaffected. `AI_PROGRAMMER_ENABLED` was
  not touched.
- `src/ai-programmer/context/*`: both AI context builders now include a
  read-only `crossWeek` field (prior-week carryover, this week's own
  persisted allocations, next week's real eligible schedule) plus prompt
  guidance to prefer distributing/deferring volume over cramming one
  session — the same trade-off the deterministic engine now makes
  structurally.

## Verification

`npm run typecheck` / `npm run build` clean throughout. Full suite
baseline-diffed against this session's established 229 pre-existing
(stale-calendar-date) failures: zero new failures at every stage.

## Not deployed

Per the task's explicit instruction, no deployment (git or the separate
production nginx config change) occurs as part of this entry — pending
review.
