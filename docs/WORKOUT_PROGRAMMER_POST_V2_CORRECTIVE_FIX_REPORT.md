# Workout Programmer — Post-v2 Corrective Fix: Implementation Report

Corresponds to `docs/WORKOUT_PROGRAMMER_POST_V2_CORRECTIVE_FIX.md`, implemented on the same
branch as all prior Workout Programmer work (`workout-programmer-ui-and-equipment-filter-fix`).
This spec explicitly superseded the prior One-Pass Dev Spec v2 implementation, confirming that
spec's own fixes (equipment/time filtering removed, authored-set caps respected, package
membership no longer a pre-ranking gate, structured reason codes, contradictory-state guard) as
correct and required to be preserved, while identifying one deeper unfixed problem: the
programmer was still allocating target work **inside a calendar-week state machine** — a
precomputed `eligibleDaysThisWeek`/`remainingWeeklySets` allocation, recomputed from scratch at
every Monday boundary, rather than a genuine rolling exposure-due-ness model keyed off real
dates.

## What changed

### The core model replacement

`workoutBuilder.ts`'s per-target day-construction loop previously precomputed, once per target
per run, the list of "eligible days this week" and a `sessionsRemainingThisWeek` count, then
spread `remainingWeeklySets` across that fixed list — a real calendar week (Monday–Sunday) as
the authoritative container for how many real exposures a target could have, with a
`sessionCap` guard (from the prior spec's own fix) only bounding how much of that weekly total
any ONE day could absorb.

This has been replaced with a genuine **exposure-cycle due-ness model**, computed fresh for
every real day the run considers:

- `expectedExposureIntervalDays = max(1, floor(7 / sessionsPerWeekForInterval))` — the target's
  own real minimum spacing between exposures (a *minimum*, not a rounded average: `floor`, not
  `round`, so a textbook 2×/week Monday+Thursday gap of 3 real days is correctly recognized as
  due, not rejected as "one day too early").
- `daysSinceLastExposure`, computed from the target's own **actual** last-trained date — real
  logged history for the first day of a run, and a `simulatedLastExposureDate` that advances
  only when a real placement happens later within the *same* run (so a Monday exposure this run
  correctly becomes "last exposure" for a Friday due-ness check within that same run — the
  model reasons about real dates, never a recomputed "days left this week" count).
- `isDueToday = daysSinceLastExposure === null || daysSinceLastExposure >= expectedExposureIntervalDays`.

Crucially, this due-ness check is **never reset by a calendar-week boundary** — `weekStart`
plays no role in it whatsoever. A target trainable on only one real day in week 1 gets exactly
one exposure there; its next exposure happens on whichever real day, in whichever week, first
satisfies its own real interval — never crammed earlier, never silently doubled later.

### Removed entirely

The `compatibleDaysThisWeek` / `sessionsRemainingThisWeek` / `eligibleDaysThisWeek` /
`weeklyAllocation` precomputation block, and the `isLastDay`/`else` two-branch day-construction
split it drove (only "the last eligible day this week" used multi-exercise construction; every
other day got exactly one exercise, an artifact of the old model). Under the new model, **every
real day that clears the due-ness gate** uses the same multi-exercise-bounded-by-`sessionCap`
construction, since each due day is its own complete, independent real exposure — not "the
week's last chance to deliver a remainder." (This is a real behavioral change, not a
side-effect: several existing tests hardcoded the old "only the last day gets more than one
exercise" assumption and needed recalibrating — see below.)

The `sessionCap = developmentReference?.direct_sets_per_exposure` guard from the prior spec's
fix is preserved as-is (it still bounds any single day's total for a target); this pass adds the
missing piece the prior spec's own comment already predicted would still be needed: *when* a day
is even eligible to receive an exposure at all is no longer a weekly list membership question,
it's a real per-day due-ness check.

### Vocabulary changes (spec §21/§22)

- `WeeklyAllocationDecision` → `ExposureCycleDecision`: `{ session_purpose_today,
  compatible_today, last_exposure_date, days_since_last_exposure,
  expected_exposure_interval_days, is_due_today, reasoning }`, computed fresh per real day
  rather than once per target for "the whole week."
- `SkippedTarget.scope: 'week' | 'session'` → `'exposure' | 'data_integrity' | 'session'`.
  `'exposure'` is a decision that recurs identically regardless of which day within the run is
  asked (recovery-avoid, adequately-covered, no-volume-recommended, not-due-for-this-exposure);
  `'data_integrity'` is a genuine Blueprint data defect discovered only after a real due day was
  actually attempted; `'session'` remains reserved (no day-specific skip mechanism exists).
- `DecisionExplanation.weekly_allocation` → `exposure_decision`.
- The `not_current_exposure` friendly explanation no longer says "not part of this week's
  exposure cycle" — it now reads *"X isn't due for this exposure yet — it was trained directly
  on \<real date\>. It remains available for the next appropriate target-training session."*
  (or, when no prior exposure is known, the equivalent without a fabricated date). No "this
  week" framing survives anywhere in this string.

## Audit findings

Per spec §37, every calendar-week-shaped entry point was traced before editing:

- `trainingState.ts`'s `weekly_exposure`/`rolling_exposure` — confirmed to be legitimate
  calendar-week/rolling **reporting** windows, recomputed fresh from real logged sessions on
  every call, never accumulated as programming "debt" state. Spec §8 explicitly allows calendar
  weeks as reporting/persistence containers; no change needed.
- `assembleWeeklyPlanInput`'s `days_since_target_last_trained`/`last_trained_date` (via
  `daysBetween(mostRecentTouch.date, date)`) — already genuinely actual-date-based, and reused
  as-is as the raw material for the new due-ness gate; no new data plumbing required.
- `exerciseSelector.ts`'s candidate universe — already the full Blueprint exercise library,
  never package-filtered; already compliant.
- `developmentReferenceEngine.ts`'s `direct_sets_per_exposure`/`sessions_per_week_reference` —
  added in the prior spec, reused unchanged as the exact reference values this pass's interval
  formula needs.

The one substantive defect found and fixed *during* implementation (not present in the spec's
own text, discovered via the first full test run): the interval formula was initially written
as `Math.round(7 / sessionsPerWeekForInterval)`, which for a 2×/week target computes 4 —
incorrectly judging a real, textbook-correct Monday+Thursday 3-day gap as "not yet due."
Corrected to `Math.floor`, treating the interval as a **minimum** real spacing rather than a
rounded average.

## Tests

Recalibration of the existing suite followed spec §38's explicit instruction: keep tests that
protect a real invariant, update tests that merely snapshotted the now-removed
"only the last eligible day may use multiple exercises" implementation detail. Every
recalibrated/rewritten test was verified by reversion (`git stash` of `workoutBuilder.ts` and
`friendlyExplanation.ts` only, tests kept) to confirm it actually fails against the pre-fix
code — all 8 rewritten tests failed as expected against the old implementation before the fix
was restored.

- `tests/engine/strictBugFixRequiredTests.test.ts` — new "Post-v2 Corrective Fix §22/§29"
  durability test: generating Monday and Friday of the identical week from identical stored
  state computes consistent real `expected_exposure_interval_days`/`last_exposure_date`/
  `days_since_last_exposure`/`is_due_today` facts, including Friday correctly reconstructing
  Monday's own same-run placement as its real last exposure. The pre-existing
  "unmapped physique_target never receives more than one exercise" test's premise was already
  stale (`obliques` does have a real Blueprint package); rewritten to check the real invariant —
  a small real requirement legitimately spans multiple exercises when no single exercise's own
  authored cap can hold it alone, with the total delivered never exceeding the real requirement.
- `tests/engine/workoutBuilder.test.ts` — 4 tests that assumed exactly one exercise for a
  specialization target recalibrated to assert on real per-target invariants (every placed
  exercise is genuine Blueprint data, authored caps respected, the specific continuing/current
  exercise is present) rather than a fixed exercise count, since a due exposure legitimately
  spanning 2 real exercises (each within its own smaller authored cap) to reach its natural
  per-exposure amount is correct under this model, not a regression.
- `tests/engine/consolidatedFixRequiredTests.test.ts` / `tests/engine/onePassDevSpecV2RequiredTests.test.ts`
  — `scope` assertions updated from the old binary `'week'` to the new `'data_integrity'` /
  `'exposure'` values respectively, matching each skip's real nature.
- `tests/friendlyExplanation.test.ts` — the `not_current_exposure` wording test rewritten to
  assert the new phrasing and the explicit absence of "this week"; a new test confirms the real
  last-exposure date is cited when the engine knows it, never fabricated.
- `tests/engine/assembleAndBuildWorkout.test.ts` / `tests/fixtures/strictBugFixFullWeek.test.ts`
  — two stale `estimated_minutes <= N` assertions (a pre-existing category of stale
  time-invariant assertion from earlier phases; time has zero effect on what's programmed)
  replaced with the established "no skip mentions time-fitting" check.

Full suite: **80 test files, 760 tests, 0 failures.** `npm run verify` (build + typecheck +
test) passes cleanly.

## Live verification

A disposable scratch-SQLite-DB smoke test drove the real HTTP server (`/api/programming/week`,
`/api/workouts`, `/api/workouts/:id/exercises`, `/api/workouts/:id` PATCH) end to end, per this
session's established pattern, to demonstrate the spec's own worked example concretely: a
training profile with **only Monday** as a real training day (so a 2×/week-reference target like
`mid-pec` can only ever be trained on that one real day per week).

- Week 1 Monday (2026-08-31): `mid-pec` — never trained before — is due, and receives one real
  exposure (`cable-fly` × 2, `flat-barbell-bench-press` × 3 = 5 sets). This was logged as a real
  completed workout session through the actual API.
- Week 2 Monday (2026-09-07) — 7 real days later, comfortably past the target's own
  `floor(7/2)=3`-day interval, and a full calendar week after the first exposure: `mid-pec` is
  due again and receives **the same 5-set exposure**, not an inflated one "making up" for week
  1's absent second eligible day, and not silently withheld for having crossed a Monday
  boundary.
- The underlying `exposure_decision` for the week-2 placement carries the real facts:
  `last_exposure_date: "2026-08-31"`, `days_since_last_exposure: 7`,
  `expected_exposure_interval_days: 3` — computed from the actual logged session date, never a
  recomputed "eligible days this week" list.

This confirms the calendar week has been fully demoted to a reporting/generation-window
convenience with no bearing on due-ness, exactly as spec §5/§8/§9 require.

## Anti-workaround checklist (spec's own list)

- `remainingWeeklySets`/`sessionCap` variable names unchanged in meaning (sessionCap still
  bounds one day's total; nothing renamed to obscure the fix) — the actual due-ness gate that
  determines whether a day is eligible AT ALL is the new mechanism, not a rename of the old one.
- No exercise-specific caps added; the existing generic authored-cap mechanism from prior specs
  is untouched and still the only per-exercise ceiling.
- No test weakened to preserve old (calendar-week) behavior — every changed assertion now
  checks a real invariant (authored caps, total delivered, real dates) rather than a fixed
  exercise/day count carried over from the old model.
- `not_current_exposure` wording contains no "this week"/"exposure cycle" framing, verified by
  an explicit substring-absence assertion in the test suite.
- `scope` uses the richer `exposure | data_integrity | session` vocabulary, not a renamed binary.

## Production Safety

- No database reset, recreation, or migration — this pass required no schema change.
- No historical workout data was altered — the live cross-week inspection used a disposable
  scratch SQLite file created and destroyed in the session's own scratchpad directory, never the
  real database.
- No goal, Blueprint package content, or aesthetic/functional target definition was modified —
  only generation-orchestration (`workoutBuilder.ts`) and presentation-layer code
  (`friendlyExplanation.ts`) changed; both operate on Blueprint's existing data read-only.
- No systemd/nginx configuration was touched.
- No AI/LLM dependency was introduced.
- No deployment performed. Per the standing rule for this project (GitHub `main` → Oracle VM
  only, no Windows local checkout, backup DB before any live regeneration, no raw SQL against
  production), this work remains on the `workout-programmer-ui-and-equipment-filter-fix` branch,
  not merged to `main`, exactly as every prior phase in this session has done.
