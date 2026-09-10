# Workout Programmer — Final Remaining Corrective Fix: Implementation Report

Corresponds to `docs/WORKOUT_PROGRAMMER_FINAL_REMAINING_PER_EXPOSURE_FIX.md`, implemented on the
same branch as all prior Workout Programmer work (`workout-programmer-ui-and-equipment-filter-fix`).
This spec is explicitly "remaining-issues-only": it confirms the immediately prior phase
("Remaining Post-v2 Corrective Fixes") correctly removed the old `remainingWeeklySets <= 0` HARD
STOP that could block a genuinely due later exposure, and identifies the one remaining defect —
the `remainingWeeklyReference` value that phase introduced still acted as a **mutable, depleting
weekly bucket** that SIZED exposures based on how much prior exposures happened to consume, even
though it no longer BLOCKED them.

## Audit (spec §18)

Every occurrence of `remainingWeeklyReference`, `fairShareWeekly`, `sessionRemaining`,
`remainingWeeklySets`, `desiredWeekly`, `weekly_exposure_units`, `needDeficit`,
`weekly_direct_set_reference` in `workoutBuilder.ts` was traced and classified against spec §18's
six categories:

- **Category F (obsolete mutable weekly prescription state — removed)**: the `let
  remainingWeeklyReference = fairShareWeekly;` declaration, the two-tier `remainingWeeklyReference >
  0 ? Math.min(remainingWeeklyReference, sessionCap) : (sessionCap ?? fairShareWeekly)` sizing
  conditional, and the `remainingWeeklyReference -= delivered;` line that coupled every later due
  day's size to exactly how much an earlier due day happened to deliver. This is the one genuine
  defect the spec identifies.
- **Category C (package-sharing/reference allocation — unchanged, correct)**:
  `plannedDirectSetsByPackage`, `packageRemainingBudget`, `isPackageDerivedRecommendation`. These
  operate entirely on `fairShareWeekly`'s ONE-TIME, once-per-TARGET computation (a cross-target
  concern: how much of a shared package aggregate this target may claim at all) — completely
  orthogonal to the per-exposure-sizing defect (a within-target, cross-DAY concern). Left untouched.
- **Category A (Blueprint/reference data — unchanged, correct)**: `sessionCap`
  (`developmentReference.direct_sets_per_exposure`), `sessionsPerWeekForInterval`
  (`developmentReference.sessions_per_week_reference`), `weekly_direct_set_reference`. Still read
  read-only from Blueprint's own package data.
