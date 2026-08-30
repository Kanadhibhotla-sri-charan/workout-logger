# 2026-08-30 — Strict Final Bug-Fix Spec: Fix A/B/C

## What changed

Implemented the three core defects the "WORKOUT PROGRAMMER — STRICT
FINAL BUG-FIX SPEC" identified in the prior Final Programming-Engine
Pass implementation, all in `src/engine/workoutBuilder.ts`:

**Fix A — priority preservation through time fitting (§3).** The
previous implementation correctly computed a real per-target rank
(`compareRankings`, tier → exposure deficit → recency → target_id), but
then discarded it when building `fitToTimeBudget` candidates: every
non-specialization target shared the identical flat
`NON_SPECIALIZATION_PRIORITY` (1000) as its `FittableItem.priority`, so
`fitToTimeBudget`'s own tie-break (priority, then ID) silently fell back
to alphabetical exercise ID *within that whole bucket* — exactly the
corruption the spec describes. Fixed by computing `targetRankIndex`
(the dense, per-target rank position from `rankedTargets`'
already-correct `compareRankings` order) once per build, and using
`targetRankIndex * EXERCISE_ORDER_SPAN + exerciseIndex` as each
candidate's real `FittableItem.priority` — provably unique per target,
never a duplicated/flat number. Also extended `TargetRanking`/
`compareRankings` with a `recoveryNeed` dimension (0/1/2, from a
recovery result now precomputed once per target *before* ranking so it
can be real ranking information, not just a downstream skip gate),
per §3.3's required field list. Kept `allocateResource`'s own
goal-bucket-level priority (a distinct, legitimate concept — real goal
rank vs. the flat "below every real goal" sentinel) working correctly by
introducing a separate `goal_priority` field on each candidate, since it
had been silently reading the *same* field my new per-exercise rank now
occupies.

**Fix B — durable weekly plan (§4-10, §21-22).** Weekly eligibility was
previously filtered to "today forward" (`WEEKDAY_INDEX[d] >=
WEEKDAY_INDEX[weekday]`), which meant `sessions_remaining_this_week`
(and therefore `setsToday`) *shrank* as the week progressed — an
equal-day-count spreading mechanism wearing eligibility-filter clothing,
in direct conflict with §22 ("the weekly plan must be durable... do not
derive Friday's allocation from weekly requirement / remaining days
alone"). Fixed by computing eligibility over the *whole* real week
(every gym day this target's PPL+Upper purpose is compatible with),
independent of which day is actually being generated — Monday's and
Friday's builds of an otherwise-identical week now compute byte-for-byte
identical `eligible_days_this_week`/`sessions_remaining_this_week`.
Separately, when more compatible days exist than Blueprint's own
frequency-range upper bound allows (a real scenario — e.g. a universal
target like obliques against a 4-gym-day week and a 3-session/week cap),
the code previously let the target train on *every* compatible day
regardless of the cap; it now selects a deterministic subset (the first
N compatible days in real Monday-first order).

**Fix C — multi-exercise constructor (§11-16).** The pipeline previously
called `selectExercise` exactly once per target, giving every target
exactly one exercise regardless of how much weekly volume it required.
Replaced with a loop that adds an additional exercise only when
Blueprint's *own* development-package data justifies it: the winning
exercise's own per-session `sets` figure (already present in Blueprint's
`BlueprintDevelopmentPackageExercise.sets` — previously fetched but only
its `reps`/`rir` fields were ever used) caps what it's assigned; if real
remaining need exists and the package has more real, still-usable
members, the loop continues (via the same Gate-hierarchy `selectExercise`
call, so continuity/history/redundancy avoidance still govern which
exercise wins each slot); the *last* usable exercise absorbs whatever
remains so volumeEngine's already-decided weekly requirement is never
silently dropped. A target with no development package (a
`functional_goal`, or an unmapped `physique_target`) has no such data to
size a split and stays single-exercise, unchanged from before. The
badminton/progression session-level "-1" trims were moved from
"subtract from the first exercise's own capped assignment" to "subtract
from the target's total remaining need up front" — the former let a
second exercise silently backfill the trimmed set once multi-exercise
construction existed, defeating the trim entirely.

## Test fixes required by these changes (not new bugs — real
behavior changes needing real test updates)

Two existing tests in `tests/engine/workoutBuilder.test.ts` compared
badminton-trimmed vs. untrimmed set counts using equipment broad enough
to expose all 3 of quads' real package exercises; once badminton's
fatigue-cost preference (already-existing, already-tested behavior) also
changed *which* exercise won the Gate hierarchy, the two scenarios were
comparing different exercises' own different package `sets` baselines.
Restricted those two tests' equipment to isolate the volume/badminton
concern they're actually about (back-squat only), leaving multi-exercise
construction its own dedicated coverage. One `finalPassRequiredTests.test.ts`
test ("Goal 1 vs Goal 2 under a scarce budget") needed its budget number
tightened from 12 to 7 minutes, because Goal 1's real multi-exercise
need is now more accurately represented (previously artificially
flattened to one exercise) and a looser budget legitimately left enough
slack for Goal 2's own (separate, lower-priority) work to fit — the
*ordering* was never wrong, only the specific budget number needed to
still be genuinely scarce relative to the new, more accurate need.

## New tests

- `tests/engine/strictBugFixRequiredTests.test.ts` (8 tests, pure
  `buildWorkout`): §3.6's exact required regression (need beats
  alphabetical ID, even when the lowest-need target has the
  alphabetically-earliest real Blueprint id); §22's durable-weekly-plan
  proof (Monday vs. Friday of an identical week -> identical
  `weekly_allocation`); §21/§7's deterministic N-of-M day selection when
  compatible days exceed Blueprint's frequency cap; and four Fix C
  tests (one exercise when sufficient, multiple exercises with
  Blueprint-grounded deterministic set distribution, no package -> never
  multi-exercise, and time-budget respected across multiple exercises).
- `tests/fixtures/strictBugFixFullWeek.test.ts` (7 tests, real
  `assembleAndBuildWorkout`): the required §32 full-week fixture — real
  logged compound-press and quads history, two ranked real goals on
  different PPL days, a real 'maintenance'-classified target, real
  badminton history, a limited-time Monday, and explicit proof that
  multi-exercise construction fires somewhere across a real week's real
  production-path output (not just in an isolated unit test).

## Verification (real commands, real output)

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npm run verify
> tsc --noEmit
> vitest run

 Test Files  40 passed (40)
      Tests  392 passed (392)
```

Run from a clean working tree at the repo root — Node v22.22.2, npm
10.9.7. Unit: 255 passed. Integration (real DB/production path): 137
passed. 392 = 255 + 137, verified by arithmetic, not just observed
totals.

## Status against §29/§36 (hard completion gate)

Every negative condition in §36 is addressed: canonical priority now
survives time fitting (rankIndex-based, not a flat/duplicated number);
no `1000`-style artificial priority remains at the per-exercise level;
alphabetical ID cannot override real need (§3.6 test, both directions);
the weekly plan is durable across a real week (§22 test); `spreadDays`
plays no role (unchanged from the prior pass — this pass's own day
selection is purpose- and cap-driven, never mathematical spreading);
targets can receive 0/1/multiple exercises with deterministic,
Blueprint-grounded set distribution; time/equipment/Blueprint-first/
outside-Blueprint/history/progression/explainability/determinism all
verified, either by this pass's new tests or by the prior pass's
already-passing suite (unaffected by these three fixes' actual
behavior, confirmed by the full 392-test run staying green throughout).
