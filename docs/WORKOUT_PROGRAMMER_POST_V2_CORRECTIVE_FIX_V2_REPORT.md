# Workout Programmer — Post-v2 Corrective Fix v2: Implementation Report

Corresponds to `docs/WORKOUT_PROGRAMMER_POST_V2_CORRECTIVE_FIX_V2.md`, implemented on the same
branch as all prior Workout Programmer work (`workout-programmer-ui-and-equipment-filter-fix`).
This spec explicitly preserved the prior Post-v2 Corrective Fix's real exposure-cycle model
(actual dates, never calendar-week debt) while identifying two deeper problems that model still
had: minimum spacing alone is not a complete frequency gate, and a Blueprint development package
shared by several distinct target_ids was being duplicated in full to each of them.

## What changed

### 1. Frequency is no longer minimum spacing alone (§3/§4/§6/§7)

`ExposureCycleDecision` previously decided `is_due_today` from a single condition:
`daysSinceLastExposure >= expectedExposureIntervalDays`. That is a necessary MINIMUM-spacing
floor, but the spec's own worked example shows it is not sufficient: a 2×/week target trained
Monday and Thursday, with minimum spacing alone as the gate, would also accept a third exposure
on Sunday (3 real days after Thursday) — three exposures inside one 7-day span for a 2/week
target.

A second, independent gate has been added: `actual_exposure_count_in_reference_window` counts
how many real (plus already-placed-this-run) direct exposures fall within a trailing
`FREQUENCY_REFERENCE_WINDOW_DAYS`-day (7-day) window ending on the day being considered, compared
against the target's own `frequency_reference_per_week`. `is_due_today` now requires **both**
gates to pass. `TargetBuildContext` gained an optional `recent_direct_exposure_dates` field (real
dates, deduped, primary-role only — a new `role` field on `TargetTouch` distinguishes primary
from secondary-role touches so compound overlap from a different exercise never inflates this
count) populated by `assembleWeeklyPlanInput` from real logged history; it defaults to
`last_trained_date` alone (or `[]`) when omitted, so every existing test fixture that only ever
tracked a single most-recent date keeps its exact prior behavior unless it opts in.

This also directly implements spec §5's own explicit rule that a target already adequately
exposed right before a calendar boundary must not automatically become due the instant the new
week starts — the window naturally spans the boundary, since it is a real trailing window, never
aligned to Monday.

### 2. A shared development package's aggregate is no longer duplicated per target (§12/§13)

Audited Blueprint's own package data directly: several muscle groups (chest, shoulders, back,
biceps, triceps, forearms, glutes, calves, core) group **multiple distinct target_ids** under one
combined package (e.g. `chest-efficient` covers `upper-pec`, `mid-pec`, and `lower-pec` together
with one shared exercise list). `getDevelopmentReference` is looked up per target_id but returns
the exact same `weekly_direct_set_reference` for every target sharing that package — and nothing
prevented each of those targets from independently treating that number as its own complete
weekly objective. In the common case (no goal touching that muscle group, all its targets
programmed as `normal_development`), this meant a package's real intended total could be
delivered up to 3× over.

A new per-run accumulator, `plannedDirectSetsByPackage`, tracks real delivered direct sets keyed
by `package_id`. Before computing a target's own weekly allocation, its remaining fair share of
the package's budget is checked; if a higher-priority sibling has already claimed the whole
budget, the target is skipped with the existing `adequately_covered` reason (a new, honest reason
string identifying the shared package), and otherwise its own allocation is capped at whatever
genuinely remains.

This is deliberately scoped narrow: the cap only ever applies when a target's own recommended
figure IS the package's own baseline starting recommendation (`current_weekly_primary_sets === 0`
and `decideVolume`'s zero-branch, `action: 'increase'`) — never when a target already has real,
actively maintained volume from genuine training history (`decideVolume`'s `'maintain'` outcome
always returns the user's own `current_weekly_primary_sets`, which must never be suppressed just
because it happens to exceed a package's baseline reference; spec §11's "never an exact workout
template" applies here). The first version of this fix, before this distinction was added,
incorrectly suppressed a single target's own real high-maintained volume down to its package's
baseline — caught by the existing `onePassDevSpecV2RequiredTests.test.ts` cramming-regression
test failing, and fixed before being considered complete (see Errors below).

### Everything else audited and confirmed compliant, unchanged

- **Planned vs. actual exposure (§8)**: `simulatedLastExposureDate`/the new per-run exposure-date
  list are local variables inside `buildWeeklyProgrammingPlan`'s per-target loop only — nothing
  here writes to the database, mutates `target`, or persists across calls.
  `assembleWeeklyPlanInput` always re-reads real DB state fresh; a repeat call with unchanged
  data reproduces byte-identical output (existing test), so an uncompleted projected exposure can
  never leak into a later call's own "actual" state.
- **Actual training drives future programming (§22)**: unchanged — `exposureEngine` +
  `weekProgramReconciliation` + real completed session data remain the sole path; no second
  manual programmer-exposure history was introduced.
- **Reconciliation safety (§23)**: unchanged — completed/locked-session protection lives entirely
  in `weekProgramReconciliation.ts`, untouched by this pass.
- **Ranking (§21)**: `rankTarget`'s `needDeficit` (from `weekly_direct_set_reference` vs.
  `weekly_exposure_units`) only ever affects processing ORDER/priority among targets, never
  volume amount — it cannot create catch-up debt, since the actual weekly figure a target
  receives is still decided solely by `decideVolume`/the package-sharing cap above. No change
  needed.
