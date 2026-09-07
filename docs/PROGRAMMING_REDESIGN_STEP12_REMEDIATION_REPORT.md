# Workout Programmer — Step 12 Remediation Report

Scope: targeted remediation of the Step 12 Programming Redesign per
`docs/PROGRAMMING_REDESIGN_STEP12_REMEDIATION_SPEC.md`. Per that spec's
explicit framing, the Step 12 architecture itself is sound — nothing here
is a redesign, a second programming engine, or a new universal
threshold. Every change is a targeted fix inside the existing goal-phase
review layer (`src/engine/goalPhaseEngine.ts`), plus the smallest
possible hook connecting it to the pre-existing goal lifecycle
(`src/repositories/goalsRepo.ts`) and two small exports from the
pre-existing weekly-programming pipeline (`src/engine/workoutBuilder.ts`)
so the review layer could reuse real data it was previously
re-deriving in a simplified/buggy way.

## Pass-by-pass summary

**Pass 1 (P0) — target-specific performance evidence.** The old
`performance_trend` computation filtered exercise performances by a
logged session's own free-text `role` field ("primary lift of the
day"), which has no relationship to whether that exercise actually
trains the goal's own Blueprint target. Fixed to use `roleFor()`
(`src/engine/exerciseSelector.ts`, pre-existing, unmodified) — the same
authoritative primary/secondary lookup the rest of the app already uses
— checked against the target itself, so an exercise only counts as
direct performance evidence when it is a real PRIMARY relationship to
that specific target. A secondary-only relationship is deliberately
excluded from direct performance evidence (real exposure, tracked
separately, never conflated with direct evidence).

**Pass 2 (P0) — phase-wide exposure, not a single current week.** The
old code called `aggregateWeeklyExposure(..., asOfDate, 'monday')`,
which silently discards every session outside the single week
containing `asOfDate` — a current-week reading masquerading as
phase-level (potentially 4-6 week) evidence. Replaced with
`aggregateExposure(..., phase.start_date, asOfDate)` — the general
explicit-range form (pre-existing, unmodified) — and added two new,
transparent evidence fields: `phase_total_primary_sets` (the real total)
and `phase_weeks_elapsed` (the real elapsed portion of the phase, a
fraction when reviewed mid-week). `actual_weekly_exposure` is now the
real average (`phase_total_primary_sets / phase_weeks_elapsed`) — this
divides by the phase's real ELAPSED time, never its full planned length,
so a phase reviewed early never has invented exposure for weeks that
haven't happened yet.

**Pass 3 (P0) — removed every invented threshold/methodology.** Three
specific numbers named as illegitimate in the remediation spec are gone
entirely, not just renamed:
- The 2% trend-change band (`TREND_CHANGE_THRESHOLD`) — `classifyValueTrend`
  is now a strict sign comparison: any real increase is `improving`, any
  real decrease is `declining`, an exact tie is `stagnant`.
- The 60% adherence cutoff (`LOW_ADHERENCE_THRESHOLD`) — replaced by
  `hasAdherenceShortfall`, which treats ANY real shortfall against the
  user's own configured plan (`adherence_ratio < 1`) as a real,
  non-arbitrary signal; there is no principled basis for calling some
  smaller shortfall "good enough."
- `consecutive_improving_phases` and its "N consecutive phases"
  graduation rule — the field is gone from `GoalReviewEvidence` entirely
  (not just unused; TypeScript itself would fail to compile any code
  that still referenced it), along with `countConsecutiveImprovingPhases`.

  Graduation is now evidence-based and conservative: real, corroborated
  improvement achievable within a SINGLE phase (an improving aesthetic
  trend together with an improving measurement OR performance trend),
  with no adherence shortfall and no flagged recovery. A bare improving
  aesthetic trend alone, or any real shortfall, never graduates —
  `reviewGoalPhase` still only ever recommends; `applyReviewDecision`
  still only ever acts on an explicit user decision.

