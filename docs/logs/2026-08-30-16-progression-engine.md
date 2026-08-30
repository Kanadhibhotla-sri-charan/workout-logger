# 2026-08-30 — Progression engine: Blueprint's own double-progression model

## Why

The old `progressionEngine.ts` stub threw `NotApprovedError`, saying
per-exercise load/rep progression needed "approved rep-range/load-
increment/performance-threshold/RIR-RPE/deload rules" this app didn't
have. Investigating Blueprint's own `programming.json` snapshot found
that it does — `globalPrinciples.progression` (model: "double-
progression", with an exact rule in `explanation`) and
`globalPrinciples.rir` (`typical_working_range: [1, 3]`) were already
present in the vendored data but typed `unknown` on
`BlueprintProgramming`, so nothing in the app could read them.

## What changed

- `src/blueprint/types.ts` — new `BlueprintGlobalPrinciples` interface
  (`rir`, `weekly_volume`, `frequency`, `progression`,
  `wording_rules`), replacing `globalPrinciples: unknown` with a real
  type. `src/blueprint/adapter.ts` — new
  `BlueprintAdapter.getGlobalPrinciples()`.
- `src/engine/progressionEngine.ts` (rewritten, real implementation) —
  `computeProgression()` applies Blueprint's double-progression rule
  literally: every completed set at the top of the target rep range at
  or below Blueprint's own `typical_working_range` RIR ceiling →
  `increase_load` (by `PROGRESSION_INCREMENTS.loadKg`); within range but
  not yet at the top → `increase_reps` (by
  `PROGRESSION_INCREMENTS.reps`); below range → `maintain`, *unless* the
  last `RECOVERY_THRESHOLDS.consecutiveDecliningSessions` sessions were
  **all** below range, which is the only path to `reduce` (spec §12: a
  single bad session is never automatic grounds for reduction — a
  genuine repeated pattern is). No completed sets logged → `unknown`,
  never a guess. No new coefficients were introduced — every number
  used is either already in `src/engine/config.ts` or read directly
  from Blueprint's own data.
- `tests/engine/unapprovedStubs.test.ts` — dropped the
  `progressionEngine` "throws NotApprovedError" case (no longer true).

## Tests

`tests/engine/progressionEngine.test.ts` (9 tests): top-of-range at
target RIR → `increase_load`; within-range → `increase_reps`; RIR at
the harder end of typical still triggers `increase_load`; one
below-range session → `maintain`, not `reduce`; exactly
`RECOVERY_THRESHOLDS.consecutiveDecliningSessions` consecutive
below-range sessions → `reduce`; one session short of that threshold
→ still `maintain`; no completed sets → `unknown`; no history at all
→ `unknown`; a set with no logged `rir` is still judged on reps alone.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  28 passed (28)
      Tests  203 passed (203)
```

(195 tests before this batch; 203 after adding
`tests/engine/progressionEngine.test.ts`'s 9 tests, minus 1 removed
from `unapprovedStubs.test.ts` — no regressions.)

## Still open

This resolves task "progression engine" from the pending engine-module
list, and is the first of several `NotApprovedError` stubs to fall now
that the Next Phase spec (and, in this case, Blueprint's own
methodology data) resolves what Phase 2 correctly flagged as an open
decision at the time. `volumeEngine`, `recoveryEngine`,
`frequencyEngine`, `exerciseSelector`, and `workoutBuilder` are still
stubs — `volumeEngine` is next, since it can reuse
`BlueprintGlobalPrinciples.weekly_volume` the same way this change
reused `.progression`.
