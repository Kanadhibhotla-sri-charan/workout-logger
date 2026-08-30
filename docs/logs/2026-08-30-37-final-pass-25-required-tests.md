# 2026-08-30 — Final Programming-Engine Pass: the 22 required end-to-end tests (§25)

## What changed

New `tests/engine/finalPassRequiredTests.test.ts` implements every one
of §25's 22 explicitly required tests, each individually labeled with
its exact number and name from the spec so coverage is auditable
without cross-referencing other files. Every test exercises the real
production generation path (`assembleAndBuildWorkout`, or `buildWorkout`
fed a realistic `TargetBuildContext[]`) — per the spec's own "unit
tests alone are insufficient" instruction — never an isolated call to
a single engine function standing in for the real pipeline.

Test-by-test summary:

1. **Goal priority**: two competing chest aesthetic goals (both push/
   upper-compatible, so they genuinely compete for the same session's
   time budget) — Goal 1 gets served, Goal 2 doesn't, under a scarce
   budget.
2. **Third goal**: activating a 3rd aesthetic goal throws
   `TooManyActiveAestheticGoalsError`; succeeds once one of the first
   two is deactivated.
3. **Compound exposure**: 4 bench sets give chest 4.00, triceps 1.32,
   front delts 1.32 exactly.
4. **Secondary exposure affects programming**: real logged pressing
   history produces real secondary exposure on triceps/front-delt,
   visible in whichever real outcome (planned or skipped) results.
5. **Real history wiring**: an otherwise-identical fixture with vs.
   without logged history produces different `recent_exercise_ids`,
   `previous_performance`, and `progression_decision`.
6. **Last-trained wiring**: a real same-day session makes
   `days_since_target_last_trained` 0 and triggers a real 'avoid' skip.
7. **Progression wiring**: real prior performance reaches the final
   `previous_performance`/`progression_decision` on the generated
   exercise.
8. **Normal development**: a zero-exposure non-goal muscle (quads, on
   its legs day) is classified `normal_development`.
9. **Maintenance**: a non-goal muscle with 10 real logged direct sets
   (above Blueprint's starting_point_sets[0]=8) is classified
   `maintenance`.
10. **No artificial priority**: every real Blueprint physique target
    fed in with identical (zero) exposure is classified
    `normal_development` — none artificially demoted by array
    position.
11. **Contextual frequency**: mid-pec (push/upper only) never appears
    on Tuesday(pull)/Thursday(legs) despite those being available gym
    days — proving day placement isn't naive even spreading.
12. **PPL + Upper**: across Monday/Tuesday/Thursday/Friday, the real
    generated sessions carry push/pull/legs/upper respectively — four
    genuinely distinct purposes.
13. **Monday lower-body prohibition**: with Monday as the week's only
    gym day, no lower-body target ever appears.
14. **Badminton changes programming**: two otherwise-identical weekly
    fixtures (low vs. high badminton intensity before a legs session)
    produce a real difference in generated set count or exercise
    choice, not just reasoning text.
15. **Badminton is complementary**: low-intensity, low-fatigue
    badminton does not eliminate aesthetic gym work.
16. **Time constraint**: a scarce budget still fits, and whatever
    survives is the specialization goal's own work, never a
    lower-priority target instead.
17. **Equipment constraint**: with only 'cable' equipment, a real
    feasible Blueprint alternative (cable-fly) is selected — proven to
    be Blueprint's own, not outside-Blueprint.
18. **Outside-Blueprint approval**: with no approved outside exercise,
    the functional_goal target is skipped, never silently prescribed.
19. **Outside-Blueprint fallback**: an approved outside exercise is
    selected, with its own name and "approved outside-Blueprint role"
    reasoning genuinely recorded, not silently applied.
20. **Functional prescription gap**: the functional goal stays real and
    active in `GoalsRepo`, while today's exercise selection is skipped
    with a real reason — the goal's existence and today's generation
    gap are kept distinct.
21. **Blueprint `supporting_targets`**: `chest-upper-shelf` (confirmed
    to lack the field) resolves and generates a real workout without
    throwing.
22. **Determinism**: two `assembleAndBuildWorkout` calls against
    identical stored state produce `toEqual`-identical results,
    including exercise order.

## Verification (real commands, real output)

Two assertions needed correction after the first real run (both
genuine test-authoring mistakes, not production bugs): Test 5 initially
asserted `decisive_gate === 'gate5_progression_continuity'`, but with
only one equipment-feasible, Blueprint-prescribed candidate available
(cable-fly), Gate 2 is trivially decisive by default — the real proof
of history consumption is `previous_performance`/`progression_decision`
being populated, which the test now asserts instead. Test 19 had a
tautological conditional assertion that couldn't actually fail; fixed
to check the reasoning text genuinely names the approved exercise.

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npx vitest run
 Test Files  38 passed (38)
      Tests  376 passed (376)
```

Run from a clean working tree at the repo root.

## Status against §25/§29

All 22 required tests exist, are individually identifiable, exercise
the real production path, and pass for real. Still open: the §26
realistic-week fixture update (PPL+Upper context, two active ranked
goals) and the final §27/§28 test-execution report.
