# Implementation Report — Fixes Task: Activity Changes, Non-Regenerative Scheduling, and AI Session Alignment

Spec: `docs/CLAUDE_TASK_ACTIVITY_SCHEDULING_AND_AI_ALIGNMENT_FIXES_FINAL.md`.
Base commit: `3aff366` (Add non-regenerative schedule swap and AI commit
activity alignment) plus `e5fe42f` (spec saved).

This is a stricter follow-up review of the immediately-preceding phase.
Per the spec's own "Completion Standard," this report does not claim
completion merely because endpoints exist or happy-path tests pass — each
section below states the actual behavior change, why it satisfies the
fix, and which test proves it.

---

## Fix 1 — Remove unsafe AI commit fallback (Option A: require intent)

**Before:** `POST /proposals/:id/commit` accepted an omitted `intent` and
silently preserved old behavior (create a planned Gym session, never
touch the weekly activity representation) — the exact "Weekly activity:
Rest / Workout session: Planned Gym" contradiction the spec describes.

**After:** `intent` is a **required** field (`aiProgrammer.ts`'s commit
route and `aiProposalLifecycle.ts`'s `commitAIProposalToPlannedSession`
signature — `options: { intent: AICommitIntent }`, no default). A
missing or invalid value is a `400`, before any read/write of the
proposal, the session table, or the override table.

**Tests:** `tests/ai-programmer/aiProposalRoutes.test.ts` — "Fix 1
(Option A): intent omitted is rejected with 400" and "intent omitted on
a Badminton day is also rejected with 400" (both assert no session
created, no override written, proposal stays `approved`). All ~20
pre-existing generic commit tests were updated to pass an explicit
`replace_day_activity` intent (their own assertions are about lifecycle
behavior unrelated to intent, so this is the harmless default for them).

**Live verification:** commit-with-no-body on a real Rest day returned
`400 "intent is required and must be one of fill_existing_gym_day|replace_day_activity"`,
and the proposal stayed `approved`.

---

## Fix 2 — Make AI replacement and weekly activity mutation consistent

The commit workflow already followed the required order (validate
proposal → validate target date/week and conflicts → check
existing/planned sessions → intent is itself the explicit replacement
confirmation → override write + session creation + `markCommitted`, all
inside one `db.transaction()` → return final state). This phase:

- Added an explicit doc comment on `commitAIProposalToPlannedSession`
  stating this workflow and why it never calls the deterministic
  planner for `replace_day_activity` (the override alone is sufficient
  for `/week`'s own effective-activity computation — no
  `program_sessions` row is needed or written).
- Added a regression test proving the "no full generation" claim
  directly: **"Fix 2: replace_day_activity never invokes full program
  generation — no program_sessions row is created for the day."**
