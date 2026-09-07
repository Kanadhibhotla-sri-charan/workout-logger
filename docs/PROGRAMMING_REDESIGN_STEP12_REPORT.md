# Workout Programmer Programming Redesign (Step 12) — Report

Per `docs/PROGRAMMING_REDESIGN_STEP12_SPEC.md`. Implemented on branch
`programming-redesign-step12` as 7 logical commits, each independently
verified (`npm run verify`) before the next began, per the spec's own
"make small logical commits, do not combine into one giant change" and
"run verify after each logical implementation stage" instructions.

```
Files changed (by phase):

Phase 1 (inspection only):
  no files modified

Phase 2 — Blueprint development references:
  src/engine/developmentReferenceEngine.ts        (new)
  tests/engine/developmentReferenceEngine.test.ts (new)

Phase 3-4 — replace universal volume with per-target references:
  src/engine/volumeEngine.ts                      (decideVolume/referenceRangeFor take an optional development_reference)
  src/engine/workoutBuilder.ts                    (rankTarget/classification/decideVolume call sites use per-target reference)
  tests/engine/developmentReferenceIntegration.test.ts (new)
  tests/engine/coreEngineSurgicalFixPassTests.test.ts  (2 tests recalibrated to real per-muscle numbers)
  tests/engine/finalPassRequiredTests.test.ts          (2 tests recalibrated)
  tests/fixtures/strictBugFixFullWeek.test.ts          (1 test recalibrated)

Phase 5-6 — weekly-first flow / goal-specific selection (no code change; already satisfied):
  tests/engine/goalSpecificExerciseSelection.test.ts (new — regression proof)

Phase 7-8 — remaining-week actual-training adaptation + deviation reasons:
  src/engine/weekProgramReconciliation.ts   (ReconciliationTrigger, classifyDeviationReason, reconcileAfterActualTraining)
  src/server/routes/programming.ts          (export computeFreshWeek/defaultBudgetMinutes; PUT .../activity passes its trigger)
  src/server/routes/workouts.ts             (adaptCurrentWeekIfNeeded — triggers on session completion / correction to a completed session)
  tests/engine/weekProgramReconciliation.test.ts (new)
  tests/routes/actualTrainingAdaptation.test.ts  (new)

Phase 9-10 — goal phase persistence, lifecycle, review engine:
  src/db/schema.sql                          (new tables: goal_phases, goal_phase_reviews — additive, CREATE TABLE IF NOT EXISTS)
  src/repositories/goalPhaseRepo.ts          (new)
  src/repositories/goalPhaseReviewsRepo.ts   (new)
  src/engine/goalPhaseEngine.ts              (new — reviewGoalPhase, gatherReviewEvidence, runGoalPhaseReview, applyReviewDecision)
  tests/repositories/goalPhaseRepo.test.ts   (new)
  tests/engine/goalPhaseEngine.test.ts       (new)

Phase 11 — expose existing/new functionality via routes:
  src/server/routes/goals.ts                 (assessment/measurement/goal-phase/review routes)
  tests/routes/goalPhaseRoutes.test.ts       (new)

Phase 12 — required test closing:
  tests/engine/exposureCoefficientsTraceability.test.ts (new)

Docs:
  docs/PROGRAMMING_REDESIGN_STEP12_SPEC.md   (this pass's spec, saved verbatim)
  docs/PROGRAMMING_REDESIGN_STEP12_REPORT.md (this report)

Database changes:
PASS — additive only. Two new tables (goal_phases, goal_phase_reviews),
both CREATE TABLE IF NOT EXISTS, no columns added/changed/removed on
any existing table. Verified directly against a simulated pre-existing
production database with real rows in `users`/`goals` — new tables
appear, existing rows are untouched, new tables are immediately usable
(real FK to goals confirmed).

Old programming behaviour replaced:
PASS — the single universal Blueprint weekly_volume.starting_point_sets
number (8, same for every muscle) is no longer what decides a target's
classification threshold or volume ceiling; each target's own Blueprint
package reference (Complete for an active goal, Efficient otherwise) is.
/api/programming/today's independent assembleAndBuildWorkout call was
already removed in the prior phase (still true here). No second,
independent adaptation engine was created — the existing
weekProgramReconciliation.ts now also serves the actual-training trigger.

New programming behaviour:
PASS — DevelopmentReference (developmentReferenceEngine.ts), remaining-
week actual-training adaptation (workouts.ts -> reconcileAfterActualTraining),
machine-readable deviation reasons (the exact 9-value spec vocabulary),
goal-phase persistence/lifecycle (active -> review_due -> review ->
continue/adjust/graduate), a goal review engine that never equates
volume-reference completion with success, and routes exposing all of
the above plus the previously-unrouted aesthetic-assessment/measurement
repos.

Tests added:
PASS — 15 new test files, ~140 new tests, covering spec section 16.A-K
(see the file list above; developmentReferenceEngine.test.ts covers A,
developmentReferenceIntegration.test.ts covers B/G,
exposureCoefficientsTraceability.test.ts covers C, actualTrainingAdaptation.test.ts
+ weekProgramReconciliation.test.ts cover D/E/F/K,
goalPhaseEngine.test.ts + goalPhaseRepo.test.ts + goalPhaseRoutes.test.ts
cover H/I/J/K).

Full test result:
PASS — 656/656 tests, 64 test files. Confirmed twice: once in this
working tree, once from a completely fresh `git archive` + `npm ci`
clean-checkout (proving it isn't dependent on this session's already-
built node_modules/dist).

Build/typecheck result:
PASS — `tsc -p tsconfig.build.json` (build) and `tsc --noEmit`
(typecheck) both clean, in both the working tree and the clean
checkout.

Real browser smoke test:
PASS — see "Real browser smoke test" section below.

Regression protection:
PASS — current-week reconciliation (activity overrides, persisted week,
future-session/session-ID preservation, completed-session protection)
all still pass unmodified; Add Unplanned Exercise and Substitute
(public/logger.html, GET /api/programming/substitutes) are verified
byte-for-byte untouched (`git diff` empty since the prior phase);
Training Profile isolation and historical immutability both still pass
unmodified; SQLite integrity verified directly.

Any assumptions or unresolved issues:
See "Assumptions and scoping decisions" below — none are blocking; all
are documented, deliberate, minimal-footprint choices consistent with
the spec's own "make the smallest safe change" instruction.

Deployed:
NO (spec explicitly excludes deployment: "do not deploy until
explicitly instructed").
```

