# Implementation Report — Final Actionable vs Historical Session Resolution Fixes

Spec: `docs/CLAUDE_TASK_FINAL_ACTIONABLE_VS_HISTORICAL_SESSION_FIXES.md`.
Base commit: `45aec4c` (spec saved).

This report follows the spec's own bar: it states what changed, why it
satisfies each numbered requirement, and which test proves it — and does
not claim a database-level invariant unless one is genuinely implemented
(the spec explicitly asks for this; see the "Remaining limitations"
section below for exactly what is and isn't enforced at the schema level).

---

## Section 1 — Distinguish historical sessions from actionable sessions

**Before:** the prior phase's `resolveSelectedSession` returned a single
flat `WorkoutSession | undefined`. A completed session and an actionable
planned session were both just "the resolved session" — nothing in the
type or the API distinguished "this already happened" from "this can
still be started."

**After:** `src/engine/selectedSessionResolver.ts` now exports
`SelectedSessionResolution`, adopting the spec's own suggested shape
almost verbatim:

```ts
interface SelectedSessionResolution {
  historicalSession: WorkoutSession | null;
  selectedPlannedWorkout: WorkoutSession | null;
  selectionConflict: SelectionConflict | null;
  source: 'completed' | 'in_progress' | 'ai' | 'deterministic' | 'none' | 'conflict';
}
```

A `completed` or `in_progress` session is **only ever** returned as
`historicalSession` — it is structurally impossible for the resolver to
also place it in `selectedPlannedWorkout` (they come from disjoint
branches of the same function). `/week` and `/today` both expose all
three fields (`historicalSession`, `selectedPlannedWorkout`,
`selectionConflict`) directly on each day/today response, alongside the
pre-existing `plannedSession` field (kept for backward compatibility with
two existing frontend pages and ~25 existing tests — see "API shape"
below).

**Tests:** `tests/engine/selectedSessionResolver.test.ts` items 5–6
("one completed session -> historicalSession, never
selectedPlannedWorkout", "one in-progress session -> historicalSession,
never a new planned workout").

---

## Section 2 — Same-date replacement policy: completed/in-progress now blocks new writes

**Before:** the prior phase's `findActiveGymSessionConflict` treated only
`planned`/`in_progress` as blocking a new session creation — a
`completed` session never blocked anything (explicitly, deliberately, to
support a hypothetical future same-day-makeup feature).

**After — reversed, per this spec's explicit instruction:**
`findActiveGymSessionConflict` now also matches `completed`. Every write
path that calls it — `POST /api/workouts` and
`aiProposalLifecycle.ts`'s commit pre-check — now rejects a new
planned/AI session for a date that already has a completed OR
in-progress Gym session, with the spec's suggested code:

```text
DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION
```

(kept distinct from the pre-existing `ACTIVE_GYM_SESSION_EXISTS`, used
when the blocker is itself merely `planned` — so a caller can tell "this
date is historically closed out" apart from "something else is already
in flight"). The historical/in-progress session itself is never deleted
or overwritten — the guard only ever refuses the NEW write.

Per the spec's own scope note, same-day makeup support is explicitly
NOT built here — the guard simply rejects; no new "second session" model
was introduced.

**Tests:** `tests/engine/selectedSessionResolver.test.ts`'s
`findActiveGymSessionConflict` describe block ("a completed gym session
IS now a conflict"); `tests/routes/workoutsSelectedSessionGuard.test.ts`
(rewritten — the prior phase's "allows... a same-day makeup session"
test now asserts the opposite: 409, with the historical session
confirmed untouched via a follow-up `GET`).

---

## Section 3/4 — One authoritative resolver, explicit precedence

**Precedence** (`resolveSelectedSession`'s own doc comment), most
authoritative first:

1. `completed` (any duplicates: most-recently-created wins, a display
   tie-break for an already-historical fact — not flagged as a conflict,
   since the spec's conflict requirement is scoped to "active planned"
   duplicates specifically).
2. `in_progress` (same tie-break note). Completed is checked ahead of
   in-progress when, unusually, both exist for one date — this preserves
   this codebase's own pre-existing status-priority convention
   (`realSessionStatus` before this phase already ranked them that way);
   no required test forces either order, so continuity was preferred
   over re-deriving a new one.
3. `planned`, `source_type` `'ai'`/`'manual'` — selected only when no
   historical session exists. More than one such session is a
   `selectionConflict` (see Section 5), never resolved by recency alone.
4. `planned`, `source_type` `'deterministic'` — same conflict handling.
5. Nothing at all — `source: 'none'`, a normal, valid, non-error result.

**"Ownership and program scope" validation** (spec's own resolver
requirement item 2): this app has no `user_id` on `workout_sessions` at
all (genuinely single-user throughout the codebase — every route already
resolves the one `UsersRepo.getOrCreateDefault()` user), so there is no
cross-user boundary to enforce here; "program scope" was already
addressed in the immediately-prior phase (`WeeklyProgramRepo.getByWeekStart`
filtering to `status = 'active'` programs) and is unchanged by this
phase. `tests/engine/selectedSessionResolver.test.ts` item 12 documents
the one real scope boundary this resolver enforces directly: non-gym
sessions (e.g. a same-day badminton session) never participate in gym-day
resolution.

**Tests:** all 13 of the spec's required resolver cases are covered in
`tests/engine/selectedSessionResolver.test.ts` (20 tests total, including
explicit array-reversal and 4-permutation order-independence fuzzing).

---

## Section 5 — Multiple active planned sessions surface a conflict, never a silent recency pick

**Before:** the prior phase's resolver picked the most-recently-created
session among multiple active AI/deterministic planned sessions, with no
signal that this was itself an unusual/invalid state.

**After:** when more than one session exists in the winning `planned`
tier, `resolveSelectedSession` returns:

```json
{
  "selectionConflict": {
    "code": "MULTIPLE_ACTIVE_PLANNED_SESSIONS",
    "message": "Multiple active planned Gym sessions exist for this date.",
    "sessionIds": ["...", "..."]
  },
  "selectedPlannedWorkout": { "...": "the most-recently-created one, still exposed" },
  "source": "conflict"
}
```

The deterministic recovery candidate (most-recently-created) is still
returned in `selectedPlannedWorkout` — per the spec's own allowance
("it may expose a deterministic recovery candidate") — but the response
is unambiguously marked conflicted via `selectionConflict`/`source`, so
no caller can mistake it for an unconditionally valid answer. **Write
paths reject creating another active planned session while this state
exists** (Section 2's guard — `findActiveGymSessionConflict` matches the
FIRST active session it finds regardless of which tier), so this state
can now only arise from data that predates this phase's guards (a
genuinely pre-existing-data concern, per Section 11).

**Tests:** `selectedSessionResolver.test.ts` items 9–10 and 13
("multiple active AI planned sessions", "multiple active deterministic
planned sessions", "tie-breaking is never a substitute for reporting the
conflict") plus the order-independence fuzz test (which deliberately
constructs a conflicted tier and checks the conflict survives every
permutation). End-to-end: `tests/routes/actionableVsHistoricalIntegration.test.ts`'s
"multiple active planned AI sessions... surface a selectionConflict
consistently on /week and /today" — constructs the state directly via
the repo (bypassing the write guard, simulating pre-existing bad data)
and confirms both endpoints report the identical conflict object.

---

## Section 6 — AI supersession provenance preserved

Unchanged from the prior two phases, re-verified: the deterministic
`program_sessions` row is never deleted when an AI session supersedes
it (only display precedence changes — `resolveGymDaySelection`'s
`combinedSession` computation, now sourced from the resolution's
`historicalSession ?? selectedPlannedWorkout` instead of the prior
phase's single flat value, but the supersession rule itself —
`source_type !== 'deterministic'` — is identical). `source_type`/
`supersedes_program_session_id` remain intact on every session row.
"Belongs to the authenticated user and active program" — see Section
3/4's note on ownership/program scope above (single-user app; program
scope enforced by the prior phase's `WeeklyProgramRepo` filter).

**Test:** the full existing supersession test suite from the prior two
phases continues to pass unmodified (52 tests in
`tests/routes/scheduleOperations.test.ts`, including the "AI/manual
session supersedes an existing deterministic prescription" describe
block).

---

## Section 7/8 — Write-path protection, extended to every creation path

| Path | Guard | Status |
|---|---|---|
| `POST /api/workouts` (deterministic/manual creation) | `findActiveGymSessionConflict`, now including `completed` | Updated this phase |
| AI proposal commit (`aiProposalLifecycle.ts`) | Same shared function | Updated this phase (widened for free — the function itself changed) |
| `PUT /week/days/:day/activity` with `reuse`/`regenerate` | N/A — this path never creates a real `workout_sessions` row; it only ever writes a `program_sessions` snapshot or a `week_activity_overrides` row. Once a real historical/actionable session exists for that date, the resolver already treats the deterministic snapshot as inert (Section 2) regardless of what this route does to it — so there is no real-session write here for the guard to protect | No change needed (verified by code inspection: `computeFreshWeek`/`reconcileWeekProgram` never call `WorkoutSessionsRepo.createSession`) |
| Move/swap destination-date guard | `isDayLocked` (session-type-agnostic completed/in_progress check), pre-existing from an earlier phase | Already satisfies this requirement — verified via `tests/engine/scheduleOperations.test.ts`'s existing "rejects when the destination has a completed session (DAY_LOCKED)" test, unmodified |

**Atomicity / no partial writes:** verified for the AI-commit path — the
active-session check happens entirely before `commitAIProposalToPlannedSession`'s
`db.transaction()` begins (unchanged control flow), so a rejection never
leaves a partial session/exercise/proposal-status write. Strengthened
the two existing "completed-session conflict"/"in-progress-session
conflict" AI-commit tests with explicit assertions that (a) exactly one
session exists for the date afterward (the pre-existing historical one,
never a second partial one) and (b) the proposal's own status is
unchanged (`'approved'`, not silently transitioned).

**Tests:** `tests/routes/workoutsSelectedSessionGuard.test.ts` (5 tests,
covering write-path items 1, 2, 5, 8 from the spec's list directly);
`tests/ai-programmer/aiProposalRoutes.test.ts` (strengthened existing
tests for items 3–4; a new "two different proposals targeting the same
date" test — see the immediately-prior phase's report — covers item 5's
AI-specific case).

---

## Section 9 — API contract: `historicalSession`/`selectedPlannedWorkout`/`selectionConflict` exposed directly

Both `GET /api/programming/week` (per day) and `GET /api/programming/today`
now carry all three fields, matching the spec's own JSON examples
exactly in shape:

```json
{ "historicalSession": null, "selectedPlannedWorkout": { "id": "...", "source": "ai", "status": "planned" }, "selectionConflict": null }
{ "historicalSession": { "id": "...", "source": "deterministic", "status": "completed" }, "selectedPlannedWorkout": null, "selectionConflict": null }
{ "historicalSession": null, "selectedPlannedWorkout": { "id": "...", "source": "ai", "status": "planned" }, "selectionConflict": { "code": "MULTIPLE_ACTIVE_PLANNED_SESSIONS", "message": "...", "sessionIds": ["...", "..."] } }
```

**API shape decision:** the pre-existing `plannedSession` field (used by
both frontend pages and ~25 existing tests) is kept, unchanged in shape
(`{id, source, status}`), now derived as `historicalSession ??
selectedPlannedWorkout` — i.e. "whichever one is relevant to show." This
was a deliberate choice to avoid a wholesale rename that would ripple
through dozens of already-passing tests and two frontend pages for a
field whose CONTENT (not name) was the actual bug; the spec explicitly
permits this ("Use the project's actual response structure... the
important requirement is that consumers can distinguish..."). The new
fields are the ones any conflict-aware or historical-vs-actionable-aware
consumer should use going forward.

**Tests:** `tests/routes/actionableVsHistoricalIntegration.test.ts` (5
new endpoint-level tests asserting the exact JSON shape for the
no-session, actionable, historical-completed, and conflict cases, on
both `/week` and `/today`, plus a completion-isolation test).

---

## Section 10 — Frontend behavior

**`today.html`'s status card** (`renderSessionStatus`) was rewritten to
branch explicitly, in priority order:

1. `selectionConflict` present → a "workout state is ambiguous" card
   with the conflict's own message, and an explicit instruction to check
   the Program page — **no `/logger.html` link is rendered in this
   branch at all** (verified by a dedicated test that slices the source
   between the conflict branch and the next `else if` and asserts no
   `logger.html?session=` appears in it).
2. `historicalSession` present → the existing completed/in-progress card
   ("View workout" / "Continue workout"), looked up by its exact
   resolver-given id in `loggedSessions` (a qualified id-lookup, never
   an unqualified `.find()` by type).
3. `selectedPlannedWorkout` present → the same card pattern for the
   actionable case.
4. Deterministic plan exists but no real session yet → "Start workout"
   (unchanged).
5. Nothing at all → "No gym workout logged for today yet." (unchanged).

The empty-state message above the exercise list (§85 of the file) also
now distinguishes a conflicted date ("Today's workout selection is
ambiguous — see below...") from the pre-existing "created from an AI
proposal" message, which now checks `historicalSession ||
selectedPlannedWorkout` explicitly instead of the old `plannedSession`.

**`program.html`**: the week-grid day card's meta text now shows "Needs
review — ambiguous workout state" instead of the normal exercise-count/
AI-planned text when `day.selectionConflict` is set; the day modal shows
the conflict's message and the conflicting session ids, and — like
today.html — never renders the "Open planned workout" link in that
branch.

All existing styling/CSS classes (`createCard`, `createStatusBadge`,
`createButton`, `.wd-meta`, `.muted`, `.faint`) are reused unchanged —
no new CSS was added.

**Tests:** `tests/frontend/todaySessionResolution.test.ts` (rewritten, 7
tests: no unqualified `.find()`, qualified id-lookup present, explicit
`historicalSession`/`selectedPlannedWorkout` branching, conflict-checked-
first with no logger link in that branch, and the equivalent two
assertions for `program.html`).

---

## Section 11 — Handling already-existing invalid data safely

No destructive migration or repair utility was written — the spec is
explicit that this phase must not auto-delete or silently
complete/supersede existing rows to "fix" bad data. Instead:

- The resolver (Section 5) already degrades safely on encountering a
  pre-existing multi-planned-session state: it reports the conflict AND
  still returns a usable recovery candidate, rather than crashing or
  silently trusting the ambiguous data.
- The resolver (Sections 1/2) already degrades safely on encountering a
  pre-existing "completed/in-progress + stray planned session on the
  same date" state (a shape this phase's OWN write guard now prevents
  going forward, but which existing data or a still-possible race could
  already contain): the planned session is simply excluded from
  `selectedPlannedWorkout`, never presented as valid, and
  `historicalSession` correctly reflects the real state.
- Every conflict/rejection now logs structured diagnostics (Section
  "Logging and Diagnostics" below) with enough information (date,
  session type, code, conflicting session ids) for a controlled manual
  repair — no repair utility exists in this codebase today, so none was
  invented; the log output is the "enough IDs and diagnostics" the spec
  asks for in that case.

**Test:** `actionableVsHistoricalIntegration.test.ts`'s conflict test
constructs exactly this "pre-existing bad data" shape directly via the
repo (bypassing the write guard, which is the only way this state can
still arise) and proves the read path handles it exactly as described.

---

## Logging and Diagnostics

`src/engine/selectedSessionResolver.ts` exports `logSessionConflict({
operation, date, sessionType, code, conflictingSessionIds, userId? })`,
a single shared `console.warn` call used at every point a
conflict/rejection is detected:

- `POST /api/workouts`'s write-guard rejection.
- `aiProposalLifecycle.ts`'s commit-time conflict rejection.
- `renderWeekDays`, whenever a read encounters a `selectionConflict`
  (proactive diagnosis of pre-existing bad data, not just write-time
  rejections).

No tokens, request bodies, or unrelated personal data are logged — only
the fields the spec lists. `userId` is accepted but not threaded through
every call site (this app is single-user, so it is not the primary
diagnostic key for this dataset); it is included wherever a caller
already has it cheaply on hand.

---

## Verification

**Canonical command** (per the spec's own instruction, adapted to this
repo's actual package manager and scripts — `package.json` has no `lint`
script, so that step is reported as not applicable rather than
fabricated):

```bash
rm -rf node_modules
npm ci
npm run verify   # = npm run build && npm run typecheck && npm test
```

**Result:**

- Environment: this session's Linux container, Node `v22.22.2`, npm `10.9.7`.
- Date: 2026-09-13 (UTC).
- Result: **PASS** — `npm run build` clean, `npm run typecheck`
  (`tsc --noEmit`) clean, **102 test files, 1171 tests, all passing**,
  exit code 0.
- **Lint: N/A** — no `lint` script exists in `package.json`; this
  codebase has never had ESLint/a linter configured (confirmed by
  inspection, consistent with every prior phase's own reports).

**Targeted checks** (spec's own suggested filters, translated to this
repo's actual vitest CLI syntax):

```bash
npm test -- selectedSessionResolver   # 1 file, 20 tests, PASS
npm test -- programming               # 1 file, 17 tests, PASS
```

**Live manual smoke test** (scratch in-memory SQLite DB, real
`createApp(db)` server, not mocked) — exercised, in order:

1. Deterministic week generation.
2. Completed a gym session for a date, then attempted `POST
   /api/workouts` for a NEW planned session on the same date — correctly
   rejected `409 DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION`
   (the exact reversal of the prior phase's "completed never blocks"
   behavior, now required by this spec).
3. `/week` and `/today` both reported the identical `historicalSession`
   (`status: 'completed'`) and `selectedPlannedWorkout: null`.
4. Directly created two `planned`/`'ai'` sessions on another date (via
   the repo, bypassing the write guard — simulating pre-existing bad
   data) — `/week` and `/today` both surfaced the identical
   `selectionConflict` (`MULTIPLE_ACTIVE_PLANNED_SESSIONS`, both
   conflicting session ids) alongside a usable `selectedPlannedWorkout`
   recovery candidate, and the structured log line fired.
5. `GET /api/workouts/<selectedPlannedWorkout.id>` (the logger's own
   call) returned exactly that session, confirming the logger opens the
   resolver-selected session even in a conflicted state.

All five steps produced exactly the behavior the spec's sections above
require.

---

## Files changed

- `src/engine/selectedSessionResolver.ts` — `SelectedSessionResolution`/
  `SelectionConflict` types; `resolveSelectedSession` rewritten to return
  the structured resolution with explicit precedence and conflict
  detection; `findActiveGymSessionConflict` widened to include
  `completed`; new `logSessionConflict`.
- `src/server/routes/programming.ts` — `resolveGymDayResolution` (was
  `findGymDaySession`); `realSessionStatus` and `resolveGymDaySelection`
  updated to consume the structured resolution; `renderWeekDays` exposes
  `historicalSession`/`selectedPlannedWorkout`/`selectionConflict` on
  every day object (plus logs conflicts it encounters); `/today` passes
  the same three fields through.
- `src/server/routes/workouts.ts` — `POST /` now distinguishes
  `DATE_ALREADY_HAS_COMPLETED_OR_IN_PROGRESS_GYM_SESSION` from
  `ACTIVE_GYM_SESSION_EXISTS` and logs the conflict.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — logs the conflict
  it already rejected (no behavior change, since `findActiveGymSessionConflict`
  widening is redundant here — `buildProgrammerContext`'s own earlier
  lock check already catches completed/in-progress before this line is
  reached).
- `public/today.html` — `renderSessionStatus` rewritten for explicit
  historical/actionable/conflict branching; empty-state message
  distinguishes the conflict case.
- `public/program.html` — week-grid meta text and day-modal both surface
  `selectionConflict` instead of silently falling through to the normal
  planned-work display.
- Tests: `tests/engine/selectedSessionResolver.test.ts` (rewritten for
  the new contract, 20 tests), `tests/routes/workoutsSelectedSessionGuard.test.ts`
  (rewritten, 5 tests), `tests/routes/actionableVsHistoricalIntegration.test.ts`
  (new, 5 tests), `tests/frontend/todaySessionResolution.test.ts`
  (rewritten, 7 tests), `tests/ai-programmer/aiProposalRoutes.test.ts`
  (2 existing tests strengthened with no-partial-write assertions).

## Remaining limitations / deliberately out of scope

- **No schema-level uniqueness constraint** exists for "at most one
  active planned session per date" or "historical sessions are
  immutable" — both remain service-level invariants (the shared
  `findActiveGymSessionConflict` guard on every write path), for the
  same reason stated in the immediately-prior phase's report: the
  resolver's own required test matrix needs multiple real session rows
  constructible per date to be meaningfully tested against, which a
  blanket `UNIQUE` constraint would make impossible. This report does
  not claim a database invariant that does not exist, per the spec's
  own explicit instruction.
- **Same-day makeup workflow** was explicitly not built — per the
  spec's own scope note, this is deferred to a future, separate feature
  with its own explicit second-session/actionable-session model.
- **No repair utility** was built for pre-existing conflicted data — the
  spec explicitly forbids auto-deleting or silently
  completing/superseding records to hide the problem, and no repair
  utility already existed in this codebase to integrate with; the
  structured logging (see above) is the diagnostic surface the spec
  asks for in that situation.
