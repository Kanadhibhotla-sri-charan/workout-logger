# 2026-09-14 — Two-Day Schedule Swap: UI + Focused Test Additions

Commit (this entry's own).

## Before implementation: existing data model, and why no new persistence method was needed

Investigated the current-week schedule representation before writing anything:

- **`week_activity_overrides`** (`training_profile_id`, `week_start`, `day`, `activity`) — this WEEK's exception to the recurring `TrainingProfile.training_days`/`other_activity_schedule` default (`applyWeekOverrides`, `src/lib/dailyActivity.ts`). This is where a day's Gym/Badminton/Both/Rest activity for the current week actually lives.
- **`program_sessions`** (`program_id`, `day_index`, `name`, `planned_session_type`, `snapshot_json`) — one row per Monday-anchored week's `programs` row, keyed by `day_index` (0=Monday…6=Sunday). `name` carries the session identity (`push`/`pull`/`legs`/`upper`), `snapshot_json` the actual deterministic prescription content.

**Finding: `src/engine/scheduleOperations.ts` already exports a fully-built `swapDayActivities(db, weekStart, dayA, dayB)`** (from an earlier "AI Activity Alignment / Non-Regenerative Schedule Fixes" task), and `POST /api/programming/week/swap` was already wired to it in `src/server/routes/programming.ts`. It already does exactly what this task specifies: **exchanges** both `week_activity_overrides` rows and both `program_sessions` rows between the two `day_index` values (never creating a new override abstraction), moves any real `planned` `workout_sessions` row's date along with it, rejects the whole operation before writing anything if either day is `completed`/`in_progress` (`DAY_LOCKED`), never touches `workout_exercises`/`workout_sets`, never calls the deterministic planner or the LLM, and wraps all of it in one `db.transaction`. **Zero frontend code called this endpoint** — confirmed by grep across `public/`.

**Decision (per the task's own framing): exchange the persisted program-session day assignments and the week's activity overrides directly — not a new override abstraction — exactly what the existing `swapDayActivities` already does.** This preserves the recurring `TrainingProfile` untouched (only this week's overrides move) and makes the current week's arrangement explicit via the existing override table. Smallest reliable change: **no backend logic was written or modified at all** — this task was purely (1) a UI control and (2) closing real gaps in an otherwise very thorough existing test matrix.

## What changed

`public/program.html`: new `buildSwapControl()`, rendered at the top of the week view (rebuilt on every `renderWeek()` so its day pickers always reflect the live week). A "Swap two days" toggle reveals two `<select>` pickers (populated from `weekData.days` — never a hardcoded weekday pair), a Confirm button calling `POST /api/programming/week/swap` via the shared `withSaving`/`api` helpers (same pattern as the existing single-day "Change activity" control), and a Cancel button. Rejects picking the same day twice client-side before any API call. Success reloads the week (`await loadWeek()`); failure shows the error inline and leaves the panel open, matching every other mutation control on this page.

## New tests

**Frontend** (`tests/frontend/weekSwapUI.test.ts`, 8): source-level assertions (this repo's established frontend-test convention — see `dailyActivityUI.test.ts`) that the control exists, calls the real swap endpoint and never AI generate/reconcile endpoints, sends whichever two days were picked (never hardcoded), rejects a same-day pick before any API call, refreshes the week on success, and never uses `alert()`.

**Backend** (`tests/engine/scheduleOperationsFocusedAdditions.test.ts`, 6 — a new file, so nothing here could affect the existing 437-line `scheduleOperations.test.ts` or 930-line route-level suite): closing the specific gaps found against this task's required test list after auditing what already existed —

- *Already covered, confirmed by reading the existing suites*: swapping two normal days, Gym↔Rest, Gym↔Gym, Badminton↔Gym, reversibility/idempotency of repeating the *same* pair, locked-day rejection (both directions), and — at the route level (`tests/routes/scheduleOperations.test.ts`) — "no LLM/provider call" (no `fetch` stub installed; a real attempt would throw) and "an uninvolved completed session's real logged data survives a swap between two OTHER days."
- *New, previously missing*: (1) the exact required worked example as a literal test — Push(Mon)/Pull(Tue)/Rest(Wed), Mon↔Wed then Tue↔Wed, asserting the documented final arrangement after **two different chained swaps** (existing tests only repeated the *same* pair); (2) two explicitly non-adjacent day pairs (Monday↔Sunday, Wednesday↔Saturday); (3) an explicit `vi.mock` spy on `reconcileWeekProgram` proving it is never invoked across several real swaps (previously only inferable from the absence of an import); (4) a forced mid-transaction failure (`WorkoutSessionsRepo.prototype.moveDate` throws) proving the whole swap — both days' overrides, both `program_sessions` rows — rolls back atomically rather than partially applying; (5) an engine-level companion to the existing route-level "completed history survives" test.

## Verification

Manual verification: started a real local server (not `tsx watch`, to avoid an unrelated dev-sandbox artifact described below), created a real training profile via the API, and drove the exact required example through the real HTTP endpoint end-to-end: initial `Push/Pull/Rest/Legs/Upper/Badminton/Badminton` → `POST /week/swap {monday,wednesday}` → confirmed `Rest/Pull/Push/…` via a fresh `GET /week` → `POST /week/swap {tuesday,wednesday}` → confirmed `Rest/Push/Pull/…` via a fresh `GET /week`, matching the spec's worked example exactly.

One false alarm during manual testing worth recording: an earlier attempt (using `tsx watch` alongside direct `sqlite3` CLI queries against the same live WAL-mode database file, with multiple stacked Node processes from repeated background server starts) produced a run where the second swap appeared not to take effect. An isolated direct call to `swapDayActivities` (bypassing HTTP entirely) immediately reproduced the CORRECT result, and a clean retest (single non-watch server process, no interleaved CLI queries) also reproduced the correct result — confirming the anomaly was an artifact of that specific ad-hoc testing setup, not a defect in the shipped code. The automated test suite (unit + route level, before and after this task) was never affected.

Could not perform a visual, in-browser click-through of the new UI — the Claude-in-Chrome browser extension was not connected in this environment. Compensated with the direct HTTP-level walkthrough above (which exercises the identical request the button issues) plus the source-level frontend tests; a human visual smoke test of the actual button/picker interaction is still recommended before considering this fully verified.

Full suite diffed against the same real-time baseline used throughout this project's recent work: zero new failures (only the pre-existing, unrelated stale-calendar-date fixtures noted in earlier log entries). `npm run typecheck` / `npm run build` clean.

## Not deployed

This feature has not been deployed to production as part of this entry — pending review of the UI addition.