**Pass 4 (P0) — goal lifecycle connected to goal-phase lifecycle.**
Inspected `GoalsRepo` first (`create`/`deactivate`/`reactivate`) — it had
no reference to `GoalPhaseRepo`/`GoalPhaseEngine` at all, so an active
goal could exist with no phase, and deactivating/graduating a goal never
touched its phase. Added the smallest hook: a private
`GoalsRepo.ensureActivePhase()` (Complete package level, no-op if the
goal already has a non-completed phase), called from `create()` when the
new goal is active and from `reactivate()`; `deactivate()` now also
completes the goal's own active phase, if any. No second goal-creation
flow — this is the same `GoalsRepo` class already calling
`GoalEventsRepo` internally, extended with one more internal call.

**Pass 5 (P1) — real recovery/activity evidence, not a fabricated
snapshot.** `gatherReviewEvidence`'s recovery computation had the exact
same bug class as Pass 1 (checking a session's own `role` field for
"last trained this target"), plus a hardcoded `recent_badminton: null`.
Exported `gatherTargetTouches` and a new small `gatherRecentBadmintonSignal`
helper from `workoutBuilder.ts` (the real weekly-programming pipeline's
own "last trained"/"recent badminton" computations, using the same
`calculateExerciseExposure` Blueprint target-relationship resolution
`roleFor` uses) and reused both in `goalPhaseEngine.ts`. Note:
`other_activity_today: []` was NOT changed — it is the real production
pipeline's own existing behavior everywhere `RecoveryConstraintInput` is
built (`workoutBuilder.ts` passes the identical empty list), so it is not
a fabrication unique to review; wiring real daily-activity data into that
field does not exist anywhere in this app yet and would be new
functionality outside this remediation's scope.

**Pass 6 (P1) — metric-specific measurement evidence.** The old code
compared the FIRST vs LAST measurement across a phase regardless of
`metric_name`/`unit` — collapsing e.g. a chest circumference (cm) and a
bodyweight (kg) into one meaningless "trend." Added
`classifyMeasurementTrend`, which groups by `metric_name:unit` and only
ever compares a metric chronologically against its own earlier readings.
With multiple tracked metrics, a real decline in ANY of them is
surfaced (never masked by a different metric improving); otherwise a
real improvement in any metric counts; only when every metric with
enough data is flat is the result `stagnant`.

**Pass 7 (P1) — strengthened remaining-week adaptation regression
tests.** Added three tests to the existing
`tests/routes/actualTrainingAdaptation.test.ts` covering named scenarios
that weren't yet directly exercised: completing a session exactly as
planned causes no unnecessary reallocation (the quiet/golden path); real
unplanned work for one target never reduces a different, unrelated
target's later-day programming; and a real shortfall followed by a real
excess within the same week never escalates a later day beyond the real
development reference (no invented "make-up" logic, no intra-week debt).
The other named scenarios (missed-with-adaptation, user-added relevant
work, completed-session immutability, later-session adaptation) were
already covered by existing tests in that file and in
`tests/engine/weekProgramReconciliation.test.ts`.

**Pass 8 — package reference vs. prescription clarified in
comments/types.** Strengthened the doc comments on
`DevelopmentReference.weekly_direct_set_reference`
(`src/engine/developmentReferenceEngine.ts`) and the new
`GoalReviewEvidence.development_reference_weekly`
(`src/engine/goalPhaseEngine.ts`) to explicitly say, in those words, that
a package reference is a weekly OBJECTIVE to aim for across a real
week's training days — never today's literal prescription, never a
single day's set count, and never itself evidence of success merely by
being reached.

## Changed files and why

- `src/engine/goalPhaseEngine.ts` — Passes 1, 2, 3, 4 (partially — see
  below), 5, 6, 8. The central file for this remediation; see per-pass
  summaries above for exactly what changed and why.
- `src/repositories/goalsRepo.ts` — Pass 4: added `ensureActivePhase()`
  and wired it into `create()`/`reactivate()`; `deactivate()` now
  completes the goal's own active phase.
- `src/engine/workoutBuilder.ts` — Pass 5: exported the pre-existing
  `gatherTargetTouches`/`TargetTouch`, and factored the pre-existing
  inline badminton-signal lookup in `assembleWeeklyPlanInput` out into a
  new exported `gatherRecentBadmintonSignal` helper (called from the same
  call site as before, plus now also from `goalPhaseEngine.ts`) — no
  behavior change to the real weekly-programming pipeline itself, purely
  making an existing computation reusable.
