# Implementation Report — Final AI-Deterministic Precedence and Scheduling Fixes

Spec: `docs/CLAUDE_TASK_FINAL_AI_DETERMINISTIC_PRECEDENCE_AND_SCHEDULING_FIXES.md`.
Base commit: `6c17e2a` (spec saved).

This report follows the spec's own "Definition of Done" — it states what
changed, why it satisfies each numbered section, and which test proves it,
rather than asserting completion from endpoint existence alone.

---

## Section 1/2 — A single selected planned workout per user/date, with an explicit precedence rule

**Before:** a date could have both a persisted deterministic
`program_sessions` snapshot AND a real `workout_sessions` row (e.g. an
AI-committed session) with no rule deciding which one `/week`/`/today`
should display. `renderWeekDays` unconditionally preferred the
deterministic branch whenever a snapshot existed, so a real AI-committed
session on that date was created but silently never shown — a hidden,
competing workout exactly as the spec describes.

**After — Option 1 ("AI replacement/supersession") implemented:**

- `workout_sessions` gained two additive columns:
  `source_type TEXT NOT NULL DEFAULT 'deterministic' CHECK (IN ('ai',
  'deterministic', 'manual'))` and `supersedes_program_session_id TEXT
  REFERENCES program_sessions(id) ON DELETE SET NULL` (schema.sql +
  `client.ts`'s `addColumnIfMissing` migration, so existing databases
  upgrade safely).
- A **single, centralized precedence rule** lives in
  `src/server/routes/programming.ts`'s `resolveGymDaySelection`: a real
  session with `source_type !== 'deterministic'` (i.e. `'ai'` or
  `'manual'`) supersedes the day's deterministic snapshot for display —
  the snapshot's own `plannedWork` is hidden and `plannedSession` points
  at the real session instead. A real session with `source_type ===
  'deterministic'` (the day's own generated plan, merely started) does
  **not** supersede — the full deterministic content stays visible, since
  it and the real session describe the exact same workout.
- The superseded `program_sessions` row is **never deleted** — only
  display precedence changes. It remains queryable via
  `WeeklyProgramRepo`, satisfying the spec's "recoverable/auditable"
  requirement. `supersedesProgramSessionId` is returned on `/week`/`/today`
  so the relationship itself is inspectable, not just implicit.
- `aiProposalLifecycle.ts`'s commit path now looks up any existing
  deterministic snapshot for the target date/day-index **before** the
  write transaction and stamps `source_type: 'ai'`,
  `supersedes_program_session_id` on the newly created session, inside
  the same transaction as the override write.
- `today.html`'s own two session-creation call sites were updated to
  declare their provenance explicitly: `startGeneratedWorkout` sends
  `source_type: 'deterministic'`; the "Log something else" form sends
  `source_type: 'manual'`.

**Tests:** `tests/routes/scheduleOperations.test.ts`'s "Single-selected-
workout precedence" describe block (4 tests: AI supersedes, snapshot
preserved/recoverable, manual supersedes, deterministic-source does NOT
supersede) plus `tests/ai-programmer/aiProposalRoutes.test.ts`'s "§1:
fill_existing_gym_day on a day with an EXISTING deterministic
prescription supersedes it and records provenance."

**Live verification:** generating a real week, then creating an
`'ai'`-sourced real session on a day that already had a deterministic
prescription, showed `/week`'s `plannedWork` become `[]`,
`plannedSession: {source: 'ai', status: 'planned'}`, and
`supersedesProgramSessionId` set to the original prescription's id — and
`/today` agreed exactly (see smoke test steps 1–2 below).

---

## Section 3 — `prescriptionPolicy: reuse` never borrows from another date

**Clarified, not changed in behavior:** `reuse` was already scoped to the
exact target date only (it reads `program.sessions.find((s) =>
s.day_index === targetDayIndex)`, never any other day/week). This phase
strengthened the doc comment on the `PUT /week/days/:day/activity` route
handler with the spec's exact required sentence: *"reuse means use the
prescription already assigned to the target date. It does not search
for, move, or borrow a prescription from another date."*

