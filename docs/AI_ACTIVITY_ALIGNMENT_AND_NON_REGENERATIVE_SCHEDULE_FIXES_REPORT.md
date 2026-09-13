# AI Session Alignment, Activity Changes, and Non-Regenerative Plan Adjustments — Implementation Report

Spec: `docs/CLAUDE_TASK_AI_ACTIVITY_ALIGNMENT_AND_NON_REGENERATIVE_SCHEDULE_FIXES.md`
Branch: `ai-programmer-first-vertical-slice`
Base commit for this task: `6d976fa` (spec save)

## 1. Files changed

- `src/engine/scheduleOperations.ts` (new) — the dedicated schedule-operation
  service: `swapDayActivities`.
- `src/engine/weekProgramReconciliation.ts` — exported the existing `isDayLocked`
  helper for reuse (no behavior change).
- `src/repositories/workoutSessionsRepo.ts` — new `moveDate()` method.
- `src/ai-programmer/errors.ts` — new `AICommitIntentMismatchError` / `AI_COMMIT_INTENT_MISMATCH`.
- `src/ai-programmer/service/aiProposalLifecycle.ts` — `commitAIProposalToPlannedSession`
  now accepts an optional `intent`, validated against the day's current effective
  activity, with the alignment write inside the same transaction as session creation.
- `src/server/routes/aiProgrammer.ts` — commit route reads/validates `intent`.
- `src/server/routes/programming.ts` — new `POST /week/swap` and `POST /week/move`
  routes; new guards on `PUT /week/days/:day/activity` (in-progress rejection,
  planned-session-conflict confirmation); `renderWeekDays` now trusts the
  authoritative activity (not only snapshot presence) for `type`/`status`.
- `public/program.html` — the AI proposal commit call now computes and sends the
  correct `intent`, and shows a one-line notice before committing onto a non-gym day.