- `src/engine/developmentReferenceEngine.ts` — Pass 8: doc-comment-only
  clarification, no logic change.
- `tests/engine/goalPhaseEngine.test.ts` — updated the shared `evidence()`
  test helper for the two new required fields
  (`phase_total_primary_sets`, `phase_weeks_elapsed`) and removed the
  retired `consecutive_improving_phases` field; rewrote the graduation
  scenario test and the "adequate exposure" scenario test to use the new,
  real methodology (full adherence + corroborated improvement) instead of
  the retired 60%/consecutive-phase thresholds. No test's original intent
  was weakened — each was recalibrated to the corrected, real behavior.
- `tests/repositories/goalPhaseRepo.test.ts`,
  `tests/routes/goalPhaseRoutes.test.ts` — Pass 4 side effect: these files
  test `GoalPhaseRepo`'s own state machine and the phase-management ROUTES
  directly by hand-creating phases; since an ACTIVE goal now auto-creates
  its own phase (Pass 4), their `beforeEach` goal creation was changed to
  `active: false` so they keep testing exactly what they tested before,
  without colliding with the new auto-created phase. The auto-creation
  hook itself is covered separately in the new
  `tests/goalPhaseLifecycleLinkage.test.ts`.
- `tests/routes/actualTrainingAdaptation.test.ts` — Pass 7: three new
  regression tests added (see above); nothing existing removed or
  weakened.

## New test files (all passing)

- `tests/engine/goalReviewPerformanceEvidence.test.ts` — Pass 1, Tests A-D.
- `tests/engine/goalReviewPhaseExposure.test.ts` — Pass 2, Tests A-D.
- `tests/engine/goalReviewGraduationMethodology.test.ts` — Pass 3, Tests A-E.
- `tests/goalPhaseLifecycleLinkage.test.ts` — Pass 4, Tests A-E.
- `tests/engine/goalReviewRecoveryEvidence.test.ts` — Pass 5, Tests A-C.
- `tests/engine/goalReviewMeasurementEvidence.test.ts` — Pass 6, Tests A-D.

## Files intentionally left unchanged

- `src/engine/exerciseSelector.ts` (`roleFor`) — the spec explicitly
  requires reusing this, not duplicating it; it needed no changes.
- `src/engine/exposureEngine.ts` (`aggregateExposure`,
  `aggregateWeeklyExposure`) — both already correct and general-purpose;
  the bug was in which one `goalPhaseEngine.ts` called, not in either
  function itself.
- `src/repositories/goalPhaseRepo.ts`, `src/repositories/goalPhaseReviewsRepo.ts`
  — `getActiveForGoal`/`complete`/`create` etc. already existed with
  exactly the semantics Pass 4 needed; no repo-level changes required.
- `src/engine/recoveryEngine.ts` (`applyRecoveryConstraint`) — already
  correct and generic; Pass 5 fixed what was PASSED into it, not the
  function itself.
- `RecoveryConstraintInput.other_activity_today` — left as `[]`
  everywhere, including in review evidence; see Pass 5 note above. Wiring
  real daily-activity data into this input does not exist anywhere in
  this app today and is out of this remediation's scope (no existing
  functionality to reuse, and building new functionality here would be
  exactly the kind of scope expansion the spec prohibits).
- `src/server/routes/goals.ts` and all other route files — no route
  contracts changed; every fix is inside the engine/repo layer the
  existing routes already call through.
- No architecture rewrite, no second programming engine, no new
  universal thresholds/percentages, no exposure coefficient changes
  (primary 1.00 / secondary 0.33 untouched), no changes to Add Unplanned
  Exercise or Substitute behavior, no automatic escalation/graduation
  logic added.

## Verification (run individually, actual output)

- `npm run typecheck` — clean, no errors, exit code 0.
- `npm test` (`vitest run`) — **70 test files, 688 tests, all passed**,
  0 failed, 0 skipped.
- `npm run build` — clean, no errors, exit code 0.
- `npm run verify` (build + typecheck + test composed) — clean, all 688
  tests passed, exit code 0.

All numbers above are from actual command runs in this session, not
estimated.

## Deployment

No deployment was performed, per the spec's scope (a remediation/fix
pass on already-implemented, already-pushed work — see the prior Step 12
implementation report for deployment status).