**Test:** `tests/routes/scheduleOperations.test.ts` — "'reuse' NEVER
borrows a prescription from another date, even when one exists" — sets
up a persisted prescription on Wednesday, then calls `reuse` for
Thursday (which has none) and asserts a `409 generationRequired`
response, never a silent copy from Wednesday.

---

## Section 4 — Distinguish Swap, Move, and Regenerate

**Swap (A↔B):** unchanged from the prior phase — `swapDayActivities`
exchanges both days' effective activity, persisted prescription, and any
real planned sessions symmetrically. `operation: 'swap'` is now echoed
in the response body so callers/logs can always tell which primitive ran.

**Move (A→B), reintroduced with TRUE asymmetric semantics:** the
immediately-prior phase had removed `/week/move` entirely (it was a
mislabeled alias for swap). This spec explicitly requires "Move workout"
as a real, distinct, user-facing action (Section 9) with its own test
matrix (Section 11.D), so this phase **reintroduces `POST
/week/move`** backed by a new `moveActivity()` function in
`scheduleOperations.ts`:

- `fromDay`'s effective activity, persisted prescription, and real
  planned sessions move onto `toDay`.
- `fromDay` becomes `unselected` (Rest) afterward — never restored from
  `toDay`'s prior content (that would be a swap).
- `toDay`'s own prior content (activity, persisted prescription) is
  **discarded**, not preserved anywhere — this is the defining asymmetry
  versus swap.
- Rejects with `409 DESTINATION_OCCUPIED` (new error code) if `toDay`
  already has a real planned/in-progress/completed session — moving onto
  an occupied day is refused rather than silently clobbering another
  active workout.
- An explicit no-op guard makes repeated identical moves idempotent:
  if `fromDay` genuinely has nothing to move (Rest, no persisted
  prescription, no real session), the function returns immediately
  without touching `toDay` at all.

**Regenerate:** unchanged — explicit, caller-approved full generation via
`prescriptionPolicy: 'regenerate'` on `PUT /week/days/:day/activity`.
Never invoked implicitly by swap or move (neither function imports or
calls the planner — verified by code inspection and by the existing "no
fetch is stubbed, would throw if it tried" test pattern already applied
to swap and now equally true of move by construction).

**Tests:** `tests/engine/scheduleOperations.test.ts` (worked example,
destination-discard, moves real planned sessions, ownership/locking ×5,
reversibility/idempotency ×2) and `tests/routes/scheduleOperations.test.ts`'s
"POST /api/programming/week/move — true asymmetric move (§4/§11.D)"
describe block (8 HTTP-level tests covering the same matrix end-to-end).

**Live verification:** see smoke test step 4 below — moving Badminton
Wednesday onto a freshly-Gym Thursday produced Wednesday: Gym (Thursday's
former content), Thursday: Rest — Badminton was discarded, not swapped
back, exactly matching the worked example in the spec.

---

## Section 5 — Movable session ownership

**Rule (already established, reaffirmed and extended to Move):** a
session's `status` alone (not its origin) decides whether it is
schedule-bound — any `planned` session on the source day moves with a
swap or move; `in_progress`/`completed` sessions lock the day instead
(§7). `moveActivity` and `swapDayActivities` share this rule exactly (both
call the source day's real sessions and relocate the `planned` ones via
`WorkoutSessionsRepo.moveDate`).

**"No unambiguous owner" is structurally impossible, not merely
rejected:** because Section 1/2's single-selected-workout precedence
already guarantees at most one real `planned`/`in_progress` session can
exist per date (the AI-commit path's own `plannedConflict` check refuses
to create a second one), and the day's effective activity is always a
single value from `WeekActivityOverridesRepo`, there is never more than
one candidate "owner" of a move/swap operation to resolve ambiguity
between — the invariant is enforced upstream at the point content is
created, not downstream by move/swap needing a tiebreaker.