- **Category D (actual/reporting data — unchanged, correct)**: `requiredDirectSetsByTarget`,
  `unmetDirectSets`, `weekly_exposure_units` (`decideVolume` input), `desiredWeekly`
  (`decideVolume`'s own recommendation, before package-sharing scoping) — none of these are mutated
  during the day loop; they remain per-target snapshots.
- **Category E (temporary planning state — unchanged, correct)**: `simulatedLastExposureDate`,
  `exposureDatesThisRun` — confirmed still pure per-run locals, never written back, never
  influencing sizing (only due-ness).

**What changed**: `fairShareWeekly` — the target's real weekly OBJECTIVE, already correctly derived
by the prior two phases — is now used to derive exactly ONE new value, `perExposurePrescription`,
computed ONCE per target before the day-construction loop runs, and never touched again. Every real
due day this run considers reads this same stable value; none of them decrement it, and none of
them read a value some earlier day left behind.

## The stable per-exposure prescription

```ts
const compatibleDaysThisRun = isPhysique
  ? orderedGymDays.filter((day) => {
      const purpose = sessionPurposes.get(day) ?? null;
      return purpose !== null && isTargetCompatibleWithPurpose(target.target_type, target.target_id, purpose);
    }).length
  : orderedGymDays.length;
const realExposureCountThisRun = Math.max(1, Math.min(compatibleDaysThisRun, Math.ceil(sessionsPerWeekForInterval)));
const perExposurePrescription = Math.max(1, Math.min(sessionCap ?? Number.POSITIVE_INFINITY, Math.ceil(fairShareWeekly / realExposureCountThisRun)));
```

`sessionRemaining` for each real due day is now simply `perExposurePrescription` (optionally
trimmed by 1 for the pre-existing badminton lower-body fatigue adjustment, itself a legitimate
per-exposure rule, not a weekly-budget one) — never initialized from, or decremented into, any
cross-day mutable state.

The divisor (`realExposureCountThisRun`) is this target's own REAL achievable exposure count this
run — schedule facts only (which of `orderedGymDays` its session-purpose compatibility actually
allows), capped at the Blueprint theoretical frequency reference — never how much any day actually
ends up delivering. This was arrived at empirically after one rejected attempt:

- **Rejected**: dividing `fairShareWeekly` by the raw theoretical `sessionsPerWeekForInterval`
  unconditionally broke 13 existing tests, all in the same category — a target realistically
  compatible with only ONE real day per week (e.g. a single-leg-day split) was incorrectly given
  only half its full weekly figure on that one real exposure, even though it can never actually be
  trained a second time that week regardless of the textbook reference's own frequency.
- **Accepted**: dividing by `realExposureCountThisRun` — the deterministic, due-ness-independent
  count of real compatible days, capped at (never exceeding) the Blueprint frequency reference —
  correctly reproduces "one real compatible day gets the full weekly figure" while still evenly
  dividing for targets with multiple real compatible days per week.

`sessionCap` still applies as the outer per-exposure ceiling, unchanged from every prior phase's
cramming-regression guarantee: `perExposurePrescription` never exceeds one exposure's own natural
worth, regardless of how large the weekly objective is.

## Tests

`tests/engine/finalRemainingPerExposureFixRequiredTests.test.ts` adds the spec's required Tests
A, B, D, and E — each specifically designed to distinguish "weekly-reference depletion" from
"per-exposure prescription," and each verified BY REVERSION (`git stash` of `workoutBuilder.ts`
only) against the immediately prior phase's own two-tier `remainingWeeklyReference` model:

- **Test A**: a target with two real due exposures (Wednesday, Sunday) where a genuine
  progression-driven decline shrinks what Wednesday actually delivers (2 sets → 1 set, verified
  non-vacuous). Sunday's prescription is identical whether or not Wednesday's decline occurred (2
  sets either way). **Failed against the pre-fix code exactly as expected**: the old model coupled
  Sunday's size to Wednesday's actual delivery (the mutable-bucket depletion this spec targets),
  giving Sunday a DIFFERENT figure in the declined run than in the baseline run — `expected 2 to be 1`.
- **Test B**: a target whose hypothetical weekly bucket would hit EXACTLY zero after its first due
  exposure (Wednesday: 1 set, exactly exhausting a 1-set weekly reference). Sunday still receives
  its own normal per-exposure prescription (1 set), never inflated merely because a bucket would
  have reached zero. **Failed against the pre-fix code exactly as expected**: the old model's
  tier-2 branch (`sessionCap ?? fairShareWeekly`) handed Sunday the package's own 8-set reference
  once the bucket hit zero, delivering 2 sets (capped only by the single candidate exercise's own
  authored cap) instead of the correct 1 — `expected 2 to be 1`.
- **Test D**: an established target whose real weekly volume (6 sets) sits well below its Blueprint
  package reference (16 weekly / 8 per-exposure). Every real due exposure stays small and stable (2
  sets each, both real due days), never jumping toward the full per-exposure development reference
  merely because the mutable bucket was removed. Passes against both the pre-fix and fixed code
  (this specific fixture's numbers happen to be clamped by the single candidate exercise's own
  2-set authored cap under both models) — it protects an already-correct invariant this phase must
  not regress, exactly as the immediately prior phase's own Test 2 did for its own concern.
- **Test E**: two sibling targets (`mid-pec`, `upper-pec`) sharing one Blueprint package
  (`chest-efficient`, 16-set weekly reference), across a full 7-day week where one sibling now
  spans multiple real due exposures under the new stable-per-exposure model. Confirms the
  package-sharing mechanism (unchanged this phase, `plannedDirectSetsByPackage`) still bounds their
  COMBINED weekly total at exactly the package's own reference (8 + 8 = 16), never multiplied by
  either sibling's own exposure count. Passes against both pre-fix and fixed code — it protects an
  already-correct cross-target invariant this phase's per-exposure change must not disturb.

Test C (calendar position must not control exposure sizing) is satisfied by this repo's own
rewritten `tests/engine/remainingPostV2FixesRequiredTests.test.ts` §20 Test 1, which directly
asserts a target's first (Monday) and second (Thursday) real exposure this week receive the
identical stable prescription. Tests F-K are cited to their existing coverage in this file's own
header comment (the underlying frequency/history/authored-cap/time/equipment invariants this spec
confirms as correct were built and tested in earlier phases, and this phase's own full-suite run
confirms none of them regressed).

Two pre-existing tests needed recalibration for the new model (both legitimately testing the
now-superseded mutable-bucket model, not genuine regressions):

1. `tests/engine/remainingPostV2FixesRequiredTests.test.ts`'s §20 Test 1 — previously expected the
   FIRST due day to receive the full `sessionCap` (front-loaded, matching the prior phase's own
   design), rewritten to assert both due days receive the SAME stable per-exposure figure — a
   stronger, more correct test of this phase's core principle.
2. `tests/engine/strictBugFixRequiredTests.test.ts`'s "small real requirement...split honestly
   across exercises" test — its 4-day fixture gave `obliques` (compatible with every session
   purpose) `realExposureCountThisRun=2`, halving its per-exposure figure from 4 to 2 and no longer
   needing 2 exercises to hold it; the fixture was narrowed to a single compatible day
   (`realExposureCountThisRun=1`), restoring the original 4-sets-in-one-exposure scenario the test
   was designed to exercise.

