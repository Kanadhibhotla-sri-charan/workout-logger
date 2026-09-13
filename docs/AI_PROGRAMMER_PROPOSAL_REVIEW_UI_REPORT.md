# AI Programmer Proposal Review UI — Implementation Report

Spec: `docs/CLAUDE_TASK_AI_PROGRAMMER_PROPOSAL_REVIEW_UI.md`
Branch: `ai-programmer-first-vertical-slice`
Base commit for this task: `8017960` (spec save)

## 1. Files changed

- `src/server/routes/blueprint.ts` — new `GET /api/blueprint/targets` route.
- `public/app.js` — new formatting helpers, extended `BADGE_VARIANT`, and a new AI
  Programmer proposal-review section (`aiApi`, `mapAiErrorCode`, `aiProposalActionsFor`).
- `public/program.html` — Blueprint id→name catalogs, and the full AI proposal
  review UI wired into each day's modal (`openDayModal`).
- `public/style.css` — CSS for the new AI proposal section/panel and a warning
  card variant.
- `tests/routes/blueprintRoutes.test.ts` (new) — backend tests for `/api/blueprint/targets`.
- `tests/frontend/aiProposalUI.test.ts` (new) — 28 tests covering the new
  helpers, decision logic, and source-level wiring in `program.html`.

No existing route, repository, service, or engine code was modified — this is
a pure UI/read-only-endpoint addition on top of the already-shipped AI
Programmer backend (Phase 2 + Cleanup Pass).

## 2. UI entry point and user flow

The review UI lives inside the existing per-day modal on `program.html`
(`openDayModal`), below the deterministic plan for that day. This was chosen
over a new page because the modal already carries exactly the context the AI
Programmer needs (`day.date`, `day.weekday`, `day.status`), avoiding a new
navigation surface.

Flow for an editable day (not completed / not in progress):
1. **Generate** — "Generate AI Workout Proposal" button. Calls
   `POST /api/ai-programmer/generate-session`, then `GET /proposals/:id` to
   normalize state, and renders the full proposal (status: Pending review).
2. **Approve** — "Approve Proposal" button, calls
   `POST /proposals/:id/approve`. On success, status becomes Approved and a
   Commit button appears.
3. **Commit** — "Commit to Planned Workout" button, calls
   `POST /proposals/:id/commit`. On success, status becomes Committed and an
   "Open planned workout" link (`/logger.html?session=<id>`) is shown.
4. **Regenerate** — once expired/rejected/committed, a fresh "Generate a new
   proposal" affordance is available (per state machine below).

A day already `completed` or `in_progress` shows a locked message instead of
any button — matching the backend's own `AI_TARGET_NOT_EDITABLE` rule, so the
UI never lets a user attempt an action the backend would reject anyway.

## 3. Backend endpoints integrated

- `POST /api/ai-programmer/generate-session` — `{targetDate}` → proposal.
- `GET /api/ai-programmer/proposals/:proposalId` — full canonical state,
  used immediately after generate (whose own response lacks
  `createdAt`/`expiresAt`) and to resync state after a failed approve/commit.
- `POST /api/ai-programmer/proposals/:proposalId/approve`
- `POST /api/ai-programmer/proposals/:proposalId/commit`
- `GET /api/blueprint/exercises` (existing), `GET /api/blueprint/targets`
  (new), `GET /api/blueprint/functional-goals` (existing) — used once per
  page load to resolve `exerciseId`/`targetId` to real Blueprint display
  names, never invented client-side.

## 4. Lifecycle / state handling

`aiProposalActionsFor(status)` (in `app.js`) is a small pure function that is
the single source of truth for which actions are available at each status:

- `null`/`undefined`/`expired`/`rejected` → can generate (new proposal).
- `pending` → can approve only.
- `approved` → can commit only.
- `committed` → terminal, shows the planned-workout link.

Approval and commit are always separate, sequential user actions — commit is
never reachable before approval. State is held in the modal's local JS
closure per day; reopening a day's modal re-renders from scratch (see
Limitations).

## 5. Error and privacy handling

`aiApi()` is a dedicated fetch wrapper (kept separate from the existing
shared `api()` helper used elsewhere) that maps every documented AI
Programmer error code to a safe, generic, user-facing string via
`AI_ERROR_MESSAGES`/`mapAiErrorCode`. The backend's `message`/`details`
fields (which may contain internal detail such as SQL errors) are never
read or displayed — verified by a dedicated regression test using a
deliberately "leaky" fixture message.

## 6. Tests added/updated

- `tests/routes/blueprintRoutes.test.ts` (3 tests): `/api/blueprint/targets`
  returns every real target with correct names, exposes only
  `id/name/parent_region`, and never leaks internal paths/errors.
