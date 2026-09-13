# AI Programmer Proposal Discovery & UI Rehydration — Implementation Report

Spec: `docs/CLAUDE_TASK_AI_PROGRAMMER_PROPOSAL_DISCOVERY_REHYDRATION.md`
Branch: `ai-programmer-first-vertical-slice`
Base commit for this task: `71576c4` (spec save)

## 1. Files changed

- `src/repositories/aiProposalRepo.ts` — new `findLatestForTargetDate()`.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — extracted the existing lazy-expiry
  logic into a shared `expireIfNeeded()` helper; new `getLatestProposalForDate()`.
- `src/server/routes/aiProgrammer.ts` — new `GET /api/ai-programmer/proposals/latest` route.
- `public/app.js` — new pure `aiProposalNoticeFor(status)` helper.
- `public/program.html` — modal-level request-token guard
  (`bumpModalToken`/`isModalTokenCurrent`), and `buildAiProposalSection` rewritten to
  discover existing proposal state on open before rendering any action.
- `tests/repositories/aiProposalRepo.test.ts` — new tests for `findLatestForTargetDate`.
- `tests/ai-programmer/aiProposalRoutes.test.ts` — new tests for
  `GET /proposals/latest`.
- `tests/frontend/aiProposalUI.test.ts` — new tests for `aiProposalNoticeFor`,
  `isModalTokenCurrent`/`bumpModalToken`, and discovery/rehydration wiring.

No existing endpoint, repository method, or lifecycle rule was changed — this task only
adds a read path and rewires the frontend to use it before deciding what to render.

## 2. Discovery endpoint

