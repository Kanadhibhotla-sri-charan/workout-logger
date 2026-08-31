# 2026-09-01 — Final Core-Engine Surgical Fix Pass: Fix A/B/C/D

## What changed

Implemented the "FINAL CORE-ENGINE SURGICAL FIX PASS — Fix A/B/C + Reproducible
Verification" specification's four required fixes, all in
`src/engine/workoutBuilder.ts`. This is a narrow correction pass against
the `buildWeeklyProgrammingPlan` architecture from the prior "Final
Surgical Fix Pass" — no methodology, goal priority, exposure model, or
Blueprint-first selection was touched.

### Fix A — final fitted sessions are now the sole source of `targetAllocations`

`targetAllocations` was previously accumulated during raw, pre-fitting
per-target construction, so it could show a number (e.g. "6 sets
planned") that contradicted what actually survived into
`sessions[].plannedWork` after resource/time fitting ran (e.g. only 3
sets actually placed). Construction now only records the two pieces of
information the final sessions genuinely can't recover on their own —
`requiredDirectSetsByTarget` (what programming decided was desirable,
captured once) and `classificationByTarget` (this target's live
layer) — in two `Map`s. A new function,
`rebuildTargetAllocationsFromFinalSessions(sessions,
requiredDirectSetsByTarget, classificationByTarget)`, is now the ONLY
place `WeeklyPlanTargetAllocation[]` is ever produced, called once at
the very end of `buildWeeklyProgrammingPlan` after every session has
already been through resource allocation and `fitToTimeBudget`. It sums
`deliveredDirectSets`/`plannedPrimaryExposure`/`plannedSecondaryExposure`/
`allocatedSessionDates` straight from whichever `plannedWork` items
actually survived, and fills in an explicit zero-delivery entry for any
target that had a real requirement but ended up with nothing (dropped
entirely by fitting, or no feasible/prescribed candidate at all) — so an
unmet requirement is never silently invisible.

`WeeklyPlanTargetAllocation.plannedDirectSets` (one field asked to mean
two different things) is now three distinctly-named fields:
`requiredDirectSets`, `deliveredDirectSets`, `unmetDirectSets` (=
`requiredDirectSets - deliveredDirectSets`, never negative).
`PlannedWorkItem` gained `primary_exposure`/`secondary_exposure` — one
placed exercise's own real contribution to its own target — so the
rebuild can sum real exposure straight from what survived, never from a
pre-fitting running total.

### Fix B — only delivered sets are ever charged against remaining weekly need

Both day-construction branches (the last-eligible-day multi-exercise
loop and the single-exercise branch for every other eligible day)
previously did `remainingWeeklySets -= naturalSets` — charging the full,
pre-reduction natural cap even when a progression-driven "reduce"
delivered one fewer set than that. An undelivered set was never actually
placed, so charging for it meant silently writing off real weekly volume
that should have stayed available for a later session to genuinely
deliver. Both branches now compute `requested` (the natural,
pre-reduction cap) and `delivered` (`requested`, or `max(1, requested -
1)` when this is the very first exercise placed for the target and its
own progression decision is `'reduce'`), then `remainingWeeklySets -=
delivered`. `finalizePlacement` takes a new `requested` parameter (used
only for the reasoning text's explicit "requested X, delivered Y"
clause when they differ) and always books the real `delivered` amount
everywhere else — the existing day-by-day distribution mechanism itself
is untouched.

### Fix C — Blueprint package exercise count is no longer the hard ceiling

`maxExercisesForTarget = Math.max(1, packageForTarget?.exercises.length
?? 1)` previously bounded the last-eligible-day while-loop and defined
`isLastUsableExercise`. Both `packageForTarget`/`maxExercisesForTarget`
are removed entirely (along with the now-unused `getPackageForTarget`
import) — the loop is now bounded purely by real remaining need
(`remainingWeeklySets > 0`) and real candidate-pool exhaustion
(`pool.length > 0`), which is itself already governed by the target's
real, equipment/prescription-filtered candidates (Blueprint's own
package members plus any approved outside-Blueprint exercises). A
target's own package length no longer acts as either a floor (a target
needing only 1 exercise still gets exactly 1, never forced through every
package member) or a ceiling (a target with real approved
outside-Blueprint candidates supplementing its Blueprint package can now
genuinely use more exercises than that package lists, when real need and
real candidate availability justify it — see Test 8 below).

### Fix D — `npm ci` + a composed `verify`

