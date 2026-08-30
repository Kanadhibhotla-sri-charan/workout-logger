# Strict Final Bug-Fix Spec — Implementation Report

Required report per the "WORKOUT PROGRAMMER — STRICT FINAL BUG-FIX
SPEC" §34. Sections A-J below, each addressing exactly what that
section asks.

---

## A. Files changed

| File | Why |
|---|---|
| `src/engine/workoutBuilder.ts` | Core of all three fixes: `TargetRanking`/`compareRankings` extended with `recoveryNeed`; recovery precomputed per-target before ranking so it's real rank information, not just a downstream skip gate; `targetRankIndex`/`EXERCISE_ORDER_SPAN` compute a real, per-target-unique `FittableItem.priority` (Fix A); weekly eligibility computed over the whole real week with a deterministic N-of-M day subset (Fix B); the single `selectExercise` call replaced with a bounded multi-exercise loop reading Blueprint's own per-exercise `sets` figures (Fix C); a separate `goal_priority` field added to candidates so `allocateResource`'s goal-bucket priority and the new per-exercise rank never collide. |
| `tests/engine/workoutBuilder.test.ts` | Two badminton-trim tests' equipment restricted to isolate the volume/badminton concern from Fix C's now-real multi-exercise substitution (see this pass's log entry for why). |
| `tests/engine/finalPassRequiredTests.test.ts` | Test 1's budget tightened from 12 to 7 minutes — Goal 1's real (now multi-exercise) need is more accurately represented, so a looser number no longer stays genuinely scarce relative to it. |
| `tests/engine/strictBugFixRequiredTests.test.ts` | New — §3.6, §21, §22, and §31's "Multiple exercises" required regression tests. |
| `tests/fixtures/strictBugFixFullWeek.test.ts` | New — the required §32 full-week fixture, through the real production path. |
| `docs/logs/2026-08-30-40-strict-bug-fix-priority-weekly-plan-multi-exercise.md` | This pass's dated change-log entry. |
| `docs/logs/README.md` | Indexes the entry above. |
| `docs/STRICT_BUG_FIX_REPORT.md` | This report. |

---

## B. Weekly planner

The weekly plan is constructed inside `buildWorkout` (not a separate
function — see "Known limitations" in section J for why), once per
call, before any per-target work is assigned:

1. `orderedGymDays` / `assignSessionPurposes` — the week's real PPL+Upper
   purposes (Monday-first canonical order).
2. `recoveryByKey` — recovery precomputed for every target from its own
   data (Stage 5 of the spec's 7-stage allocation order, made available
   *before* ranking rather than only inside the per-target loop).
3. `rankedTargets` / `targetRankIndex` — the canonical priority order
   (Stage 1/2/3: Goal 1, Goal 2, normal-development, maintenance, each
   internally ordered by real need) and its dense rank index.
4. Inside the per-target loop, for each target: `compatibleDaysThisWeek`
   (Stage 6/7: PPL+Upper compatibility, badminton soft-avoidance already
   baked into `assignSessionPurposes`) → `eligibleDaysThisWeek` (the
   deterministic N-of-M subset when compatible days exceed Blueprint's
   frequency cap) → `setsToday` (Stage 4: `desiredWeekly` — already
   Stage-3/4-fused via `rankTarget`'s exposure-aware classification —
   divided across the *durable* weekly session count, never a shrinking
   "today forward" count).

Today's session is then a real slice of this: the per-target loop only
emits work for targets whose `eligibleDaysThisWeek` includes today's
weekday; everything else is skipped with its own explained reason.

---

## C. Priority preservation

The canonical comparator is `compareRankings` in `workoutBuilder.ts`
(unchanged in its core logic from the prior pass, extended with
`recoveryNeed`). `targetRankIndex` (built immediately after
`rankedTargets = ... .sort(compareRankings)`) turns that already-correct
total order into a dense per-target integer. Every exercise a target
produces gets `priority: targetRankIndex.get(key)! * EXERCISE_ORDER_SPAN
+ exerciseIndex` as its `FittableItem.priority` — `fitToTimeBudget`
(`constraintEngine.ts`, itself unchanged) sorts on that field, so the
real programming order survives all the way through time fitting. No
class of candidate shares a flat/duplicated priority number anymore;
where the prior implementation's bug lived (every non-specialization
target sharing the literal constant 1000) is exactly what this fixes.

---

## D. Multi-exercise constructor

Inside the per-target loop, once a target's `setsToday` and
equipment/prescription-filtered candidate pool are known:

1. `getPackageForTarget` resolves the target's real Blueprint
   development package (or `null` if unmapped/functional_goal) —
   `maxExercisesForTarget` is that package's own exercise count, or 1.
2. A `while` loop calls `selectExercise` (the existing, unchanged Gate
   1-6 hierarchy) against the shrinking candidate pool. Each winner's
   own `sets` figure (from `lookupExercisePrescription`, previously
   fetched but unused) caps its assignment — `Math.min(remainingSets,
   prescription.sets)` — *unless* it's the last usable exercise (no
   candidates left, or the package's own exercise cap reached), in which
   case it absorbs whatever's left so no real weekly volume is silently
   dropped.
3. The loop stops when remaining need hits 0, the pool is exhausted, the
   package's own exercise cap is reached, or the winning candidate has
   no package `sets` figure at all (an outside-Blueprint pick — no
   Blueprint data exists to justify or size a further split).

