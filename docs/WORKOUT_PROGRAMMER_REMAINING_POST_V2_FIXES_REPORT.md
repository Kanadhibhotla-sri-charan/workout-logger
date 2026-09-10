# Workout Programmer — Remaining Post-v2 Corrective Fixes: Implementation Report

Corresponds to `docs/WORKOUT_PROGRAMMER_REMAINING_POST_V2_FIXES.md`, implemented on the same
branch as all prior Workout Programmer work (`workout-programmer-ui-and-equipment-filter-fix`).
This spec is explicitly "remaining-issues-only": it confirms the prior two Post-v2 Corrective Fix
passes' real exposure-history/rolling-frequency/spacing model is correct and must be preserved,
and identifies the one remaining defect — `remainingWeeklySets` still acting as an authoritative
cross-day stop, the last residual piece of the calendar-week quota/debt architecture underneath
the otherwise-corrected frequency logic.

## Audit (spec §18)

Every occurrence of `remainingWeeklySets`, `desiredWeekly`, `weekly_direct_set_reference`,
`weekly_exposure_units`, `needDeficit`, `simulatedLastExposureDate`, `exposureDatesThisRun`,
`isDueToday` in `workoutBuilder.ts` was traced and classified:

- **Category A (actual state)**: `simulatedLastExposureDate`'s seed (`target.last_trained_date`)
  and `exposureDatesThisRun`'s seed (`target.recent_direct_exposure_dates`) — real logged
  history, read-only, unchanged.
- **Category B (temporary planning state)**: `simulatedLastExposureDate`/`exposureDatesThisRun`
  themselves once the day loop starts advancing them — pure per-run locals, never written back,
  confirmed unchanged and still correctly scoped (§6 of this spec — already compliant, no
  change needed).
- **Category C (development/reference data)**: `weekly_direct_set_reference`,
  `weekly_exposure_units`, `needDeficit` (via `rankTarget`, used only for processing-order
  priority, confirmed in the prior phase never to size actual volume) — untouched.
- **Category D (reporting/diagnostic data)**: `requiredDirectSetsByTarget`/`fairShareWeekly` as
  surfaced in `WeeklyPlanTargetAllocation` — untouched; `unmetDirectSets` already clamps to zero
  (`Math.max(0, required - delivered)`), so `deliveredDirectSets` legitimately exceeding
  `requiredDirectSets` (a natural outcome of this fix) was already handled correctly with no
  change needed there.
- **Category E (obsolete weekly-quota logic — removed/refactored)**: the `if (remainingWeeklySets
  <= 0) break;` outer day-loop guard, and `remainingWeeklySets`'s role as a cross-day-decrementing
  hard ceiling on `sessionRemaining` (`Math.min(remainingWeeklySets, sessionCap)`) and on the
  exercise-selection `while` loop's continuation condition. This is the one genuine defect: a
  target whose nominal weekly reference happened to be fully consumed by its FIRST real due
  exposure this run would have every SUBSEQUENT real day's due-ness never even evaluated (the
  `break` exits the whole per-target loop), silently dropping a second, genuinely due exposure
  later the same week.

## What changed

1. **Removed the outer `if (remainingWeeklySets <= 0) break;` guard entirely.** Every real day
   this target is considered on is now evaluated for due-ness — due-ness is decided purely by
   actual exposure history, frequency/cadence, and recovery, never short-circuited by a spent
   reference counter.