`package.json`'s `verify` script was `"npm run typecheck && npm test"`,
which never actually ran `build` even though the project already has all
three scripts. Changed to `"npm run build && npm run typecheck && npm
test"` — composing the existing scripts rather than duplicating any
implementation, per the spec's own instruction. `npm ci` and `npm run
verify` were both run for real against a genuinely clean checkout (see
Verification below); no `package.json`/`package-lock.json` dependency
changes were needed — the toolchain the three composed scripts require
was already fully declared.

## New tests

`tests/engine/coreEngineSurgicalFixPassTests.test.ts` (16 `it`s covering
the spec's 13 required tests, some split into more than one assertion
block for clarity) — all exercising the real production path
(`buildWeeklyProgrammingPlan` / `assembleWeeklyProgrammingPlan` /
`assembleAndBuildWorkout`), never an isolated helper in place of it:

1. Final allocation is authoritative (`requiredDirectSets(3) >
   deliveredDirectSets(2)`, no contradiction against the real session).
2. Undelivered sets are never consumed (remaining decreases by the
   delivered 2, not the requested 3).
3. Progression-driven reduction (3 requested / 2 delivered, unmet = 1,
   distinct fields).
4. Time-fit reduction (a tight session budget drops one whole candidate
   exercise; required stays what construction decided, delivered is
   exactly what survived, the gap is explicit — see the test file's own
   comment on why this is a whole-exercise drop rather than a
   same-exercise 3→2, since `fitToTimeBudget` only ever keeps or drops
   whole candidates).
5. One exercise fully satisfies real need, even with a 3-exercise
   package available.
6. Zero exercises when real baseline exposure already meets Blueprint's
   own starting threshold.
7. Multiple exercises — first candidate alone insufficient, a second
   real candidate exists, correct total delivered.
8. Package length controls neither floor (8a, same as Test 5) nor
   ceiling (8b: real exercise count of 4 exceeds the real 3-exercise
   Blueprint package, using 2 real approved outside-Blueprint candidates
   as genuine additional need — with Blueprint-first selection verified
   still intact, i.e. at least one real Blueprint candidate used before
   any outside one).
9. Real bench-press exposure math (chest 4.00 primary / triceps 1.32
   secondary / front-delt 1.32 secondary — exact 1.00/0.33 coefficients,
   `calculateExerciseExposure` directly), plus a production-path
   assertion that a later, lower-priority target's own allocation
   genuinely accounts for a real, computed propagated-exposure number
   (never a fabricated direct-set equivalence — the skip reasoning cites
   the real "8.25" figure).
10. The whole real weekly plan (Mon Push/Tue Pull/Wed rest/Thu Legs/Fri
    Upper, Sat+Sun badminton, Goal 1 + Goal 2 + normal-development/
    maintenance all present in the SAME plan from one call), plus the
    §22 assertion that today's own workout (`assembleAndBuildWorkout`)
    is a real slice of that same plan (`assembleWeeklyProgrammingPlan`),
    never an independently re-derived allocation.
11. Monday rule holds even under extreme lower-body need.
12. Real programming priority survives, never an alphabetically-earlier
    id.
13. Determinism, both for the pure `buildWeeklyProgrammingPlan` and for
    the real production path end to end.

`tests/engine/surgicalFixWeeklyPlanTests.test.ts` — updated for the
Fix A field rename (`plannedDirectSets` → `deliveredDirectSets`).

## Verification (real commands, real output)

Install command:
```
npm ci
```

Verification command:
```
npm run verify
```

Exact result (from a genuinely clean checkout — the working tree
archived via `git archive` on a `git stash create` snapshot, including
the new untracked test file, into a scratch directory with no
`node_modules`/`dist`, then `npm ci` followed by `npm run verify` from
there):

```
$ npm ci
added 172 packages, and audited 173 packages in 2s
(no errors)

$ npm run verify
> workout-logger@0.1.0 verify
> npm run build && npm run typecheck && npm test

> workout-logger@0.1.0 build
> tsc -p tsconfig.json

> workout-logger@0.1.0 typecheck
> tsc --noEmit

> workout-logger@0.1.0 test
> vitest run

 Test Files  42 passed (42)
      Tests  416 passed (416)
```

Tests:
Total: 416
Passed: 416
Failed: 0
Skipped: 0

Build: PASS (`tsc -p tsconfig.json` — no errors, no output)
Typecheck: PASS (`tsc --noEmit` — no errors, no output)

Node v22.22.2, npm 10.9.7. 416 = the pre-existing 400 (all still passing
unchanged, confirming Fix A/B/C introduced no regressions) + 16 new
`it`s in `coreEngineSurgicalFixPassTests.test.ts` covering the 13
required tests. No `package.json`/`package-lock.json` dependency changes
were required — only the `verify` script itself changed (Fix D).

## Status against the completion gate

Fix A: `targetAllocations` is now rebuilt exclusively from final,
post-fitting sessions — verified directly (Tests 1, 4, 8b). Fix B: only
delivered sets are ever charged, both for progression-driven and
time-fitting-driven reductions — verified directly (Tests 2, 3, 4). Fix
C: Blueprint package length no longer floors or ceilings real exercise
count — verified directly (Tests 5-8), with Blueprint-first selection
confirmed still intact. Fix D: `npm ci` and a real, composed `npm run
verify` (build + typecheck + test) both run clean from an actual clean
checkout, reported above with exact commands and exact results — nothing
claimed without having been executed. Every frozen invariant listed in
the spec (goal priority, 1.00/0.33 exposure, PPL+Upper, Monday rule,
Blueprint-first selection, deterministic output, explainability,
supporting-target safety) was re-verified through the real production
path rather than assumed unchanged.
