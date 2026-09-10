# Workout Programmer — Same-Week History & Day-Specific Recovery Fix: Implementation Report

Spec: `docs/WORKOUT_PROGRAMMER_SAME_WEEK_HISTORY_RECOVERY_FIX.md`

## 1. Files changed

| File | Change |
|---|---|
| `src/engine/workoutBuilder.ts` | `assembleWeeklyPlanInput` gains an explicit `historyAsOfDate` parameter (defaults to `date`, preserving every single-day caller's existing behavior); `buildWeeklyProgrammingPlan` no longer promotes a same-day recovery `'avoid'` signal into a whole-week `continue`/skip. |
| `src/server/routes/programming.ts` | `computeFreshWeek` gains a 4th parameter `historyAsOfDate` (defaults to `weekStart` for backward compatibility), threaded through to `assembleWeeklyPlanInput`. All 3 call sites (`GET /week`, `PUT /week/days/:day/activity`, `GET /today`) now pass the route's real requested `date`. |
| `src/server/routes/workouts.ts` | `adaptCurrentWeekIfNeeded` now computes `today = todayForUser(database)` once and passes it as `computeFreshWeek`'s `historyAsOfDate`, so the canonical post-workout reconciliation path reads real history through today, not through the week's Monday. |
| `tests/engine/sameWeekHistoryRecoveryFixRequiredTests.test.ts` | **New.** 17 tests — the required regression matrix's genuinely new coverage (items 1-9, 13-14, 17). |
| `tests/engine/assembleAndBuildWorkout.test.ts` | 1 test rewritten to check day-scoped (not week-scoped) same-day recovery. |
| `tests/engine/finalPassRequiredTests.test.ts` | 1 test ("Test 6") rewritten to the corrected day-scoped behavior. |
| `tests/engine/workoutBuilder.test.ts` | 2 tests rewritten to the corrected day-scoped behavior. |
| `tests/friendlyExplanation.test.ts` | New describe block (2 tests) covering the previously-uncovered `days_since === 0` vs `days_since > 0` branches of the `'recovery'` friendly-reasoning case. |
| `tests/routes/actualTrainingAdaptation.test.ts` | 2 assertions relaxed from strict `.toBe(0)` to bounded `.toBeLessThanOrEqual(...)`, since a later same-week day is now correctly shown as genuinely due regardless of an earlier day's real volume. |

No schema/migration file was added or changed — this fix requires no new persisted data.

## 2. Exact reference-date architectural change

Before this fix, every canonical caller of `assembleWeeklyPlanInput` passed the same single `date` value for two conceptually different purposes at once:

- **WHICH CALENDAR WEEK is being programmed** — always that week's Monday (`programmingWeekStart(date)`).
- **HOW MUCH REAL TRAINING HISTORY the planner may see** — internally, `buildTrainingState(db, date)` never reads real logged history past this date.

Because `computeFreshWeek` always called `assembleWeeklyPlanInput(database, weekStart, budgetMinutes)` with `weekStart` (the Monday) as that single `date`, the planner's history boundary was pinned to Monday no matter which real day of the week generation/reconciliation actually ran on. Real Tuesday-Sunday training already logged in that same week was invisible to any later same-week regeneration.

The fix introduces `historyAsOfDate` as a genuinely separate, explicit parameter:

```ts
export function assembleWeeklyPlanInput(
  db: Database.Database,
  date: string,
  budgetMinutes: number,
  historyAsOfDate: string = date,
): WeeklyPlanInput
```

`date` still anchors `weekStart` (`programmingWeekStart(date)`) — the calendar week structure is completely unchanged. `historyAsOfDate` now drives `buildTrainingState`, `weekdayOfDate`, every `days_since_target_last_trained`/`last_trained_date` computation, and the returned `today` field. The default `historyAsOfDate = date` means every single-day caller that was already correct (`assembleAndBuildWorkout`, `assembleWeeklyProgrammingPlan` — where `date` already IS the one real day in question) is completely unaffected; only `computeFreshWeek` needed to start passing a real, distinct second date.

`computeFreshWeek` itself gained the same parameter (`historyAsOfDate: string = weekStart`), and its three route call sites (`GET /week`, `PUT /week/days/:day/activity`, `GET /today`) now pass their own `date` query/request value — the real day the request is being made for — instead of relying on the default. `adaptCurrentWeekIfNeeded` in `workouts.ts` (the canonical actual-training reconciliation trigger) now passes `todayForUser(database)`.

## 3. How current-week reconciliation now sees real same-week training

Concretely: completing a real Tuesday workout (`POST /api/workouts` → `POST /:id/exercises` → `PATCH .../:id` with `status: 'completed'`) triggers `adaptCurrentWeekIfNeeded(database, session.date)`, which now calls `computeFreshWeek(database, weekStart, budgetMinutes, today)` — `today` being the real current date, which by the time this fires already includes the just-completed Tuesday session. Any subsequent `GET /api/programming/week?date=<later day this week>` regenerates or reconciles using that same real-history boundary, so Friday's plan correctly reflects Tuesday's real sets, last-trained date, and exercise history — rather than reading history only as of Monday and seeing nothing.

This was verified live (see §7 below) using the exact Sep 7/Sep 8/Sep 11 scenario the forensic audit supplied: after logging real Monday push work and real Tuesday back/arm/forearm work, `GET /api/programming/week?date=2026-09-11` (Friday, same week) now shows every one of the 7 audited targets (Lat Width, Back Thickness, Brachialis/Arm Thickness, Biceps, Rear Delt, Forearm Extensors, Forearm Flexors) with their real Sep 8 exposure/history correctly visible.

## 4. How recovery scope changed

`applyRecoveryConstraint`'s `'avoid'` signal (`recoveryEngine.ts`) is inherently a same-day fact: it fires when `days_since_target_last_trained === 0` as of the reference date being evaluated. Previously, `buildWeeklyProgrammingPlan` used this signal, evaluated once per target before the day loop even started, to `continue` — removing that target from consideration for every day in the whole week's run, including days that are not the same real day at all.

The fix removes that pre-loop block entirely (replaced with an explanatory comment; no functional replacement is needed). The pre-existing per-day exposure-cycle spacing gate — `expectedExposureIntervalDays = Math.max(1, Math.floor(7 / Math.max(sessionsPerWeekForInterval, 0.1)))`, always `>= 1` — already independently and correctly excludes a same-day repeat for whichever real day matches the reference date (since `daysSinceLastExposure` there evaluates to `0` on exactly that day), while remaining fully due-eligible on every other, later real day. `recovery.priority_adjustment` remains computed and available for its other legitimate uses (the badminton lower-body trim, ranking tie-break inputs, and the `decision.recovery` field in every target's `ExposureCycleDecision`) — only its former blanket whole-week exclusion role was removed.

## 5. How explanations changed

No code change was required in `friendlyExplanation.ts` itself — its `'recovery'` case already correctly branches on `days_since === 0` ("earlier today") versus `days_since > 0` (a real historical date), and its "haven't trained this target yet this week" / "You had N sets for this target so far this week" wording already correctly derives from `current_weekly_primary_sets`. Both of these were previously being fed **wrong upstream data** (a `days_since_target_last_trained` and `current_weekly_primary_sets` computed against the wrong `historyAsOfDate`), which is exactly what made "earlier today" appear incorrectly and "haven't trained this target yet this week" appear falsely. With the reference-date fix in `workoutBuilder.ts`, these same explanation code paths now receive correct facts and produce correct text. A new test describe block was added to `tests/friendlyExplanation.test.ts` covering both branches directly, since neither had prior standalone coverage.

## 6. Tests added

- **`tests/engine/sameWeekHistoryRecoveryFixRequiredTests.test.ts`** (new, 17 tests) — the required-matrix's new coverage:
  - **Group A** (items 1-3, 5 tests): Monday/Tuesday/Thursday same-week history visibility via `buildTrainingState`/`assembleWeeklyPlanInput`, plus a future-week fabrication-safety test.
  - **Group B** (items 4-9, 9 tests): the exact audited Sep 7/Sep 8 fixture, checking `current_weekly_primary_sets`/`exercise_history`/`last_trained_date` for all 7 real targets, the incomplete-Wrist-Curl-set exclusion, and the unused-variation/target-history regressions.
  - **Group C** (items 13-14, 2 async tests): real HTTP route (`GET /api/programming/week?date=<Friday>`), verifying `friendly_reasoning` truthfulness.
  - **Group D** (item 17, 1 async test): the full canonical HTTP reconciliation path (`POST /api/workouts` → `POST /:id/exercises` → `PATCH .../:id` completed), confirming real Tuesday training becomes visible and no fake `workout_*` rows are created.
- **`tests/engine/assembleAndBuildWorkout.test.ts`** — rewritten test proving a same-day repeat is excluded on the same day but the target genuinely succeeds later in the same run (Friday).
- **`tests/engine/finalPassRequiredTests.test.ts`** — "Test 6" rewritten to the corrected day-scoped facts.
- **`tests/engine/workoutBuilder.test.ts`** — two tests rewritten: one proving the same-day exclusion is day-scoped, not week-scoped; one proving a target with no other real eligible day this run still carries real recovery/volume/exposure facts with `selection: null`.
- **`tests/friendlyExplanation.test.ts`** — new describe block, 2 tests, covering the `'recovery'` case's `days_since === 0` and `days_since > 0` branches directly.
- **`tests/routes/actualTrainingAdaptation.test.ts`** — 2 existing assertions relaxed from an incorrect strict-zero expectation to a correct bounded expectation.

## 7. Full test/typecheck/build/verification results

Verification-by-reversion was performed first: `git stash push -- src/engine/workoutBuilder.ts src/server/routes/programming.ts src/server/routes/workouts.ts` (reverting only the 3 fix source files, keeping every test file), then running the new/rewritten test files against the pre-fix code:

```
Test Files  4 failed | 2 passed (6)
     Tests  16 failed | 101 passed (117)
```

All 16 failures were exactly the newly-added or rewritten assertions (Group B's `current_weekly_primary_sets`/history checks, Group C's truthful-explanation checks, and the two rewritten `workoutBuilder.test.ts` day-scoping checks) — confirming they genuinely exercise the fix rather than passing vacuously. `git stash pop` then restored the fix.

With the fix restored, the full suite, typecheck, and build were run for real:

```
npm run verify
  > tsc -p tsconfig.build.json && cp src/db/schema.sql dist/db/schema.sql   [build: clean]
  > tsc --noEmit                                                            [typecheck: clean]
  > vitest run
    Test Files  84 passed (84)
         Tests  802 passed (802)
```

(`npm run typecheck`, `npm run build`, and a standalone `npx vitest run` were each also run individually beforehand with the same results.)

## 8. Live HTTP smoke test

A standalone script drove the real Express app (`createApp`) through real HTTP requests (via `supertest`) against a disposable scratch SQLite file (never the production database), reproducing the exact spec Sep 7/Sep 8/Sep 11 scenario:

- Real completed Monday session: 6 exercises (push day — chest/shoulders/triceps/abs).
- Real completed Tuesday session: 7 exercises (back/arms/forearms), including the Wrist Curl exercise with one genuinely incomplete set.
- `GET /api/programming/week?date=2026-09-11` (Friday, same week).

**Fixed build** — all 7 audited targets correctly show real Sep 8 exposure, e.g.:

> Lat Width: *"You had 3 sets for this target so far this week, so this session adds another 2 sets toward the weekly development target."*
> Forearm Flexors: *"You had 1 set for this target so far this week..."* (correctly counting only the one completed Wrist Curl set, excluding the incomplete one).

No target's explanation falsely claimed "haven't trained this target yet this week." Exactly 2 real `workout_sessions` rows existed (no fake rows created by generation).

**Contrast against the pre-fix build** (same scenario, same script, `src/engine/workoutBuilder.ts` / `src/server/routes/programming.ts` / `src/server/routes/workouts.ts` reverted via `git stash` for the run only, then restored): all 6 checked targets instead produced the exact bug the spec describes, e.g.:

> Lat Width: *"You haven't trained this target yet this week, so it was prioritized here."* *(false — Tuesday's real 3 sets exist)*
> Biceps' Friday item silently substituted a completely different, "first time" variation (`barbell-ez-bar-curl` incorrectly shown as never-used) instead of correctly continuing progression on the same exercise Tuesday had already used.

Result: `6 CHECK(S) FAILED` against the pre-fix build, `ALL CHECKS PASSED` against the fixed build — the identical real-server, real-HTTP-route scenario, contrasted directly.

## 9. Confirmations

- **No DB migration occurred.** No schema file was added or changed; `openDb`'s existing `migrate()` was not touched.
- **No Blueprint data changed.** No file under `src/blueprint/` or Blueprint's own data was modified; `sync-blueprint` was never run.
- **No historical workout data changed.** `workout_sessions`/`workout_exercises`/`workout_sets` were never written to except by this session's own new, disposable-scratch-DB smoke test and test-suite runs — the real production database was never touched by this phase's work.
- **No fake exposure history was created.** All new tests and the live smoke test only ever log real, explicit completed sessions through the same real repositories/routes production code uses; no synthetic `exercise_history`/`recent_sessions` rows were fabricated.
- **Locked days remain protected.** `isDayLocked` in `weekProgramReconciliation.ts` was not touched by this fix; `tests/engine/weekProgramReconciliation.test.ts`'s locked-day coverage passes unchanged.
- **The separate Class E multi-exercise-per-target issue (e.g. Hammer Curl / Cross-Body Hammer Curl spillover) was explicitly NOT touched.** This phase's scope was limited exactly to the history-reference-date and recovery-scope defects; no exerciseSelector/candidate-gathering logic governing multiple simultaneous exercises per target was modified.

## 10. Out of scope for this environment

Spec §22-23's optional post-fix Sep 11 production regeneration (backing up the live SQLite database, hashing `workout_sessions`/`workout_exercises`/`workout_sets`/goals/goal_events/goal_phases/goal_phase_reviews/aesthetic_assessments/measurements, regenerating only through canonical reconciliation, then verifying hashes/`PRAGMA integrity_check`/`PRAGMA foreign_key_check`) requires access to the live production Oracle VM database, which this remote development environment does not have. Per this session's established precedent, that step was not attempted here; the code/test change is complete and verified, and remains on branch `workout-programmer-ui-and-equipment-filter-fix`, not merged to `main`, not deployed.