- `tests/frontend/aiProposalUI.test.ts` (28 tests), using this repo's
  established extraction-execution technique (slicing the real function
  source out of `app.js`/`program.html` and executing it against fixtures):
  - `mapAiErrorCode` — every documented code maps to a safe message; unknown
    codes get a generic fallback; the raw code is never returned.
  - `aiApi` — success passthrough; correct request body/headers; a
    structured backend error's raw `message`/`details` never reach the
    thrown `Error` (verified with a "distinctive" leak-fixture string);
    `ok:false` with HTTP 200 still throws; malformed JSON and network
    failures both degrade to the generic message instead of throwing raw
    errors.
  - `aiProposalActionsFor` — exhaustive per-status assertions plus a
    mutual-exclusivity check across all six statuses.
  - Formatting helpers — `formatRirRange`, `formatRestSeconds`, `capitalize`,
    `formatTimestamp` — exact output assertions.
  - Source-level wiring assertions on `program.html` — correct endpoint call
    sequence, approve/commit implemented as separate calls, locked-day
    gating, in-flight guards, no leakage of `err.details`/`err.stack`/raw
    `err.code` into displayed status text, and the "Nothing is added to your
    program until..." disclosure text is present.

## 7. Verification commands executed

```
npm ci
npm run build
npx tsc --noEmit
npm test
npm run verify
```

Plus a manual, live end-to-end browser smoke test (see §9).

## 8. Verification results

- `npm ci` — clean install, no errors (pre-existing `npm audit` advisories
  only, unrelated to this change).
- `npm run build` — clean (`tsc -p tsconfig.build.json` + schema copy).
- `npx tsc --noEmit` — clean, no type errors.
- `npm test` — **95 test files / 1004 tests, all passing**, including the
  29 new tests (26 route + frontend combined... see exact counts in §6:
  3 route + 28 frontend). No existing test was modified.
- `npm run verify` — same result, 1004/1004 passing.

## 9. Manual testing walkthrough (live browser)

A real, live end-to-end browser test was run (not just source assertions):

- A scratch SQLite DB + a real `createApp(db)` server were started with a
  seeded default user/training profile and a stub HTTP server standing in
  for the Velona gateway (mimicking its real request/response shape: chat
  `turns[]`, `context.targetDate`/`context.targetWeekday`, JSON-string
  `content` fields).
- Headless Chromium (pre-installed in this environment) drove `program.html`
  end-to-end via Playwright (invoked via the environment's global
  `playwright` package, since it isn't a project `devDependency`):
  1. Opened a day's modal → AI proposal section renders with the
     "Generate AI Workout Proposal" button and the "Nothing is added..."
     disclosure text.
  2. Clicked Generate → proposal rendered with real Blueprint exercise/target
     names ("Flat Barbell Bench Press", "Mid Chest"), correctly formatted
     sets/reps/RIR/rest, status badge "Pending review", and
     provider/model footnote.
  3. Clicked Approve → status became "Approved", Commit button appeared.
  4. Clicked Commit → status became "Committed", "Open planned workout" link
     appeared.
  5. Followed the link into `logger.html` — confirmed the two committed
     exercises appear with their exact authored prescriptions (3×6–12 and
     2×8–15 sets/reps) and the session note is
     `AI-proposed session (proposal <id>)` using the underlying proposal
     record id, consistent with the Cleanup Pass fix.
  - Also exercised the `AI_TARGET_NOT_EDITABLE` and `AI_OUTPUT_DOMAIN_INVALID`
    error paths live (by attempting past dates, and once against a
    deliberately misconfigured stub) and confirmed the mapped, generic error
    text is what's shown — never raw backend detail.

Screenshots were captured at each step during this manual run (modal open,
after generate, after approve, after commit) but were not saved as
repository artifacts, per this task's scope (UI code + tests only).

## 10. Remaining limitations

- **No cross-reopen persistence**: proposal state (pending/approved) lives
  only in the day modal's local JS closure. Closing and reopening a day's
  modal loses in-progress (not-yet-committed) proposal state; a committed
  proposal is unaffected since it becomes a real `workout_sessions` row, but
  the modal itself does not re-fetch/rehydrate an existing proposal for that
  date on reopen. Adding that would require a "does a proposal already exist
  for this date" lookup, which is not part of this task's scope.
- **Week-grid day status doesn't reconcile after commit**: committing an AI
  proposal on a `rest`/other-activity day creates a real `workout_sessions`
  row, but `program.html`'s week-grid day card still shows that day's status
  from the deterministic weekly program (e.g. still "Rest") until the page
  is reloaded, and `logger.html` labels the committed AI exercises as
  "Unplanned exercise" rather than as part of the persisted weekly plan.
  This is a pre-existing characteristic of how `WeeklyProgramRepo`/`logger.html`
  distinguish planned vs. unplanned exercises, unrelated to this change, and
  reconciling it is explicitly excluded by the task spec's scope.
- **Playwright is not a project dependency**: the manual smoke test relied on
  the environment's globally-installed `playwright` package (referenced by
  absolute path) since it isn't in `package.json`. No project file changes
  were made to accommodate this — it was a scratch, out-of-repo test harness
  only.