Full suite: **83 test files, 771 tests, 0 failures**, including every pre-existing test (apart from
the two legitimate recalibrations above). `npm run typecheck`, `npm run build`, and `npm run verify`
all pass cleanly.

## Live verification

A disposable scratch-SQLite-DB smoke test drove the real HTTP server (`GET
/api/programming/week`) with a real active specialization goal (mid-pec, Complete package,
`sessions_per_week_reference=2`) and one real prior logged session establishing a maintained weekly
volume exactly equal to the package's own per-exposure reference (13 sets), across a real 4-day
split giving mid-pec two real due exposures (Monday=push, Friday=upper).

Rebuilding the SAME scenario against the immediately prior phase's own dist build (via `git stash`
of `workoutBuilder.ts` + rebuild, run, then restore + rebuild) for direct contrast:

| | Monday (1st real due exposure) | Friday (2nd real due exposure) |
|---|---|---|
| **Prior phase (mutable bucket)** | 5 sets | 3 sets |
| **This phase (stable prescription)** | 4 sets | 4 sets |

The prior phase's own build front-loads Monday and leaves Friday whatever remained (5 vs 3) — the
exact defect this spec targets, reproduced live through the real production code path. This phase's
fix delivers the identical, stable 4-set prescription on both real due exposures. A second
`GET /api/programming/week` re-fetch (no new actual state) reproduced the identical Friday figure,
confirming the prescription is deterministic, not a depleting run-to-run counter.

## Production Safety

- No database reset, recreation, or migration — this pass required no schema change.
- No historical workout data was altered — the live inspection used disposable scratch SQLite files
  created and destroyed in the session's own scratchpad directory, never the real database.
- No goal, Blueprint package content, or aesthetic/functional target definition was modified —
  only generation-orchestration (`workoutBuilder.ts`) changed, operating on Blueprint's existing
  data read-only.
- No systemd/nginx configuration was touched.
- No AI/LLM dependency was introduced.
- No deployment performed. Per the standing rule for this project (GitHub `main` → Oracle VM
  only, no Windows local checkout, backup DB before any live regeneration, no raw SQL against
  production), this work remains on the `workout-programmer-ui-and-equipment-filter-fix` branch,
  not merged to `main`, exactly as every prior phase in this session has done.
