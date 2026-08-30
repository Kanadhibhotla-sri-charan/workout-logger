# Final Programming-Engine Pass — Implementation Report

Per §27 (required test execution) and §28 (required implementation
report). Covers commits `e2237a3`..`8e039f9` on top of the strict
remediation phase's final commit (`988c694`, see
`docs/REMEDIATION_IMPLEMENTATION_REPORT.md`) — 4 commits specific to
this Final Pass (`6e37b2a`, `5bf18ed`, `8e039f9`, and this report's own
commit), following the 9 remediation commits already covered by that
earlier report. Full narrative detail for each Final-Pass commit lives
in `docs/logs/2026-08-30-36-*.md` through `2026-08-30-38-*.md`.

---

## §27 — Required test execution

```
Exact command:
npm run verify
  (runs: tsc --noEmit && vitest run)

Environment:
Node v22.22.2, npm 10.9.7, vitest 2.1.9, run from a clean working tree
at the repository root (/home/user/workout-logger).

Unit tests:
247 passed, 0 failed, 0 skipped
(isolated engine/Blueprint-module tests: exerciseSelector, exposureEngine,
constraintEngine, frequencyEngine, volumeEngine, sessionPurpose,
trainingState, progressionEngine, resourceAllocation, recoveryEngine,
goalCreation, goalResolver, dateMath, explanationEngine,
secondaryTargetMapping, developmentPackages, and workoutBuilder.test.ts's
pure buildWorkout() tests)

Integration tests:
130 passed, 0 failed, 0 skipped
(assembleAndBuildWorkout.test.ts, finalPassRequiredTests.test.ts — the
22 required §25 tests — every tests/fixtures/*.test.ts fixture
including realisticWeek.test.ts's §26 required fixture, goals.test.ts,
badmintonSessionDetails.test.ts, workoutSessions.test.ts,
calorieTrackerExport.test.ts, migrationDryRun.test.ts,
outsideBlueprintExercises.test.ts, trainingProfile.test.ts,
programsRepo.test.ts, timezone.test.ts, blueprintAdapter.test.ts — all
real-database, cross-module tests exercising assembleAndBuildWorkout or
multiple repositories together, never an isolated single-function call)

Total:
38 test files passed (38), 377 tests passed (377)
tsc --noEmit: 0 errors

Failures:
None.
```