**Tests:** `tests/engine/scheduleOperations.test.ts`'s "ownership/locking
(§5)" describe block (5 sub-tests: destination occupied, source locked,
destination locked, same-day rejected, no profile) plus Section 1/2's own
supersession tests, which are what make "no unambiguous owner" true by
construction.

---

## Section 6 — Regeneration policy on the normal activity endpoint (schedule-only)

**Before:** `prescriptionPolicy` accepted only `'reuse' | 'regenerate'`,
both nominally required on every call but actually irrelevant (and
untested as irrelevant) when the target activity was Rest/Badminton —
callers had to pass a value that meant nothing for that direction.

**After:** a third value, **`'schedule-only'`**, was added
(`PRESCRIPTION_POLICIES = ['reuse', 'regenerate', 'schedule-only']`) with
strict **direction-dependent validation**, computed immediately after the
activity/policy presence check:

- Target is Gym/Both → `'schedule-only'` is **rejected** (400) —
  changing to Gym always needs an explicit reuse-or-regenerate decision.
- Target is Rest/Badminton → anything other than `'schedule-only'` is
  **rejected** (400) — there is no prescription decision to make in this
  direction, so `'reuse'`/`'regenerate'` are refused as unsupported
  combinations rather than silently accepted and ignored.

Both success response paths now echo `appliedPrescriptionPolicy` so
callers/logs can always see exactly which policy governed the write.
`program.html`'s "Change activity" control was updated to send
`'schedule-only'` when leaving Gym and `'reuse'` (with an explicit
regenerate fallback button on `generationRequired`) when moving to
Gym/Both.