- **Development references remain references, never exact templates (§11)**: confirmed — no
  generic 75–80% fallback exists anywhere in `developmentReferenceEngine.ts`; `decideVolume`'s
  `'maintain'` path already never overrides real user data with a package number.
- **Package aggregate vs. per-exposure vs. exercise-level vs. actual (§12/§13)**: the
  four-layer separation from prior specs remains intact; this pass adds the missing cross-target
  sharing layer on top without collapsing any of the four.
- **Blueprint exercise validity, candidate vs. selected, time/equipment invariance, skip scope,
  completed/locked protection**: all previously fixed and re-confirmed green by the full test
  suite; no regressions.

## Errors and fixes (found during this pass)

- **Package-sharing cap too broad.** The first implementation computed
  `packageRemainingBudget = packageWeeklyReference - alreadyClaimed` unconditionally, which caps
  EVERY target sharing a package at that package's own weekly reference even with zero real
  siblings present — incorrectly suppressing `onePassDevSpecV2RequiredTests.test.ts`'s own
  cramming-regression fixture (a single `triceps` target deliberately maintaining
  `sessionCap * 3` real sets, no sibling in that fixture at all) down to the package's much
  smaller baseline. Root cause: conflating "this package's baseline recommendation" with "this
  target's own real requirement." Fixed by scoping the cap to apply only when the target's own
  figure IS the package-derived zero-volume starting recommendation, never a genuinely maintained
  real volume — see design section above.
- **Frequency window seeded from real history, not reset per run.** Verified via reversion that
  seeding the window purely from real logged history (not resetting to empty each run) is both
  what the spec's §5 explicitly requires (no artificial due-ness the instant a new week starts
  after real over-training right before the boundary) and what a live smoke test and the existing
  `realisticWeek.test.ts` fixture's real logged data (4 real direct chest exposures in one week,
  deliberately exceeding the 2/week reference, to also exercise secondary-exposure accumulation)
  actually produces: the following week's Monday is correctly not-yet-due, with the target
  resuming on the next real day whose own trailing window has genuinely cleared (Friday, per
  direct calculation and confirmed by a scratch script). `tests/fixtures/realisticWeek.test.ts`'s
  one affected assertion — which hardcoded "goal 1 must appear specifically on Monday of week
  2," a calendar-week assumption this exact spec supersedes — was updated to check presence
  across the whole week instead, preserving its real invariant (goal 1 is never starved) without
  assuming a specific day the new, more correct frequency model legitimately overrides.

## Tests

`tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts` adds the four genuinely new required
cases from spec §24 not already covered by the existing suite (D/E/F/H/I/J/K/M/N are cited to
their existing coverage in the file's own header comment):

- **§24.A/§24.G**: a 2/week target trained Monday and Thursday never receives a third exposure on
  Sunday despite minimum spacing alone allowing it; exactly two exposures' worth is delivered,
  with the remainder honestly left for a later, genuinely appropriate day.
- **§24.B**: three separate real calendar weeks, each with only Thursday available, each produce
  exactly one honest exposure — never crammed, never doubled, never carrying debt forward.
- **§24.C**: an exposure on the last real day of one calendar week is read as real, dated history
  (not "never trained") the very next calendar day, across the week boundary.
- **§24.L**: three real sibling chest targets sharing one Blueprint package never combine to
  exceed that package's own real weekly reference, with a sibling target's deferral now carrying
  an honest, structured reason; a second test in the same block confirms a target's own real
  maintained volume is never suppressed by this cap when no sibling is present.

All five new tests were verified by reversion (`git stash` of `workoutBuilder.ts` and
`friendlyExplanation.ts` only, tests kept) — the two tests directly exercising the new mechanisms
(§24.A/G and §24.L) failed against the pre-fix code exactly as expected before the fix was
restored; the other three passed even against the reverted code, confirming they exercise
already-correct continuity/debt behavior from the prior phase rather than duplicating a
regression check.

Full suite: **81 test files, 765 tests, 0 failures.** `npm run verify` (build + typecheck + test)
passes cleanly.

## Live verification

A disposable scratch-SQLite-DB smoke test drove the real HTTP server
(`GET /api/programming/week`) with a training profile carrying **no active goals at all** — the
real-world default case where every physique target, including all three chest sub-regions, is
programmed purely as `normal_development`. Real output:

- `upper-pec`: 0 sets, `mid-pec`: 8 sets, `lower-pec`: 8 sets — combined 16, exactly matching
  `chest-efficient`'s own real 16-set weekly reference, never the 24 a naive per-target
  duplication would have produced.
- `upper-pec` carries an honest `adequately_covered` skip explicitly naming the shared
  `chest-efficient` package and stating its budget was already claimed by higher-priority
  sibling targets this run.

## Production Safety

- No database reset, recreation, or migration — this pass required no schema change.
- No historical workout data was altered — the live inspection used a disposable scratch SQLite
  file created and destroyed in the session's own scratchpad directory, never the real database.
- No goal, Blueprint package content, or aesthetic/functional target definition was modified —
  only generation-orchestration (`workoutBuilder.ts`) and presentation-layer code
  (`friendlyExplanation.ts`) changed; both operate on Blueprint's existing data read-only.
- No systemd/nginx configuration was touched.
- No AI/LLM dependency was introduced.
- No deployment performed. Per the standing rule for this project (GitHub `main` → Oracle VM
  only, no Windows local checkout, backup DB before any live regeneration, no raw SQL against
  production), this work remains on the `workout-programmer-ui-and-equipment-filter-fix` branch,
  not merged to `main`, exactly as every prior phase in this session has done.