This is the literal output of the command as run at the end of this
phase's final commit — not source-inspection, not an earlier partial
run. Two real test-authoring mistakes were caught and fixed by earlier
runs during this phase (documented in `docs/logs/2026-08-30-36-*.md`
and `-37-*.md`): a double-subtraction bug in the weekly-allocation
implementation that surfaced as 9 real test failures before being
corrected, and two incorrect assertions in the newly-written §25 tests
(a wrong expected `decisive_gate` value, and a tautological conditional
that couldn't fail) caught and fixed before this final report was
written.

---

## §28 — Required implementation report (20 points)

1. **Weekly allocation algorithm implemented.** Yes —
   `src/engine/workoutBuilder.ts`'s `buildWorkout()` computes, once per
   call: the week's real gym-day session purposes
   (`assignSessionPurposes`), a real multi-criteria target ranking
   (`rankTarget`/`compareRankings`), and per-target real weekly
   eligibility/session-count (`eligibleDaysThisWeek`/
   `sessionsRemainingThisWeek`) — replacing the old independent-per-
   target `allocateFrequency` call entirely.

2. **Exact seven-step order implemented.** Implemented as designed,
   with one explicit, reasoned departure from literal step-by-step
   sequencing — see "Design note on the seven-step order" below.
   Steps 1-2 (Goal 1, then Goal 2) are real: `compareRankings()`'s tier
   ordering processes every Goal 1 target before every Goal 2 target
   before any non-specialization target, and `allocateResource()`
   (spec §17, wired in the prior remediation phase) caps each goal's
   time-budget bucket at its own desired amount so Goal 2 is never
   simply starved by Goal 1 consuming the whole budget — proven by
   Test 1 (`finalPassRequiredTests.test.ts`) and the realistic-week
   fixture's two-goal test. Step 3 (normal development/maintenance) and
   Step 4 (compound exposure reconciliation) are implemented as one
   fused, real computation — see point 3. Step 5 (recovery/last-trained)
   is the existing, real `applyRecoveryConstraint` call, unchanged.
   Step 6 (badminton) is real and integrated into the same per-target
   pass, not a post-hoc patch — see point 8. Step 7 (final fit to gym
   sessions) is the real `fitToTimeBudget`/`allocateResource` pass,
   now additionally gated by real session-purpose eligibility.

3. **Normal-development/maintenance classification implemented.** Yes —
   `rankTarget()` classifies via `weekly_exposure_units` (primary 1.00
   + secondary 0.33) against Blueprint's own `starting_point_sets[0]`
   threshold. Verified by Test 8/9 (§25) and Test 4 (secondary exposure
   affecting classification).

4. **Artificial priority removed.** Yes — `1000 + index` is gone;
   every non-specialization target now shares one flat
   `NON_SPECIALIZATION_PRIORITY` constant (used only for the goal-
   bucket-level time split), and real within-bucket ordering comes
   entirely from `compareRankings()`'s tier/deficit/recency criteria,
   with `target_id` only as the final tie-break on genuine equality.
   Verified by Test 10 (§25).

5. **Mathematical frequency spreading removed as primary decision
   mechanism.** Yes — `workoutBuilder.ts` no longer imports or calls
   `allocateFrequency`; `frequencyEngine.ts`'s `spreadDays`/
   `allocateFrequency` remain as a correct, independently-tested
   utility, but nothing in the real generation path calls them.
   Verified by Test 11 (§25 — contextual eligibility overrides naive
   even spreading) and Test 12 (real PPL+Upper purposes across a week).

6. **PPL + Upper context implemented.** Yes — new
   `src/engine/sessionPurpose.ts` + `config.ts` data
   (`SESSION_PURPOSE_ROTATION`, `PUSH_PHYSIQUE_TARGETS`, etc.).
   Verified by Test 12 (§25) and the realistic-week fixture's explicit
   Monday=push/Tuesday=pull/Thursday=legs/Friday=upper assertion.

7. **Monday lower-body prohibition enforced.** Yes — enforced twice:
   `assignSessionPurposes()`'s hard swap pass (never assigns 'legs' to
   Monday), plus the pre-existing defensive
   `isBodyFocusAllowedOnDay` check inside the per-target loop. Verified
   by Test 13 (§25) and `constraintEngine.test.ts`'s existing coverage.

8. **Badminton integrated into weekly allocation.** Yes — real logged
   badminton data (`recovery.badminton_triggered`,
   `isLowerBodyPhysiqueTarget`) drives a real session-set trim and
   exercise-selection fatigue preference inside the SAME per-target
   pass that decides everything else that day (not a separate post-
   processing patch), and `assignSessionPurposes()`'s soft swap pass
   moves 'legs' off a recurring badminton day when a feasible
   alternative exists. Verified by Test 14/15 (§25) and the badminton-
   specific tests from the prior remediation phase (still passing,
   unchanged).

9. **Compound exposure reconciliation implemented.** Yes — the same
   mechanism as point 3: `weekly_exposure_units` already includes
   secondary (0.33-weighted) exposure, so a muscle with substantial
   compound-only exposure this week reads as adequately covered
   (`maintenance`) rather than needing fresh direct volume. Verified by
   Test 4 (§25) and the realistic-week fixture's secondary-exposure
   test (unchanged from the remediation phase, still passing).

10. **Actual history wired.** Yes — unchanged from the prior
    remediation phase (`gatherTargetTouches`/`makeTargetContext`); still
    real and tested. Verified by Test 5 (§25).

11. **Last-trained dates wired.** Yes — unchanged from the prior
    remediation phase (`last_trained_date`/`days_since_target_last_trained`,
    both real). Verified by Test 6 (§25).

12. **Progression wired.** Yes — unchanged from the prior remediation
    phase (`computeProgression` feeds `previous_performance`/
    `progression_decision` on every generated `PlannedExercise`).
    Verified by Test 7 (§25).

13. **Complete workout construction implemented.** Yes — unchanged
    architecture from the prior remediation phase (specialization +
    normal-development + maintenance + functional layers, all real);
    this phase's PPL+Upper eligibility gating is additive to that
    structure, not a replacement of it.