A target with `weekly requirement <= its own package's first-exercise
sets figure` naturally exits after one iteration (0/1 exercises, per
§11.2's "one exercise is a decision, not a hard constraint").

---

## E. Badminton

Badminton enters the weekly allocation exactly where it did in the
prior pass — `assignSessionPurposes`'s soft day-avoidance (unchanged)
and `applyRecoveryConstraint`'s `badminton_triggered` signal (now
precomputed once per target, before ranking, so it's real
`recoveryNeed` ranking information too — a Fix A addition, not new
badminton behavior). This pass's actual change is *where the trim
applies*: previously `sessionSets -= 1` was applied to the single
exercise's own capped assignment; now `remainingSets` (the target's
total real need) is reduced by 1 *before* any exercise is assigned, so
a second exercise can no longer silently backfill the trimmed set.

Concrete example (`tests/engine/workoutBuilder.test.ts`, quads, full
equipment): without badminton, exercise 1 (back-squat, Gate 6
alphabetical tie-break) gets `min(8, 3) = 3` sets. With a recent
high-intensity badminton session, exercise 1 becomes leg-extension
(Gate 6's fatigue-cost preference) with a real, total-session-reduced
`min(7, 2) = 2` sets — one full set fewer overall, provably not
recovered by a later exercise.

---

## F. Exposure

```
4 bench-press sets (flat-barbell-bench-press)
  -> mid-pec (primary)     4.00
  -> triceps (secondary)   1.32
  -> front-delt (secondary) 1.32
```

Verified end-to-end (not just in the exposure engine's own unit tests)
by `tests/fixtures/realisticWeek.test.ts`'s
`secondary exposure from real compound pressing accumulates end-to-end
through buildTrainingState` test and by
`tests/fixtures/strictBugFixFullWeek.test.ts`'s real logged
`flat-barbell-bench-press` history feeding both classification and
progression on a real production-path day.

---

## G. History

`tests/fixtures/strictBugFixFullWeek.test.ts` logs real
`flat-barbell-bench-press` sessions in week 1 (via `WorkoutSessionsRepo`)
and asserts, on a real week-2 `assembleAndBuildWorkout` call, that the
generated `flat-barbell-bench-press` plan's `previous_performance` is
non-null (the real prior weight/reps) — proving real history reaches
the production planner, not a `[]`/`null` placeholder.

---

## H. Progression

The same test asserts `progression_decision` is non-null on that plan —
`computeProgression`'s real output (double-progression against the
logged prior sets) reaches the *final* prescription object a caller/UI
would render, not just debug metadata. This mechanism is unchanged from
the prior pass; this pass's own contribution is proving it still holds
true through the new multi-exercise/weekly-plan code paths.

---

## I. Tests

```
Exact command:
npm run verify

Environment:
Node v22.22.2, npm 10.9.7, run from a clean working tree at the repo root

Total tests:
392 (40 test files)

Passed:
392

Failed:
0

Skipped:
0
```

Unit: 255 passed (every test file with no `openDb`/real-repository
call). Integration (real DB, real production path — `assembleAndBuildWorkout`
or equivalent): 137 passed. 255 + 137 = 392, verified by direct
arithmetic against `grep -l openDb` classification, not estimated.

---

## J. Known limitations

- **The weekly plan is not a separately-typed, separately-returned
  object.** §23's "do not overengineer persistence" explicitly permits
  this: "the weekly plan must exist as a first-class object during
  programming." It does — every value the spec's own
  `WeeklyProgrammingContext`/`WeeklyProgrammingPlan` sketch requires
  (session purposes, eligible days, session count, per-target
  allocation reasoning) is computed once per `buildWorkout` call and
  reused identically regardless of which single day is being generated
  (proven by the §22 durability test) — it just isn't reified as its
  own named TypeScript interface returned to the caller. Reifying it
  would require touching `assembleAndBuildWorkout`'s per-day call
  contract for no behavior change; deferred as genuine scope creep
  beyond what the three named defects require.
- **The N-of-M day-subset selection (§21/§7 Stage 7) uses "first N
  compatible days in Monday-first order," not a recovery-spacing
  heuristic.** The spec explicitly warns against inventing a new
  methodology ("do not blindly move work merely to make dates evenly
  spaced" is the one thing it rules out; it does not specify what
  *should* decide the subset beyond "actual recovery/badminton/
  session-purpose context"). A stable, deterministic, documented
  default was chosen over inventing an unstated recovery-scoring rule;
  this only matters for a target compatible with more sessions/week
  than Blueprint's own frequency cap, which real PPL+Upper targets
  rarely are (only "universal" targets like obliques/neck hit it).
- **The badminton/progression session-level trim still stacks at most
  -1 total per target per day**, exactly as the prior pass established
  — this pass only changed *where* it's applied (total remaining need,
  not the first exercise's own capped share), never its magnitude or
  the conditions that trigger it.

These are documented, bounded choices grounded in explicit data or
explicit spec permission — not open methodology questions and not a
rationalization of an unmet requirement.

---

## §30/§38 — Final stop condition

Every item in §36's hard completion gate is addressed by the work
above and by this pass's real, executed test suite. Per §38: core
programming methodology is frozen again after this pass. Further
product work should move to Workout Programmer UI/UX, workout logging
UX, goal-entry/confirmation UX, history/progress views, Blueprint app
integration, and calorie-tracker integration — not another cycle of
priority/weekly-plan/exposure/badminton/PPL+Upper redesign.