- The existing rollback test ("a persistence failure mid-commit rolls
  back the alignment override too") already covers "no orphaned
  override on session-creation failure." No behavior change was needed
  here — the previous implementation was already transactional; this
  phase adds the coverage/documentation the spec asked for.

**Live verification:** committing `replace_day_activity` for Sunday
(Rest) produced one atomic state change — `/week` and `/today` both
immediately showed `activity: gym`, `type: gym`, `plannedSession`
pointing at the new session, in the same response cycle.

---

## Fix 3 — Stop leaving active planned sessions orphaned

**Before:** `PUT /week/days/:day/activity` rejected a Gym→non-Gym change
with a planned session present, UNLESS the caller passed
`confirmReplacePlanned: true`, in which case the change proceeded and
the planned session was left in place but effectively orphaned (day
says Rest, session still says Planned Gym).

**After:** the escape hatch is removed entirely. Changing a day away
from Gym while an active `planned` session exists for that date is
**unconditionally rejected** (`409`, `conflictingSessionId` in the
body) — there is no bypass field. In-progress sessions were already
rejected (unchanged). Completed sessions are still never touched
(unchanged).

This matches the spec's stated safer policy for this phase ("reject...
unless the operation explicitly moves/reuses that session") — this
endpoint has no move/reuse capability of its own (that's `/week/swap`'s
job), so it never has a safe way to proceed and always rejects.

**Tests:** `tests/routes/scheduleOperations.test.ts` — rewrote "rejects
moving a gym-having day..." to assert the 409 with no override written,
and added "there is no bypass field — passing the old
confirmReplacePlanned: true no longer has any effect, still 409."

**Live verification:** `PUT .../sunday/activity {"activity":"unselected"}`
against a day with a real planned AI session returned `409` with the
exact "Move or cancel that session before changing the activity"
message and the conflicting session id; the day's activity remained
`gym` afterward.

---

## Fix 4 — Correctly distinguish `swap` from `move` (Option A)

**Before:** `POST /week/move` (`{fromDay, toDay}`) was a thin alias
calling the exact same `swapDayActivities` as `/week/swap` — silently
performing swap semantics (A↔B, source's prior activity returns onto
the source) under a name that implies true move semantics (A→B,
destination's own prior activity discarded).

**After:** `/week/move` is **removed**. Only `/week/swap` is exposed.
`scheduleOperations.ts`'s `ScheduleChangeMode` keeps `'move'` in its
type union only as a documented, unimplemented future mode (Option B),
never routed to anything. No frontend page ever called `/week/move` (it
was backend/test-only), so this has zero UI impact.

**Tests:** `tests/routes/scheduleOperations.test.ts` — replaced the
"alias for swap" test with "no longer exists — 404, not a swap alias."

**Live verification:** `POST /api/programming/week/move` returned `404`.

---

## Fix 5 — Define which planned sessions are movable (Option A)

**Decision:** all `status === 'planned'` sessions are schedule-bound and
move with their day during a swap — this was already `swapDayActivities`'s
actual behavior; what was missing was making the rule explicit (not
"AI-only" as some comments implied) and testing it against a
non-AI-created planned session.

**Change:** rewrote `scheduleOperations.ts`'s doc comments to state the
rule plainly (status alone decides, not origin) and to note that in
today's codebase only AI-committed sessions reach `planned` in practice,
but the function itself makes no such assumption.

**Test:** `tests/engine/scheduleOperations.test.ts` — "Fix 5: a
manually-created planned session (not AI-committed) is schedule-bound
too — status alone decides, not origin," which creates a `planned`
session directly via the repo (bypassing `aiProposalLifecycle.ts`
entirely) and confirms it still moves with the swap.

---

## Fix 6 — Verify program-session identity semantics

**Audit performed** (all consumers of `program_sessions.id`):

- `program_session_exercises.program_session_id` (FK, `ON DELETE
  CASCADE`) — written only by the separate, legacy `ProgramsRepo`
  (draft/active/completed Program concept), which creates and reads its
  own rows and never touches rows `WeeklyProgramRepo`/`scheduleOperations.ts`
  manage.
- `workout_sessions.program_session_id` (FK, `ON DELETE SET NULL`) —
  the column exists in schema, but **no code path** (`POST
  /api/workouts`, `aiProposalLifecycle.ts`'s commit, or any frontend
  page) ever sets it. It is always `null` in current practice.
- No UI state or historical/audit logic anywhere is keyed by a
  `program_sessions.id` value.

**Conclusion (documented in `weeklyProgramRepo.ts`'s `upsertSession` doc
comment):** `program_sessions.id` represents a **stable day slot**
(program_id, day_index), not a stable prescription-artifact identity.
Overwriting content in place during a swap (as `swapDayActivities`
already does) is therefore correct, not a shortcut. If a future feature
starts setting `workout_sessions.program_session_id`, this conclusion
must be re-checked before any code swaps day content in place again —
called out explicitly in the doc comment for that reason.

**Test:** `tests/engine/scheduleOperations.test.ts`'s "both days already
Gym" test now also asserts each day_index's `program_sessions.id`
is unchanged after a swap even though its content is now the other
day's former prescription — proving the "stable slot" semantics in
code, not just prose.

---

## Fix 7 — Make the normal activity endpoint's regeneration policy explicit

**Before:** `PUT /week/days/:day/activity` always called the
deterministic planner (`computeFreshWeek` + `reconcileWeekProgram`)
whenever the resulting activity needed a gym prescription, with no way
for the caller to say "don't regenerate."

**After:** `prescriptionPolicy: 'reuse' | 'regenerate'` is a **required**
body field (mirroring Fix 1's `intent` — same "reject ambiguous
operations rather than silently guess" principle):

- **`'reuse'`** — never calls the planner. If this exact day already has
  a persisted `program_sessions` row (this week's own day_index), that
  content is kept as-is and only the activity override is written. If no
  such prescription exists, nothing is written and the response is a
  `409` with `generationRequired: true` — never a silent generation.
- **`'regenerate'`** — explicit, caller-approved generation: identical to
  the endpoint's pre-existing behavior.
- Turning a day AWAY from Gym never needs a prescription either way —
  `prescriptionPolicy` is validated but has no effect on that direction.

All ~30 pre-existing test call sites across
`tests/routes/{scheduleOperations,weekActivityOverride,weekProgramPersistence}.test.ts`
were updated via their shared `putActivity` helper, which now injects
`prescriptionPolicy: 'regenerate'` by default — preserving every
existing test's original (pre-Fix-7) behavior with a one-line change per
file, rather than touching 30 call sites individually.

**Frontend:** `program.html`'s "Change activity" control now tries
`'reuse'` first; on a `generationRequired` response it shows the
backend's message plus a separate, explicit "Generate a new workout for
this day" button that retries with `'regenerate'` — never a silent
fallback. `app.js`'s `api()` helper was extended to attach the parsed
error body (`error.body`) to thrown errors, additively, so this is the
only caller that needs the extra field.

**Tests:** new describe block in `tests/routes/scheduleOperations.test.ts`
covering: omitted policy → 400; invalid policy → 400; `'reuse'` with
nothing to reuse → `409 generationRequired`, override never written;
`'reuse'` on a day with an existing prescription → exact content kept,
byte-for-byte; `'regenerate'` → generates as before; policy irrelevant
when leaving Gym.

**Live verification:** N/A beyond the automated tests above (this path
doesn't need a live AI proposal to exercise) — covered by the automated
suite instead.

---

## Fix 8 — Ensure weekly UI accurately represents AI-created planned sessions

**Before:** a Gym day created via AI replacement (no deterministic
`program_sessions` snapshot) carried `hasUnpersistedSnapshot: true`,
which no UI ever read — the day card showed "0 exercises," and the day
modal showed "No exercises were placed on this day," both implying
nothing was scheduled even though a real planned session existed.

**After:**

- `renderWeekDays` (`programming.ts`) now returns `plannedSession: {id,
  source: 'deterministic' | 'ai', status} | null` on every gym-typed day
  (both the normal deterministic-snapshot branch and the
  no-snapshot/AI-alignment branch), replacing `hasUnpersistedSnapshot`
  entirely. `GET /today` now also carries the same field.
- `program.html`'s week-grid day card shows "AI-planned workout" instead
  of "0 exercises" when `plannedWork` is empty but `plannedSession`
  exists; the day modal shows "This day's workout was created from an AI
  proposal — open it to see the planned exercises" plus an "Open planned
  workout" link (`/logger.html?session=<id>`) instead of the misleading
  empty-state message.
- `today.html`'s exercises panel shows the equivalent message instead of
  "No exercises were placed for today" when a `plannedSession` exists;
  "Today's session" (below) already linked to the real session
  correctly in the prior release (it reads `loggedSessions` directly, not
  `exercises`) and is unchanged.

**Tests:** `tests/routes/scheduleOperations.test.ts` — updated the
existing Part 3/5 test to assert `plannedSession` (not
`hasUnpersistedSnapshot`, which is now `undefined`), added a
deterministic-source case, a null case, and a `/today`-vs-`/week`
consistency case.

**Live verification:** after committing an AI proposal with
`replace_day_activity`, both `/week`'s Sunday entry and `/today` returned
the identical `plannedSession: {id, source: "ai", status: "planned"}`.

---

## State invariants — verified

1. **A successful AI replacement never leaves weekly activity
   Rest/Badminton while an active Gym session exists for the day** — the
   override write and session creation are in the same transaction (Fix
   2); live-verified.
2. **A pure schedule swap never invokes program generation** — verified
   both by code inspection (`swapDayActivities` never imports/calls the
   planner) and by the live swap smoke test (no fetch/LLM call possible —
   `tests/routes/scheduleOperations.test.ts` already asserts no fetch
   mock is installed for swap tests).
3. **A planned session never silently becomes detached** — Fix 3 removes
   the only path that could do this.
4. **Completed/in-progress sessions are never silently moved, deleted,
   or rewritten** — unchanged from the prior phase; still enforced by
   `isDayLocked`/the in-progress guard.
5. **The recurring profile is never modified by current-week schedule
   operations** — unchanged; only `WeekActivityOverridesRepo` is ever
   written by these code paths.
6. **Repeated requests never create duplicates** — commit idempotency
   (existing test), swap idempotency (existing "swap twice restores
   original state" test), both still pass.

---

## Regression checks

- Full suite: `npm run verify` (build + typecheck + `vitest run`) — **97
  test files, 1096 tests, all passing**, exit code 0.
- `npx tsc --noEmit` — clean.
- `npm run build` — clean.
- Manual HTTP smoke test against a scratch SQLite DB + real `createApp(db)`
  server, following the spec's own 9-step verification list exactly
  (steps 1–9 all confirmed above), including a seeded approved AI
  proposal (since this environment has no real Velona credentials) to
  exercise the commit endpoint's Fix 1/2/3 behavior live, not only in
  the automated suite.

## Files changed

- `src/ai-programmer/service/aiProposalLifecycle.ts` — Fix 1/2 (required
  intent, workflow documentation).
- `src/server/routes/aiProgrammer.ts` — Fix 1 (required intent
  validation).
- `src/engine/scheduleOperations.ts` — Fix 4/5/6 (removed move-alias
  claim, Fix 5 rule documentation, Fix 6 identity note).
- `src/repositories/weeklyProgramRepo.ts` — Fix 6 (identity-semantics
  audit doc comment).
- `src/server/routes/programming.ts` — Fix 3 (unconditional rejection),
  Fix 4 (removed `/week/move` route), Fix 7 (`prescriptionPolicy`,
  reuse/generation-required path), Fix 8 (`plannedSession` field on
  `/week` and `/today`).
- `public/app.js` — `api()` now attaches the parsed error body to thrown
  errors (Fix 7's frontend consumption).
- `public/program.html` — Fix 7 (reuse-first activity change with
  explicit regenerate fallback), Fix 8 (day card/modal empty-state fix).
- `public/today.html` — Fix 8 (empty-state message fix).
- Tests: `tests/ai-programmer/aiProposalRoutes.test.ts`,
  `tests/engine/scheduleOperations.test.ts`,
  `tests/routes/scheduleOperations.test.ts`,
  `tests/routes/weekActivityOverride.test.ts`,
  `tests/routes/weekProgramPersistence.test.ts`.

## Remaining limitations / deliberately out of scope

- Fix 4's Option B (true asymmetric move semantics) is not implemented —
  only `swap` is exposed, per the spec's own recommendation ("use Option
  A unless the UI already needs true move behavior"); no UI calls
  `/week/move` today.
- Fix 5's Option B (an explicit `source` column on `workout_sessions`)
  was not added — Option A (status-based, tested against a
  non-AI-created case) fully satisfies the spec's requirement without
  a schema change, per Main Objective #6 ("avoid introducing unnecessary
  new abstractions").
- No cancellation/abandonment workflow for a planned session exists
  (Fix 3's "move or cancel" message describes an action this codebase
  cannot yet perform for a solo planned session outside of `/week/swap`).
  Building one is explicitly out of this task's scope per its own
  Non-Goals ("adding a new session status without implementing its
  complete lifecycle").
