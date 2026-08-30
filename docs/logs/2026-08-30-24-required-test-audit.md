# 2026-08-30 — Audit against spec §23's 15 required tests; fixed a real bug found along the way

## Why

Spec §23 enumerates 15 specific required test scenarios. Tests were
added incrementally alongside each engine module this session, but
nothing had cross-checked the full list against what actually exists.
Dispatched an independent audit (a fresh agent with no context on what
I'd already written, searching `tests/` directly) rather than trusting
my own memory of what I'd covered.

## Audit result

12 of 15 were already directly covered (several explicitly labeled
"required test N" in their own test names — bench press exposure,
Blueprint-first selection, time-fitting preserves priority, ranking
allocation, good-progress-maintains, stagnation-introspects,
justified-increase, poor-recovery-no-increase, Monday-never-lower-body,
outside-Blueprint approval gate, natural-language confirmation). Three
gaps:

1. **Required test 6** (third active aesthetic goal rejected) — the
   cap (`TooManyActiveAestheticGoalsError`,
   `MAX_ACTIVE_AESTHETIC_GOALS`) was implemented in an earlier commit
   but never actually exercised by a test.
2. **Required test 11** (badminton workload used by weekly planning) —
   `recoveryEngine`'s unit tests covered badminton in isolation, but no
   test drove the *pipeline* (`workoutBuilder`) with a badminton signal
   to prove it actually changes an outcome.
3. **Required test 15** (returning goal loads history) — true only "by
   construction" (nothing deletes data); no test proved a
   deactivate → reactivate cycle actually preserves `goal_events`
   history and reloads exposure/priority data.
4. **Required test 3** (substitution when the best exercise is
   unavailable) — flagged as only partially covered at the unit level
   (`exerciseSelector`, `equipmentConstrained` fixture); nothing at
   the full-pipeline level proved a genuine substitution end to end.

## A real bug the test-3 gap surfaced

Writing the pipeline-level substitution test exposed an actual
inconsistency in `workoutBuilder.ts`: when the top-ranked candidate
exercise had no Blueprint development-package prescription, the code
fell back to `getPackageForTarget(target)?.exercises[0]` — silently
applying a *different* exercise's reps/RIR to the one actually
selected. That directly contradicted this same file's own documented
guarantee ("never filled in with a guess"). Fixed two ways:

- Removed the fallback entirely — no prescription match means no
  invented substitute, full stop.
- Went further and fixed the *design*, not just the symptom: candidate
  exercises are now filtered to only those with a real Blueprint
  prescription **before** ranking (not after selecting the top pick
  and then discovering it doesn't work). This means a preferred
  exercise that becomes infeasible now correctly substitutes to
  another *usable* (prescription-backed) candidate, rather than either
  applying someone else's numbers or giving up when a real alternative
  existed.

## Tests added

`tests/engine/workoutBuilder.test.ts` (+2): **required test 3** — with
only `cable` equipment available, the preferred/current
`flat-barbell-bench-press` (needs barbell/bench/rack) is infeasible;
the pipeline substitutes `cable-fly` (feasible, real prescription
data) rather than `cable-chest-press` (feasible but no prescription)
or giving up. **required test 11** — a stagnant target's
`reasoning_log` differs (cites "recovery is flagged") when a recent
high-intensity badminton session is present vs. absent, proving the
badminton signal actually reaches the volume decision through the full
pipeline.

`tests/goals.test.ts` (+6, two new describe blocks): **required test
6** — a third simultaneous active aesthetic goal is rejected
(`TooManyActiveAestheticGoalsError`), succeeds once one of the first
two is deactivated, and functional goals are confirmed uncapped.
**required test 15** — deactivate→reactivate preserves the full
`goal_events` history (`created, activated, priority_changed,
deactivated, activated`, including the deactivation note); a
reactivated goal reappears in `TrainingState.active_goals` with its
`priority_map` intact; exposure logged while the goal was active is
still reflected in exposure aggregates after it returns (nothing was
ever deleted).

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 297 passed (297)
```

(289 tests before this batch; 297 after — no regressions from the
workoutBuilder fix.)

## Result

All 15 of spec §23's required test scenarios now have explicit,
verified, individually-identifiable coverage.