**Reused the existing `serializeProposal` response shape** rather than inventing a new
one. Inspecting the codebase first (per the task's own instruction) found:
- No existing list/search or "find by date" endpoint or repository method.
- `AIProposalRepo` only supported lookup by id (`getById`).
- The `ai_program_proposals` table already had an index on `target_date`
  (`idx_ai_program_proposals_target_date`), so a date-scoped query was cheap to add.

Added:

```
GET /api/ai-programmer/proposals/latest?targetDate=YYYY-MM-DD
```

(the second of the two shapes the spec suggested — chosen because a plain
`GET /proposals?targetDate=...` reads like a list endpoint, and this task only ever
needs "the one current answer for this date", never a list). Registered **before**
`GET /proposals/:proposalId` in the router so the literal path segment `latest` is never
captured as a `:proposalId` value by that route instead (Express matches in registration
order — verified by test).

Response:
- No proposal ever generated for the date → `{ok: true, found: false}` (HTTP 200, never a
  404 — this is the normal, expected state for a day nobody has asked the AI Programmer
  about yet).
- A proposal exists → `{ok: true, found: true, ...serializeProposal(record)}` — the
  **exact same fields** `GET /proposals/:id`/approve/commit already return, so the
  frontend has one shared shape to render regardless of which call produced it.
- Missing/malformed `targetDate` → `400` (same validation style as
  `POST /generate-session`).
- Feature disabled → `503 AI_PROGRAMMER_DISABLED`, checked before any DB access (same
  `requireEnabled()` guard every other route already uses).

Response safety is identical to `GET /proposals/:id` by construction (same
`serializeProposal` call) — no provider payload, API key, raw error, or extra DB field is
ever added.

## 3. Active-proposal semantics

**"Latest" = the single most recently CREATED proposal for the target date, regardless of
its current status.** Ordering is `created_at DESC`, with `id DESC` as a deterministic
tie-breaker for two rows sharing an identical `created_at` — never unspecified SQLite row
order (verified by a test that forces an exact `created_at` tie and asserts the same
winner on repeated calls).

This single-latest-row model, rather than "the latest **active** row specifically", was
chosen because:
- It requires exactly one query and one deterministic answer, with no secondary question
  of "what if the true latest is committed/expired but an older pending one is still
  technically active?" — a scenario this application's own generation rules don't
  actually produce today (see §6: a new proposal is never generated while one is already
  pending/approved for the same date).
- It still satisfies every case in the spec's discovery table: pending/approved are
  shown for review, committed is shown with its "Open planned workout" link, and
  expired/rejected are shown with the "no longer active" notice — because the frontend
  decides what to render from the returned **status**, not from which query found it.

**Expiry**: the same lazy pending/approved → expired transition `GET /proposals/:id`,
approve, and commit already apply is now shared via a single `expireIfNeeded()` helper
and applied to the discovery result too — so a proposal that has quietly passed its
`expiresAt` is reported (and persisted) as `expired`, never as still `pending`/`approved`.

**Rejected**: the `rejected` status exists in the schema/type but no code path in this
codebase actually produces it yet (no reject endpoint exists) — discovery still handles
it correctly (treated identically to `expired` for notice/generation purposes) since the
test suite forces it directly via a DB write, matching this repo's existing convention
for exercising otherwise-unreachable stored states.

## 4. Frontend rehydration flow

`buildAiProposalSection(day, modalToken)` — every day's modal now performs discovery
**before** deciding which action to show:

1. On build, `renderActions()` is called once immediately (shows a
   "Checking for an existing proposal…" placeholder) and `discover()` is kicked off.
2. `discover()` calls `GET /proposals/latest?targetDate=<day.date>` and seeds `state`
   from the result (`result.found ? result : null`).
3. Only once discovery completes (`discoveryDone = true`) does `renderActions()` compute
   real actions, via the **same, unchanged** `aiProposalActionsFor(state.status)` pure
   function the previous (single-session) UI already used and the previous task's tests
   already cover exhaustively — discovery only changes **when** `state` is first
   populated, never the decision logic itself.
4. `renderNotice()` shows the small "The previous proposal is no longer active. You can
   generate a new one." message (via the new `aiProposalNoticeFor(status)` pure helper)
   for `expired`/`rejected`, and nothing for every other status.
5. Every subsequent action (generate/approve/commit) still re-fetches or receives the
   canonical server response and re-renders from it — the backend remains authoritative
   throughout, matching the original single-session design.

## 5. Stale-request and duplicate-generation protection

**Stale requests** (spec §5): a module-level `currentModalToken` counter is bumped by
`bumpModalToken()` on every `openDayModal()` (a day opened) **and** every
`closeDayModal()` (the modal closed) — so both "switched to a different day" and "closed
the modal entirely" invalidate any request a now-superseded section is still waiting on.
Each `buildAiProposalSection` call captures its own token once, and every async
continuation (`discover`, and each of `onGenerate`/`onApprove`/`onCommit`'s success and
`finally` paths) checks `isModalTokenCurrent(modalToken)` before applying its result or
re-rendering. `isModalTokenCurrent`/`bumpModalToken` are small, genuinely pure, DOM-free
functions — extracted directly from the shipped `program.html` and unit-tested in
isolation (see §7), including the exact "out-of-order response" scenario (an older
request's token is never reported current once a newer one has already been issued,
regardless of the order responses actually arrive in).

Structurally, this guard is defense-in-depth on top of an already-safe design: every
`openDayModal()` call rebuilds the entire modal DOM tree from scratch
(`root.innerHTML = ''`), so a stale section's elements are already detached from the
document by the time a late response could try to update them — the token check makes
that guarantee explicit and directly testable rather than relying on it as an
implementation detail.

**Duplicate generation** (spec §6/§9): `renderActions()` shows no action at all (only the
"Checking…" placeholder) until discovery has completed, so the user can never click
Generate before it is known whether an active proposal already exists. Once discovery
completes, `aiProposalActionsFor` (unchanged) reports `canGenerate: false` for
`pending`/`approved`, so no Generate/regenerate action is ever offered while one is
active. **Regeneration is out of scope / deferred**, exactly as the spec allows: there is
no "cancel this proposal and start over" action anywhere in the UI for a
pending/approved/committed proposal — the only way to reach a fresh Generate button again
is for the current proposal to reach `expired` or `rejected` (a state this application
does not otherwise let the user force).

## 6. Tests added/updated

- `tests/repositories/aiProposalRepo.test.ts` (+6 tests): no-proposal case, single match,
  `created_at DESC` ordering (forced timestamps), deterministic tie-break by `id`,
  date-scoping (never returns another date's row), and status-agnostic return
  (rejected/expired/committed all still returned).
- `tests/ai-programmer/aiProposalRoutes.test.ts` (+11 tests): found:false for no
  proposal, exact-shape match against `GET /proposals/:id`, deterministic ordering
  through the real HTTP route, expired-effective-status (and that it's actually
  persisted), rejected handling, missing/malformed `targetDate` → 400, sanitized
  response-shape assertion, pending/approved/committed progression, cross-date isolation,
  and the `AI_PROGRAMMER_ENABLED` gate.
- `tests/frontend/aiProposalUI.test.ts` (+16 tests):
  - `aiProposalNoticeFor` (3 tests): expired/rejected get the notice, every other status
    (including no proposal) gets `null`, and the notice text is never phrased as
    blocking generation.
  - `isModalTokenCurrent`/`bumpModalToken` (4 tests): a fresh token is current, an older
    token stops being current once superseded (switching days), also stops being current
    on a close (not only a switch), and the exact out-of-order-response scenario.
  - Discovery/rehydration wiring (9 tests, source-level — this repo has no
    browser/jsdom harness, matching its existing convention): discovery is called on
    section build with the exact endpoint/query; `state` is seeded from `found`;
    `aiProposalActionsFor` is still the single decision path (called exactly once in the
    function, reused for the discovered state); actions are gated behind
    `discoveryDone`; the notice is rendered via `aiProposalNoticeFor`, never duplicated
    inline logic, and never touches `canGenerate`; every async continuation checks
    `isCurrent()`; `openDayModal`/`closeDayModal` both call `bumpModalToken()`; and a
    discovery failure degrades safely (`state = null`, mapped `err.message` only, never
    `err.details`/`err.stack`).

All new/changed tests were run to confirm they pass against the real, current
implementation (not reversion-verified individually for this task, since none of them
touch logic complex/subtle enough to warrant it beyond the ordering/tie-break tests,
which were written and read carefully against the exact SQL before running).

## 7. Verification commands executed

```
npm run build
npx tsc --noEmit
npm test
npm run verify
```

## 8. Verification results

- `npm run build` — clean.
- `npx tsc --noEmit` — clean, no type errors.
- `npm test` — **95 test files / 1037 tests, all passing** (1004 pre-existing + 33 new:
  6 repo + 11 route + 16 frontend).
- `npm run verify` — same result, 1037/1037 passing.

## 9. Manual/browser test results

A live end-to-end browser test was run (headless Chromium via Playwright, driving a real
`createApp(db)` server against a scratch SQLite DB and a stub Velona gateway), exercising
the exact sequence the spec's "browser-level test" section describes:

1. Opened Sunday's day modal → generated a proposal → confirmed the review panel
   rendered.
2. **Closed the modal** (Escape).
3. **Reopened the same date** → the proposal was fully rehydrated from the backend:
   status badge read "Pending review", full exercise cards, rationale, and footer all
   present exactly as before closing — with no leftover "Checking…" state.
4. **Approved** the (rehydrated) proposal → status became "Approved", Commit button
   appeared.
5. **Closed and reopened again** → status was rehydrated as "Approved" and the Commit
   button was present, with no re-approval offered.
6. **Bonus check**: switched to a different (locked-by-date) day in the same session —
   confirmed Sunday's review panel never appeared under that day (no stale-data leak
   across days).
7. **Bonus check**: committed the rehydrated proposal, closed and reopened once more —
   discovery correctly reported "Committed" with the "Open planned workout" link
   restored, confirming the full lifecycle survives a close/reopen at every stage, not
   only pending → approved.

All checks passed. Screenshots were captured at each step during this manual run but were
not saved as repository artifacts, per this task's scope (UI code + tests only).

## 10. Remaining limitations / deferred decisions

- **Regeneration is deferred**, as noted in §5 — there is no explicit "start over" action
  for an active (pending/approved) or committed proposal. Reaching a fresh Generate
  button again requires the current proposal to become `expired` (24h TTL, unchanged from
  Phase 2) or `rejected` (currently unreachable — no reject endpoint exists in this
  codebase).
- **No cross-tab/cross-session sync**: discovery runs once per modal open. If a proposal
  for the currently-open day changes on the backend while the modal stays open (e.g. a
  hypothetical second client approving it), this modal will not notice until it is
  closed and reopened.
- **The pre-existing week-grid/`logger.html` reconciliation gap is unchanged**: as
  documented in the prior UI task's report, a committed AI proposal still does not
  update the deterministic week-grid's day-card status, and its exercises still display
  as "Unplanned exercise" in `logger.html` — both are pre-existing, out-of-scope
  characteristics of how the persisted weekly program and AI proposals are separate
  systems, not something this task touches.