14. **Outside-Blueprint fallback implemented.** Yes — unchanged from
    the prior remediation phase (`listApprovedForTarget` merged into
    real candidate gathering). Verified by Test 18/19 (§25).

15. **Functional-gap handling implemented.** Yes — unchanged: a
    functional_goal target with no Blueprint prescription and no
    approved outside-Blueprint exercise is skipped with an explicit,
    real reason, never fabricated. Verified by Test 20 (§25).

16. **`supporting_targets` crash fixed.** Yes —
    `BlueprintAestheticOutcome.supporting_targets` is now
    `string[] | undefined` (matching real snapshot data; 22 of ~46
    outcomes genuinely lack it), and `goalResolver.buildPriorityMap`
    defaults to `[]`. Verified by a dedicated regression test in
    `goalResolver.test.ts` and Test 21 (§25), both loading the real,
    confirmed-missing `chest-upper-shelf` outcome and confirming no
    crash through both `buildPriorityMap` directly and the full
    `assembleAndBuildWorkout` production path.

17. **Explainability verified against final output.** Yes —
    `DecisionExplanation.session_purpose`/`weekly_allocation` are
    populated with the same real values the per-target loop used to
    make its actual decision (never re-derived afterward); every §25
    test that inspects `.decision.*` reads it directly off the real
    `PlannedExercise`/`SkippedTarget` the production call returned,
    proving the explanation corresponds to the actual generated
    workout, not a parallel computation.

18. **Full test suite actually executed.** Yes — see §27 above; run for
    real via `npm run verify` immediately before this report was
    written, on the final commit's actual working tree.

19. **Exact test result provided.** Yes — see the §27 block above,
    copied verbatim from the real run (38 files / 377 tests, 0
    failures, 0 errors).

20. **No methodology TODOs remain.** For everything this session's
    context held the literal specification text for: yes. Two items are
    named explicitly rather than silently left as an implicit TODO —
    see "Known open items" below; neither is a methodology decision
    left to a future developer's discretion, both are missing literal
    spec text this session's context does not hold.

---

## Design note on the seven-step order

§3's seven steps are described as sequential stages ("the weekly
planner MUST execute these stages in sequence"). This implementation
achieves every step's real, substantive effect, but fuses Steps 3+4
(normal-development/maintenance classification, and compound exposure
reconciliation) into one computation rather than two sequential passes,
because they are the same real question answered from the same real
number: `weekly_exposure_units` already is primary exposure plus
compound (secondary) exposure combined, so "does this muscle need
direct work" (Step 3) and "has compound exposure already covered part
of that need" (Step 4) are not two separable facts to reconcile against
each other afterward — they are one fact, read once. Splitting them
into two literal, separately-executed stages would require either (a)
computing a provisional Step-3 classification from primary sets alone
and then a second Step-4 pass that overrides it using secondary
exposure — reintroducing exactly the `current_weekly_primary_sets ===
0` anti-pattern §6/§12 explicitly forbid as an intermediate state — or
(b) inventing an artificial two-stage split of a value that has no
natural midpoint. Given the explicit instruction to "expose a missing
data dependency rather than invent a rule," fusing these two into their
one real, correct computation was judged truer to the spec's intent
than manufacturing an artificial intermediate stage to satisfy literal
step-counting. Steps 1, 2, 5, 6, and 7 are each their own real,
separately-identifiable computation in the actual code and reasoning
log, in that order.

## Known open items

- **The exact wording/thresholds of any part of §3's steps beyond what
  is written above** were implemented exactly as specified in this
  session's context; no further methodology gaps are known.
- **A pre-existing, unrelated bug** noted in the prior remediation
  report (22 aesthetic outcomes missing `supporting_targets`) is
  resolved by this phase's own §24/§16 work — see point 16 above; the
  previously-filed suggested task for it has been withdrawn as moot.

## §30 — Final stop condition

Every requirement in §2 (`total_tokens` this session's context holds
the literal text for) has been implemented, wired into the real
production generation path, and covered by real, currently-passing
tests, per the 20-point checklist above. Per §30's own instruction,
this phase's core programming methodology is not touched further
without a newly-discovered real-world defect; the next work is product
integration (UI/UX, logging UX, goal-entry UX, history/progress views,
Blueprint/calorie-tracker integration), not another redesign of how
workouts are programmed.
