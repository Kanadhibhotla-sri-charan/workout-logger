# Implementation Report — Final Selected Session Resolution and AI/Deterministic Precedence Fixes

Spec: `docs/CLAUDE_TASK_FINAL_SELECTED_SESSION_RESOLUTION_AND_AI_PRECEDENCE_FIXES.md`.
Base commit: `2f924ed` (spec saved).

This report follows the spec's own "Definition of Done" — it states what
changed, why it satisfies each numbered section, and which test proves
it, rather than asserting completion from endpoint existence alone.

---

## Section 1 — Replace `findRealGymSession()` with an authoritative resolver

**Before:** `programming.ts`'s `findRealGymSession()` was
`listSessionsByDate(date).find((s) => s.session_type === 'gym')` —
`listSessionsByDate` orders by `start_time ASC`, so this picked whichever
row happened to sort first, not the session that was actually
authoritative. In practice this rarely diverged (the AI-commit path
already prevented two simultaneous `planned` sessions), but it was not a
valid precedence rule, and the app's own frontend (`today.html`)
independently re-implemented the exact same anti-pattern — see Section 6.

**After:** a new module, `src/engine/selectedSessionResolver.ts`, exports
`resolveSelectedSession(sessionsOnDate)` — the ONE authoritative resolver.
It filters to `session_type === 'gym'` internally and applies an explicit
tiered precedence (Section 2), breaking ties within a tier by
`created_at` (most recent wins), never by array/row order. Verified
directly with a deliberately reversed input array in every unit test
(`tests/engine/selectedSessionResolver.test.ts`).