- Tests: `tests/engine/scheduleOperations.test.ts` (new), `tests/routes/scheduleOperations.test.ts`
  (new), `tests/ai-programmer/aiProposalRoutes.test.ts` (+8 intent tests),
  `tests/frontend/aiProposalUI.test.ts` (+2 wiring tests), `tests/routes/weekProgramPersistence.test.ts`
  (one test's expectation intentionally updated — see §9).

## 2. Operation types actually implemented

- **`swap`** (`POST /api/programming/week/swap`, body `{dayA, dayB}`) — the one
  general-purpose primitive this task implements in full. Exchanges two days'
  activity AND, wherever it already exists, the real underlying artifact (a
  persisted deterministic prescription, or a real still-`planned` AI-committed
  session) — never calling the planner or any LLM.
- **`move`** (`POST /api/programming/week/move`, body `{fromDay, toDay}`) —
  exposed as a thin alias for `swap`. The task's own worked example ("move
  Thursday's workout to Wednesday, Thursday becomes Rest") is mathematically
  identical to swapping Wednesday (Rest) and Thursday (Gym): the destination's
  own prior activity (Rest) is exactly what the source day ends up with. A
  genuinely asymmetric "move that discards the destination's own activity" is
  **not** implemented — see §10.
- **`replace`** — the pre-existing `PUT /week/days/:day/activity` endpoint,
  unchanged in its core contract (still calls the planner when a day's fresh
  prescription differs from what's persisted), now with the two new guards
  described in §4.
- **`regenerate`** — the same endpoint's existing planner-call path, unchanged.

`ScheduleChangeMode` (`'swap' | 'move' | 'replace' | 'regenerate'`) is documented
as a type in `scheduleOperations.ts` for conceptual clarity; it is not used as a
runtime dispatch value since each operation has its own dedicated function/route.

## 3. Swap implementation (Part 1/2)

`swapDayActivities(db, weekStart, dayA, dayB)`:

1. Rejects `dayA === dayB`.
2. Rejects if **either** day is locked (a real session `completed` or
   `in_progress`) — the whole swap is refused before writing anything (Part 4).
3. Reads the current effective activity for both days (profile + this week's
   overrides — the exact same computation `/week` already uses for display).
4. In one `db.transaction()`:
   - Swaps the `WeekActivityOverridesRepo` entries for both days (never the
     recurring `TrainingProfile`).
   - If a `programs`/`program_sessions` row exists for this week, swaps the
     persisted deterministic snapshot between the two `day_index`es —
     `WeeklyProgramRepo.upsertSession`'s existing "preserve the row occupying
     this day_index" identity model is reused as-is (Part 5: follow the
     current schema rather than inventing a new one).
   - Moves any real, still-`planned` (AI-committed) `workout_sessions` row's
     `date` along with its day — **both sides' planned sessions are read
     BEFORE either is moved** (a genuine bug caught during testing: reading
     side B's list only after already writing side A's session onto date B
     would find that same session and move it straight back — see the
     regression test in `tests/engine/scheduleOperations.test.ts`).

This never calls `buildWeeklyProgrammingPlan`/`assembleWeeklyPlanInput` (the
planner) and never calls `fetch`/the Velona provider — verified live (curl
against a real running server) and by a dedicated test asserting no fetch mock
is even installed for the swap tests, so a real network call would be the only
way the test could pass. Swapping is its own inverse (verified: swapping twice
restores the exact original state, `snapshot` included) and idempotent under
repetition (no duplicate `program_sessions` rows accumulate).

## 4. Guards added to the existing single-day `PUT /week/days/:day/activity` (Part 4)

- **In-progress**: if the target date has a real `in_progress` session, the
  request is now rejected outright (409) before writing the override — this
  **intentionally supersedes** a prior phase's behavior (see §9).
- **Completed**: unchanged — still allowed to succeed; the completed session's
  own fields are never touched regardless (this was already true via
  `reconcileWeekProgram`'s existing locked-day skip).
- **Planned session, moving away from Gym**: if a real `planned` (AI-committed)
  session exists on the target date and the new activity has no gym component,
  the request is rejected (409, naming the conflicting session id) unless the
  caller passes `confirmReplacePlanned: true`. There is no cancellation
  workflow in this codebase (the spec explicitly scopes one out — "if such a
  workflow exists"), so confirming proceeds without deleting the session; the
  response/rejection text says so explicitly rather than leaving it silent.

## 5. AI proposal commit intent (Part 3)

`POST /api/ai-programmer/proposals/:proposalId/commit` now accepts an optional
`intent: 'fill_existing_gym_day' | 'replace_day_activity'`:

- **Omitted** (backward compatibility): behavior is byte-for-byte unchanged
  from before this task — no activity override is written. Every pre-existing
  test in `aiProposalRoutes.test.ts` (~20 commit calls with no body) still
  passes unmodified.
- **`fill_existing_gym_day`**: validated against the day's CURRENT effective
  activity (recomputed fresh, not from the proposal's generation-time
  context) — if the day is not Gym/Both, the commit is rejected
  (`409 AI_COMMIT_INTENT_MISMATCH`) before writing anything.
- **`replace_day_activity`**: writes a `WeekActivityOverridesRepo` override
  setting the date to `'gym'`, **inside the same `db.transaction()`** as
  session creation — a mid-commit failure rolls back both (verified by a
  dedicated test that forces `addExercisePerformance` to throw and asserts
  the override was never left behind).
- Intent validation only runs on the pending→committed transition — a
  repeated commit of an already-committed proposal is idempotent regardless
  of what `intent` is passed the second time (existing idempotency behavior,
  now verified to survive the new field).

`public/program.html`'s commit call now always computes and sends the correct
intent from the day's own known `activity` field (`fill_existing_gym_day` if
Gym/Both, else `replace_day_activity`), and shows a one-line notice
("Committing will replace Wednesday's current activity (Rest) with Gym for
this week.") before the Commit button when replacing — this is the one
frontend change that was necessary, not optional polish, since without it the
UI's own real commit calls would keep hitting the backward-compat default and
the Part 3 gap would persist for actual users.

## 6. `/week` display consistency (Part 3/5)

`renderWeekDays` previously decided a day's `type`/`status` purely from
whether a persisted `program_sessions` snapshot existed for it. That meant a
day whose activity is authoritatively Gym (via an AI-commit alignment
override) but has no deterministic snapshot — because an AI-committed session
is a structurally different kind of prescription this model doesn't persist a
snapshot for — fell through to the non-gym branch and reported `type: 'rest'`,
reproducing the exact contradiction the task describes.

Fixed by branching on the authoritative `activity` (still derived only from
the profile + week overrides — never from `workout_sessions`, per the task's
own explicit "do not do this") first: a Gym/Both day without a persisted
snapshot now reports `type: 'gym'` and a real `status` (via the same
`realSessionStatus` every persisted gym day already used), with `plannedWork`
left empty and a new `hasUnpersistedSnapshot: true` field — `workout_exercises`
does not retain `target_type`/`target_id`/`classification`, so a fabricated
`PlannedWorkItem` would misrepresent the real prescription rather than
honestly show that this display gap applies. The real exercises stay fully
visible through the session's own detail endpoint (the AI proposal review
UI's "Open planned workout" link).

## 7. Tests added/updated

- `tests/engine/scheduleOperations.test.ts` (16 tests): the primary worked
  example (prescription moves, LLM never called implicitly by the absence of
  any generation call), Gym↔Gym, Badminton↔Gym, no-persisted-prescription,
  never-generated-week, moving a real planned session (including the
  both-sides-have-one regression case), locking (completed/in-progress on
  either side), same-day/no-profile validation.
- `tests/routes/scheduleOperations.test.ts` (21 tests): the same matrix
  through the real HTTP routes — including "never invokes the LLM" (no fetch
  mock installed at all), `/today` agreement, reversibility, idempotency (no
  duplicate rows), the `move` alias, the two new `PUT .../activity` guards,
  and the `/week` display-consistency fix.
- `tests/ai-programmer/aiProposalRoutes.test.ts` (+8 tests): intent omitted
  (unchanged behavior), `replace_day_activity` on Rest (aligns),
  `fill_existing_gym_day` on Rest (rejected, nothing written),
  `fill_existing_gym_day`/`replace_day_activity` on an already-Gym day,
  invalid intent value (400), idempotent repeated commit with a mismatched
  second intent, and transactional rollback of the alignment write on a
  simulated mid-commit failure.
- `tests/frontend/aiProposalUI.test.ts` (+2 tests, plus one existing
  assertion's regex updated for the new multi-line commit call): `isGymDay`
  computed once from `day.activity`, and the replace-activity notice text is
  present and gated correctly.

## 8. Verification commands executed

```
npx tsc --noEmit
npm run build
npm test
npm run verify
```

Plus a live HTTP smoke test (curl) against a real running server, and the same
scratch-server pattern used throughout this session's prior phases.

## 9. Verification results

- `npx tsc --noEmit` — clean.
- `npm run build` — clean.
- `npm test` / `npm run verify` — **97 test files / 1084 tests, all passing.**
- **One pre-existing test's expectation was intentionally changed**
  (`tests/routes/weekProgramPersistence.test.ts`, §22.4): it previously
  asserted that changing an **in-progress** day's own activity succeeded
  (200) with the override recorded but the persisted prescription protected.
  This task's Part 4 explicitly supersedes that with "reject the conflicting
  schedule change with a clear explanation." The test was rewritten to assert
  the new, intentional behavior (409, nothing written — override included);
  every other assertion in that file (completed-day protection, an unrelated
  day's logged session surviving, etc.) was re-verified unchanged and passes
  as-is.

## 10. Manual/live testing walkthrough

A real HTTP server (scratch SQLite DB, real `createApp(db)`, no mocks) was
driven with curl:

1. `GET /week` on a profile with Thursday as the only training day — confirmed
   Wednesday = Rest, Thursday = Gym with 22 planned exercises.
2. `POST /week/swap {dayA: wednesday, dayB: thursday}` — Wednesday now shows
   the exact same 22-exercise prescription Thursday had; Thursday is Rest.
   Exactly the task's own worked example, reproduced live.
3. Swapped back (`dayA: thursday, dayB: wednesday`) — original state restored
   exactly.
4. Created a real `planned` `workout_sessions` row on Sunday (simulating an
   AI-committed session on a Rest day) via `POST /api/workouts`.
5. `PUT /week/days/sunday/activity {activity: badminton}` (no confirmation) —
   rejected 409, naming the conflicting session id, exactly as designed.
6. Same request with `confirmReplacePlanned: true` — succeeded (200); the
   session remained fully intact and un-deleted afterward.
7. Confirmed the resulting `/week` day: `activity: 'badminton'`, but
   `status: 'rest'` (not showing the still-present session) — this is the one
   place the display doesn't fully catch up when moving AWAY from Gym via
   explicit confirmation without deleting anything. Documented below as a
   known, deliberate limitation rather than left silent.

## 11. Remaining limitations / deferred decisions

- **A "move" that discards (rather than swaps back) the destination day's own
  prior activity is not implemented.** `POST /week/move` is a `swap` alias —
  correct for the task's own worked example (moving onto a Rest day), but a
  move onto a day that currently has some OTHER real activity the user does
  not want restored to the source day would need a genuinely separate
  operation. Not required by the acceptance criteria or test matrix, and
  explicitly out of scope to invent beyond what's specified.
- **No cancellation/abandon workflow exists** for a real `workout_sessions`
  row, in this codebase, before or after this task. Confirming
  `confirmReplacePlanned: true` therefore changes the day's activity without
  removing the now-orphaned planned session; after that, `/week`'s day object
  reports the day's real (new) activity but its `status` field reverts to the
  generic non-gym `'rest'` even though a real session still exists on that
  date — the session itself remains fully intact and reachable by id, just
  not surfaced on that day's card until a future pass adds a proper
  cancellation flow (explicitly named as "if such a workflow exists" in the
  task, and it does not).
- **`replace`'s "reuse a prescription from elsewhere in the week" is not
  implemented.** The single-day `PUT .../activity` endpoint still calls the
  planner (unchanged from before this task) whenever a genuinely new
  prescription is needed for a day going Rest/Badminton → Gym; it does not
  search the rest of the week for a reusable one the way `swap` does. The
  task's own Part 1 hedges this ("this may require a new gym prescription if
  no valid existing prescription can be moved or reused"), and `swap` is the
  operation that gives the user an explicit, no-regeneration path for the
  common case where a reusable prescription does exist elsewhere.
- **No blocking "explicit regenerate confirmation" gate was added to the
  single-day `PUT .../activity` endpoint.** An existing, deliberately-tested
  acceptance criterion from a prior phase (`tests/routes/weekActivityOverride.test.ts`'s
  "all 24 activity transitions," including `unselected -> gym`) requires this
  endpoint to succeed directly without any extra confirmation step. Adding a
  hard gate would have broken that established contract. The endpoint's very
  call — an explicit `PUT` the user/UI issues on purpose — already satisfies
  "requires an explicit replacement action" in the acceptance criteria's own
  wording; the NEW protection this task required (rejecting in-progress days,
  requiring confirmation before silently stranding a planned session) was
  added without touching that existing contract.
- **`hasUnpersistedSnapshot`** is new, additive API surface with no frontend
  consumer yet — `program.html`'s day cards do not currently render anything
  different for it. Adding that UI affordance was judged lower priority than
  the backend correctness work in this pass, given the scope already covered.