## How the redesign works

### Development references (Phases 2-4)

`developmentReferenceEngine.ts` computes a target's weekly direct-set
reference as `sum(package exercise sets) x package frequency`, reading
Blueprint's own development-package data (`developmentPackages.ts`,
unmodified) — never a duplicated constant. `developmentPackageLevelFor`
maps `is_specialization` (already the existing signal for "this target
belongs to an active goal," established in an earlier phase) onto
Complete (active goal) vs. Efficient (non-goal).

This reference now replaces the single universal number
(`BlueprintAdapter.getGlobalPrinciples().weekly_volume.starting_point_sets[0]`,
literally 8 for every muscle) in the exact two places that number
previously drove real, per-week decisions:

- `workoutBuilder.ts`'s `rankTarget`/per-target classification loop: a
  non-goal target's normal_development-vs-maintenance threshold is now
  that target's own Efficient reference (falling back to the universal
  8 only when no package exists — every `functional_goal` today, since
  Blueprint's development packages are physique-only).
- `volumeEngine.ts`'s `decideVolume`: the ceiling on further increases
  (`blueprint_reference_range`) is now the target's own reference
  (Complete for a goal target) instead of the universal three-tier
  bands; the very-first zero-volume starting point is `min(universal
  8, this target's own reference)` — never higher than the universal
  conservative floor, but genuinely lower when a specific muscle's own
  package recommends starting lower.

Both call sites read from one `developmentReferenceByKey` map computed
once per plan run, so rankTarget's classification and decideVolume's
ceiling can never disagree about which reference a target was judged
against. `decideVolume`'s own state machine (maintain/increase/
introspect_needed, gradual build-up, aesthetic-trend-driven) is
otherwise byte-for-byte unchanged — only which number it compares
against changed.

Five pre-existing tests were recalibrated (not weakened) because they
had hardcoded the old universal 8 into their own fixtures — e.g. quads'
real Efficient reference is 16, not 8; front-delt's is 14. Each still
asserts its original intent, against the now-correct number.

### Weekly-first flow / goal-specific selection (Phases 5-6)

No code change was needed. Inspection confirmed `workoutBuilder.ts`'s
existing session-by-session distribution (never
`desiredWeekly/sessionsRemaining` division) and the existing Gate 1-6
`exerciseSelector` (never copies a package's exercise list, never
repeats one exercise to hit a number) already satisfy these phases —
`tests/engine/goalSpecificExerciseSelection.test.ts` is the explicit
regression proof the spec's own testing discipline calls for.

### Remaining-week actual-training adaptation (Phases 7-8)

The key realization: `computeFreshWeek` (in `programming.ts`, already
existing) always reads real, current, logged exposure — so simply
re-running it after real training already reflects that training's
consequences in every downstream classification/volume decision.
"Recalculate accumulated exposure -> inspect remaining sessions ->
modify minimum necessary future work" (spec §8) therefore did not need
a new decision engine; it needed a new **trigger**.