**Tests:** `tests/routes/scheduleOperations.test.ts` — two new rejection
tests ("schedule-only rejected when moving TO gym," "reuse/regenerate
rejected when moving AWAY from gym") plus the rewritten "turning a day
AWAY from gym succeeds" test now using the correct `'schedule-only'`
value.

---

## Section 7 — Active-session safety invariants (preserved and tested more thoroughly)

All prior-phase invariants remain fully enforced and were extended with
two new byte-identity regression tests proving the historical record is
untouched by scheduling operations, not merely "not obviously broken":

1. **"§7 invariant 5: a completed session's real logged exercises/sets
   are byte-identical after its own activity is changed"** — logs a real
   set (weight/reps/RIR/completed) on a completed session, changes that
   same day's activity, and asserts `getSession`/`getExercisePerformances`
   return byte-identical results (`toEqual`) before and after.
2. **"§7 invariant 5: an uninvolved completed session's real logged data
   survives a swap between two OTHER days"** — same assertion, but the
   completed session's own day is never touched; a swap/move happens
   between two different days entirely.

Locking (`DAY_LOCKED`) continues to reject any swap/move touching a
completed or in-progress day; `PUT /week/days/:day/activity` continues to
unconditionally reject leaving Gym while an active planned session exists
(no bypass field, per the prior phase's Fix 3).

---

## Section 8 — `/today`, `/week`, logger, and completion agree

**New consistency tests added this phase** (beyond the prior phase's
Fix 8 coverage):

- **"§8/§11.F: /week and /today agree after a pure schedule operation"**
  — asserts identical `days` state from `/week` and matching
  `plannedSession` from `/today` after both a swap and a move.
- **"§11.A: completing the AI-committed session updates only that
  session, and /week + /today agree it is completed"** — commits an AI
  session that supersedes a deterministic prescription, `PATCH`es it to
  `completed`, and verifies: (a) the superseded deterministic snapshot's
  `plannedWork` is untouched (there is nothing else that could have been
  completed instead — it isn't even a status-bearing row), (b) exactly
  one real session exists for that date and it is the one now
  `completed`, and (c) `/week` and `/today` both report the same
  `completed` `plannedSession`.
- **"§11.F: logger (GET /api/workouts/:id) opens the exact same session
  /today reports, with matching real exercises"** — logs a real exercise
  performance onto an AI-committed session, then follows `/today`'s
  `plannedSession.id` into `GET /api/workouts/:id` (the same call
  `logger.html` makes) and asserts the returned `session_id` and
  `exercises` (from `repo.getExercisePerformances`, the same source
  `logger.html` renders from) match exactly — proving logger.html's own
  data source is exactly what `/today` points callers to, not a
  parallel/stale view.

---

## Section 9 — Simplified user-facing API concepts

The five required user actions map onto explicit internal operations as
follows, and no page requires understanding `program_sessions` vs
`workout_sessions` to use them:

| User-facing action | Internal operation |
|---|---|
| Swap days | `POST /week/swap {dayA, dayB}` → `operation: 'swap'` |
| Move workout | `POST /week/move {fromDay, toDay}` → `operation: 'move'` |
| Generate workout | `PUT /week/days/:day/activity {activity, prescriptionPolicy: 'regenerate'}` |
| Use existing workout | `PUT /week/days/:day/activity {activity, prescriptionPolicy: 'reuse'}` |
| Keep current workout | no-op — simply not changing the day's activity |

**Scope decision:** `program.html`'s "Change activity" control already
speaks only in these terms (`'reuse'` / `'regenerate'` / `'schedule-only'`,
never a raw `program_sessions` id). Building dedicated Swap/Move buttons
in the UI was **not** undertaken this phase — consistent with the
immediately-prior phase's Fix 4/5 scope decision, no frontend page calls
`/week/swap` or `/week/move` today (both are exercised via the automated
HTTP test suite and this phase's live smoke test), so there is no UI
regression risk either way. This is called out explicitly under
"Remaining limitations" below rather than silently left undocumented.

---

## Section 10 — Normalized verification command and count

**Canonical command:**

```bash
npm ci
npm run verify   # = npm run build && npm run typecheck && npm test
```

**Result (this run):**

- Command: `npm ci && npm run verify`
- Environment: this session's Linux container, Node `v22.22.2`, npm `10.9.7`
- Date: 2026-09-13 (UTC)
- Result: **PASS** — `npm run build` clean, `npx tsc --noEmit` clean (via
  `npm run typecheck`), **97 test files, 1130 tests, all passing**, exit
  code 0.
- No suites are intentionally excluded; `npm test` runs the full
  `vitest run` suite with no filters.
- `npm audit` reports 8 pre-existing dependency advisories (6 moderate, 1
  high, 1 critical) inherited from `npm ci`'s dependency tree — unrelated
  to this phase's changes, not addressed here, and not part of the test
  count above.

This exact command, count, and date supersede any earlier report's
figures (e.g. "1096" from the prior phase, now stale after this phase's
additional tests) as the current canonical result.

---

## Section 11 — Required regression test matrix (A–F)

**A. Deterministic and AI precedence** — all six items covered: existing
deterministic + AI commit on same date, supersession (Option 1),
`/today`/`/week` returning the same selected workout, logger opening it
(§8 above), and completion updating only that workout (§8 above). "AI
commit enriches deterministic prescription" (Option 2) was **not**
implemented — Option 1 (replacement) was the chosen behavior per the
spec's own "choose one" framing; this is recorded under "Remaining
limitations."

**B. Reuse behavior** — existing-prescription reuse, no-prescription
`409`, never-borrows-from-another-date (§3 above), unsupported-fallback
rejection (§6's direction-dependent validation) — all covered by
existing and newly-added tests in `tests/routes/scheduleOperations.test.ts`.

**C. Swap behavior** — Gym↔Rest, Gym↔Gym (pre-existing), and a newly
added **Rest↔Rest** case ("POST /api/programming/week/swap — Rest <->
Rest (§11.C)"); no-LLM-invocation, exercise-list preservation, completed-
history immutability (§7 above), and in-progress rejection are all
covered.

**D. Move behavior** — worked example (deterministic Gym day), AI-
selected Gym day, explicit source-becomes-Rest result, destination-
occupied rejection, source-completed/in-progress rejection (`DAY_LOCKED`)
— all covered by `tests/engine/scheduleOperations.test.ts` and
`tests/routes/scheduleOperations.test.ts`'s move describe blocks.
"No unambiguous owner" is satisfied by construction (§5 above) rather
than a dedicated rejection test, since the precondition for ambiguity
cannot occur.

**E. Regeneration behavior** — explicit regeneration via `'regenerate'`,
one selected workout produced, `source_type`/`supersedes_program_session_id`
provenance recorded (§1/2 above), no duplicate active sessions (the
AI-commit path's `plannedConflict` check, unchanged from the prior
phase), and regeneration never triggered by swap/move/schedule-only
(verified by code inspection — neither `swapDayActivities` nor
`moveActivity` nor the `schedule-only` branch of the activity route
imports the planner).

**F. UI consistency** — `/today`/`/week` agreement after AI commit
(pre-existing Fix 8 test), after swap, and after move (both new this
phase, §8 above); logger/`/today` open the same session (new, §8 above);
Rest/Gym label consistency and stale-data invalidation are unchanged from
prior phases (no new caching layer was introduced that could go stale —
every route reads fresh from SQLite on each request).

---

## Section 12 — Required invariants

1. **At most one selected planned workout per user/date** — enforced by
   the AI-commit path's `plannedConflict` check (rejects creating a
   second `planned` session for a date that already has one) — unchanged
   from the prior phase, now additionally guaranteed meaningful by §1/2's
   precedence rule actually surfacing the one that exists.
2. **Every selected planned workout has a valid source/provenance** —
   `source_type` is `NOT NULL` with a `CHECK` constraint; every session-
   creation call site in the codebase was audited and updated to declare
   its provenance explicitly (deterministic start, AI commit, manual log).
3. **A completed or in-progress workout cannot be silently rescheduled**
   — `DAY_LOCKED` rejection in both `swapDayActivities` and
   `moveActivity`, unconditionally, no bypass.
4. **A pure swap never regenerates exercises** — verified by code
   inspection and the existing "no fetch stubbed" test.
5. **`reuse` never silently means `regenerate`** — `409
   generationRequired` instead (§3/§6 above), and `'schedule-only'` and
   `'reuse'`/`'regenerate'` are now mutually exclusive by direction,
   closing the "unsupported fallback" gap explicitly.
6. **AI commits cannot create an orphan competing workout** — the
   `plannedConflict` pre-commit check (unchanged) plus §1/2's
   supersession rule means even the deterministic snapshot that remains
   on disk is never displayed as competing content once superseded.
7. **`/today`, `/week`, logger, and completion use the same session
   resolver** — `findRealGymSession`/`toPlannedSessionField`/
   `resolveGymDaySelection` in `programming.ts` are the single shared
   implementation both `/week` and `/today` call; logger
   (`GET /api/workouts/:id`) and completion (`PATCH /api/workouts/:id`)
   both operate on the exact `workout_sessions` row identified by
   `plannedSession.id` — proven end-to-end by §8's new tests.
8. **Historical workout logs are immutable through schedule operations**
   — §7's two new byte-identity tests.
9. **Every move/swap/regenerate operation is auditable** — `operation`
   field on swap/move responses, `appliedPrescriptionPolicy` on activity-
   change responses, `supersedes_program_session_id`/`source_type`
   persisted on every AI/manual session.
10. **The user-facing schedule always has one unambiguous
    interpretation** — §1/2's precedence rule plus §5's ownership
    argument together mean there is never a code path that must guess
    between two candidate "current" workouts for a date.

---

## Files changed

- `src/db/schema.sql`, `src/db/client.ts` — `source_type` +
  `supersedes_program_session_id` columns (additive, migrated).
- `src/contracts/types.ts` — `WorkoutSessionSourceType`, extended
  `WorkoutSession`.
- `src/repositories/workoutSessionsRepo.ts` — read/write the two new
  columns.
- `src/server/routes/workouts.ts` — validate/accept `source_type` on
  `POST /api/workouts`.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — look up and stamp
  the superseded program-session id; `source_type: 'ai'` on commit.
- `src/engine/scheduleOperations.ts` — new `moveActivity()`, `MoveResult`,
  `DESTINATION_OCCUPIED` error code; doc-comment rewrite distinguishing
  swap/move/regenerate as real primitives.
- `src/server/routes/programming.ts` — `resolveGymDaySelection`/
  `toPlannedSessionField`/`findRealGymSession` (single shared precedence
  resolver); `supersedesProgramSessionId` on `/week` and `/today`;
  `'schedule-only'` policy + direction-dependent validation;
  `weekOperationErrorStatus` helper; `respondToMove` + `POST /week/move`
  route; `operation` field on swap/move responses;
  `appliedPrescriptionPolicy` on activity-change responses; strengthened
  `reuse` doc comment.
- `public/today.html` — explicit `source_type` on both session-creation
  call sites.
- `public/program.html` — direction-dependent `prescriptionPolicy` on the
  Change Activity control (§6).
- Tests: `tests/routes/scheduleOperations.test.ts`,
  `tests/engine/scheduleOperations.test.ts`,
  `tests/ai-programmer/aiProposalRoutes.test.ts`,
  `tests/routes/weekActivityOverride.test.ts`,
  `tests/routes/weekProgramPersistence.test.ts`.

## Regression checks

- `npm ci` — clean.
- `npm run verify` (build + typecheck + `vitest run`) — **97 test files,
  1130 tests, all passing**, exit code 0. See Section 10 above for the
  full canonical record.
- `npx tsc --noEmit` — clean, run standalone in addition to being part of
  `verify`.
- Manual HTTP smoke test against a scratch in-memory SQLite DB with a
  real `createApp(db)` server (not mocked), exercising, in order: (1)
  deterministic generation, (2) AI supersession of an existing
  deterministic prescription with `/week`/`/today` agreement, (3)
  completing the AI session and confirming only it changes, (4) a true
  asymmetric move (Badminton Wednesday → Friday After Move, discarding
  destination content), (5) a swap with the `operation` field present,
  (6) `reuse` on a day with no existing prescription correctly returning
  `409` rather than silently regenerating, (7) `schedule-only` correctly
  rejected for a Gym target. All seven steps produced exactly the
  behavior described in the corresponding sections above.

## Remaining limitations / deliberately out of scope

- **Section 1's Option 2 ("AI enrichment")** was not implemented —
  Option 1 (replacement/supersession) was chosen, since it required no
  new merge semantics between deterministic and AI-authored exercise
  lists and directly satisfies every acceptance criterion in the spec's
  §1 without inventing an undefined merge strategy.
- **Section 9's UI action mapping is documented, not built as new
  buttons** — no frontend page calls `/week/swap` or `/week/move` today
  (both existed pre-this-phase as backend-only, or were reintroduced
  backend-only this phase); adding dedicated Swap/Move UI controls was
  out of scope for this fix pass, consistent with the same scope
  boundary the immediately-prior phase drew around Fix 4/5.
- **"Move with no unambiguous owner" (§11.D)** has no dedicated rejection
  test, because the precondition that would create ambiguity (two
  candidate real sessions/prescriptions genuinely tied for "the" day's
  content) cannot occur given §1/2's precedence rule and the AI-commit
  path's own conflict check — this is argued as a structural invariant
  in §5 above rather than demonstrated as a runtime rejection path.
- **`npm audit`'s 8 pre-existing dependency vulnerabilities** were not
  addressed — out of scope for this fix pass, unrelated to the spec's
  functional requirements, and pre-dating this phase's changes.