2. **Replaced the cross-day decrementing ceiling with a two-tier per-day sizing rule.** A new
   `remainingWeeklyReference` (seeded from `fairShareWeekly`) is still consulted for SIZING a due
   day's exposure — but only while it remains positive:
   - **While `remainingWeeklyReference > 0`**: size normally, bounded by `sessionCap` when one
     exists (`Math.min(remainingWeeklyReference, sessionCap)`). This is what keeps a
     `'maintain'`/`'introspect_needed'` target's genuinely small real established volume (e.g. 2
     sets/week) from being silently inflated to the package's full natural per-exposure figure
     (e.g. 7) on its very first real exposure — `decideVolume`'s own explicit "maintain, don't
     increase" decision is respected, not overridden by unrelated package data.
   - **Once exhausted (`remainingWeeklyReference <= 0`)**: a genuinely due day still receives its
     own natural per-exposure amount (`sessionCap`, or the reference figure itself with no better
     number) rather than nothing — the reference can run out; due-ness is never blocked by it
     (spec §9's own explicit rule, and Test 1 below).

   `remainingWeeklyReference` is allowed to run negative; it is read only as a `> 0` check, never
   compared for equality, so going negative has no special meaning beyond "already exhausted."

3. **Badminton's per-session trim moved from a one-time weekly deduction to a per-due-exposure
   one**, applied identically to every real due day's own `sessionRemaining` rather than a single
   upfront reduction to a pool that no longer exists in that form.

This design was arrived at empirically: an initial, simpler attempt (drop `remainingWeeklySets`
entirely and size every due day purely by `sessionCap`) passed the new spec's own Test 1/Test 2
but broke 10 existing tests — it silently inflated `'maintain'` targets (a real 2-set/week
target ballooning to a package's full 7-set natural exposure) and reopened the shared-package
double-counting the immediately prior phase had just fixed (two sibling targets, each now
uncapped by their own fair share once due more than once, could together exceed the shared
package's real total). A second attempt (divide the weekly reference evenly by the target's own
expected exposure count) fixed the `'maintain'` inflation but under-delivered whenever fewer real
exposures occur than the reference frequency implies (a single real weekly exposure getting only
half its natural `sessionCap`, contradicting the prior phase's own already-tested "one compatible
session per week" invariant). The two-tier design above is the first that satisfies every
existing invariant simultaneously — confirmed by the full suite passing with **zero changes to
any pre-existing test file**.

## Tests

`tests/engine/remainingPostV2FixesRequiredTests.test.ts` adds the two genuinely new required
cases from spec §20 (Tests 3–15 are cited to their existing coverage in the file's own header
comment — every one of those was already exercised by an earlier phase's tests, since the
underlying frequency/history/package/skip-scope mechanisms this spec confirms as correct were
built and tested in the two prior Post-v2 phases):

- **Test 1**: a target whose real weekly reference (`current_weekly_primary_sets` set exactly
  equal to its own `sessionCap`) is fully consumed by its first real exposure (Monday) still
  receives a real, non-empty second exposure on a later real day (Thursday) that is genuinely due
  by its own spacing/frequency state — never flagged as any kind of skip.
- **Test 2**: a fresh (zero-volume) target — the largest possible weekly deficit `decideVolume`
  can produce — trained only yesterday (short of its own real minimum spacing) remains correctly
  not-due; no catch-up exposure is generated merely because the deficit is large.

Both were verified by reversion (`git stash` of `workoutBuilder.ts` only): Test 1 failed against
the pre-fix code exactly as expected (`expected 0 to be greater than 0` — Thursday's exposure was
silently dropped by the spent-counter `break`); Test 2 passed even against the old code, confirming
it protects an already-correct invariant (large deficit alone never forces due-ness) rather than
duplicating a regression check.

Full suite: **82 test files, 767 tests, 0 failures**, including all 765 pre-existing tests
unchanged. `npm run verify` (build + typecheck + test) passes cleanly.

## Live verification

A disposable scratch-SQLite-DB smoke test drove the real HTTP server (`GET
/api/programming/week`) with a real active specialization goal (mid-pec, Complete package,
`sessions_per_week_reference=2`, `direct_sets_per_exposure=13`) and one real prior logged session
(13 sets) exactly one real week before generation. Real output:

- Monday (first real due exposure this run): 5 sets — consuming the target's full nominal
  starting weekly reference (8, since current-week primary sets are 0 as of generation time).
- Friday (a second real day, compatible with mid-pec's push/upper purposes, 4 real days after
  Monday — genuinely due by both spacing and the maximum-frequency window): **3 sets**, not
  zero — confirming live, through the real production path, that the spent weekly reference did
  not block this second genuinely due exposure.

## Production Safety

- No database reset, recreation, or migration — this pass required no schema change.
- No historical workout data was altered — the live inspection used a disposable scratch SQLite
  file created and destroyed in the session's own scratchpad directory, never the real database.
- No goal, Blueprint package content, or aesthetic/functional target definition was modified —
  only generation-orchestration (`workoutBuilder.ts`) changed, operating on Blueprint's existing
  data read-only.
- No systemd/nginx configuration was touched.
- No AI/LLM dependency was introduced.
- No deployment performed. Per the standing rule for this project (GitHub `main` → Oracle VM
  only, no Windows local checkout, backup DB before any live regeneration, no raw SQL against
  production), this work remains on the `workout-programmer-ui-and-equipment-filter-fix` branch,
  not merged to `main`, exactly as every prior phase in this session has done.
