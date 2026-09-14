# 2026-09-14 — AI Programmer: Server-Side Duplicate-Generation Guard

Commit `3f2eda4`.

## What changed

`POST /api/ai-programmer/generate-session` had no server-side check for
an existing `pending` proposal on the same `targetDate` — only
`public/program.html`'s client-side `inFlight` flag prevented a double-
click in one browser tab. Two concurrent requests (two tabs, a retry
racing the original, a script) could each call Velona and persist a
second competing pending proposal for one date.

`AIProgrammerService.generateSession()` (`src/ai-programmer/service/aiProgrammerService.ts`)
now checks `AIProposalRepo.findLatestForTargetDate(targetDate)` before
building context or calling the provider. If the latest proposal for
that date has **effective** status `pending` (via the existing
`effectiveStatus()` helper — so an already-expired-but-not-yet-lazily-
transitioned pending row never blocks), it throws a new 409
`AIProposalAlreadyPendingError` (`src/ai-programmer/errors.ts`).
`approved`/`committed`/`expired` proposals never block; `rejected` is
defined in the status union but unreachable in this codebase today (no
route/service ever sets it) — noted rather than tested against, since
there is no real path that produces it.

## Why this shape

Scoped to exactly the duplicate-generation problem — no change to
`reconcile-week`, approval, commit, retry/timeout handling, or the
feature flag. The check runs before any provider call so a rejected
duplicate never wastes a real Velona request.

## New tests

`tests/ai-programmer/aiProgrammerService.test.ts`: rejects a second
`generateSession` for the same date without a second provider call;
does not block a *different* date while one date has a pending
proposal; allows generating again once the prior proposal is committed;
allows generating again once the prior proposal has expired.
`tests/ai-programmer/aiProgrammerRoute.test.ts`: the same duplicate
rejection through the real HTTP route, asserting the mocked Velona call
fires exactly once across both requests.

All five new tests use a real-clock-relative `futureDate()` helper
rather than a fixed calendar-date constant, specifically to avoid the
pre-existing `SUNDAY = '2026-09-13'`-style staleness these tests would
otherwise inherit once real time passes that date (see the next log
entry's baseline-diff note).

## Verification

Full suite diffed against a `git stash`-restored baseline at the exact
same real timestamp (`npx vitest run --reporter=verbose`, sorted `FAIL`
line lists compared): the pre-existing ~229 failures (unrelated,
hardcoded-past-date test fixtures across the suite) were byte-identical
before and after; exactly 5 new tests added, all passing, zero
regressions. `npm run typecheck` / `npm run build` clean.

Deployed to production (backup taken of the systemd unit before any
edit); `AI_PROGRAMMER_ENABLED` was `false` throughout this deploy — the
guard shipped dormant until AI generation was separately enabled later
the same day. Database verified byte-identical (hash-compared across
all affected tables) before/after deploy.