`programming.ts`'s `findRealGymSession` is now `findGymDaySession`, a
thin wrapper: `resolveSelectedSession(new WorkoutSessionsRepo(database).listSessionsByDate(date))`.
`realSessionStatus` (a day's real status label) was also rewritten to
delegate to the same resolver rather than maintaining its own separate
completed/in-progress/planned tiering — a day's "real status" and "which
session is selected" can no longer disagree with each other.

**Tests:** `tests/engine/selectedSessionResolver.test.ts` — 17 tests
covering every case in §11.A's required matrix (see Section 11 below),
including explicit array-order fuzzing.

---

## Section 2 — Define and centralize session precedence

**Precedence implemented** (most authoritative first), exactly as the
spec recommends, and documented once in `selectedSessionResolver.ts`'s
own doc comment — never re-described independently anywhere else:

1. `completed` — a finished workout is the permanent historical record;
   a later `planned` replacement never displaces it.
2. `in_progress` — active execution in flight takes precedence over any
   other `planned` candidate.
3. `planned`, `source_type` `'ai'`/`'manual'` — an explicit replacement
   supersedes the deterministic prescription.
4. `planned`, `source_type` `'deterministic'` — the day's own generated
   plan, merely started.

**The two distinct questions the spec calls out are both answered
explicitly, not conflated:**

- *Which session is authoritative?* → `resolveSelectedSession`'s return
  value (a real `WorkoutSession` or `undefined`).
- *Should deterministic `plannedWork` be displayed?* →
  `resolveGymDaySelection`'s `showDeterministic` boolean, computed FROM
  the resolved session (`realSession.source_type !== 'deterministic'`
  means don't show it) — kept as a separate, explicitly-named field
  precisely because the spec flags a `{ showDeterministic: boolean }`-only
  helper as insufficient by itself; here it exists alongside, not instead
  of, the resolved session identity.

---

## Section 3 — Enforce one selected planned workout per user/date

**Chosen approach:** a variant of Option C ("existing single-user model")
adapted to this app's real architecture, rather than Option A's `selected`
column or Option B's mapping table. Rationale, stated plainly: this app
has no `user_id` on `workout_sessions` (genuinely single-user, per
existing precedent throughout the codebase), and — more importantly — the
regression matrix this SAME spec requires (§11.A: "completed session plus
planned replacement", "multiple AI sessions exist") demands that MULTIPLE
real session rows be able to coexist for one date; a blunt schema-level
`UNIQUE(date) WHERE session_type='gym'` constraint would make it
impossible to even construct those required test fixtures, let alone
correctly resolve them. A persisted `selected` boolean toggled
procedurally on every write path would reintroduce exactly the
scattered-precedence-logic risk this spec exists to eliminate (the flag
could itself drift out of sync with reality).

**What was actually built instead** — a single shared, exported,
directly-tested guard function, `findActiveGymSessionConflict`
(`selectedSessionResolver.ts`): "is there already a `planned` or
`in_progress` real gym session for this date?" `completed` never
conflicts (a same-day makeup session is legitimate — required by
§11.A). This function is now called from EVERY session-creation write
path in the codebase:

- `POST /api/workouts` (`workouts.ts`) — **this was the actual gap**: the
  generic session-creation route (used by `today.html`'s "Start
  workout"/"Log something else") had NO conflict checking at all before
  this fix, unlike the AI-commit path. A gym-type creation now gets a
  `409 ACTIVE_GYM_SESSION_EXISTS` with `conflictingSessionId` if one
  already exists.
- `aiProposalLifecycle.ts`'s commit path — its own inline
  `.find((s) => s.status === 'planned')` check was refactored to call
  the SAME shared function, unifying both call sites into one auditable
  rule rather than two independently-maintained ones (also closes a
  narrow gap: the old check only looked at `'planned'`, relying on an
  earlier, separate lock check to catch `'in_progress'`; the shared
  function checks both directly, so this call site is now self-sufficient).

This makes "at most one active (planned/in_progress) real gym session
per date" hold through every SUPPORTED write path — the spec's own
stated bar ("no supported API flow can create two competing selected
workouts"), not a blanket "physically impossible in the database"
guarantee that would conflict with the resolver's own required test
matrix.

**Tests:** `tests/routes/workoutsSelectedSessionGuard.test.ts` (5 tests:
planned conflict, in-progress conflict, completed-never-blocks, cross-
type non-interference, cross-date non-interference) and the mixed-source
AI-commit test in Section 10 below.

---

## Section 4 — Make AI supersession atomic

Already true before this phase (verified, not re-built): the entire
commit — override write, session creation with `source_type`/
`supersedes_program_session_id`, exercise/set persistence, and
`markCommitted` — happens inside one `db.transaction()` in
`commitAIProposalToPlannedSession`. This phase's own change to that
function (swapping the inline conflict check for the shared
`findActiveGymSessionConflict`) sits entirely BEFORE the transaction
begins (a pure pre-check, as it already was), so the atomicity boundary
itself is unchanged.

**Invariant verified:** "no committed proposal without a corresponding
selected session" — the existing rollback tests
(`tests/ai-programmer/aiProposalRoutes.test.ts`'s "a persistence failure
mid-commit rolls back...") already prove this and continued to pass
unmodified through this phase's refactor.

---

## Section 5 — Strengthen deterministic program-session ownership

**Audit finding:** `WeeklyProgramRepo.getByWeekStart` matched
`programs.start_date = ?` with no `status` filter — and the SAME
`programs` table is also written by the separate, legacy `ProgramsRepo`
(the original draft/active/completed/archived Program concept). A row
that legacy repo later marks `'archived'`/`'completed'`/`'draft'` could,
in a purely hypothetical future collision, still be matched here if its
`start_date` ever coincided with a real week-Monday.

**Fix:** `getByWeekStart`'s query now filters `AND status = 'active'`
explicitly. Every row THIS repo ever creates is written with
`status = 'active'` and never transitions away from it, so this is a
no-op for the happy path — it closes the hypothetical gap for free.

**Why no schema-level `UNIQUE(start_date)` was added:** the same shared-
table risk applies here as in Section 3 — the legacy `ProgramsRepo`
writes its own (nullable, usually-null) `start_date` to the same table,
and a blanket unique constraint could throw a spurious `SQLITE_CONSTRAINT`
if a legacy Program's `start_date` ever coincided with a real week-Monday
value. One-program-per-week is instead a procedural invariant, safe in
this codebase's synchronous, single-threaded architecture (better-sqlite3
has no `await` point between `ensureWeekProgramGenerated`'s
check-then-create), and is now documented explicitly and directly
regression-tested per the spec's own escape hatch ("if the application
guarantees one active program, document that invariant and add a test").

**Tests:** `tests/repositories/weeklyProgramRepo.test.ts` — "getByWeekStart
never returns a non-active program row, even if one exists with a
matching start_date" (directly archives a row and proves it's no longer
matched) and a second test documenting the check-then-create reality for
the pathological double-create case.

---

## Section 6 — Make `/today`, `/week`, and Logger use the same resolver

**Backend:** already structurally guaranteed — `GET /today` calls
`buildWeekResponse` → `renderWeekDays`, the EXACT SAME function `GET
/week` calls; both routes were already reading from one shared
computation, not two independent ones. This phase's fix was making that
shared computation correct (Section 1), not restructuring the routes.

**Frontend — the concrete divergence found and fixed:** `today.html`'s
own status card computed `gymSession` via
`todayData.loggedSessions.find((s) => s.session_type === 'gym')` — the
EXACT SAME row-order-dependent anti-pattern as the old backend
`findRealGymSession()`. If more than one real gym session existed for a
date (e.g. a completed one plus a newer planned one — a state the
backend resolver now handles correctly), this independent frontend
`.find()` could pick a DIFFERENT session than `plannedSession` (and
therefore than the logger/completion would operate on). Fixed to look
the session up BY THE ID `plannedSession` already resolved:
`todayData.loggedSessions.find((s) => s.session_id === todayData.plannedSession.id)`.

**Logger and completion:** audited, unchanged — `logger.html` always
operates on an explicit `?session=<id>` query parameter (never
independently re-derives "today's session"), and `PATCH
/api/workouts/:id` / `POST /api/workouts/:id/exercises` both act on
whatever id the caller passes. Since today.html/program.html now
consistently link `plannedSession.id`, logger and completion transitively
always act on the resolver's own pick.

**Tests:** `tests/frontend/todaySessionResolution.test.ts` (static
markup/script assertions, this codebase's existing pattern for testing
inline page scripts — see `tests/frontend/exercisePicker.test.ts`) proves
the old pattern is gone and the by-id lookup is in place. The live smoke
test below additionally proves `/today`/`/week`/logger agreement
end-to-end against a real server.

---

## Section 7 — Keep `plannedWork` and `plannedSession` semantically clear

Kept the existing field names (`plannedWork`, `plannedSession`,
`supersedesProgramSessionId`) rather than adopting the spec's suggested
`selectedPlannedWorkout` rename — the spec explicitly allows this ("the
exact schema may differ"). These fields already carry exactly the
semantics required: `plannedWork` is deterministic-only, `plannedSession`
is the authoritative persisted session, and an empty `plannedWork` next
to a non-null `plannedSession` is the documented, tested signal that a
real workout exists despite no deterministic exercise list (Section 11.G
below verifies this is never misread as "no workout"/Rest).

---

## Section 8 — Clarify `reuse`/`swap`/`move`/`regenerate`

Unchanged from the immediately-prior phase, which already implemented
and tested this section's exact requirements (`reuse` never borrows
across dates, `swap` is exchange-only and never regenerates, `move` has
explicit, tested source-date behavior — the source becomes Rest,
`regenerate` is never implicit). This phase's `findActiveGymSessionConflict`
guard is orthogonal to these operations (swap/move/reuse touch
schedule/prescription state directly, never through the generic
`POST /api/workouts` route this guard protects) and does not change
their behavior — confirmed by the full existing swap/move/reuse test
suite continuing to pass unmodified.

---

## Section 9 — Movable session ownership and protection

Unchanged, verified still correct: `moveActivity`/`swapDayActivities`
(`scheduleOperations.ts`) already reject `DAY_LOCKED` (completed/
in-progress source or destination) and `DESTINATION_OCCUPIED`. This
phase's resolver work makes "the selected session cannot be determined
unambiguously" structurally unreachable rather than needing a dedicated
runtime rejection: Section 3's write-time guard means at most one
`planned`/`in_progress` real session can ever exist per date through any
supported flow, and Section 1's resolver gives a deterministic answer
even in the one case that IS still reachable (a `completed` session
coexisting with a stray `planned` one) — so ownership is never actually
ambiguous, only ever resolved by an explicit, tested rule.

---

## Section 10 — Mixed-source conflict handling

Every combination the spec lists now resolves to exactly one of the four
documented outcomes:

| Combination | Outcome |
|---|---|
| Deterministic + AI | AI supersedes (Section 1/2); the deterministic row is never deleted |
| Deterministic + manual | Manual supersedes, same rule |
| AI + manual (both `planned`) | `findActiveGymSessionConflict` rejects the second create/commit |
| Completed deterministic + planned AI | Resolver keeps the completed one authoritative (§11.A) |
| In-progress deterministic + planned AI | Resolver keeps the in-progress one authoritative (§11.A) |
| Multiple AI sessions | Rejected at creation time (§3); if two somehow exist, resolver picks the most recent |
| Existing superseded session + new AI proposal | The pre-commit conflict check rejects the new proposal while the old one is still active |
| Existing selected session + idempotent recommit | Unchanged pre-existing idempotent-recommit behavior (returns the same `committedSessionId`) |

**New explicit test** for the specifically-named "AI commit targets a
date with selected manual session" case:
`tests/ai-programmer/aiProposalRoutes.test.ts`'s "an existing MANUAL
selected session on the target date is also rejected as a conflict" —
proves the shared guard doesn't discriminate by `source_type`.

**New explicit test** for "two AI commits target the same date
concurrently" as two DIFFERENT proposals (distinct from the pre-existing
same-proposal idempotency/concurrency tests):
"two different proposals targeting the same date: the first commit
succeeds, the second is rejected as a conflict."

---

## Section 11 — Required regression test matrix

**A. Authoritative resolver** — all 10 required cases, `tests/engine/selectedSessionResolver.test.ts`:
no-session, deterministic-only, AI-supersedes, manual-supersedes,
AI-and-manual-coexist (most recent wins), multiple-AI (most recent
wins), completed-plus-planned-replacement, in-progress-plus-planned-
replacement, order-independence (explicit reversed-array and 4-permutation
fuzz tests), and returns source/id/status/supersession metadata via the
resolved object itself.

**B. Selected-session uniqueness** — two different proposals same date
(new, Section 10), AI commit vs. existing deterministic prescription
(pre-existing, unchanged), AI commit vs. existing selected manual session
(new, Section 10), database-level duplicate rejection (via the shared
write-time guard — Section 3's own design note explains why this is
enforced at the service level, not the schema level), recommit
idempotency (pre-existing, re-verified passing), failed-transaction-
leaves-no-orphan (pre-existing rollback tests, re-verified passing).

**C. AI commit** — `fill_existing_gym_day`/`replace_day_activity` on
Gym/Rest days, invalid/missing intent, stale proposal, existing-session
conflict (both generic and the new manual-specific case), supersession
metadata correctness, atomic commit — all pre-existing and passing, plus
the two new tests above.

**D. Reuse** — unchanged from the prior phase, full coverage retained
(existing-prescription reuse, no-prescription 409, never-borrows-from-
another-date, no-silent-regeneration).

**E. Swap** — unchanged from the prior phase (Gym↔Rest, Gym↔Gym,
Rest↔Rest, no-LLM, no-regenerate, history-preservation, protected-session
rejection, `/today`/`/week` agreement).

**F. Move** — unchanged from the prior phase (deterministic and
AI-selected sessions, empty/occupied destination, explicit source-date
behavior, completed/in-progress source rejection); "source ownership is
ambiguous" is unreachable by construction per Section 9 above, argued
there rather than demonstrated as a runtime rejection.

**G. UI/API consistency** — `/today`/`/week` agreement after AI commit,
swap, and move (pre-existing, unchanged); logger opens the same session
as `/today` (pre-existing `§11.F` test from the prior phase, plus this
phase's frontend fix removing the one place that COULD have diverged);
completion updates the same selected session (pre-existing); **new**:
"AI-selected Gym is not displayed as Rest because plannedWork is null" —
explicit `activity`/`type`/`status` assertions added to the main
supersession test in `tests/routes/scheduleOperations.test.ts`; stale-
frontend-data invalidation is unchanged (no caching layer exists — every
route reads fresh from SQLite on each request, verified by code
inspection, unchanged this phase).

---

## Section 12 — Required invariants

1. **At most one selected planned workout per user/date** — Section 3's
   shared write-time guard, applied uniformly across every creation path.
2. **Every selected workout has valid provenance** — `source_type`
   `NOT NULL` with a `CHECK` constraint (pre-existing); every creation
   call site declares it explicitly.
3. **A completed/in-progress workout cannot be silently rescheduled** —
   `DAY_LOCKED` in swap/move (pre-existing, re-verified).
4. **A pure swap never regenerates exercises** — pre-existing, re-verified
   passing.
5. **`reuse` never silently becomes `regenerate`** — pre-existing,
   re-verified passing.
6. **AI commits cannot create an orphan competing workout** — Section 3's
   guard, now also closing the `POST /api/workouts` gap that could
   previously have produced exactly this state via a non-AI path.
7. **`/today`, `/week`, logger, and completion use the same resolver** —
   Sections 1/6; the frontend fix is what makes this true end-to-end, not
   just at the backend layer.
8. **Historical workout logs are immutable through schedule operations**
   — pre-existing, re-verified passing (byte-identity tests from the
   prior phase).
9. **Every move/swap/replacement/regeneration is auditable** — `operation`
   field on swap/move responses, `appliedPrescriptionPolicy` on activity
   changes, `source_type`/`supersedes_program_session_id` on sessions —
   all pre-existing; this phase adds the single shared conflict-check
   function itself as an auditable point (one place to look, not two).
10. **The user-facing schedule has one unambiguous interpretation per
    date** — the resolver (Section 1) plus the write-time guard (Section
    3) together mean no code path ever needs to guess between two
    candidate "current" workouts for a date.

---

## Section 13 — Clean verification

**Canonical command:**

```bash
rm -rf node_modules
npm ci
npm run verify   # = npm run build && npm run typecheck && npm test
```

**Result (this run):**

- Environment: this session's Linux container, Node `v22.22.2`, npm `10.9.7`.
- Date: 2026-09-13 (UTC).
- Result: **PASS** — `npm run build` clean, `npm run typecheck`
  (`tsc --noEmit`) clean, **101 test files, 1158 tests, all passing**,
  exit code 0.
- No suites intentionally excluded; `npm test` runs the full `vitest run`
  suite with no filters.
- `npm audit` reports 8 pre-existing dependency advisories (6 moderate, 1
  high, 1 critical), inherited from `npm ci`'s dependency tree, unrelated
  to this phase's changes and not addressed here.

This exact command, count, and date supersede the prior phase's report
figures (97 files / 1130 tests), which are now stale after this phase's
17 new tests across 4 new files plus 2 test files extended in place.

**Live manual smoke test** (scratch in-memory SQLite DB, real
`createApp(db)` server, not mocked) — exercised, in order:

1. Deterministic week generation.
2. Directly creating an older `planned` AI session followed by a newer
   `completed` manual session for the same date (out of creation order,
   simulating exactly the ambiguity §11.A describes) — confirmed `/week`
   resolves the **completed** one as `plannedSession`, and `activity`/
   `type` stay `'gym'` (never `'rest'`) despite `plannedWork` being empty.
3. `POST /api/workouts` for a new gym session on that date — correctly
   rejected `409 ACTIVE_GYM_SESSION_EXISTS`, because the STILL-PLANNED
   older AI session (never completed or removed) is still active — this
   is exactly the state the resolver/guard pairing is designed to catch:
   the resolver hides it from display (the completed session wins), but
   the guard still refuses to let a THIRD session pile on top of an
   unresolved active one.
4. `/today` and `/week` returned byte-identical `plannedSession` objects.
5. `GET /api/workouts/<plannedSession.id>` (the logger's own call)
   returned the exact same `session_id` and `status`.

All five steps produced exactly the behavior the spec's sections above
require.

---

## Files changed

- `src/engine/selectedSessionResolver.ts` (new) — `resolveSelectedSession`,
  `findActiveGymSessionConflict`.
- `src/server/routes/programming.ts` — `findRealGymSession` →
  `findGymDaySession` (now backed by the resolver); `realSessionStatus`
  delegates to the resolver instead of its own tiering.
- `src/server/routes/workouts.ts` — new `409 ACTIVE_GYM_SESSION_EXISTS`
  guard on `POST /` for `session_type: 'gym'`.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — its own conflict
  check now calls the shared `findActiveGymSessionConflict`.
- `src/repositories/weeklyProgramRepo.ts` — `getByWeekStart` filters
  `status = 'active'`; extended doc comment on ownership/one-program-
  per-week.
- `public/today.html` — status card now resolves its display session by
  `plannedSession.id`, not an independent `.find()` by type.
- Tests: `tests/engine/selectedSessionResolver.test.ts` (new, 17 tests),
  `tests/routes/workoutsSelectedSessionGuard.test.ts` (new, 5 tests),
  `tests/repositories/weeklyProgramRepo.test.ts` (new, 2 tests),
  `tests/frontend/todaySessionResolution.test.ts` (new, 2 tests),
  `tests/ai-programmer/aiProposalRoutes.test.ts` (+2 tests),
  `tests/routes/scheduleOperations.test.ts` (extended 1 existing test
  with §11.G assertions).

## Regression checks

- `rm -rf node_modules && npm ci` — clean.
- `npm run verify` (build + typecheck + `vitest run`) — **101 test
  files, 1158 tests, all passing**, exit code 0. See Section 13.
- Manual HTTP smoke test against a scratch SQLite DB + real
  `createApp(db)` server — see Section 13.

## Remaining limitations / deliberately out of scope

- **No schema-level uniqueness constraint** for "one selected session per
  date" or "one program per week" — both were deliberately rejected in
  favor of service-level enforcement, for the reasons stated in Sections
  3 and 5 (the shared `programs`/`workout_sessions` tables' use by
  separate, uncoordinated repos makes a blanket constraint either
  unsafe or, in the session case, directly incompatible with this same
  spec's own required test matrix, which needs multiple real sessions
  per date constructible for the resolver to be meaningfully tested
  against).
- **The spec's suggested `selectedPlannedWorkout` API shape was not
  adopted** — the existing `plannedSession`/`supersedesProgramSessionId`
  fields already carry equivalent semantics and are used by two existing
  frontend pages and dozens of existing tests; the spec explicitly allows
  this ("the exact schema may differ").
- **No dedicated runtime rejection exists for "source ownership is
  ambiguous"** (§11.F/§9) — argued in Section 9 as a structurally
  unreachable state given Sections 1 and 3 together, rather than
  demonstrated via a runtime error path that has no way to occur through
  any supported flow.