`src/server/routes/workouts.ts` now calls
`reconcileAfterActualTraining` (new, in `weekProgramReconciliation.ts`)
when:
- a session's status transitions to `completed` (`PATCH /:id`), or
- an already-completed session's own logged work is corrected (`POST
  /:id/exercises` against a session that's already `completed` — spec
  rule #14, "user-modified work counts as actual training").

This reuses the exact same `reconcileWeekProgram` the existing
current-week activity-override endpoint already calls — never a second,
independent adaptation engine (spec §18's explicit code-ownership
instruction). Its two pre-existing rules (a locked/completed day is
never touched; an unlocked day whose core prescription didn't genuinely
change is left alone) already are "modify only the minimum necessary
future work" — verified directly: completing Monday with real quads
volume above quads' own reference removes quads from Thursday's
persisted plan (not a blind "planned minus actual, +N on Friday" rule),
and a later-in-the-week already-completed session is never touched by
an earlier day's adaptation.

No persistent volume-debt ledger exists or was added: exposure is
computed fresh from each week's own real logged sessions, so a badly-
missed week simply doesn't carry anything into the next week by
construction (spec rule #17) — verified by a test asserting a distant
future week has no persisted state at all.

`ReconciliationTrigger` (`{ kind: 'activity_override' | 'actual_training',
dayIndex }`) and `classifyDeviationReason` attach one of the spec's
exact 9 deviation-reason values to any day reconciliation actually
rewrites, tracing to a real signal (a recovery adjustment, an
"adequately exposed" skip already generated by the unmodified engine)
where one exists, falling back to the run's own root cause otherwise.
Never attached on first-ever generation — genesis is not a deviation.

### Goal phases and reviews (Phases 9-11)

Two new, purely additive tables (`goal_phases`, `goal_phase_reviews`),
deliberately separate from `workout_sessions.program_phase` (spec rule
#28). `GoalPhaseRepo` implements the exact lifecycle: `active ->
review_due -> review -> (continue: same phase, extended review_date |
adjust/graduate: this phase completes)`. A new phase via `create()`
carries nothing from its predecessor except `goal_id` — no volume-debt
transfer, no automatic escalation (spec rules #17, #22).

`goalPhaseEngine.ts`'s `reviewGoalPhase` is a pure decision function —
given real evidence (aesthetic trend, measurement trend, logged-
performance trend, real weekly exposure vs. this goal's own Complete
reference, adherence, recovery, and how many immediately-preceding
phases were themselves "improving"), it recommends `continue` /
`adjust` / `graduate` with a specific, cited reason, never equating
hitting the Blueprint reference with success (spec rule #27):

- Recovery flagged, or a declining trend -> `adjust`, always, before
  anything else is considered.
- Improving, on its own -> `continue` (progression is not automatically
  escalation); only sustained improvement across more than one phase
  with good adherence -> `graduate`.
- Stagnant with poor adherence -> `adjust`, citing adherence, not
  volume.
- Stagnant with adequate exposure and adherence -> `adjust`, citing
  approach/exercise-selection, not adherence — a genuinely different
  diagnosis from the previous case, per spec §12's "diagnose before
  escalating."
- Anything insufficiently evidenced -> `continue` (the safe,
  non-escalating default, mirroring `decideVolume`'s own established
  philosophy).

`gatherReviewEvidence` assembles all of this from already-stored data
(`AestheticAssessmentsRepo`, `MeasurementsRepo`, `WorkoutSessionsRepo`,
`TrainingProfileRepo`, the existing `recoveryEngine`/`exposureEngine`) —
no new tracking mechanism. `runGoalPhaseReview` persists the
recommendation; `applyReviewDecision` only ever acts on an explicit
decision a caller passes in (spec §12: "the engine recommends, the
user decides") — verified directly: a system recommendation of
`graduate` with a user decision of `continue` leaves the goal active
and the phase unchanged, with both the system's and the user's values
recorded, neither overwriting the other.

`AestheticAssessmentsRepo` and `MeasurementsRepo` already had real
storage from an earlier phase but no HTTP route (confirmed during
inspection); Phase 11 exposes them, plus the new goal-phase/review
functionality, as thin routes over the already-tested repos/engine —
no duplicate storage, per the spec's own instruction.

## Assumptions and scoping decisions

- **Functional goals have no Blueprint development-package reference.**
  Blueprint's development packages are physique-only; a
  `functional_goal` target's `DevelopmentReference` is explicitly null,
  and every call site falls back to the pre-existing universal bands
  unchanged for that case — an honest "missing package" rather than a
  guess (spec §16.A's own requirement).
- **A goal-phase review's "representative target"** is the goal's own
  first primary-tier target from its `PriorityMap` — a defensible
  simplification for a version-1 review engine; a multi-target goal's
  other targets aren't separately reviewed yet.
- **Measurement/performance trend direction** assumes this app's
  established hypertrophy/muscle-growth scope (a real measurement or
  logged working weight trending up over a phase is "improving") — the
  same domain assumption the rest of this codebase already makes
  (aesthetic goals are muscle-growth targets, not fat-loss targets); a
  2% change threshold distinguishes improving/stagnant/declining,
  documented as a `[DEFAULT]` in the source.
- **Adherence ratio** is approximated as (real completed gym days in
  the phase window) / (configured training days implied by that
  window's length) — a real, computable proxy given this app has no
  separate "planned session count" ledger; documented in the source.
- **The remaining-week adaptation trigger** only fires for the CURRENT
  week (matching the spec's own "current week" framing throughout) and
  only on a session's completion or a correction to an already-
  completed session — never on every incremental set logged mid-session
  (that isn't the final actual result yet).
- **`POST/GET /api/goals/measurements`** (the goal-optional measurement
  route) lives under the existing `/api/goals` router mount rather than
  a new top-level router, to avoid adding a whole new route file for
  two endpoints — registered before the existing generic `GET
  /api/goals/:id` so it is never accidentally swallowed.

None of these block any required behavior; all are documented at their
point of decision in the source.

## Test commands run

```
npx vitest run                                    # full suite, working tree: 656/656 passed
npx tsc --noEmit                                  # typecheck: clean
npm run build                                     # build: clean
npm run verify                                    # build + typecheck + test composed: PASS
```

Clean-checkout verification (this session's established practice):
archived the final commit (`git archive HEAD`) into a scratch
directory, ran `npm ci` then `npm run verify` there — **656/656 tests
passed, build + typecheck clean, exit code 0** — proving the change
works from a fresh install.

Migration safety verification (direct, not part of the automated
suite): built a simulated pre-existing database using the schema
*without* `goal_phases`/`goal_phase_reviews`, inserted real
`users`/`goals` rows, then opened it through the actual `openDb()`.
Result: both new tables appeared, the existing `goals` row was
byte-for-byte unchanged, and the new tables were immediately usable
(a real `goal_phases` row referencing the existing goal via its foreign
key inserted and read back correctly).

## Real browser smoke test

Started the actual built server against a fresh SQLite file, set up a
real profile + goal via the real API, then drove Chromium through the
real UI:
1. Loaded `program.html` — a real 7-day week rendered, generated by the
   redesigned development-reference-driven engine.
2. Opened Monday's day modal — real exercise cards with real reasoning
   rendered (proving the volume-decision/development-reference plumbing
   reaches the UI, not just the API).
3. Created a real in-progress session for Monday via the API (the same
   contract `today.html` uses) and loaded `logger.html` for it.
4. Logged real, substantial quads volume (20 sets) via the same
   endpoint `Add unplanned exercise` uses, then completed the session
   the same way the Logger's own "Finish workout" button does.
5. Confirmed, directly against the server's own SQLite file, that at
   least one persisted day now carries a real `deviation_reason`.
6. Confirmed the persisted week (`GET /api/programming/week`) genuinely
   changed as a consequence of that real completed training.
7. Confirmed no unexpected browser console errors.

All steps passed.

## Regression protection confirmation

- **Current-week reconciliation** (activity overrides, persisted week,
  future-session/session-ID preservation, completed-session
  protection): all pre-existing tests
  (`tests/routes/weekProgramPersistence.test.ts`,
  `tests/routes/weekActivityOverride.test.ts`) pass unmodified.
- **Add Unplanned Exercise / Substitute**: `git diff --stat
  public/logger.html` since before this phase is empty; `GET
  /api/programming/substitutes` in `programming.ts` was not touched
  (the only diff in that file is two `export` additions and one call
  site passing its trigger context to `reconcileWeekProgram`).
- **Training Profile isolation**: `tests/routes/weekActivityOverride.test.ts`'s
  existing "profile remains unchanged" tests pass unmodified.
- **Historical immutability**: existing completed-history-protection
  tests pass unmodified; new tests
  (`tests/routes/actualTrainingAdaptation.test.ts`) add coverage
  specifically for the new actual-training trigger never rewriting a
  locked day.
- **Database integrity**: verified directly (see Migration safety
  verification above).

## Deployment

No deployment or infrastructure change was made or attempted, per the
spec's explicit instruction to wait for it.
