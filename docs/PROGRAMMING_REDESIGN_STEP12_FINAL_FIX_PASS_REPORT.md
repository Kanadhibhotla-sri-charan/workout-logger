# Workout Programmer — Final Step 12 Fix Pass Report

Scope: surgical remediation per
`docs/PROGRAMMING_REDESIGN_STEP12_FINAL_FIX_PASS_SPEC.md`. Per that
spec's own framing, the Step 12 architecture is accepted — every change
below is a targeted fix inside the existing goal-phase review layer
(`src/engine/goalPhaseEngine.ts`), reusing existing infrastructure
(`workoutBuilder.ts`'s `weekdayOfDate`/`programmingWeekStart`,
`src/lib/dailyActivity.ts`'s `applyWeekOverrides`,
`WeekActivityOverridesRepo`) rather than building anything new.
`workoutBuilder.ts` itself was not touched.

## P0 fixes

**P0-1 — aesthetic assessment evidence is now a real trend.** The
previous implementation classified the single latest 1-5 rating directly
(`classifyAestheticTrend`, still used unchanged for its OTHER, different
purpose — see "left unchanged" below). Added
`classifyAestheticTrendForReview`, which compares an appropriate earlier
assessment against the latest one, phase-aware and priority-ordered
exactly per spec: (1) two or more assessments inside the phase window —
earliest-in-phase vs latest-in-phase; (2) exactly one in-phase assessment
plus an earlier one recorded before the phase started — that prior
reading vs the in-phase one; (3) fewer than two comparable assessments
overall — `insufficient_data`. No percentage threshold — reuses the
existing strict sign comparison (`classifyValueTrend`, unchanged) applied
to the two ratings. The existing staleness guard (a latest reading older
than 2x the goal's review cadence is too stale to use) is preserved.
Assessments are already scoped `.listForGoal(goal.id)`, so a different
goal's assessment history is structurally excluded — never a new filter
needed.

**P0-2 — the engine never recommends Graduate.** The previous
implementation could return `'graduate'` from corroborated improving
evidence with full adherence. `GoalPhaseReviewResult.recommendation` is
now typed `Exclude<ReviewRecommendation, 'graduate'>` — TypeScript itself
enforces that `reviewGoalPhase` can only ever return `'continue'` or
`'adjust'`. `ReviewRecommendation` itself (the 3-value union used for
persisted `system_recommendation`/`user_decision`) is unchanged —
`'graduate'` remains a fully valid REVIEW DECISION, and
`applyReviewDecision` handles it exactly as before (completes the phase,
deactivates the goal) when a user explicitly chooses it.

**P0-3 — adherence is contextual evidence, never a pass/fail gate.**
Removed `hasAdherenceShortfall` and every `adherence_ratio < 1` decision
branch entirely. `reviewGoalPhase` no longer inspects adherence to decide
`continue` vs `adjust` at all — the real trend/exposure/recovery evidence
alone drives the recommendation, and the real `adherence_ratio` is now
only ever quoted as context appended to the `reason` text (e.g. "...
(adherence this phase: 72% of real training opportunities)"). This means
90% adherence with improving evidence recommends `continue` (adherence
never overrides real improvement), and 100% adherence with stagnant
evidence is never itself treated as success (it still recommends
`continue`, meaning "insufficient evidence to change" — never a success
claim).

**P0-4 — adherence is calculated by exact calendar-date enumeration.**
Replaced the approximate `Math.round((phaseDays / 7) * trainingDaysCount)`
estimate with `enumerateTrainingOpportunityDates`, which walks every real
date from `phase.start_date` to `min(asOfDate, phase.review_date)`
inclusive and, for each date, resolves that date's REAL effective
training days by reusing the exact same per-week override resolution the
real weekly-programming pipeline already uses
(`WeekActivityOverridesRepo.get` + `src/lib/dailyActivity.ts`'s
`applyWeekOverrides`, the same functions `workoutBuilder.ts`'s
`assembleWeeklyPlanInput` calls) — never a second, approximate attendance
model. No future dates (capped at `asOfDate`), no extrapolation beyond
the phase's own boundary (capped at `phase.review_date`), and an
intentional current-week override is honored exactly as it is in the
real weekly plan: a day the user explicitly moved off gym for a given
week is excluded from "real opportunity" entirely, never counted as a
missed one (proven by Test E below — an overridden single-day window
returns `adherence_ratio: null`, not a punitive `0`).

## Changed files and why

- `src/engine/goalPhaseEngine.ts` — all four P0 fixes live here:
  - Added `classifyAestheticTrendForReview` (P0-1) and switched
    `gatherReviewEvidence`'s `aesthetic_trend` computation to use it,
    passing the full assessment history instead of just the most recent
    one.
  - Narrowed `GoalPhaseReviewResult.recommendation`'s type (P0-2) and
    removed the `'graduate'`-returning branch from `reviewGoalPhase`.
  - Removed `hasAdherenceShortfall` and every branch that used it;
    `reviewGoalPhase` now appends adherence as context text only (P0-3).
  - Added `enumerateTrainingOpportunityDates` and switched
    `gatherReviewEvidence`'s `adherence_ratio` computation to use exact
    date enumeration instead of the `phaseDays/7` estimate (P0-4).
  - New imports: `TrainingProfile` (contracts/types.js),
    `WeekActivityOverridesRepo`, `applyWeekOverrides`, `weekdayOfDate`,
    `programmingWeekStart`, `addDays`. Removed the now-unused
    `classifyAestheticTrend` import (still used, unchanged, by
    `workoutBuilder.ts` for its own different per-day volume-decision
    question — see "left unchanged" below).
  - Updated doc comments on `GoalReviewEvidence.development_reference_weekly`
    and `.adherence_ratio` to reflect the corrected semantics.
- `tests/engine/goalPhaseEngine.test.ts` — updated 4 pre-existing tests
  whose assertions encoded exactly the behavior this spec forbids
  (adherence-driven automatic `adjust`, corroborated-evidence automatic
  `graduate`, a single assessment treated as a trend). Each was
  recalibrated to the corrected, real behavior — never weakened in
  intent; the new assertions are stricter about what the engine must
  NOT do.
- `tests/engine/goalReviewGraduationMethodology.test.ts` — this file's
  entire premise (the PREVIOUS remediation pass's "corroborated evidence
  may graduate" methodology) is superseded by P0-2. Rewritten in full to
  test the new methodology: the engine never returns `'graduate'` under
  any evidence combination, and adherence never independently gates the
  recommendation.

## New test files (all passing)

- `tests/engine/goalReviewAestheticTrendEvidence.test.ts` — P0-1's five
  required scenarios: 2→3 improving, 5→4 declining, 3→3 stagnant, one
  assessment insufficient, an unrelated goal's assessment excluded.
- `tests/engine/goalReviewAdherenceEvidence.test.ts` — P0-4's five
  required scenarios: complete-week exact count, partial-week exact
  count, multi-week exact count, future dates excluded (including a
  session logged beyond the phase's own boundary never counted), and an
  intentional current-week override handled conservatively (proven
  against the same setup WITHOUT the override, which correctly shows a
  real `0` — the override changes that to `null`, never silently to a
  better-looking number).

## Files intentionally left unchanged

- `src/engine/volumeEngine.ts`'s `classifyAestheticTrend` — still used
  as-is by `workoutBuilder.ts`'s real per-day weekly-programming volume
  decision, which legitimately asks a different question ("what does the
  user's latest self-assessment suggest about programming this week"),
  not the phase-level trend question P0-1 fixes. Changing its behavior
  would have altered the real weekly-programming pipeline, which this
  spec explicitly says not to touch.
- `src/engine/workoutBuilder.ts` — not modified at all this pass; only
  its pre-existing exports (`weekdayOfDate`, `programmingWeekStart`) were
  reused.
- `src/lib/dailyActivity.ts`'s `applyWeekOverrides`,
  `src/repositories/weekActivityOverridesRepo.ts` — already had exactly
  the semantics P0-4 needed; reused directly, no changes.
- `ReviewRecommendation` (`src/repositories/goalPhaseReviewsRepo.ts`) —
  stays the 3-value union; `'graduate'` is still a valid persisted value
  for an explicit user decision. Only `reviewGoalPhase`'s own return type
  was narrowed.
- `applyReviewDecision` — unchanged; still processes an explicit
  `'graduate'` user decision exactly as before.
- Exposure coefficients (primary 1.00 / secondary 0.33), Complete/
  Efficient package references, phase-wide exposure aggregation,
  metric-specific measurement evidence, target-specific performance
  evidence, recovery-infrastructure reuse, goal-phase lifecycle linkage,
  Add Unplanned Exercise, Substitute, Training Profile, current-week
  overrides/reconciliation, and historical immutability — all from the
  prior remediation pass, all untouched by this one.
- No architecture rewrite, no second programmer/exposure/recovery/
  attendance model, no new universal volume percentages, no automatic
  volume escalation.

## Verification (run individually, actual output)

- `npm run typecheck` — clean, no errors, exit code 0.
- `npm test` (`vitest run`) — **72 test files, 699 tests, all passed**,
  0 failed, 0 skipped.
- `npm run build` — clean, no errors, exit code 0.
- `npm run verify` (build + typecheck + test composed) — clean, all 699
  tests passed, exit code 0.

All numbers above are from actual command runs in this session.

## Remaining limitations

- Adherence's numerator (a completed `session_type: 'gym'` WorkoutSession
  on a given date) is unchanged from before this pass — a real gym
  session either happened on a date or it didn't; this pass only fixed
  how the DENOMINATOR (real opportunities) is computed.
- This app still has no stored concept of a goal's actual physical
  completion endpoint, by design (per this spec's "core principle") —
  graduation therefore remains, correctly, a judgment call only a human
  user can make.

## Deployment

No deployment was performed.
